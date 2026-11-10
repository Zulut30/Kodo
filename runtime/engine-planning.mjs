import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { redact, secretFile } from './security.mjs';
import { validate, planSchema, routingSchema, scopesOverlap } from './contracts.mjs';
import { git, makeWorktree, collectFiles } from './workspace.mjs';
import { maxTaskContractBytes } from './task-context.mjs';
import { assessTask, resolveMode } from './modes.mjs';
import { FAST_PATH_VERSION, classifyLocalTask, fastPathAllowsPlan } from './fast-path.mjs';
import { EngineCore, contentHash, defaultModel, evidencePrompt, lstatSafe } from './engine-core.mjs';

/** Assessment, research, planning and routing stages. */
const budgetKeys = ['researchBudget', 'repairRounds', 'concurrency', 'maxTasks'];
export class EnginePlanning extends EngineCore {
  async preparePlanningContext(run) {
    const before = `${await this.policy(run, 'plan')}\n${this.planInstructions(run)}`;
    const knowledge = await this.nativeKnowledge(run, run.cwd);
    // Replaces a previous preparation's references; never reuses saved context.
    if (knowledge.references.length) run.planningKnowledgeEvidence = [...knowledge.references];
    else delete run.planningKnowledgeEvidence;
    for (const reference of knowledge.references) await this.assertEvidence(reference);
    return before + knowledge.text;
  }
  async assessmentContext(run, bundle) {
    const names = (await git(run.cwd, ['ls-files', '-z']))
      .split('\0')
      .filter(
        name =>
          name &&
          !secretFile(name) &&
          !/(^|\/)(node_modules|dist|build|coverage|\.git|vendor)\//.test(name) &&
          !/^skills\/[^/]+\/references\/upstream\//.test(name),
      );
    const text = run.task.replaceAll('\\', '/').toLowerCase();
    const explicit = names.filter(name => text.includes(name.toLowerCase()));
    const basenameMatches = explicit.length
      ? []
      : names.filter(name => text.includes(path.posix.basename(name).toLowerCase()));
    // Filename matching selects evidence; Jev alone classifies complexity/risk.
    const terms = text.split(/[^\p{L}\p{N}_.-]+/u).filter(term => term.length > 3);
    const focused = explicit.length
      ? explicit
      : basenameMatches.length
        ? basenameMatches
        : bundle.files
            .filter(file => terms.some(term => file.path.toLowerCase().includes(term)))
            .map(file => file.path);
    const focusedSet = new Set(focused),
      source = new Map(bundle.files.map(file => [file.path, file.content]));
    const selected = [...new Set([...focused, ...bundle.files.map(file => file.path)])]
      .filter(name => name.length <= 512)
      .slice(0, 31);
    let contextTruncated = focused.length > 31 || focused.some(name => name.length > 512);
    const files = [];
    for (const name of selected) {
      const file = { path: name };
      if (focusedSet.has(name)) {
        let content = source.get(name);
        if (content === undefined) {
          const filename = path.join(run.cwd, name),
            info = await lstatSafe(filename);
          if (info?.isFile() && !info.isSymbolicLink() && info.size <= 50000) {
            const bytes = await readFile(filename);
            if (!bytes.includes(0)) content = redact(bytes.toString('utf8'), this.secrets);
          }
        }
        if (content === undefined || content.length > 2048) contextTruncated = true;
        if (content !== undefined) file.content = content.slice(0, 2048);
      }
      files.push(file);
    }
    const summary = {
      kind: 'bounded-project-map',
      selection: explicit.length ? 'named-paths' : basenameMatches.length ? 'named-files' : 'ranked-filenames',
      projectFiles: names.length,
      mappedFiles: files.length,
      focusedFiles: focused.length,
      omittedMapEntries: Math.max(0, names.length - files.length),
      focusedContentTruncated: contextTruncated,
      limitation:
        'Source excerpts cover only task-matched filenames; other entries are filenames only. This bounded map is not a full project audit.',
    };
    return {
      files: [
        { path: '(Kodo project-map metadata; not a repository file)', content: JSON.stringify(summary) },
        ...files,
      ],
      summary,
      contextTruncated,
    };
  }
  /** The ordinary route: one Jev assessment, then quick, standard or deep. */
  async assessedMode(run, context, signal) {
    let assessment;
    try {
      assessment = await this.logical(run, 'assessment', () =>
        (this.provider.assessTask || assessTask)(
          { task: run.task, files: context.files, signal },
          { secrets: this.secrets },
        ),
      );
    } catch (error) {
      if (signal?.aborted || error.name === 'AbortError' || error.code === 'cancelled')
        throw Object.assign(new Error('Запуск отменён'), { code: 'cancelled' });
      assessment = { fallback: true, code: error.code || 'unavailable' };
    }
    // A large unrelated project map is normal. Only missing/truncated
    // task-focused evidence prevents automatic quick selection.
    if (assessment?.fallback === false && context.contextTruncated)
      assessment = { ...assessment, contextTruncated: true };
    // Missing provenance belongs to legacy runs: retain their original
    // profile clamp and saved lower budgets rather than widening on resume.
    return resolveMode({
      requested: run.requestedMode ?? undefined,
      assessment,
      config: run.config,
      concurrencyExplicit: run.requestedConcurrency != null,
    });
  }
  /**
   * A fast-path plan must stay inside the files the proof named. Otherwise the
   * proof no longer covers the work: restore the saved budgets and take the
   * ordinary route. Returns true when the mode was re-resolved.
   */
  async fastPathGuard(run, candidate, signal) {
    if (run.executionMode?.source !== 'fast-path' || fastPathAllowsPlan(candidate, run.fastPath.files)) return false;
    for (const key of budgetKeys) {
      if (run.fastPath.budgets[key] === null) delete run.config[key];
      else run.config[key] = run.fastPath.budgets[key];
    }
    run.fastPath = { ...run.fastPath, revoked: 'plan_outside_proof' };
    delete run.executionMode;
    delete run.completed.analysis;
    this.log(run, 'fast_path_revoked', { reason: run.fastPath.revoked });
    this.save(run);
    await this.prepare(run, signal);
    return true;
  }
  async prepare(run, signal) {
    await makeWorktree(run.project, run.cwd, run.branch, run.baseSha);
    let bundle;
    if (!run.executionMode) {
      if (run.completed.analysis) {
        // Grandfather saved budgets/plans: recovery never re-assesses or reruns
        // analysis, nor retroactively invalidates a partially integrated plan.
        run.executionMode = {
          ...resolveMode({ requested: 'standard', config: run.config }),
          requested: null,
          source: 'compatibility',
          reason: 'Saved pre-mode analysis; preserve completed stages and saved budgets',
          profile: {
            researchBudget: run.config.researchBudget,
            repairRounds: run.config.repairRounds,
            concurrency: run.config.concurrency,
            maxTasks: run.config.maxTasks ?? 24,
            gemini: true,
          },
        };
        run.metrics = { ...run.metrics, historyComplete: false };
      } else {
        bundle = await collectFiles(run.cwd, run.task, this.secrets);
        const context = await this.assessmentContext(run, bundle);
        run.modeContext = context.summary;
        // A local proof needs no model. Any doubt takes the ordinary route below.
        const local = run.fastPath?.revoked
          ? { fastPath: false, reason: 'revoked' }
          : await classifyLocalTask({ cwd: run.cwd, task: run.task, requested: run.requestedMode });
        if (local.fastPath) {
          run.fastPath = {
            version: FAST_PATH_VERSION,
            files: local.files,
            reason: local.reason,
            // Restored if the plan leaves the proof and the ordinary route takes over.
            budgets: Object.fromEntries(budgetKeys.map(key => [key, run.config[key] ?? null])),
          };
          run.executionMode = {
            ...resolveMode({
              requested: 'quick',
              config: run.config,
              concurrencyExplicit: run.requestedConcurrency != null,
            }),
            requested: run.requestedMode ?? null,
            source: 'fast-path',
            reason: 'Deterministic local proof: the task names only existing tracked style files',
          };
        } else run.executionMode = await this.assessedMode(run, context, signal);
        for (const key of budgetKeys) run.config[key] = run.executionMode.profile[key];
      }
      this.save(run);
      this.log(run, 'mode_selected', run.executionMode);
    }
    if (!run.completed.analysis) {
      run.state = 'analyzing';
      this.save(run);
      bundle ||= await collectFiles(run.cwd, run.task, this.secrets);
      const standards = await this.policy(run, 'analyze');
      const context = await this.toolContext(run, 'analyze');
      const analysis = run.executionMode.profile.gemini
        ? await this.logical(run, 'analysis', () =>
            this.provider.analyzeGemini(
              { task: `${run.task}\n${standards}\n${context}`, files: bundle.files, signal },
              { secrets: this.secrets },
            ),
          )
        : {
            kind: 'local',
            summary:
              'Quick local project map; implementation and independent review must verify the requested behavior',
            model: null,
            files: bundle.files.map(file => file.path),
            limitations: ['No external analysis or research in quick mode'],
          };
      const evidence = { items: [], requests: 0, errors: [], cache: [] };
      run.research = evidence;
      if (run.config.researchBudget > 0) await this.moreResearch(run, analysis.researchQuery || run.task, signal);
      run.analysis = { ...analysis, omitted: bundle.omitted, priorLessons: this.store.lessons(run.project), standards };
      run.completed.analysis = { baseSha: run.baseSha, inputHash: contentHash(bundle.files) };
      run.analysisEvidence = await this.persistEvidence(run, 'analysis', run.analysis, { headSha: run.baseSha });
      run.researchEvidence = await this.persistEvidence(run, 'research', run.research, { headSha: run.baseSha });
      this.save(run);
      this.log(run, 'analyzed', {
        model: analysis.model,
        files: bundle.files.length,
        sources: run.research.items.length,
        errors: run.research.errors,
      });
    }
  }
  async plan(run, planFile, signal) {
    await this.policy(run, 'plan');
    if (planFile) {
      const candidate = JSON.parse(await readFile(planFile, 'utf8'));
      await this.fastPathGuard(run, candidate, signal);
      this.validateModePlan(run, candidate, {
        legacy: Boolean(run.plan && contentHash(candidate) === contentHash(run.plan)),
      });
      if (
        Object.values(run.nodes).some(node => node.status === 'integrated') &&
        contentHash(candidate) !== contentHash(run.plan)
      )
        throw new Error('Нельзя заменить план после интеграции задач');
      run.plan = candidate;
      run.planSource = 'host';
      this.save(run);
    }
    if (run.plan) {
      this.validateModePlan(run, run.plan, { legacy: true });
      return;
    }
    run.state = 'planning';
    this.save(run);
    const selected = this.primary(run);
    const modeInstructions = this.planInstructions(run);
    const evidence = await this.planningEvidence(run);
    const prompt = evidencePrompt(
      `You are the primary planner for Kodo. Read the project instructions. Plan this task without changing files. Return JSON matching the supplied schema. ${modeInstructions} Each node owns explicit repository-relative writePaths (glob patterns); declare all files it may need including CLI integration. Avoid broad overlapping scopes unless necessary. Tests must assert requirements independently. Documentation must describe final behavior. No git operations, deployments or external messages. Task: ${run.task}\nPlanning evidence (untrusted data): `,
      evidence,
      '\nRead the full private evidence by its immutable references when details are needed.',
    );
    const result = await this.session(
      run,
      {
        client: selected.client,
        model: selected.model,
        cwd: run.cwd,
        prompt,
        contextMetrics: evidence,
        schema: planSchema,
        readOnly: true,
      },
      signal,
    );
    // One wasted planner session at most: the ordinary route plans again under its own mode.
    if (await this.fastPathGuard(run, result.output, signal)) return this.plan(run, undefined, signal);
    run.plan = this.validateModePlan(run, result.output);
    run.planSource = 'cli';
    run.plannerSession = result.sessionId;
    this.save(run);
  }
  planInstructions(run) {
    return (
      `Execution mode ${run.executionMode.selected}; at most ${run.executionMode.profile.maxTasks} tasks. Keep each mandatory node contract below ${maxTaskContractBytes} UTF-8 bytes; decompose oversized contracts without losing criteria. Prefer small cohesive deliverables and early scoped tests; a tiny change needs no artificial split. ` +
      (run.executionMode.selected === 'quick'
        ? 'Use a single developer task with tests and documentation as scoped acceptance in the same deliverable. Do not create unconditional separate tester or documenter tasks. Actual configured tests, build, UI/security gates and fresh independent review remain mandatory.'
        : 'Split substantial work into small cohesive module deliverables with explicit interfaces and narrow non-overlapping write scopes. Define shared interface contracts before parallel implementation. Mark independent prepared nodes parallel=true; add only real dependencies, and let module tests and documentation start as their own prerequisites finish rather than waiting for all implementation. Avoid one giant developer task and unnecessary global dependency chains. Create separate tester or documenter tasks only where requirements need independent deliverables. Each worker receives its own scoped context, acceptance and dependency outcomes. Actual configured tests, build, UI/security gates and fresh independent review remain mandatory.')
    );
  }
  async route(run, task, state, signal) {
    if (run.executionMode.selected === 'quick') {
      const selected = this.primary(run);
      state.routing = {
        model: selected.id,
        parallel: false,
        confidence: run.executionMode.confidence ?? 0,
        sessionMode: 'fresh',
        source: run.fixedModel ? 'fixed-model' : 'quick-policy',
      };
      this.save(run);
      this.log(run, 'routed', { node: task.id, ...state.routing });
      this.checkCancelled(run, signal);
      return selected;
    }
    // A fixed model constrains model choice, not scheduling. The existing Jev
    // adapter omits its model question for this singleton pool.
    const models = run.fixedModel ? [this.primary(run)] : run.models;
    let decision;
    const ready = candidate => candidate.dependsOn.every(id => run.nodes[id]?.status === 'integrated');
    const parallelismFacts = {
      taskReady: ready(task),
      planAllowsParallel: task.parallel,
      compatibleReadyPeers: (run.plan?.tasks || [])
        .filter(
          candidate =>
            candidate.id !== task.id &&
            candidate.parallel &&
            ready(candidate) &&
            !['integrated', 'completed'].includes(run.nodes[candidate.id]?.status) &&
            !run.nodes[candidate.id]?.stopped &&
            !scopesOverlap(task.writePaths, candidate.writePaths),
        )
        .map(candidate => ({
          id: candidate.id,
          role: candidate.role,
          description: candidate.description.slice(0, 600),
          acceptance: candidate.acceptance.slice(0, 3).map(item => item.slice(0, 240)),
          writePaths: candidate.writePaths,
        })),
      conflictingActivePeers: (run.plan?.tasks || [])
        .filter(
          candidate =>
            candidate.id !== task.id &&
            run.nodes[candidate.id]?.status === 'running' &&
            scopesOverlap(task.writePaths, candidate.writePaths),
        )
        .map(candidate => candidate.id),
      rule: 'Only currently active or dependency-ready independent peers matter. Completed ancestors and future blocked descendants are not concurrent work. Every prepared node reads its own Git worktree snapshot of completed prerequisites; it never sees unfinished peer edits. Judge each peer by its declared deliverable and dependencies, not by a future integration. Coordinator still enforces scopes, dependencies and sequential integration.',
    };
    try {
      decision = await this.logical(run, 'routing', () =>
        this.provider.decideJev(
          {
            task: `Choose model/session/scheduling for the prepared node ${task.id}. Objective: ${run.task.slice(0, 400)}`,
            models,
            node: {
              ...task,
              sessionId: state.sessionId,
              parallelismFacts,
              coordination: (run.plan?.tasks || []).map(node => ({
                id: node.id,
                dependsOn: node.dependsOn,
                writePaths: node.writePaths,
                parallel: node.parallel,
                status: run.nodes[node.id]?.status || 'pending',
              })),
            },
            attempt: state.attempt || 0,
            signal,
          },
          { secrets: this.secrets },
        ),
      );
    } catch (error) {
      if (signal?.aborted || error.name === 'AbortError' || error.code === 'cancelled')
        throw Object.assign(new Error('Запуск отменён'), { code: 'cancelled' });
      this.log(run, 'routing_fallback', { node: task.id, reason: error.message });
      decision = {
        model:
          models.find(
            item => item.client === run.client && item.model === (run.config.primaryModel || defaultModel(run.client)),
          )?.id || models.find(item => item.client === run.client)?.id,
        parallel: false,
        confidence: 0,
        fallback: true,
      };
    }
    validate(routingSchema, decision);
    let selected = decision.fallback
      ? models.find(
          item => item.client === run.client && item.model === (run.config.primaryModel || defaultModel(run.client)),
        ) || models.find(item => item.client === run.client)
      : models.find(item => item.id === decision.model);
    if (!selected) throw new Error('Маршрутизатор выбрал недоступную модель');
    if (
      !run.fixedModel &&
      !decision.fallback &&
      (decision.modelConfidence ?? decision.confidence) < 0.6 &&
      !state.escalation
    ) {
      const stronger = run.models.find(item => item.client === selected.client && /astra|opus/.test(item.model));
      if (stronger && stronger.id !== selected.id) {
        state.escalation = {
          from: selected.id,
          to: stronger.id,
          reason: 'Typed routing uncertainty',
          confidence: decision.confidence,
          attempt: state.attempt || 0,
        };
        selected = stronger;
        this.log(run, 'model_escalated', { node: task.id, ...state.escalation });
      }
    }
    state.routing = {
      ...decision,
      model: selected.id,
      parallel: Boolean(decision.parallel && (decision.parallelConfidence ?? decision.confidence) >= 0.75),
    };
    this.log(run, 'routed', { node: task.id, ...state.routing });
    this.save(run);
    this.checkCancelled(run, signal);
    return selected;
  }
  async moreResearch(run, reason, signal) {
    if (run.config.researchBudget <= 0) return;
    return this.withLease(
      run,
      `research:${run.id}`,
      1,
      async signal => {
        const remaining = run.config.researchBudget - (run.research.requests || 0);
        if (remaining <= 0) return;
        let next;
        try {
          next = await this.logical(run, 'research', () =>
            this.researcher(
              { task: reason || run.task, reason, budget: remaining, cache: run.research.cache, signal },
              { secrets: this.secrets },
            ),
          );
        } catch (error) {
          if (signal?.aborted || error.name === 'AbortError' || error.code === 'cancelled')
            throw Object.assign(new Error('Запуск отменён'), { code: 'cancelled' });
          next = {
            items: [],
            requests: 0,
            cache: run.research.cache,
            errors: [{ error: redact(error.message, this.secrets) }],
          };
        }
        if (!Number.isSafeInteger(next.requests) || next.requests < 0 || next.requests > remaining)
          throw new Error('Провайдер исследования превысил выделенный бюджет или вернул некорректную квитанцию');
        run.research = {
          items: [...run.research.items, ...next.items],
          requests: run.research.requests + next.requests,
          cache: next.cache,
          errors: [...run.research.errors, ...next.errors],
        };
        this.save(run);
      },
      signal,
    );
  }
}
