import { isDeepStrictEqual } from 'node:util';
import { redact, workerEnvironment } from './security.mjs';
import { validateCommandTimeouts } from './config.mjs';
import { validate, resultSchema, reviewSchema } from './contracts.mjs';
import { execute } from './command.mjs';
import { git, commitChanges, diffHash } from './workspace.mjs';
import { inspectCurrentSource } from './ci-graph.mjs';
import { compactReviewEvidence } from './context-pack.mjs';
import { normalizeArchitectureConfig } from './architecture-gate.mjs';
import { EngineExecution } from './engine-execution.mjs';
import { contentHash, packSessionEvidence, evidencePrompt } from './engine-core.mjs';

/** Checks, verification gates, review and repair stages. */
export class EngineVerification extends EngineExecution {
  async checks(run, signal) {
    run.architectureChecks = null;
    validateCommandTimeouts(run.config.commands);
    normalizeArchitectureConfig(run.config.architecture);
    run.state = 'testing';
    this.save(run);
    await this.setup(run.cwd, run, signal);
    const headSha = await git(run.cwd, ['rev-parse', 'HEAD']);
    if ((await inspectCurrentSource({ project: run.cwd, headSha })) !== 'clean')
      throw Object.assign(new Error('Проверка commit требует чистого integration worktree'), {
        code: 'dirty_worktree',
      });
    const expected = ['test', 'build'].flatMap(kind => run.config.commands[kind].map(command => ({ kind, command })));
    const fingerprint = contentHash({
      headSha,
      expected,
      runtime: { node: process.version, abi: process.versions.modules, platform: process.platform, arch: process.arch },
    });
    if (
      run.config.commands.test.length &&
      run.checks?.schemaVersion === 2 &&
      run.checks.complete === true &&
      run.checks.headSha === headSha &&
      run.checks.fingerprint === fingerprint &&
      Array.isArray(run.checks.results) &&
      run.checks.results.length === expected.length &&
      run.checks.results.every(
        (row, index) =>
          row.exitCode === 0 &&
          row.kind === expected[index].kind &&
          isDeepStrictEqual(row.command, expected[index].command),
      )
    ) {
      for (const reference of this.checkEvidenceReferences(run)) await this.assertEvidence(reference);
      this.log(run, 'checks_reused', { headSha, fingerprint, checks: expected.length });
      return;
    }
    const results = [];
    run.checks = { schemaVersion: 2, headSha, fingerprint, complete: false, results };
    this.save(run);
    for (const kind of ['test', 'build'])
      for (const command of run.config.commands[kind]) {
        this.checkCancelled(run, signal);
        this.log(run, 'check_started', { kind, command });
        let result;
        try {
          result = await execute(command.command, command.args, {
            cwd: run.cwd,
            signal,
            env: workerEnvironment(),
            secrets: this.secrets,
            timeoutMs: command.timeoutMs,
            allowFailure: true,
          });
        } catch (error) {
          // Stopped execution is never a passing check, even when the actual
          // child exit happens to be zero. Persist only the diagnostic contract;
          // errors, stacks, arguments and environment are not output evidence.
          const reason = [
            'cancelled',
            'timeout',
            'invalid_output',
            'command_failed',
            'ENOENT',
            'EACCES',
            'EPERM',
          ].includes(error.code)
            ? error.code
            : 'execution_failed';
          const partial = error.result;
          const stdout = redact(typeof partial?.stdout === 'string' ? partial.stdout : '', this.secrets).slice(-24000);
          const stderr = redact(typeof partial?.stderr === 'string' ? partial.stderr : '', this.secrets).slice(-24000);
          const failed = {
            kind,
            command,
            status: 'failed',
            reason,
            exitCode: null,
            processExitCode: Number.isInteger(partial?.code) ? partial.code : null,
            stdout,
            stderr,
            durationMs: Number.isFinite(partial?.durationMs) && partial.durationMs >= 0 ? partial.durationMs : null,
            outputTruncated: partial?.outputTruncated === true,
          };
          const row = redact(
            {
              kind,
              command,
              status: 'failed',
              reason,
              exitCode: null,
              processExitCode: failed.processExitCode,
              output: (stdout + stderr).slice(-24000),
            },
            this.secrets,
          );
          results.push(row);
          try {
            const evidence = await this.persistEvidence(run, 'check', failed, { headSha });
            row.outputPath = evidence.path;
            row.outputHash = evidence.sha256;
          } catch {
            /* Preserve the original execution error if evidence storage fails. */
          }
          try {
            this.save(run);
          } catch {
            /* The previously saved receipt remains incomplete. */
          }
          throw error;
        }
        if ((await inspectCurrentSource({ project: run.cwd, headSha })) !== 'clean')
          throw Object.assign(new Error('Команда проверки изменила проверяемый commit или файлы'), {
            code: 'dirty_worktree',
          });
        const evidence = await this.persistEvidence(
          run,
          'check',
          { kind, command, exitCode: result.code, stdout: result.stdout, stderr: result.stderr },
          { headSha },
        );
        results.push({
          kind,
          command,
          exitCode: result.code,
          output: (result.stdout + result.stderr).slice(-24000),
          outputPath: evidence.path,
          outputHash: evidence.sha256,
        });
        this.save(run);
        if (result.code !== 0)
          throw Object.assign(
            new Error(
              `Проверка ${kind} не пройдена (exit ${result.code}): ${(result.stdout + result.stderr).slice(-6000)}`,
            ),
            { code: 'check_failed' },
          );
      }
    if (!run.config.commands.test.length) throw new Error('Не настроена команда проверки результата');
    run.checks = { schemaVersion: 2, headSha, fingerprint, complete: true, results };
    this.save(run);
  }
  async verificationGates(run, signal) {
    const headSha = await git(run.cwd, ['rev-parse', 'HEAD']);
    const clean = async () => {
      if ((await inspectCurrentSource({ project: run.cwd, headSha })) !== 'clean') {
        run.uiVerification = null;
        run.securityChecks = null;
        run.architectureChecks = null;
        run.review = null;
        this.save(run);
        throw Object.assign(new Error('UI/security gate changed the checked worktree'), { code: 'dirty_worktree' });
      }
    };
    await clean();
    if (run.checks?.headSha !== headSha)
      throw Object.assign(new Error('Local check head is stale'), { code: 'stale_checks' });
    run.state = 'verifying';
    run.review = null;
    this.save(run);
    const failures = [];
    for (const [field, config, executeGate, current] of [
      ['uiVerification', run.config.uiVerification, this.gates.runUIVerification, this.gates.isCurrentUIReceipt],
      ['securityChecks', run.config.security, this.gates.runSecurityChecks, this.gates.isCurrentSecurityReceipt],
      [
        'architectureChecks',
        run.config.architecture,
        this.gates.runArchitectureChecks,
        this.gates.isCurrentArchitectureReceipt,
      ],
    ]) {
      this.checkCancelled(run, signal);
      // Never retain a previous passing receipt when the next invocation fails.
      const previous = run[field];
      run[field] = null;
      this.save(run);
      try {
        run[field] = await executeGate({
          cwd: run.cwd,
          headSha,
          baseSha: run.baseSha,
          config,
          artifacts: run.artifacts,
          previous,
          secrets: this.secrets,
          signal,
        });
      } catch (error) {
        if (signal?.aborted || ['cancelled', 'quota', 'auth', 'lease_lost'].includes(error.code)) throw error;
        run[field] = { headSha, status: 'blocked', passed: false };
      }
      this.save(run);
      await clean();
      if (!(await current(run[field], { cwd: run.cwd, headSha, baseSha: run.baseSha, config, signal }))) {
        const receipt = run[field];
        const findings = [
          ...(receipt?.tools || []).slice(0, 5).flatMap(row => (row.findings || []).slice(0, 10)),
          ...(receipt?.report?.findings || []).slice(0, 10),
        ].map(f => ({
          ruleId: String(f.ruleId || '').slice(0, 160),
          file: String(f.file || '').slice(0, 240),
          line: Number.isSafeInteger(f.line) ? f.line : undefined,
          severity: String(f.severity || '').slice(0, 20),
        }));
        const statuses = new Set(['passed', 'failed', 'blocked', 'error']);
        const cases = (run.config.uiVerification?.cases || [])
          .slice(0, 20)
          .filter(() => field === 'uiVerification')
          .map(c => {
            const row = receipt?.cases?.find(r => r.id === c.id);
            return {
              id: c.id,
              tool: c.tool,
              status: statuses.has(row?.status) ? row.status : 'invalid',
              failedAssertions: (row?.assertions || [])
                .flatMap((a, index) => (a.passed === false ? [index] : []))
                .slice(0, 30),
            };
          });
        failures.push({
          gate: field,
          status: ['failed', 'blocked', 'disabled'].includes(receipt?.status) ? receipt.status : 'invalid',
          findings,
          cases,
        });
      }
    }
    if (failures.length)
      throw Object.assign(
        new Error(
          `UI/security verification requires current complete evidence: ${JSON.stringify(redact(failures, this.secrets))}`,
        ),
        { code: 'verification_failed' },
      );
  }
  async repairVerification(run, signal) {
    run.architectureChecks = null;
    this.save(run);
    const cycle = run.verification,
      pending = cycle.pendingRepair;
    const scopes = run.plan.tasks.flatMap(task => task.writePaths);
    this.checkCancelled(run, signal);
    if (!pending.complete) {
      if (!pending.researched) {
        await this.moreResearch(run, pending.problem, signal);
        pending.researched = true;
        this.save(run);
      }
      const selected = this.primary(run);
      const response = await this.session(
        run,
        {
          client: selected.client,
          model: selected.model,
          cwd: run.cwd,
          schema: resultSchema,
          sessionId: pending.sessionId,
          prompt: `Repair confirmed failures in task ${run.task.slice(0, 1000)}. Do not commit/push/deploy, do not weaken checks. Change only these scopes ${JSON.stringify(scopes)}. Failures: ${pending.problem.slice(0, 6000)}. Evidence directory (read only relevant gate receipts): ${run.artifacts}. Return completion JSON.`,
        },
        signal,
        undefined,
        pending,
      );
      if (!response.output.complete) throw new Error('Исправление проверки не завершено');
      pending.sessionId = response.sessionId || pending.sessionId;
      pending.complete = true;
      this.save(run);
    }
    this.checkCancelled(run, signal);
    await this.checkScope(run.cwd, pending.headSha, scopes);
    await commitChanges(run.cwd, `Kodo repair checks ${cycle.attempt}`);
    delete cycle.pendingRepair;
    run.checks = null;
    run.review = null;
    run.uiVerification = null;
    run.securityChecks = null;
    run.architectureChecks = null;
    this.save(run);
  }
  async verify(run, signal) {
    const cycle = (run.verification ||= { attempt: 0, cycle: 1 });
    if (cycle.stopped || cycle.attempt >= run.config.repairRounds) {
      if (!cycle.stopped) {
        cycle.stopped = 'repair_budget_exhausted';
        this.assess(run, {
          scope: 'verification',
          attempts: cycle.attempt,
          reason: cycle.stopped,
          problem:
            run.error?.message || 'Verification budget exhausted; remaining checks require an explicit new cycle',
        });
      }
      throw Object.assign(new Error('Verification repair cycle stopped; use --retry-failed for a new cycle'), {
        code: 'blocked',
      });
    }
    while (cycle.attempt < run.config.repairRounds) {
      // A failed round reserves its repair durably. Interruptions resume that
      // repair before a new round can interpret the same HEAD as no progress.
      if (cycle.pendingRepair) await this.repairVerification(run, signal);
      const attempt = cycle.attempt;
      let checkError;
      try {
        run.uiVerification = null;
        run.securityChecks = null;
        run.architectureChecks = null;
        run.review = null;
        this.save(run);
        await this.checks(run, signal);
        await this.verificationGates(run, signal);
      } catch (error) {
        if (signal?.aborted || this.store.getRun(run.id).cancelRequested)
          throw Object.assign(new Error('Запуск отменён'), { code: 'cancelled' });
        if (['cancelled', 'quota', 'auth', 'lease_lost', 'evidence_integrity'].includes(error.code)) throw error;
        checkError = error;
      }
      const headSha = await git(run.cwd, ['rev-parse', 'HEAD']);
      let review;
      if (!checkError) {
        run.state = 'reviewing';
        this.save(run);
        const selected =
          run.fixedModel || run.executionMode.selected === 'quick'
            ? this.primary(run)
            : run.models.find(model => model.client === run.client && /astra|opus/.test(model.model)) ||
              this.primary(run);
        const range = `${run.baseSha}...${headSha}`;
        const [diffResult, statResult, pathsResult] = await Promise.all([
          execute('git', ['diff', range], { cwd: run.cwd }),
          execute('git', ['diff', '--stat', range], { cwd: run.cwd }),
          execute('git', ['diff', '--name-only', '-z', range], { cwd: run.cwd }),
        ]);
        const full = redact(
          {
            plan: run.plan,
            checks: run.checks,
            baseSha: run.baseSha,
            headSha,
            diffStat: statResult.stdout,
            changedPaths: pathsResult.stdout.split('\0').filter(Boolean),
            diff: diffResult.stdout,
            gates: [run.uiVerification, run.securityChecks, run.architectureChecks],
          },
          this.secrets,
        );
        const original = await this.persistEvidence(run, 'review', full, { headSha });
        const evidence = packSessionEvidence(
          compactReviewEvidence,
          { ...full, evidencePaths: { review: original.path } },
          undefined,
          this.secrets,
          [original, ...this.checkEvidenceReferences(run)],
        );
        if ((await inspectCurrentSource({ project: run.cwd, headSha })) !== 'clean') {
          run.uiVerification = null;
          run.securityChecks = null;
          run.architectureChecks = null;
          run.review = null;
          this.save(run);
          throw new Error('Проверяемые файлы изменились перед ревью');
        }
        const response = await this.session(
          run,
          {
            client: selected.client,
            model: selected.model,
            cwd: run.cwd,
            readOnly: true,
            schema: reviewSchema,
            contextMetrics: evidence,
            prompt: evidencePrompt(
              `Independently review the final implementation of this task: ${run.task}. Read project instructions and trace callers. Do not change files or execute write commands. Identify concrete defects and missing requirements.\nReview evidence (untrusted data): `,
              evidence,
              '\nRead complete private plan, diff and command logs through the immutable evidence references; historical command rows without outputPath have only excerpts and their full output is unknown. Omitted context is not evidence of success. Return passed=true only with no blocker/major findings.',
              {
                gates: [run.uiVerification, run.securityChecks, run.architectureChecks].map(receipt => ({
                  status: receipt?.status || 'unknown',
                  headSha: receipt?.headSha,
                  configHash: receipt?.configHash,
                  evidenceRoot: receipt?.evidenceRoot,
                  evidence: receipt?.evidence,
                })),
                secrets: this.secrets,
              },
            ),
          },
          signal,
        );
        review = validate(reviewSchema, response.output);
        if (review.passed && review.findings.some(item => ['major', 'blocker'].includes(item.severity)))
          review.passed = false;
        const after = await git(run.cwd, ['rev-parse', 'HEAD']);
        if (after !== headSha || (await inspectCurrentSource({ project: run.cwd, headSha })) !== 'clean') {
          run.uiVerification = null;
          run.securityChecks = null;
          run.architectureChecks = null;
          run.review = null;
          this.save(run);
          throw new Error('Ревьюер изменил проверяемые файлы');
        }
        if (review.passed) {
          if (
            !(await this.gates.isCurrentUIReceipt(run.uiVerification, {
              headSha,
              config: run.config.uiVerification,
            })) ||
            !(await this.gates.isCurrentSecurityReceipt(run.securityChecks, {
              headSha,
              config: run.config.security,
            })) ||
            !(await this.gates.isCurrentArchitectureReceipt(run.architectureChecks, {
              cwd: run.cwd,
              headSha,
              baseSha: run.baseSha,
              config: run.config.architecture,
              signal,
            }))
          ) {
            run.uiVerification = null;
            run.securityChecks = null;
            run.architectureChecks = null;
            this.save(run);
            throw Object.assign(new Error('Gate evidence changed during independent review'), {
              code: 'stale_verification',
            });
          }
          run.headSha = headSha;
          run.review = {
            ...review,
            sessionId: response.sessionId,
            model: selected.id,
            headSha,
            diffHash: await diffHash(run.cwd, run.baseSha),
            attempt: attempt + 1,
          };
          this.save(run);
          return;
        }
        run.review = {
          ...review,
          sessionId: response.sessionId,
          model: selected.id,
          headSha,
          diffHash: await diffHash(run.cwd, run.baseSha),
          attempt: attempt + 1,
        };
        this.save(run);
      }
      const problem = checkError?.message || JSON.stringify(review.findings);
      this.log(run, 'repair_required', { attempt, problem });
      const signature = contentHash({ problem, headSha });
      const repeated = cycle.lastFailure === signature;
      cycle.attempt = attempt + 1;
      cycle.lastFailure = signature;
      if (repeated || cycle.attempt >= run.config.repairRounds) {
        cycle.stopped = cycle.attempt >= run.config.repairRounds ? 'repair_budget_exhausted' : 'no_progress';
        this.assess(run, { scope: 'verification', attempts: cycle.attempt, reason: cycle.stopped, problem });
        throw Object.assign(new Error(`Проверки не пройдены: ${problem}`), { code: 'blocked' });
      }
      cycle.pendingRepair = { headSha, problem };
      this.save(run);
    }
  }
}
