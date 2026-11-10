import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { Store } from './store.mjs';
import { loadSecrets, redact } from './security.mjs';
import { validateCommandTimeouts } from './config.mjs';
import { planSchema } from './contracts.mjs';
import { commitChanges } from './workspace.mjs';
import { writeProgress } from './progress.mjs';
import { recordBlocker, resetWatchdog, resolveBlocker } from './watchdog.mjs';
import { normalizeArchitectureConfig } from './architecture-gate.mjs';
import { EngineVerification } from './engine-verification.mjs';

/** Public engine: the durable run loop over the layered stages. */
/** Why the run stopped now, with the facts and evidence the next session needs. */
function currentBlocker(run, error) {
  const assessed = error.code === 'blocked' ? run.controllerAssessment : null;
  return recordBlocker(run.blocker, {
    code: assessed?.reason || run.error.code,
    message: run.error.message,
    scope: assessed?.scope || 'run',
    at: new Date().toISOString(),
    headSha: run.headSha || null,
    reasons: [run.error.code, error.classification, run.behavior?.passed === false ? 'behavior_failed' : null].filter(
      Boolean,
    ),
    evidence: [
      ...(run.checks?.results || []).map(row => ({ sha256: row.outputHash, kind: 'check' })),
      ...(run.behavior?.oracles || []).map(row => ({ sha256: row.outputHash, kind: 'oracle' })),
    ].filter(item => typeof item.sha256 === 'string'),
  });
}
export class Engine extends EngineVerification {
  // oxlint-disable-next-line max-lines-per-function, complexity -- debt: docs/kodo-roadmap/MAINTAINABILITY-PLAN.md
  async run(id, { prepare = false, planFile, signal, resumeCancelled = false, retryFailed = false } = {}) {
    const run = this.store.getRun(id);
    writeProgress(run, {
      home: run.artifacts ? path.resolve(run.artifacts, '../..') : this.store.home,
      secrets: this.secrets,
    });
    if (run.state === 'succeeded' || (run.state === 'cancelled' && !resumeCancelled)) return run;
    const token = this.store.acquireLease(`run:${id}`, id);
    if (!token) throw new Error('Этот запуск уже исполняется');
    // The saved error describes the previous attempt: from here on it is history, not the current blocker.
    run.blocker = resolveBlocker(run.blocker, { at: new Date().toISOString(), outcome: 'resumed' });
    if (resumeCancelled) {
      this.store.updateRun(id, { cancelRequested: false, state: 'resuming' });
      delete run.cancelRequested;
      run.state = 'resuming';
    }
    if (retryFailed) {
      for (const node of Object.values(run.nodes))
        if (!['completed', 'integrated'].includes(node.status)) {
          node.previousAttempts = (node.previousAttempts || 0) + node.attempt;
          node.previousCycles = [
            ...(node.previousCycles || []),
            { attempt: node.attempt, error: node.error, sessionId: node.sessionId, stopped: node.stopped },
          ].slice(-20);
          node.attempt = 0;
          node.status = 'pending';
          delete node.routing;
          delete node.sessionId;
          delete node.lastFailure;
          delete node.stopped;
        }
      const previous = run.verification;
      // A reserved repair must finish in its existing cycle, even on explicit retry.
      if (previous && !previous.pendingRepair)
        run.verification = {
          attempt: 0,
          cycle: (previous.cycle || 1) + 1,
          previousCycles: [
            ...(previous.previousCycles || []),
            { attempt: previous.attempt, cycle: previous.cycle, stopped: previous.stopped },
          ].slice(-20),
        };
      delete run.controllerAssessment;
      run.watchdog = resetWatchdog(run.watchdog);
      this.save(run);
      this.log(run, 'retry_requested');
    }
    const parentSignal = signal,
      controller = new AbortController(),
      cancel = () => controller.abort();
    let leaseError;
    const heartbeat = setInterval(() => {
      if (!this.store.renewLease(token)) {
        leaseError = Object.assign(new Error('Потеряна блокировка запуска'), { code: 'lease_lost' });
        cancel();
      }
    }, this.leaseHeartbeatMs);
    heartbeat.unref();
    parentSignal?.addEventListener('abort', cancel, { once: true });
    if (parentSignal?.aborted) cancel();
    signal = controller.signal;
    const cancellation = setInterval(() => {
      if (this.store.getRun(id).cancelRequested) cancel();
    }, 500);
    cancellation.unref();
    try {
      // Saved runs bypass readConfig; reject invalid timer values before any
      // preparation, check reuse or coordinator delivery command can start.
      validateCommandTimeouts(run.config.commands);
      normalizeArchitectureConfig(run.config.architecture);
      this.checkCancelled(run, signal);
      await this.prepare(run, signal);
      if (prepare && !run.plan) {
        run.state = 'awaiting_plan';
        run.planningContext = await this.preparePlanningContext(run);
        await writeFile(path.join(run.artifacts, 'plan-context.md'), run.planningContext);
        await writeFile(
          path.join(run.artifacts, 'plan.schema.json'),
          JSON.stringify(
            {
              ...planSchema,
              properties: {
                ...planSchema.properties,
                tasks: { ...planSchema.properties.tasks, maxItems: run.executionMode.profile.maxTasks },
              },
            },
            null,
            2,
          ),
        );
        this.save(run);
        return run;
      }
      if (run.verification?.stopped)
        throw Object.assign(new Error('Verification repair cycle stopped; use --retry-failed for a new cycle'), {
          code: 'blocked',
        });
      // Recover a completed external merge before requiring native clients.
      // A lost delivery receipt must not rediscover models or replay analysis.
      if (run.delivery?.pr && this.delivery.reconcileDelivery) {
        const recovered = await this.delivery.reconcileDelivery({
          run,
          config: run.config,
          store: this.store,
          cwd: run.cwd,
          secrets: this.secrets,
          signal,
        });
        if (recovered) {
          run.delivery = recovered;
          this.save(run);
        }
      }
      if (!run.delivery?.mergeCommit) {
        run.models = (
          await this.logical(run, 'discovery', () =>
            this.provider.discoverProviders(
              {
                client: run.client,
                providers: run.fixedModel ? 'current' : run.providers,
                primaryModel: run.config.primaryModel,
              },
              { secrets: this.secrets, config: run.config },
            ),
          )
        ).filter(
          item =>
            item.available !== false &&
            (run.providers === 'both' || item.client === run.client) &&
            run.config.models[item.client]?.includes(item.model) &&
            (!run.fixedModel || (item.client === run.fixedModel.client && item.model === run.fixedModel.model)),
        );
        if (!run.models.length) throw Object.assign(new Error('Нет доступных моделей по подписке'), { code: 'auth' });
        this.primary(run);
        this.save(run);
      }
      await this.plan(run, planFile, signal);
      await this.assertProjectPlan(run);
      if (!run.delivery?.mergeCommit) {
        if (!run.completed.implementation) {
          await this.baseline(run, signal);
          await this.executeTasks(run, signal);
          run.completed.implementation = true;
          this.save(run);
        }
        // Finish and scope-check the saved repair against its original HEAD
        // before generic recovery can commit partial writes or base/release
        // updates can introduce unrelated changes into that scope comparison.
        if (run.verification?.pendingRepair) await this.repairVerification(run, signal);
        await this.recoverIntegrationEdits(run, signal);
        if (run.config.delivery.enabled) await this.synchronizeBase(run, signal);
        if (run.config.delivery.release) {
          if (this.delivery.prepareReleaseVersion)
            await this.delivery.prepareReleaseVersion({
              run,
              config: run.config,
              store: this.store,
              cwd: run.cwd,
              secrets: this.secrets,
              signal,
            });
          await commitChanges(run.cwd, 'Kodo assign release version', [
            'package.json',
            'package-lock.json',
            'registry.json',
          ]);
        }
        await this.verify(run, signal);
      }
      this.checkCancelled(run, signal);
      if (run.config.delivery.enabled) {
        run.state = 'delivering';
        this.save(run);
        for (let attempt = 0; ; attempt++) {
          try {
            run.delivery = await this.delivery.deliver({
              run,
              config: run.config,
              store: this.store,
              cwd: run.cwd,
              review: run.review,
              secrets: this.secrets,
              signal,
              onEvent: event => this.log(run, 'delivery', event),
            });
            break;
          } catch (error) {
            if (error.code !== 'stale_base' || attempt >= 3) throw error;
            if (run.delivery?.pr && this.delivery.reconcileDelivery) {
              const recovered = await this.delivery.reconcileDelivery({
                run,
                config: run.config,
                store: this.store,
                cwd: run.cwd,
                secrets: this.secrets,
                signal,
              });
              if (recovered) {
                run.delivery = recovered;
                break;
              }
            }
            await this.synchronizeBase(run, signal);
            if (run.config.delivery.release && this.delivery.prepareReleaseVersion) {
              await this.delivery.prepareReleaseVersion({
                run,
                config: run.config,
                store: this.store,
                cwd: run.cwd,
                secrets: this.secrets,
                signal,
              });
              await commitChanges(run.cwd, 'Kodo refresh release version', [
                'package.json',
                'package-lock.json',
                'registry.json',
              ]);
            }
            await this.verify(run, signal);
          }
        }
        this.save(run);
        this.checkCancelled(run, signal);
        if (run.config.delivery.release) {
          run.state = 'releasing';
          this.save(run);
          run.release = await this.delivery.releasePackage({
            run,
            config: run.config,
            store: this.store,
            cwd: run.cwd,
            mergeCommit: run.delivery.mergeCommit,
            secrets: this.secrets,
            signal,
            onEvent: event => this.log(run, 'release', event),
          });
        }
      }
      if (!run.release?.published) this.checkCancelled(run, signal);
      run.state = 'succeeded';
      run.error = null;
      run.blocker = resolveBlocker(run.blocker, { at: new Date().toISOString(), outcome: 'succeeded' });
      this.save(run);
      this.log(run, 'succeeded', { headSha: run.headSha, pr: run.delivery?.pr, release: run.release });
      await this.policy(run, 'complete');
      run.knowledge = this.store.remember(run);
      this.save(run);
      await writeFile(path.join(run.artifacts, 'receipt.json'), JSON.stringify(redact(run, this.secrets), null, 2));
      return run;
    } catch (error) {
      // oxlint-disable-next-line no-ex-assign -- a lost lease outranks the stage error
      error = leaseError || error;
      run.state = this.store.getRun(run.id).cancelRequested
        ? 'cancelled'
        : error.code === 'lease_lost'
          ? 'blocked'
          : error.code === 'quota'
            ? 'waiting_limits'
            : error.code === 'cancelled' || signal?.aborted
              ? 'cancelled'
              : 'blocked';
      run.error = {
        code: error.code || 'error',
        message: redact(error.message, this.secrets),
        ...(error.retryAt ? { retryAt: error.retryAt } : {}),
      };
      if (['blocked', 'waiting_limits'].includes(run.state)) run.blocker = currentBlocker(run, error);
      this.save(run);
      this.log(run, run.state, run.error);
      return run;
    } finally {
      clearInterval(heartbeat);
      clearInterval(cancellation);
      parentSignal?.removeEventListener('abort', cancel);
      this.store.releaseLease(token);
    }
  }
}
export async function openEngine(options = {}) {
  const secrets = options.secrets || (await loadSecrets());
  return new Engine({ ...options, secrets, store: options.store || new Store(undefined, secrets) });
}
