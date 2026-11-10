import { lstat, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isCurrentUIReceipt, uiConfigHash } from './ui-verification.mjs';
import { isCurrentSecurityReceipt, securityConfigHash } from './security-gates.mjs';
import { isCurrentArchitectureReceipt, architectureConfigHash } from './architecture-gate.mjs';
import { sha256, fail, parse, wait } from './delivery-process.mjs';
import { operationIntent, operationOutcome } from './delivery-operations.mjs';
import {
  context,
  validateRepository,
  acquire,
  releaseOwnedLease,
  fetchBase,
  safeRemove,
  cleanupDelivery,
  compareVersion,
  publishedReleases,
} from './delivery-context.mjs';
export { execute } from './delivery-process.mjs';
export { assertFreshRelease } from './delivery-context.mjs';
export { prepareReleaseVersion, releasePackage } from './delivery-release.mjs';

export function validateChecks(checks, required) {
  if (!Array.isArray(required) || !required.length)
    throw fail('configuration', 'At least one required CI check must be configured');
  const byName = new Map();
  for (const check of checks ?? []) {
    const name = check.name ?? check.context;
    const value = String(check.conclusion ?? check.state ?? check.status ?? 'PENDING').toUpperCase();
    const previous = byName.get(name);
    // Duplicated names cannot hide a failing/incomplete workflow behind success.
    if (!previous || previous === 'SUCCESS') byName.set(name, value);
  }
  const missing = required.filter(name => !byName.has(name));
  const pending = required.filter(name =>
    ['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED', 'EXPECTED', ''].includes(byName.get(name)),
  );
  const failed = required.filter(name => byName.has(name) && byName.get(name) !== 'SUCCESS' && !pending.includes(name));
  return { ready: !missing.length && !pending.length && !failed.length, missing, pending, failed };
}

async function getPr(ctx, number) {
  return parse(
    await ctx.command('gh', [
      'pr',
      'view',
      String(number),
      '--repo',
      ctx.repository,
      '--json',
      'number,url,state,mergedAt,mergeCommit,headRefOid,baseRefName,baseRefOid,statusCheckRollup',
    ]),
    'gh pr view',
  );
}

function mergedReceipt(ctx, previous, saved, expectedHead) {
  if (!expectedHead || previous.headRefOid !== expectedHead || previous.baseRefName !== ctx.baseBranch)
    throw fail('stale_review', 'Saved PR no longer matches its immutable reviewed head and target');
  const mergeCommit = previous.mergeCommit?.oid;
  if (!/^[a-f0-9]{40,64}$/.test(mergeCommit ?? ''))
    throw fail('invalid_output', 'Merged PR is missing a valid merge commit');
  return { ...saved, pr: { number: previous.number, url: previous.url }, reviewedHead: expectedHead, mergeCommit };
}

/** Read-only GitHub reconciliation; only the confirmed receipt may be persisted. */
export async function reconcileDelivery(options) {
  const ctx = context(options);
  const saved = ctx.run.delivery;
  if (!saved?.pr?.number) return null;
  validateRepository(ctx.repository, ctx.baseBranch);
  if (!/^\d+$/.test(String(saved.pr.number))) throw fail('configuration', 'Invalid saved pull request number');
  const previous = await getPr(ctx, saved.pr.number);
  if (previous.state !== 'MERGED') return null;
  const expectedHead = saved.reviewedHead || options.review?.headSha || ctx.run.review?.headSha || ctx.run.headSha;
  const receipt = mergedReceipt(ctx, previous, saved, expectedHead);
  await ctx.save({ delivery: receipt });
  // Found by reading the remote state back: no merge command is sent again.
  await operationOutcome(ctx, 'merge', 'reconciled', { pr: receipt.pr.number, mergeCommit: receipt.mergeCommit });
  return receipt;
}

// oxlint-disable-next-line complexity -- debt: docs/kodo-roadmap/MAINTAINABILITY-PLAN.md
async function verifyReview(ctx) {
  const head = (await ctx.command('git', ['rev-parse', 'HEAD'])).trim();
  if (head !== ctx.run.headSha) throw fail('stale_review', 'Working commit differs from the reviewed run head');
  const diff = await ctx.command('git', ['diff', '--binary', `${ctx.run.baseSha}...${head}`]);
  // The hash is of canonical git diff bytes without trailing CR/LF, matching command().
  const diffHash = sha256(diff);
  if (ctx.review?.passed !== true || ctx.review.headSha !== head || ctx.review.diffHash !== diffHash)
    throw fail('stale_review', 'A passing review bound to this exact head and diff is required');
  const uiConfig = ctx.config.uiVerification ?? ctx.run.config?.uiVerification;
  const securityConfig = ctx.config.security ?? ctx.run.config?.security;
  const architectureConfig = ctx.config.architecture ?? ctx.run.config?.architecture;
  if (ctx.run.config?.uiVerification?.enabled && uiConfigHash(uiConfig) !== uiConfigHash(ctx.run.config.uiVerification))
    throw fail('stale_ui_verification', 'Delivery configuration differs from the verified run UI configuration');
  if (
    ctx.run.config?.security?.enabled &&
    securityConfigHash(securityConfig) !== securityConfigHash(ctx.run.config.security)
  )
    throw fail('stale_security_checks', 'Delivery configuration differs from the verified run security configuration');
  if (
    ctx.run.config?.architecture?.enabled &&
    architectureConfigHash(architectureConfig) !== architectureConfigHash(ctx.run.config.architecture)
  )
    throw fail(
      'stale_architecture_checks',
      'Delivery configuration differs from the verified run architecture configuration',
    );
  if (uiConfig?.enabled || securityConfig?.enabled || architectureConfig?.enabled) {
    if ((await ctx.command('git', ['status', '--porcelain'])).trim())
      throw fail('dirty_worktree', 'Delivery requires a clean checked worktree');
    if (ctx.run.checks?.headSha !== head) throw fail('stale_checks', 'Local checks must match the delivered head');
  }
  if (uiConfig?.enabled && !isCurrentUIReceipt(ctx.run.uiVerification, { headSha: head, config: uiConfig }))
    throw fail('stale_ui_verification', 'Current UI verification evidence is required for delivery');
  if (
    securityConfig?.enabled &&
    !isCurrentSecurityReceipt(ctx.run.securityChecks, { headSha: head, config: securityConfig })
  )
    throw fail('stale_security_checks', 'Current security evidence is required for delivery');
  if (
    architectureConfig?.enabled &&
    !(await isCurrentArchitectureReceipt(ctx.run.architectureChecks, {
      cwd: ctx.cwd,
      headSha: head,
      baseSha: ctx.run.baseSha,
      config: architectureConfig,
      signal: ctx.signal,
    }))
  )
    throw fail('stale_architecture_checks', 'Current architecture evidence is required for delivery');
  return { head, diffHash };
}

async function requiredChecks(ctx) {
  const protection = parse(
    await ctx.command('gh', [
      'api',
      `repos/${ctx.repository}/branches/${encodeURIComponent(ctx.baseBranch)}/protection`,
    ]),
    'branch protection',
  );
  if (protection.required_status_checks?.strict !== true || protection.enforce_admins?.enabled !== true)
    throw fail('branch_protection', 'Target branch must enforce strict up-to-date checks, including administrators');
  const protectedNames = [
    ...(protection.required_status_checks.contexts ?? []),
    ...(protection.required_status_checks.checks ?? []).map(check => check.context),
  ];
  const configured = ctx.config.checks ?? protectedNames.filter(name => name !== 'kodo/review');
  if (
    !configured.length ||
    configured.some(name => !protectedNames.includes(name)) ||
    !protectedNames.includes('kodo/review')
  )
    throw fail('branch_protection', 'Required CI checks and kodo/review must be protected');
  return [...new Set([...configured, 'kodo/review'])];
}

async function awaitChecks(ctx, number, expectedHead, names) {
  const started = Date.now();
  while (true) {
    const pr = await getPr(ctx, number);
    if (pr.headRefOid !== expectedHead) throw fail('stale_review', 'PR head changed after review');
    if (pr.baseRefName !== ctx.baseBranch) throw fail('configuration', 'PR targets an unexpected branch');
    // Conflicting or outdated branches may never receive CI checks. Replan
    // against the actual target immediately instead of waiting for absent CI.
    if (pr.baseRefOid !== ctx.run.baseSha)
      throw fail('stale_base', 'PR target advanced; synchronize, retest and review before waiting for checks', {
        baseSha: pr.baseRefOid,
      });
    const checks = validateChecks(pr.statusCheckRollup, names);
    if (checks.failed.length)
      throw fail('checks_failed', `Required checks failed: ${checks.failed.join(', ')}`, { checks });
    if (checks.ready) return pr;
    await ctx.event('delivery.checks_waiting', { pr: pr.url, checks });
    if (Date.now() - started >= (ctx.maxWaitMs ?? 20 * 60 * 1000))
      throw fail('checks_pending', 'Required checks are not complete; resume this run later', { checks });
    await wait(ctx.pollMs ?? 10000, ctx.signal);
  }
}

// oxlint-disable-next-line max-lines-per-function, complexity -- debt: docs/kodo-roadmap/MAINTAINABILITY-PLAN.md
export async function deliver(options) {
  const ctx = context(options);
  validateRepository(ctx.repository, ctx.baseBranch);
  if (!ctx.run.branch || ctx.run.branch === ctx.baseBranch || ctx.run.branch.startsWith('-'))
    throw fail('configuration', 'Delivery needs a separate task branch');
  // Reconcile a previously merged PR before requiring an obsolete local review.
  const reconciled = await reconcileDelivery(options);
  if (reconciled) return reconciled;
  let saved = ctx.run.delivery ?? {};
  const { head, diffHash } = await verifyReview(ctx);
  const required = await requiredChecks(ctx);
  const initialBase = await fetchBase(ctx);
  if (initialBase !== ctx.run.baseSha)
    throw fail(
      'stale_base',
      'Target branch advanced; synchronize, retest and review before publishing the task branch',
      { baseSha: initialBase },
    );
  await ctx.command('git', ['push', '--set-upstream', 'origin', ctx.run.branch]);
  const matches = parse(
    await ctx.command('gh', [
      'pr',
      'list',
      '--repo',
      ctx.repository,
      '--head',
      ctx.run.branch,
      '--state',
      'all',
      '--json',
      'number,url,state',
    ]),
    'gh pr list',
  );
  if (matches.length > 1) throw fail('ambiguous_pr', 'More than one PR matches the run branch');
  let pr = matches[0];
  if (!pr) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'kodo-pr-'));
    const ownership = await lstat(directory);
    let primaryError;
    try {
      const filename = path.join(directory, 'body.md');
      await writeFile(
        filename,
        `${ctx.run.task}\n\nImplemented and checked by Kodo.\n\n- Run: \`${ctx.run.id}\`\n- Reviewed head: \`${head}\`\n- Diff SHA-256: \`${diffHash}\`\n\n<!-- kodo-run:${ctx.run.id} -->\n`,
      );
      await operationIntent(ctx, 'pr', { head });
      const url = await ctx.command('gh', [
        'pr',
        'create',
        '--repo',
        ctx.repository,
        '--base',
        ctx.baseBranch,
        '--head',
        ctx.run.branch,
        '--title',
        ctx.run.task.replace(/[\r\n]+/g, ' ').slice(0, 180),
        '--body-file',
        filename,
      ]);
      const number = Number(/\/pull\/(\d+)/.exec(url)?.[1]);
      if (!number) throw fail('invalid_output', 'GitHub did not return a PR URL');
      pr = { number, url, state: 'OPEN' };
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      await cleanupDelivery(ctx, primaryError, [() => safeRemove(directory, 'kodo-pr-', ownership)]);
    }
  }
  if (pr.state === 'CLOSED') throw fail('pr_closed', 'The run PR was closed without merge');
  saved = { ...saved, pr: { number: pr.number, url: pr.url }, reviewedHead: head, diffHash };
  await ctx.save({ delivery: saved });
  await ctx.event('delivery.pr_created', { pr: saved.pr });
  // `matches[0]` means the PR was found by listing the branch, not created by this call.
  await operationOutcome(ctx, 'pr', matches[0] ? 'reconciled' : 'confirmed', { pr: pr.number, head });
  if (pr.state === 'MERGED') {
    const merged = await getPr(ctx, pr.number);
    const receipt = mergedReceipt(ctx, merged, saved, saved.reviewedHead || head);
    await ctx.save({ delivery: receipt });
    return receipt;
  }
  await ctx.command('gh', [
    'api',
    '--method',
    'POST',
    `repos/${ctx.repository}/statuses/${head}`,
    '-f',
    'state=success',
    '-f',
    'context=kodo/review',
    '-f',
    'description=Independent Kodo review passed for this exact diff',
  ]);
  await awaitChecks(ctx, pr.number, head, required);
  const lease = await acquire(ctx, `merge:${ctx.repository}:${ctx.baseBranch}`);
  let publicationLease;
  try {
    if (ctx.config.delivery?.release)
      publicationLease = await acquire(ctx, `release:${ctx.repository}:${ctx.baseBranch}`);
    const currentBase = await fetchBase(ctx);
    if (currentBase !== ctx.run.baseSha)
      throw fail('stale_base', 'Target branch advanced; synchronize, retest and review before merge', {
        baseSha: currentBase,
      });
    await awaitChecks(ctx, pr.number, head, required);
    if (ctx.config.delivery?.release) {
      const manifest = parse(await readFile(path.join(ctx.cwd, 'package.json'), 'utf8'), 'reviewed release manifest');
      const targetManifest = parse(
        await ctx.command('git', ['show', `${currentBase}:package.json`]),
        'target release manifest',
      );
      const assigned = ctx.run.releaseAssignment;
      const latest = (await publishedReleases(ctx)).at(-1);
      if (
        !assigned?.prepared ||
        assigned.version !== manifest.version ||
        compareVersion(assigned.version, targetManifest.version) <= 0 ||
        (latest && compareVersion(assigned.version, latest.tagName.replace(/^v/, '')) <= 0)
      ) {
        throw fail(
          'stale_base',
          'Release version assignment is stale; prepare, commit, test and review a fresh version before merging',
          { latestVersion: latest?.tagName, targetVersion: targetManifest.version },
        );
      }
    }
    // CI/queue waits are outside our private evidence boundary; re-read the
    // configured gate evidence immediately before the irreversible merge.
    if (
      ctx.config.uiVerification?.enabled ||
      ctx.config.security?.enabled ||
      ctx.config.architecture?.enabled ||
      ctx.run.config?.uiVerification?.enabled ||
      ctx.run.config?.security?.enabled ||
      ctx.run.config?.architecture?.enabled
    )
      await verifyReview(ctx);
    return await ctx.irreversible(async () => {
      let mergeError;
      await operationIntent(ctx, 'merge', { pr: pr.number, head });
      try {
        await ctx.command(
          'gh',
          ['pr', 'merge', String(pr.number), '--repo', ctx.repository, '--squash', '--match-head-commit', head],
          { ignoreAbort: true },
        );
      } catch (error) {
        mergeError = error;
      }
      const merged = await getPr(ctx, pr.number);
      if (merged.state !== 'MERGED' || !merged.mergeCommit?.oid) {
        await operationOutcome(ctx, 'merge', 'absent', { pr: pr.number, head });
        if ((await fetchBase(ctx)) !== ctx.run.baseSha)
          throw fail('stale_base', 'Target branch changed while merging; synchronize and retry');
        if (mergeError) throw mergeError;
        throw fail('merge_pending', 'PR has not been confirmed merged');
      }
      const receipt = mergedReceipt(ctx, merged, saved, saved.reviewedHead || head);
      await ctx.save({ delivery: receipt });
      await ctx.event('delivery.merged', { pr: receipt.pr, mergeCommit: receipt.mergeCommit });
      // A command error followed by a confirmed merge is an uncertain effect resolved by read-back.
      await operationOutcome(ctx, 'merge', mergeError ? 'reconciled' : 'confirmed', {
        pr: receipt.pr.number,
        mergeCommit: receipt.mergeCommit,
      });
      return receipt;
    });
  } finally {
    try {
      if (publicationLease) await releaseOwnedLease(ctx, publicationLease);
    } finally {
      await releaseOwnedLease(ctx, lease);
    }
  }
}
