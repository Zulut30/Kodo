import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { redact, secretFile } from './security.mjs';
import { validate, resultSchema, ownsPath, scopesOverlap } from './contracts.mjs';
import { execute } from './command.mjs';
import { git, makeWorktree, changedFiles, commitChanges } from './workspace.mjs';
import { taskContract } from './task-context.mjs';
import { runReadyQueue } from './task-scheduler.mjs';
import { executeDurableTasks } from './engine-jobs.mjs';
import { EnginePlanning } from './engine-planning.mjs';
import { contentHash, evidencePrompt, lstatSafe } from './engine-core.mjs';

/** Node execution, integration and base synchronization stages. */
export class EngineExecution extends EnginePlanning {
  async checkScope(cwd, baseSha, scopes) {
    const tracked = await changedFiles(cwd, baseSha);
    const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']))
      .split('\0')
      .filter(Boolean);
    const files = [...new Set([...tracked, ...untracked])];
    const outside = files.filter(name => !ownsPath(scopes, name) || secretFile(name));
    if (outside.length)
      throw Object.assign(new Error(`Изменены файлы вне области задачи: ${outside.join(', ')}`), {
        code: 'scope_conflict',
      });
    for (const name of files) {
      const stat = await lstatSafe(path.join(cwd, name));
      if (stat?.isSymbolicLink()) throw new Error(`Ссылка в изменениях не разрешена: ${name}`);
      if (stat?.isFile() && stat.size < 2000000) {
        const data = await readFile(path.join(cwd, name), 'utf8');
        if (
          Object.values(this.secrets).some(
            secret => typeof secret === 'string' && secret.length > 5 && data.includes(secret),
          )
        )
          throw new Error(`Секрет обнаружен в изменениях: ${name}`);
      }
    }
    return files;
  }
  async failureFingerprint(cwd) {
    const diff = await execute('git', ['diff', '--binary', 'HEAD'], { cwd, rawOutput: true });
    const names = (await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']))
      .split('\0')
      .filter(Boolean)
      .sort();
    const untracked = [];
    let remaining = 8 * 1024 * 1024;
    for (const name of names.slice(0, 256)) {
      if (secretFile(name)) continue;
      const file = path.join(cwd, name),
        info = await lstatSafe(file);
      if (!info) {
        untracked.push({ name, missing: true });
        continue;
      }
      const row = { name, size: info.size, regular: info.isFile() && !info.isSymbolicLink() };
      // Bound fingerprint I/O and never follow links or retain source. When
      // bytes are known, rewriting identical content is still no progress.
      if (row.regular && info.size <= Math.min(2 * 1024 * 1024, remaining)) {
        row.hash = createHash('sha256')
          .update(await readFile(file))
          .digest('hex');
        remaining -= info.size;
      } else row.modified = info.mtimeMs;
      untracked.push(row);
    }
    return {
      head: await git(cwd, ['rev-parse', 'HEAD']),
      tracked: createHash('sha256').update(diff.stdout).digest('hex'),
      untracked,
      untrackedCount: names.length,
    };
  }
  async refreshNode(run, task, node, integratedHead, selected, signal) {
    while (node.baseSha !== integratedHead || node.pendingRefresh) {
      this.checkCancelled(run, signal);
      const target = node.pendingRefresh?.headSha || integratedHead;
      const pending = await execute('git', ['rev-parse', '--verify', 'MERGE_HEAD'], {
        cwd: node.cwd,
        allowFailure: true,
      });
      if (pending.code === 0 && pending.stdout.trim() !== target)
        throw Object.assign(new Error('Незавершённое обновление принадлежит другой ветке'), { code: 'merge_state' });
      const included = await execute('git', ['merge-base', '--is-ancestor', target, 'HEAD'], {
        cwd: node.cwd,
        allowFailure: true,
      });
      if (pending.code !== 0 && included.code === 0) {
        await this.checkScope(node.cwd, target, task.writePaths);
        node.baseSha = target;
        delete node.pendingRefresh;
        this.save(run);
        continue;
      }
      let merged = { code: 1 };
      if (pending.code !== 0) {
        await this.checkScope(node.cwd, node.baseSha, task.writePaths);
        await commitChanges(node.cwd, `Kodo preserve ${task.id} before base refresh`);
        node.pendingRefresh = { headSha: target, model: selected.id };
        this.save(run);
        merged = await execute('git', ['merge', '--no-edit', target], { cwd: node.cwd, allowFailure: true });
      } else if (!node.pendingRefresh) {
        node.pendingRefresh = { headSha: target, model: selected.id };
        this.save(run);
      }
      if (merged.code) {
        if (
          (await execute('git', ['rev-parse', '--verify', 'MERGE_HEAD'], { cwd: node.cwd, allowFailure: true }))
            .code !== 0
        )
          throw new Error(`Не удалось обновить задачу: ${merged.stderr}`);
        const conflicts = (await git(node.cwd, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
        if (conflicts.some(file => !ownsPath(task.writePaths, file)))
          throw Object.assign(new Error(`Конфликт обновления вне области задачи: ${conflicts.join(', ')}`), {
            code: 'scope_conflict',
          });
        if (conflicts.length) {
          const state = node.pendingRefresh;
          if (state.model !== selected.id) {
            state.model = selected.id;
            delete state.sessionId;
            this.save(run);
          }
          const result = await this.session(
            run,
            {
              client: selected.client,
              model: selected.model,
              cwd: node.cwd,
              sessionId: state.sessionId,
              schema: resultSchema,
              prompt: `Resolve conflicts ${JSON.stringify(conflicts)} preserving both the assigned task work and current integrated upstream. Edit only ${JSON.stringify(task.writePaths)}. Do not commit, push, abort or change branches. Return completion JSON.`,
            },
            signal,
            undefined,
            state,
          );
          if (!result.output.complete) throw new Error('Конфликт обновления задачи не разрешён');
          state.sessionId = result.sessionId;
          this.save(run);
        }
        await this.checkScope(node.cwd, target, task.writePaths);
        await git(node.cwd, ['add', '-A']);
        await execute(
          'git',
          [
            '-c',
            'core.whitespace=cr-at-eol,-blank-at-eol,-blank-at-eof,-space-before-tab',
            'diff',
            '--cached',
            '--check',
          ],
          { cwd: node.cwd },
        );
        await commitChanges(node.cwd, `Kodo refresh ${task.id}`);
      }
      await this.checkScope(node.cwd, target, task.writePaths);
      node.baseSha = target;
      delete node.pendingRefresh;
      this.save(run);
    }
  }
  async performNode(run, task, signal) {
    const node = (run.nodes[task.id] ||= { id: task.id, attempt: 0, status: 'pending' });
    if (['completed', 'integrated'].includes(node.status)) return;
    if (node.stopped || node.attempt >= run.config.repairRounds) {
      if (!node.stopped) {
        node.stopped = 'repair_budget_exhausted';
        this.assess(run, {
          scope: task.id,
          attempts: node.attempt,
          reason: node.stopped,
          problem: node.error || 'Требуется устранить блокер',
        });
      }
      throw Object.assign(new Error(`Исчерпаны попытки ${task.id}: ${node.error || 'требуется устранить блокер'}`), {
        code: 'blocked',
      });
    }
    while (node.attempt < run.config.repairRounds) {
      this.checkCancelled(run, signal);
      const selected = node.routing
        ? run.models.find(model => model.id === node.routing.model)
        : await this.route(run, task, node, signal);
      if (!selected) throw new Error('Сохранённая модель задачи больше недоступна');
      if (!node.cwd) {
        node.baseSha = await git(run.cwd, ['rev-parse', 'HEAD']);
        node.cwd = path.join(run.worktreeRoot || path.dirname(run.cwd), task.id);
        node.branch = `kodo/${run.id}-${task.id}`;
      }
      await makeWorktree(run.project, node.cwd, node.branch, node.baseSha);
      const integratedHead = await git(run.cwd, ['rev-parse', 'HEAD']);
      await this.refreshNode(run, task, node, integratedHead, selected, signal);
      await this.setup(node.cwd, run, signal);
      node.attempt++;
      node.status = 'running';
      this.save(run);
      try {
        const { contract, evidence } = await this.withEvidenceBatch(run, async persist => {
          const contract = await persist(
            'node-contract',
            { task: taskContract(task, this.secrets), previousError: node.error || null },
            { headSha: node.baseSha },
          );
          const evidence = await this.planningEvidence(run, { maxBytes: 4000 }, persist);
          evidence.references.push(contract);
          return { contract, evidence };
        });
        const prompt = evidencePrompt(
          `Complete this ${task.role} task in the current isolated Kodo worktree. Follow project instructions. Do not ask permission for the requested work. Do not commit, push, change branches, publish, deploy, or start other agents; the coordinator owns those actions. You may edit ONLY the repository-relative write scope in the mandatory node contract below. Preserve all existing code and other work. Tests must verify public requirements, not mirror implementation. Do not weaken tests to pass. Never write secrets. Return the structured completion report.\n`,
          evidence,
          `\nPrevious error (brief; full value in node contract): ${redact(String(node.error || 'none'), this.secrets).slice(0, 1200)}`,
          { nodeContext: { run, task, contractPath: contract.path }, secrets: this.secrets },
        );
        const resumeSession =
          node.model === selected.id && (node.resumeRequired || node.routing.sessionMode === 'continue')
            ? node.sessionId
            : undefined;
        node.model = selected.id;
        if (!resumeSession) delete node.sessionId;
        this.save(run);
        const result = await this.session(
          run,
          {
            client: selected.client,
            model: selected.model,
            cwd: node.cwd,
            prompt,
            contextMetrics: evidence,
            schema: resultSchema,
            sessionId: resumeSession,
          },
          signal,
          node,
        );
        node.model = selected.id;
        node.sessionId = result.sessionId;
        node.result = validate(resultSchema, result.output);
        if (!node.result.complete) throw new Error(`Исполнитель не завершил задачу: ${node.result.summary}`);
        node.changedFiles = await this.checkScope(node.cwd, node.baseSha, task.writePaths);
        node.headSha = await commitChanges(node.cwd, `Kodo ${task.id}: ${run.task.slice(0, 100)}`);
        node.status = 'completed';
        delete node.error;
        delete node.resumeRequired;
        this.save(run);
        return;
      } catch (error) {
        if (
          signal?.aborted ||
          this.store.getRun(run.id).cancelRequested ||
          ['quota', 'auth', 'cancelled', 'lease_lost', 'unavailable', 'evidence_integrity'].includes(error.code)
        ) {
          node.attempt--;
          node.resumeRequired = true;
          node.status = error.code === 'quota' ? 'waiting_limits' : 'pending';
          this.save(run);
          if (signal?.aborted || this.store.getRun(run.id).cancelRequested)
            throw Object.assign(new Error('Запуск отменён'), { code: 'cancelled' });
          throw error;
        }
        const signature = contentHash({ error: error.message, workspace: await this.failureFingerprint(node.cwd) });
        node.error = redact(error.message, this.secrets);
        node.status = 'retrying';
        this.log(run, 'node_failed', { node: task.id, attempt: node.attempt, error: node.error });
        const repeated = node.lastFailure === signature;
        node.lastFailure = signature;
        this.save(run);
        if (repeated || node.attempt >= run.config.repairRounds) {
          node.stopped = node.attempt >= run.config.repairRounds ? 'repair_budget_exhausted' : 'no_progress';
          node.status = 'blocked';
          this.assess(run, { scope: task.id, attempts: node.attempt, reason: node.stopped, problem: node.error });
          throw Object.assign(new Error(`Нет прогресса в ${task.id}: ${node.error}`), { code: 'blocked' });
        }
        await this.moreResearch(run, node.error, signal);
        delete node.routing;
        this.save(run);
        return;
      }
    }
  }
  async integrateNode(run, task, signal) {
    const node = run.nodes[task.id];
    if (node.status === 'integrated') return;
    run.architectureChecks = null;
    this.save(run);
    const mergeState = await execute('git', ['rev-parse', '--verify', 'MERGE_HEAD'], {
      cwd: run.cwd,
      allowFailure: true,
    });
    const mergeInProgress = mergeState.code === 0;
    if (mergeInProgress && mergeState.stdout.trim() !== node.headSha)
      throw Object.assign(new Error('Незавершённый merge принадлежит другой задаче'), { code: 'merge_state' });
    const included = await execute('git', ['merge-base', '--is-ancestor', node.headSha, 'HEAD'], {
      cwd: run.cwd,
      allowFailure: true,
    });
    if (included.code !== 0 || mergeInProgress) {
      const beforeMerge = await git(run.cwd, ['rev-parse', 'HEAD']);
      run.pendingMerge = { kind: 'node', sha: node.headSha, nodeId: task.id };
      this.save(run);
      const merged = mergeInProgress
        ? { code: 1 }
        : await execute('git', ['merge', '--no-ff', '--no-edit', node.branch], { cwd: run.cwd, allowFailure: true });
      if (merged.code) {
        const conflicts = (await git(run.cwd, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
        const pending =
          (await execute('git', ['rev-parse', '--verify', 'MERGE_HEAD'], { cwd: run.cwd, allowFailure: true })).code ===
          0;
        if (!pending) throw new Error(`Не удалось интегрировать ${task.id}: ${merged.stderr}`);
        if (conflicts.length) {
          const selected = this.primary(run);
          const response = await this.session(
            run,
            {
              client: selected.client,
              model: selected.model,
              cwd: run.cwd,
              prompt: `Resolve these Git merge conflicts preserving BOTH tasks: ${JSON.stringify(conflicts)}. Task ${run.task}. Do not commit, abort, push, or discard either implementation. The coordinator will stage resolved files. Return completion JSON.`,
              schema: resultSchema,
            },
            signal,
          );
          if (!response.output.complete) throw new Error('Конфликт интеграции не разрешён');
        }
        await this.checkScope(
          run.cwd,
          beforeMerge,
          run.plan.tasks.flatMap(item => item.writePaths),
        );
        await git(run.cwd, ['add', '-A']);
        await execute(
          'git',
          [
            '-c',
            'core.whitespace=cr-at-eol,-blank-at-eol,-blank-at-eof,-space-before-tab',
            'diff',
            '--cached',
            '--check',
          ],
          { cwd: run.cwd },
        );
        await commitChanges(run.cwd, `Kodo integrate ${task.id}`);
      }
    }
    node.status = 'integrated';
    run.pendingMerge = null;
    run.headSha = await git(run.cwd, ['rev-parse', 'HEAD']);
    this.save(run);
    this.log(run, 'integrated', { node: task.id, headSha: run.headSha });
  }
  async executeTasks(run, signal) {
    run.state = 'implementing';
    this.save(run);
    await this.recoverIntegrationEdits(run, signal);
    // A failed merge command can leave an owner receipt even without MERGE_HEAD.
    // Recover that exact completed node before scheduling another integration.
    if (run.pendingMerge?.kind === 'node') {
      const task = run.plan.tasks.find(
        task => task.id === run.pendingMerge.nodeId && run.nodes[task.id]?.headSha === run.pendingMerge.sha,
      );
      if (!task || run.nodes[task.id].status !== 'completed')
        throw Object.assign(new Error('Неизвестный владелец незавершённой интеграции'), { code: 'merge_state' });
      this.checkCancelled(run, signal);
      await this.integrateNode(run, task, signal);
    }
    this.checkCancelled(run, signal);
    if (run.config.delivery.enabled) await this.synchronizeBase(run, signal);
    this.checkCancelled(run, signal);
    if (run.pendingMerge)
      throw Object.assign(new Error('Не восстановлена незавершённая интеграция'), { code: 'merge_state' });
    if (run.config.scheduler === 'durable') return executeDurableTasks(this, run, signal);
    await runReadyQueue({
      tasks: run.plan.tasks,
      limit: run.config.concurrency,
      signal,
      isIntegrated: task => run.nodes[task.id]?.status === 'integrated',
      prepare: async task => {
        this.checkCancelled(run, signal);
        const state = (run.nodes[task.id] ||= { id: task.id, attempt: 0, status: 'pending' });
        if (state.status !== 'completed' && !state.routing) await this.route(run, task, state, signal);
        this.checkCancelled(run, signal);
      },
      compatible: (task, active) =>
        !active.length ||
        Boolean(
          task.parallel &&
          run.nodes[task.id].routing?.parallel &&
          active.every(
            other =>
              other.parallel &&
              run.nodes[other.id].routing?.parallel &&
              !scopesOverlap(task.writePaths, other.writePaths),
          ),
        ),
      execute: async task => {
        this.checkCancelled(run, signal);
        if (run.nodes[task.id].status !== 'completed') await this.performNode(run, task, signal);
      },
      integrate: async task => {
        this.checkCancelled(run, signal);
        if (run.nodes[task.id].status === 'completed') await this.integrateNode(run, task, signal);
        this.checkCancelled(run, signal);
      },
    });
  }
  async synchronizeBase(run, signal) {
    await git(run.cwd, ['fetch', 'origin', run.config.baseBranch]);
    const remoteBase = await git(run.cwd, ['rev-parse', `origin/${run.config.baseBranch}`]);
    const pending = await execute('git', ['rev-parse', '--verify', 'MERGE_HEAD'], { cwd: run.cwd, allowFailure: true });
    if (pending.code === 0) {
      const sha = pending.stdout.trim();
      const task = run.plan.tasks.find(
        item => run.nodes[item.id]?.headSha === sha && run.nodes[item.id]?.status !== 'integrated',
      );
      if (task) {
        await this.integrateNode(run, task, signal);
        return this.synchronizeBase(run, signal);
      }
      if (
        run.pendingMerge?.kind === 'node' ||
        (sha !== remoteBase && sha !== (run.pendingMerge?.sha || run.pendingMerge?.baseSha))
      )
        throw Object.assign(new Error('Незавершённый merge не соответствует целевой ветке'), { code: 'merge_state' });
    }
    const base = pending.code === 0 ? pending.stdout.trim() : remoteBase;
    if (base === run.baseSha && pending.code !== 0) return;
    run.architectureChecks = null;
    run.pendingMerge = { kind: 'base', sha: base, baseSha: base };
    this.save(run);
    const merged =
      pending.code === 0
        ? { code: 1 }
        : await execute('git', ['merge', '--no-edit', `origin/${run.config.baseBranch}`], {
            cwd: run.cwd,
            allowFailure: true,
          });
    if (merged.code) {
      const conflicts = (await git(run.cwd, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
      if (
        (await execute('git', ['rev-parse', '--verify', 'MERGE_HEAD'], { cwd: run.cwd, allowFailure: true })).code !== 0
      )
        throw new Error(`Не удалось обновить целевую ветку: ${merged.stderr}`);
      if (conflicts.length) {
        const selected = this.primary(run);
        const result = await this.session(
          run,
          {
            client: selected.client,
            model: selected.model,
            cwd: run.cwd,
            schema: resultSchema,
            prompt: `Resolve target branch merge conflicts preserving BOTH the task implementation and incoming upstream changes. Conflicting paths: ${JSON.stringify(conflicts)}. Task: ${run.task}. Do not commit, push, abort the merge, or discard either side. Return structured completion JSON.`,
          },
          signal,
        );
        if (!result.output.complete) throw new Error('Конфликт целевой ветки не разрешён');
      }
      await this.checkScope(run.cwd, base, [...run.plan.tasks.flatMap(task => task.writePaths), ...conflicts]);
      await git(run.cwd, ['add', '-A']);
      await execute(
        'git',
        [
          '-c',
          'core.whitespace=cr-at-eol,-blank-at-eol,-blank-at-eof,-space-before-tab',
          'diff',
          '--cached',
          '--check',
        ],
        { cwd: run.cwd },
      );
      await commitChanges(run.cwd, 'Kodo reconcile target branch');
    }
    run.baseSha = base;
    run.pendingMerge = null;
    this.save(run);
    if (remoteBase !== base) await this.synchronizeBase(run, signal);
  }
  async recoverIntegrationEdits(run, signal) {
    this.checkCancelled(run, signal);
    if (
      (await execute('git', ['rev-parse', '--verify', 'MERGE_HEAD'], { cwd: run.cwd, allowFailure: true })).code === 0
    ) {
      if (run.config.delivery.enabled) await this.synchronizeBase(run, signal);
      else {
        const sha = await git(run.cwd, ['rev-parse', 'MERGE_HEAD']);
        const task = run.plan.tasks.find(item => run.nodes[item.id]?.headSha === sha);
        if (!task) throw Object.assign(new Error('Неизвестный незавершённый merge'), { code: 'merge_state' });
        await this.integrateNode(run, task, signal);
      }
    }
    if (await git(run.cwd, ['status', '--porcelain'])) {
      const scopes = run.plan.tasks.flatMap(task => task.writePaths);
      if (run.config.delivery.release && run.releaseAssignment?.version) {
        const changed = await changedFiles(run.cwd, 'HEAD');
        for (const name of ['package.json', 'package-lock.json', 'registry.json'].filter(
          file => changed.includes(file) && !ownsPath(scopes, file),
        )) {
          const baseline = await execute('git', ['show', `HEAD:${name}`], { cwd: run.cwd, rawOutput: true });
          const before = JSON.parse(baseline.stdout),
            after = JSON.parse(await readFile(path.join(run.cwd, name), 'utf8'));
          if (after.version !== run.releaseAssignment.version)
            throw Object.assign(new Error(`Неожиданная версия при восстановлении: ${name}`), {
              code: 'scope_conflict',
            });
          after.version = before.version;
          if (name === 'package-lock.json' && after.packages?.[''] && before.packages?.['']) {
            if (after.packages[''].version !== run.releaseAssignment.version)
              throw Object.assign(new Error('Неожиданная версия корневого пакета lock'), { code: 'scope_conflict' });
            after.packages[''].version = before.packages[''].version;
          }
          if (!isDeepStrictEqual(before, after))
            throw Object.assign(new Error(`Изменения metadata выходят за назначение версии: ${name}`), {
              code: 'scope_conflict',
            });
          scopes.push(name);
        }
      }
      await this.checkScope(run.cwd, 'HEAD', scopes);
      run.headSha = await commitChanges(run.cwd, 'Kodo recover scoped interrupted repair');
      run.checks = null;
      run.review = null;
      run.uiVerification = null;
      run.securityChecks = null;
      run.architectureChecks = null;
      this.save(run);
      this.log(run, 'repair_recovered', { headSha: run.headSha });
    }
  }
}
