import {
  settled,
  stages,
  storedRun,
  evidenceFor,
  verifyRef,
  observation,
  validateRun,
} from './project-director-proofs.mjs';
import { command, ports } from './project-director-scheduling.mjs';

export function containerResult(ctx, { snapshot, blockers }) {
  return {
    status: settled(snapshot.project.status) ? 'succeeded' : 'blocked',
    projectStatus: snapshot.project.status,
    ...(blockers.length ? { blockers } : {}),
  };
}

export async function advanceContainers(ctx, guard) {
  const A = await ports(ctx),
    D = await evidenceFor(ctx.evaluator),
    blockers = [];
  let snapshot = await guard();
  const entities = [
    ...snapshot.epics.map(row => ['epic', row.id]),
    ...snapshot.milestones.map(row => ['milestone', row.id]),
    ['project', snapshot.project.projectId],
  ];
  for (const [kind, id] of entities) {
    for (let step = 0; step < stages.length; step++) {
      snapshot = await guard();
      const record = kind === 'project' ? snapshot.project : snapshot[`${kind}s`].find(row => row.id === id);
      if (record.status === 'released') break;
      if (record.status === 'accepted' && !record.evidence.some(ref => ref.kind === 'release')) break;
      const children =
        kind === 'project'
          ? snapshot.milestones
          : kind === 'milestone'
            ? snapshot.epics.filter(row => row.milestoneId === id)
            : snapshot.tasks.filter(row => row.epicId === id);
      if (!children.length || !children.every(row => settled(row.status))) {
        blockers.push(`${kind}:${id}:children_not_accepted`);
        break;
      }
      const criteria = kind === 'project' ? record.definitionOfDone : record.acceptance;
      const byHash = new Map(record.evidence.map(ref => [ref.sha256, ref]));
      const ownProof = criteria.every(criterion => {
        const mapping = record.mappings.find(row => row.criterionId === criterion.id);
        return (
          mapping?.refs.length &&
          mapping.refs.every(digest => byHash.has(digest)) &&
          criterion.evidenceKinds.every(type => mapping.refs.some(digest => byHash.get(digest).kind === type))
        );
      });
      if (!ownProof) {
        blockers.push(`${kind}:${id}:own_proof_missing`);
        break;
      }
      const ids = new Set(
        record.evidence
          .filter(ref => ['checks', 'review'].includes(ref.kind))
          .map(ref => ref.runId)
          .filter(Boolean),
      );
      if (ids.size !== 1) {
        blockers.push(`${kind}:${id}:bound_run_ambiguous`);
        break;
      }
      const run = storedRun(ctx.store, [...ids][0]);
      if (!run) {
        blockers.push(`${kind}:${id}:bound_run_missing`);
        break;
      }
      const to = record.status === 'proposed' ? 'ready' : stages[stages.indexOf(record.status) + 1];
      if (!to) {
        blockers.push(`${kind}:${id}:state_blocked`);
        break;
      }
      const c = command(ctx, snapshot, {
        op: 'transition',
        kind,
        id,
        to,
        evidence: record.evidence,
        mappings: record.mappings,
      });
      const result = await D.evaluateProjectTransition(
        { snapshot, command: c, run },
        {
          ...A,
          verifyRef: ref => verifyRef(ctx.engine, ref, run, true),
          validateRun: value =>
            validateRun({
              store: ctx.store,
              engine: ctx.engine,
              contracts: A.contracts,
              snapshot,
              run: value,
              publication: to === 'released',
            }),
        },
      );
      if (!result.eligibleStates.includes(to)) {
        blockers.push(...result.blockers.map(reason => `${kind}:${id}:${reason}`));
        break;
      }
      await guard(snapshot.revision);
      await ctx.repo.apply(c);
      if (kind === 'project' && to === 'released')
        return { snapshot: await guard(undefined, undefined, true), blockers };
    }
  }
  return { snapshot: await guard(), blockers: [...new Set(blockers)] };
}

export async function advance(ctx, id, run, guard) {
  const A = await ports(ctx),
    D = await evidenceFor(ctx.evaluator);
  let snapshot = await guard();
  // Acceptance observes the actual checked/reviewed frozen task, rather than
  // trusting a provider's completion prose or a caller-supplied decision.
  await validateRun({ store: ctx.store, engine: ctx.engine, contracts: A.contracts, snapshot, run });
  const refs = [];
  if (typeof ctx.engine.persistEvidence === 'function') {
    for (const kind of [
      'acceptance',
      'contract',
      'checks',
      'review',
      ...(run.release?.published ? ['delivery', 'release'] : []),
    ]) {
      const headSha = ['delivery', 'release'].includes(kind) ? run.delivery.mergeCommit : run.headSha;
      const ref = await ctx.engine.persistEvidence(run, `project-${kind}`, observation(run, kind), { headSha });
      refs.push({ kind, runId: run.id, headSha, path: ref.path, sha256: ref.sha256 });
    }
  }
  for (const kind of ['attempt', 'task']) {
    for (let step = 0; step < stages.length; step++) {
      snapshot = await guard();
      const attempt = snapshot.currentAttempts.find(row => row.runId === run.id),
        task = snapshot.tasks.find(row => row.id === attempt.taskId);
      const record = kind === 'attempt' ? attempt : task;
      const to = record.status === 'reserved' ? 'running' : stages[stages.indexOf(record.status) + 1];
      if (!to || record.status === 'released') break;
      const evidence = [
        ...new Map([...record.evidence, ...task.interfaceRefs, ...refs].map(ref => [ref.sha256, ref])).values(),
      ];
      const mappings = task.acceptance.map(criterion => ({
        criterionId: criterion.id,
        refs: evidence.filter(ref => criterion.evidenceKinds.includes(ref.kind)).map(ref => ref.sha256),
        actor: 'project-director',
        reason: 'Exact frozen task passed required checks and independent review',
      }));
      if (mappings.some(row => !row.refs.length)) break;
      const c = command(ctx, snapshot, { op: 'transition', kind, id: record.id, to, evidence, mappings });
      const result = await D.evaluateProjectTransition(
        { snapshot, command: c, run },
        {
          ...A,
          verifyRef: ref => verifyRef(ctx.engine, ref, run),
          validateRun: value =>
            validateRun({
              store: ctx.store,
              engine: ctx.engine,
              contracts: A.contracts,
              snapshot,
              run: value,
              publication: to === 'released',
            }),
        },
      );
      if (!result.eligibleStates.includes(to)) break;
      await guard(snapshot.revision, attempt);
      await ctx.repo.apply(c);
    }
  }
}
