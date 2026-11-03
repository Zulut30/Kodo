import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { workerEnvironment } from './security.mjs';
import { gitBoundary } from './command.mjs';
import { isCurrentUIReceipt, uiConfigHash } from './ui-verification.mjs';
import { isCurrentSecurityReceipt, securityConfigHash } from './security-gates.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const parse = (text, label) => { try { return JSON.parse(text); } catch { throw fail('invalid_output', `Invalid JSON from ${label}`); } };
const wait = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(fail('cancelled', 'Delivery cancelled'));
  const timer = setTimeout(done, ms);
  function done() { signal?.removeEventListener('abort', abort); resolve(); }
  function abort() { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(fail('cancelled', 'Delivery cancelled')); }
  signal?.addEventListener('abort', abort, { once: true });
});

async function npmCommand() {
  const candidates = [process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.join(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
    ...(process.env.PATH ?? '').split(path.delimiter).map(item => path.join(item, 'node_modules/npm/bin/npm-cli.js'))];
  for (const candidate of candidates.filter(Boolean)) {
    try { await access(candidate); return [process.execPath, [candidate]]; } catch { /* next installation */ }
  }
  throw fail('configuration', 'Cannot find npm-cli.js; install npm beside Node.js');
}

export async function execute(command, args, { cwd, signal, timeoutMs = 120000, allowFailure = false, env } = {}) {
  const baseEnv = env ?? process.env;
  let environment = workerEnvironment(baseEnv);
  let executable = command, argv = args;
  // Coordinator Git processes retain credentials, so repository-authored hooks
  // must never run inside that boundary, including pre-push and reference hooks.
  if (/(?:^|[\\/])git(?:\.exe)?$/i.test(command)) ({ args: argv, env: environment } = gitBoundary(args, baseEnv));
  else if (/(?:^|[\\/])gh(?:\.exe)?$/i.test(command)) environment = gitBoundary(['ls-remote'], baseEnv).env;
  if (command === 'npm') {
    const [node, prefix] = await npmCommand(); executable = node; argv = [...prefix, ...args];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv, { cwd, env: environment, signal, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    let stdout = '', stderr = '', settled = false;
    const timer = setTimeout(() => { child.kill(); finish(fail('timeout', `${command} timed out`)); }, timeoutMs);
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 20 * 1024 * 1024) { child.kill(); finish(fail('invalid_output', `${command} output exceeded limit`)); } });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-32768); });
    child.on('error', error => finish(signal?.aborted ? fail('cancelled', 'Delivery cancelled') : error));
    child.on('close', code => {
      const result = { stdout, stderr, code };
      if (signal?.aborted) return finish(fail('cancelled', 'Delivery cancelled'));
      if (code !== 0 && !allowFailure) return finish(fail('command_failed', `${command} failed (${code}): ${stderr.slice(-1500)}`, { exitCode: code, stderr }));
      finish(null, result);
    });
  });
}

function context(options) {
  const { run, config = {}, cwd = run.project, signal, store } = options;
  const runner = options.exec ?? execute;
  const leaseRegistry = new Map();
  let finishingIrreversible = false;
  const checkpoint = () => {
    if (signal?.aborted) throw fail('cancelled', 'Delivery cancelled');
    for (const lease of leaseRegistry.values()) if (lease.error) throw lease.error;
  };
  const command = async (name, args, settings = {}) => {
    if (!settings.reconcile && !finishingIrreversible) checkpoint();
    const baseEnv = settings.env ?? process.env;
    const environment = /(?:^|[\\/])git(?:\.exe)?$/i.test(name) ? gitBoundary(args, baseEnv).env
      : /(?:^|[\\/])gh(?:\.exe)?$/i.test(name) ? gitBoundary(['ls-remote'], baseEnv).env : workerEnvironment(baseEnv);
    const result = await runner(name, args, { cwd, ...settings, env: environment, signal: settings.ignoreAbort || finishingIrreversible ? undefined : signal });
    if (result.code && !settings.allowFailure) throw fail('command_failed', `${name} failed (${result.code}): ${(result.stderr ?? '').slice(-1500)}`, { exitCode: result.code, stderr: result.stderr });
    return result.stdout?.trimEnd() ?? '';
  };
  const event = async (type, data) => { await store?.event?.(run.id, type, data); await options.onEvent?.({ type, ...data }); };
  const save = async patch => { Object.assign(run, patch); await store?.updateRun?.(run.id, patch); };
  const irreversible = async action => {
    checkpoint();
    // Cancellation is honored before an irreversible unit. Once it has begun,
    // finish its bounded confirmation/receipt sequence instead of killing a
    // process whose remote mutation may already have succeeded.
    const previous = finishingIrreversible; finishingIrreversible = true;
    try { return await action(); } finally { finishingIrreversible = previous; }
  };
  return { ...options, run, config, cwd, signal, command, event, save, irreversible, leaseRegistry, repository: config.repository, baseBranch: config.baseBranch ?? 'main' };
}

function validateRepository(repository, branch) {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository ?? '')) throw fail('configuration', 'A GitHub owner/repository is required');
  if (!branch || branch.startsWith('-') || /[\s~^:?*\[\\]|\.\.|@\{|\/$/.test(branch)) throw fail('configuration', 'Invalid target branch');
}

export function validateChecks(checks, required) {
  if (!Array.isArray(required) || !required.length) throw fail('configuration', 'At least one required CI check must be configured');
  const byName = new Map();
  for (const check of checks ?? []) {
    const name = check.name ?? check.context;
    const value = String(check.conclusion ?? check.state ?? check.status ?? 'PENDING').toUpperCase();
    const previous = byName.get(name);
    // Duplicated names cannot hide a failing/incomplete workflow behind success.
    if (!previous || previous === 'SUCCESS') byName.set(name, value);
  }
  const missing = required.filter(name => !byName.has(name));
  const pending = required.filter(name => ['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED', 'EXPECTED', ''].includes(byName.get(name)));
  const failed = required.filter(name => byName.has(name) && byName.get(name) !== 'SUCCESS' && !pending.includes(name));
  return { ready: !missing.length && !pending.length && !failed.length, missing, pending, failed };
}

export function assertFreshRelease({ candidateSha, remoteHead, candidateIsAncestor = false, latestSha, containsLatest = false, latestVersion, version }) {
  if (!candidateSha || candidateSha !== remoteHead && !candidateIsAncestor) throw fail('stale_release', 'Release candidate is not contained in the current target branch');
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw fail('release_version_mismatch', 'Release version must be X.Y.Z');
  if (latestVersion) {
    const previous = latestVersion.replace(/^v/, '').split('.').map(Number);
    const current = version.split('.').map(Number);
    if (previous.some(Number.isNaN) || previous.length !== 3) throw fail('release_version_mismatch', 'Latest release has an unsupported version');
    let comparison = 0;
    for (let index = 0; index < 3 && !comparison; index++) comparison = Math.sign(current[index] - previous[index]);
    if (comparison <= 0 || latestSha && latestSha !== candidateSha && !containsLatest) throw fail('stale_release', 'Release would replace the same or a newer published result');
  }
  return true;
}

async function acquire(ctx, name) {
  if (!ctx.store?.acquireLease) throw fail('configuration', 'Delivery requires persistent queue leases');
  const maxWaitMs = ctx.maxWaitMs ?? 20 * 60 * 1000;
  const started = Date.now();
  while (true) {
    const token = await ctx.store.acquireLease(name, ctx.run.id, { ttlMs: maxWaitMs + 300000, limit: 1 });
    if (token) {
      const lease = { active: true, error: null, timer: null };
      if (ctx.store.renewLease) {
        lease.timer = setInterval(async () => {
          if (!lease.active) return;
          try {
            if (await ctx.store.renewLease(token) === false) lease.error = fail('lease_lost', `Delivery queue lease expired: ${name}`);
          } catch (error) { lease.error = fail('lease_lost', `Delivery queue lease could not be renewed: ${name}`, { cause: error }); }
        }, ctx.leaseHeartbeatMs ?? 10000);
        lease.timer.unref?.();
      }
      ctx.leaseRegistry.set(token, lease);
      return token;
    }
    if (Date.now() - started >= maxWaitMs) throw fail('queue_waiting', `Delivery queue is busy: ${name}`);
    await ctx.event('delivery.queue_waiting', { queue: name });
    await wait(ctx.pollMs ?? 5000, ctx.signal);
  }
}

async function releaseOwnedLease(ctx, token) {
  const lease = ctx.leaseRegistry.get(token);
  if (lease) { lease.active = false; clearInterval(lease.timer); ctx.leaseRegistry.delete(token); }
  await ctx.store.releaseLease(token);
}

async function getPr(ctx, number) {
  return parse(await ctx.command('gh', ['pr', 'view', String(number), '--repo', ctx.repository, '--json', 'number,url,state,mergedAt,mergeCommit,headRefOid,baseRefName,baseRefOid,statusCheckRollup']), 'gh pr view');
}

function mergedReceipt(ctx, previous, saved, expectedHead) {
  if (!expectedHead || previous.headRefOid !== expectedHead || previous.baseRefName !== ctx.baseBranch) throw fail('stale_review', 'Saved PR no longer matches its immutable reviewed head and target');
  const mergeCommit = previous.mergeCommit?.oid;
  if (!/^[a-f0-9]{40,64}$/.test(mergeCommit ?? '')) throw fail('invalid_output', 'Merged PR is missing a valid merge commit');
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
  return receipt;
}

async function fetchBase(ctx) {
  await ctx.command('git', ['fetch', 'origin', ctx.baseBranch]);
  return (await ctx.command('git', ['rev-parse', `origin/${ctx.baseBranch}`])).trim();
}

async function verifyReview(ctx) {
  const head = (await ctx.command('git', ['rev-parse', 'HEAD'])).trim();
  if (head !== ctx.run.headSha) throw fail('stale_review', 'Working commit differs from the reviewed run head');
  const diff = await ctx.command('git', ['diff', '--binary', `${ctx.run.baseSha}...${head}`]);
  // The hash is of canonical git diff bytes without trailing CR/LF, matching command().
  const diffHash = sha256(diff);
  if (ctx.review?.passed !== true || ctx.review.headSha !== head || ctx.review.diffHash !== diffHash) throw fail('stale_review', 'A passing review bound to this exact head and diff is required');
  const uiConfig = ctx.config.uiVerification ?? ctx.run.config?.uiVerification;
  const securityConfig = ctx.config.security ?? ctx.run.config?.security;
  if (ctx.run.config?.uiVerification?.enabled && uiConfigHash(uiConfig) !== uiConfigHash(ctx.run.config.uiVerification)) throw fail('stale_ui_verification', 'Delivery configuration differs from the verified run UI configuration');
  if (ctx.run.config?.security?.enabled && securityConfigHash(securityConfig) !== securityConfigHash(ctx.run.config.security)) throw fail('stale_security_checks', 'Delivery configuration differs from the verified run security configuration');
  if (uiConfig?.enabled || securityConfig?.enabled) {
    if ((await ctx.command('git', ['status', '--porcelain'])).trim()) throw fail('dirty_worktree', 'Delivery requires a clean checked worktree');
    if (ctx.run.checks?.headSha !== head) throw fail('stale_checks', 'Local checks must match the delivered head');
  }
  if (uiConfig?.enabled && !isCurrentUIReceipt(ctx.run.uiVerification, { headSha: head, config: uiConfig })) throw fail('stale_ui_verification', 'Current UI verification evidence is required for delivery');
  if (securityConfig?.enabled && !isCurrentSecurityReceipt(ctx.run.securityChecks, { headSha: head, config: securityConfig })) throw fail('stale_security_checks', 'Current security evidence is required for delivery');
  return { head, diffHash };
}

async function requiredChecks(ctx) {
  const protection = parse(await ctx.command('gh', ['api', `repos/${ctx.repository}/branches/${encodeURIComponent(ctx.baseBranch)}/protection`]), 'branch protection');
  if (protection.required_status_checks?.strict !== true || protection.enforce_admins?.enabled !== true) throw fail('branch_protection', 'Target branch must enforce strict up-to-date checks, including administrators');
  const protectedNames = [...(protection.required_status_checks.contexts ?? []), ...(protection.required_status_checks.checks ?? []).map(check => check.context)];
  const configured = ctx.config.checks ?? protectedNames.filter(name => name !== 'kodo/review');
  if (!configured.length || configured.some(name => !protectedNames.includes(name)) || !protectedNames.includes('kodo/review')) throw fail('branch_protection', 'Required CI checks and kodo/review must be protected');
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
    if (pr.baseRefOid !== ctx.run.baseSha) throw fail('stale_base', 'PR target advanced; synchronize, retest and review before waiting for checks', { baseSha: pr.baseRefOid });
    const checks = validateChecks(pr.statusCheckRollup, names);
    if (checks.failed.length) throw fail('checks_failed', `Required checks failed: ${checks.failed.join(', ')}`, { checks });
    if (checks.ready) return pr;
    await ctx.event('delivery.checks_waiting', { pr: pr.url, checks });
    if (Date.now() - started >= (ctx.maxWaitMs ?? 20 * 60 * 1000)) throw fail('checks_pending', 'Required checks are not complete; resume this run later', { checks });
    await wait(ctx.pollMs ?? 10000, ctx.signal);
  }
}

export async function deliver(options) {
  const ctx = context(options);
  validateRepository(ctx.repository, ctx.baseBranch);
  if (!ctx.run.branch || ctx.run.branch === ctx.baseBranch || ctx.run.branch.startsWith('-')) throw fail('configuration', 'Delivery needs a separate task branch');
  // Reconcile a previously merged PR before requiring an obsolete local review.
  const reconciled = await reconcileDelivery(options);
  if (reconciled) return reconciled;
  let saved = ctx.run.delivery ?? {};
  const { head, diffHash } = await verifyReview(ctx);
  const required = await requiredChecks(ctx);
  const initialBase = await fetchBase(ctx);
  if (initialBase !== ctx.run.baseSha) throw fail('stale_base', 'Target branch advanced; synchronize, retest and review before publishing the task branch', { baseSha: initialBase });
  await ctx.command('git', ['push', '--set-upstream', 'origin', ctx.run.branch]);
  const matches = parse(await ctx.command('gh', ['pr', 'list', '--repo', ctx.repository, '--head', ctx.run.branch, '--state', 'all', '--json', 'number,url,state']), 'gh pr list');
  if (matches.length > 1) throw fail('ambiguous_pr', 'More than one PR matches the run branch');
  let pr = matches[0];
  if (!pr) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'kodo-pr-'));
    try {
      const filename = path.join(directory, 'body.md');
      await writeFile(filename, `${ctx.run.task}\n\nImplemented and checked by Kodo.\n\n- Run: \`${ctx.run.id}\`\n- Reviewed head: \`${head}\`\n- Diff SHA-256: \`${diffHash}\`\n\n<!-- kodo-run:${ctx.run.id} -->\n`);
      const url = await ctx.command('gh', ['pr', 'create', '--repo', ctx.repository, '--base', ctx.baseBranch, '--head', ctx.run.branch, '--title', ctx.run.task.replace(/[\r\n]+/g, ' ').slice(0, 180), '--body-file', filename]);
      const number = Number(/\/pull\/(\d+)/.exec(url)?.[1]);
      if (!number) throw fail('invalid_output', 'GitHub did not return a PR URL');
      pr = { number, url, state: 'OPEN' };
    } finally { await safeRemove(directory, 'kodo-pr-'); }
  }
  if (pr.state === 'CLOSED') throw fail('pr_closed', 'The run PR was closed without merge');
  saved = { ...saved, pr: { number: pr.number, url: pr.url }, reviewedHead: head, diffHash };
  await ctx.save({ delivery: saved });
  await ctx.event('delivery.pr_created', { pr: saved.pr });
  if (pr.state === 'MERGED') {
    const merged = await getPr(ctx, pr.number);
    const receipt = mergedReceipt(ctx, merged, saved, saved.reviewedHead || head);
    await ctx.save({ delivery: receipt }); return receipt;
  }
  await ctx.command('gh', ['api', '--method', 'POST', `repos/${ctx.repository}/statuses/${head}`, '-f', 'state=success', '-f', 'context=kodo/review', '-f', 'description=Independent Kodo review passed for this exact diff']);
  await awaitChecks(ctx, pr.number, head, required);
  const lease = await acquire(ctx, `merge:${ctx.repository}:${ctx.baseBranch}`);
  let publicationLease;
  try {
    if (ctx.config.delivery?.release) publicationLease = await acquire(ctx, `release:${ctx.repository}:${ctx.baseBranch}`);
    const currentBase = await fetchBase(ctx);
    if (currentBase !== ctx.run.baseSha) throw fail('stale_base', 'Target branch advanced; synchronize, retest and review before merge', { baseSha: currentBase });
    await awaitChecks(ctx, pr.number, head, required);
    if (ctx.config.delivery?.release) {
      const manifest = parse(await readFile(path.join(ctx.cwd, 'package.json'), 'utf8'), 'reviewed release manifest');
      const targetManifest = parse(await ctx.command('git', ['show', `${currentBase}:package.json`]), 'target release manifest');
      const assigned = ctx.run.releaseAssignment;
      const latest = (await publishedReleases(ctx)).at(-1);
      if (!assigned?.prepared || assigned.version !== manifest.version || compareVersion(assigned.version, targetManifest.version) <= 0 || latest && compareVersion(assigned.version, latest.tagName.replace(/^v/, '')) <= 0) {
        throw fail('stale_base', 'Release version assignment is stale; prepare, commit, test and review a fresh version before merging', { latestVersion: latest?.tagName, targetVersion: targetManifest.version });
      }
    }
    // CI/queue waits are outside our private evidence boundary; re-read the
    // configured gate evidence immediately before the irreversible merge.
    if (ctx.config.uiVerification?.enabled || ctx.config.security?.enabled || ctx.run.config?.uiVerification?.enabled || ctx.run.config?.security?.enabled) await verifyReview(ctx);
    return await ctx.irreversible(async () => {
      let mergeError;
      try { await ctx.command('gh', ['pr', 'merge', String(pr.number), '--repo', ctx.repository, '--squash', '--match-head-commit', head], { ignoreAbort: true }); }
      catch (error) { mergeError = error; }
      const merged = await getPr(ctx, pr.number);
      if (merged.state !== 'MERGED' || !merged.mergeCommit?.oid) {
        if (await fetchBase(ctx) !== ctx.run.baseSha) throw fail('stale_base', 'Target branch changed while merging; synchronize and retry');
        if (mergeError) throw mergeError;
        throw fail('merge_pending', 'PR has not been confirmed merged');
      }
      const receipt = mergedReceipt(ctx, merged, saved, saved.reviewedHead || head);
      await ctx.save({ delivery: receipt });
      await ctx.event('delivery.merged', { pr: receipt.pr, mergeCommit: receipt.mergeCommit });
      return receipt;
    });
  } finally {
    try { if (publicationLease) await releaseOwnedLease(ctx, publicationLease); }
    finally { await releaseOwnedLease(ctx, lease); }
  }
}

async function safeRemove(directory, prefix) {
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(prefix)) throw fail('unsafe_path', 'Refusing to remove unexpected temporary directory');
  await rm(resolved, { recursive: true, force: true });
}

async function pack(ctx, source, destination) {
  const output = parse(await ctx.command('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', destination], { cwd: source }), 'npm pack');
  const item = Array.isArray(output) ? output[0] : Object.values(output)[0];
  if (!item || !item.filename || path.basename(item.filename) !== item.filename || !item.filename.endsWith('.tgz')) throw fail('invalid_output', 'npm pack did not produce a package');
  return { ...item, filename: path.join(destination, item.filename) };
}

async function smokePackage(ctx, artifact, directory, manifest) {
  const install = path.join(directory, 'install');
  await mkdir(install);
  await ctx.command('npm', ['install', '--prefix', install, '--ignore-scripts', '--no-audit', '--no-fund', artifact], { timeoutMs: 180000 });
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.kodo;
  if (!bin || path.isAbsolute(bin) || bin.split(/[\\/]/).includes('..')) throw fail('release_package', 'Package has no valid kodo executable');
  if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/.test(manifest.name ?? '') || manifest.name.split('/').some(part => part === '.' || part === '..')) throw fail('release_package', 'Package name is not valid');
  const packageRoot = path.join(install, 'node_modules', ...manifest.name.split('/'));
  let installed;
  try { installed = parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'), 'installed package manifest'); }
  catch { throw fail('release_conflict', 'Downloaded archive does not contain the expected package'); }
  const installedBin = typeof installed.bin === 'string' ? installed.bin : installed.bin?.kodo;
  if (installed.name !== manifest.name || installed.version !== manifest.version || installedBin?.replace(/^\.\//, '') !== bin.replace(/^\.\//, '')) throw fail('release_conflict', 'Archive package identity/version differs from the exact release commit');
  const entry = path.join(packageRoot, bin);
  const help = await ctx.command(process.execPath, [entry, '--help'], { cwd: install });
  if (!/kodo/i.test(help)) throw fail('smoke_failed', 'Installed command did not identify itself as Kodo');
  const list = parse(await ctx.command(process.execPath, [entry, 'list', '--json'], { cwd: install }), 'installed catalog');
  if (!Array.isArray(list) || !list.length) throw fail('smoke_failed', 'Installed package catalog is empty');
  const validation = parse(await ctx.command(process.execPath, [entry, 'validate', '--json'], { cwd: install }), 'installed validation');
  if (validation.valid !== true) throw fail('smoke_failed', 'Installed package failed validation');
  return { passed: true, commands: ['kodo --help', 'kodo list --json', 'kodo validate --json'], node: process.version, platform: process.platform };
}

const versionParts = value => {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value ?? '')) throw fail('release_version_mismatch', `Unsupported release version: ${value}`);
  return value.split('.').map(Number);
};
function compareVersion(left, right) {
  const a = versionParts(left), b = versionParts(right);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return Math.sign(a[index] - b[index]);
  return 0;
}

async function writeMetadata(filename, content) {
  const temporary = path.join(path.dirname(filename), `.kodo-version-${randomUUID()}.tmp`);
  try { await writeFile(temporary, JSON.stringify(content, null, 2) + '\n', { flag: 'wx' }); await rename(temporary, filename); }
  finally { await rm(temporary, { force: true }); }
}

export async function prepareReleaseVersion(options) {
  const ctx = context(options);
  validateRepository(ctx.repository, ctx.baseBranch);
  const lease = await acquire(ctx, `release-version:${ctx.repository}:${ctx.baseBranch}`);
  try {
    const filename = path.join(ctx.cwd, 'package.json');
    const manifest = parse(await readFile(filename, 'utf8'), 'package.json');
    versionParts(manifest.version);
    const targetSha = await fetchBase(ctx);
    const targetVersion = parse(await ctx.command('git', ['show', `${targetSha}:package.json`]), 'target package manifest').version;
    versionParts(targetVersion);
    const floor = ctx.config.delivery?.firstVersion ?? '0.2.0';
    versionParts(floor);
    const releases = parse(await ctx.command('gh', ['release', 'list', '--repo', ctx.repository, '--limit', '100', '--json', 'tagName,isDraft,isPrerelease']), 'release versions');
    const versions = releases.filter(item => !item.isDraft && !item.isPrerelease && /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(item.tagName)).map(item => item.tagName.replace(/^v/, '')).sort(compareVersion);
    const latest = versions.at(-1);
    const saved = ctx.run.releaseAssignment;
    const previousVersion = saved?.version === manifest.version ? saved.previousVersion : manifest.version;
    let version;
    if (saved && (manifest.version === saved.version || saved.baseSha === ctx.run.baseSha && manifest.version === saved.previousVersion) && compareVersion(saved.version, targetVersion) > 0 && compareVersion(saved.version, floor) >= 0 && (!latest || compareVersion(saved.version, latest) > 0)) version = saved.version;
    else if (ctx.config.delivery?.nextVersion) version = ctx.config.delivery.nextVersion;
    else {
      const greatest = [previousVersion, targetVersion, latest].filter(Boolean).sort(compareVersion).at(-1);
      const [major, minor, patch] = versionParts(greatest);
      const bumped = `${major}.${minor}.${patch + 1}`;
      version = compareVersion(bumped, floor) >= 0 ? bumped : floor;
    }
    versionParts(version);
    if (compareVersion(version, targetVersion) <= 0 || compareVersion(version, floor) < 0 || latest && compareVersion(version, latest) <= 0) throw fail('release_version_mismatch', 'Assigned release version must exceed target/published versions and satisfy the configured floor');
    // Save intent before atomic metadata writes so a crash cannot bump twice.
    const assignment = { version, previousVersion: saved?.version === version ? saved.previousVersion : previousVersion, baseSha: ctx.run.baseSha, prepared: false };
    await ctx.save({ releaseAssignment: assignment });
    const files = [];
    if (manifest.version !== version) { manifest.version = version; await writeMetadata(filename, manifest); files.push('package.json'); }
    const lockFilename = path.join(ctx.cwd, 'package-lock.json');
    try {
      const lock = parse(await readFile(lockFilename, 'utf8'), 'package-lock.json');
      if (lock.version !== version || lock.packages?.[''] && lock.packages[''].version !== version) {
        lock.version = version;
        if (lock.packages?.['']) lock.packages[''].version = version;
        await writeMetadata(lockFilename, lock); files.push('package-lock.json');
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const registryFilename = path.join(ctx.cwd, 'registry.json');
    try {
      const registry = parse(await readFile(registryFilename, 'utf8'), 'registry.json');
      if (Array.isArray(registry.components) && typeof registry.version === 'string' && registry.version !== version) {
        registry.version = version; await writeMetadata(registryFilename, registry); files.push('registry.json');
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    assignment.prepared = true;
    await ctx.save({ releaseAssignment: assignment });
    await ctx.event('delivery.version_prepared', { version, files });
    return { version, changed: files.length > 0, files };
  } finally { await releaseOwnedLease(ctx, lease); }
}

async function verifyReleaseAssets(ctx, info, { tag, artifact, sha256: checksum }, directory) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? '') || path.basename(artifact ?? '') !== artifact || !/^[a-f0-9]{64}$/.test(checksum ?? '')) throw fail('release_conflict', 'Release receipt is invalid');
  if (info.tagName !== tag || !info.assets?.some(asset => asset.name === artifact) || !info.assets?.some(asset => asset.name === 'SHA256SUMS')) throw fail('release_conflict', 'Published release has incomplete assets');
  const downloaded = path.join(directory, `verify-${randomUUID()}`); await mkdir(downloaded);
  for (const filename of [artifact, 'SHA256SUMS']) await ctx.command('gh', ['release', 'download', tag, '--repo', ctx.repository, '--pattern', filename, '--dir', downloaded]);
  if (sha256(await readFile(path.join(downloaded, artifact))) !== checksum) throw fail('release_conflict', 'Published package differs from its release receipt');
  if ((await readFile(path.join(downloaded, 'SHA256SUMS'), 'utf8')).trim() !== `${checksum}  ${artifact}`) throw fail('release_conflict', 'Published checksum file differs from its release receipt');
  return { ...info, downloadedArtifact: path.join(downloaded, artifact) };
}

async function reusableRemotePackage(ctx, info, { tag, expectedSha }, directory) {
  const downloaded = path.join(directory, `recover-${randomUUID()}`); await mkdir(downloaded);
  const checksumFile = path.join(downloaded, 'SHA256SUMS');
  const hasChecksum = info.assets?.some(asset => asset.name === 'SHA256SUMS');
  let recorded;
  if (hasChecksum) {
    await ctx.command('gh', ['release', 'download', tag, '--repo', ctx.repository, '--pattern', 'SHA256SUMS', '--dir', downloaded]);
    const content = (await readFile(checksumFile, 'utf8')).trim();
    const match = /^([a-f0-9]{64})  ([a-zA-Z0-9_.-]+\.tgz)$/.exec(content);
    if (!match) throw fail('release_conflict', 'Published SHA256SUMS is not a single valid Kodo artifact');
    recorded = { checksum: match[1], filename: match[2] };
  }
  const attested = expectedSha ?? /^SHA-256: ([a-f0-9]{64})\s*$/m.exec(info.body ?? '')?.[1];
  if (!attested || recorded && recorded.checksum !== attested) throw fail('release_conflict', 'Release checksum is not bound to its original commit attestation');
  const archives = (info.assets ?? []).filter(asset => /^[a-zA-Z0-9_.-]+\.tgz$/.test(asset.name));
  const filename = recorded?.filename ?? (archives.length === 1 ? archives[0].name : null);
  if (archives.length > 1 && !recorded) throw fail('release_conflict', 'Release contains ambiguous package archives');
  if (!filename || !archives.some(asset => asset.name === filename)) return { missingArchive: true, expectedSha: attested, filename, hasChecksum };
  await ctx.command('gh', ['release', 'download', tag, '--repo', ctx.repository, '--pattern', filename, '--dir', downloaded]);
  const archivePath = path.join(downloaded, filename), checksum = sha256(await readFile(archivePath));
  if (checksum !== attested) throw fail('release_conflict', 'Published archive differs from its original commit attestation');
  if (!hasChecksum) await writeFile(checksumFile, `${checksum}  ${filename}\n`);
  return { archivePath, checksumFile, checksum, filename, hasChecksum };
}

async function getRelease(ctx, tag) {
  return parse(await ctx.command('gh', ['release', 'view', tag, '--repo', ctx.repository, '--json', 'url,tagName,assets,isDraft,isPrerelease,body,targetCommitish']), 'release information');
}

async function verifyPublishedArtifact(ctx, receipt, directory) {
  if (!/^v\d+\.\d+\.\d+$/.test(receipt.tag ?? '') || path.basename(receipt.artifact ?? '') !== receipt.artifact || !/^[a-f0-9]{64}$/.test(receipt.sha256 ?? '')) throw fail('release_conflict', 'Release receipt is invalid');
  await ctx.command('git', ['fetch', 'origin', '--tags']);
  const actualCommit = (await ctx.command('git', ['rev-parse', `refs/tags/${receipt.tag}^{commit}`])).trim();
  if (actualCommit !== receipt.commit) throw fail('release_conflict', 'Published tag points to a different commit');
  const info = await getRelease(ctx, receipt.tag);
  if (info.isDraft !== false) throw fail('release_conflict', 'Release has not been confirmed published');
  return verifyReleaseAssets(ctx, info, receipt, directory);
}

async function releaseInventory(ctx) {
  return parse(await ctx.command('gh', ['release', 'list', '--repo', ctx.repository, '--limit', '100', '--json', 'tagName,isDraft,isPrerelease']), 'release inventory');
}

function sortedPublished(releases) {
  return releases.filter(item => !item.isDraft && !item.isPrerelease && /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(item.tagName))
    .sort((a, b) => compareVersion(a.tagName.replace(/^v/, ''), b.tagName.replace(/^v/, '')));
}

async function publishedReleases(ctx) { return sortedPublished(await releaseInventory(ctx)); }

function assertOwnedDraft(ctx, info, version, candidate) {
  const marker = `<!-- kodo-release:${ctx.run.id}:${candidate} -->`;
  const legacy = info.body?.includes(`Kodo ${version}\n`) && info.body.includes(`\nCommit: ${candidate}\n`) && info.body.includes(`\nRun: ${ctx.run.id}\n`);
  if (info.tagName !== `v${version}` || info.targetCommitish !== candidate || info.isPrerelease || !(info.body?.includes(marker) || legacy)) throw fail('release_conflict', 'An unrelated draft already uses this tag; refusing to modify it');
}

async function assertCandidateFresh(ctx, candidate, version, latest) {
  const remoteHead = await fetchBase(ctx);
  const candidateIsAncestor = (await ctx.command('git', ['merge-base', candidate, remoteHead], { allowFailure: true })).trim() === candidate;
  // Release inventory may announce a tag created after our initial fetch;
  // explicitly fetch that ref even when origin disables automatic tag following.
  if (latest) await ctx.command('git', ['fetch', 'origin', 'tag', latest.tagName]);
  const latestSha = latest ? (await ctx.command('git', ['rev-parse', `${latest.tagName}^{commit}`])).trim() : null;
  const containsLatest = !latestSha || (await ctx.command('git', ['merge-base', latestSha, candidate], { allowFailure: true })).trim() === latestSha;
  assertFreshRelease({ candidateSha: candidate, remoteHead, candidateIsAncestor, latestSha, containsLatest, latestVersion: latest?.tagName, version });
}

/**
 * Publish an immutable package for an exact merged SHA. The receipt's tag URL
 * and artifact URL are authoritative. Kodo v1 never changes GitHub's mutable
 * "latest" alias, because independent publishers do not share a local lease.
 */
export async function releasePackage(options) {
  const ctx = context(options);
  validateRepository(ctx.repository, ctx.baseBranch);
  const candidate = options.mergeCommit;
  if (!/^[a-f0-9]{40,64}$/.test(candidate ?? '')) throw fail('configuration', 'A full merged commit SHA is required for release');
  const lease = await acquire(ctx, `release:${ctx.repository}:${ctx.baseBranch}`);
  let directory, source;
  try {
    directory = await mkdtemp(path.join(os.tmpdir(), 'kodo-release-'));
    const savedReceipt = ctx.run.delivery?.release;
    if (savedReceipt?.published === true && savedReceipt.commit === candidate) {
      const info = await verifyPublishedArtifact(ctx, savedReceipt, directory);
      const manifest = parse(await ctx.command('git', ['show', `${candidate}:package.json`]), 'release commit manifest');
      if (manifest.version !== savedReceipt.version) throw fail('release_conflict', 'Saved release version differs from its exact commit');
      const smoke = await smokePackage(ctx, info.downloadedArtifact, directory, manifest);
      const receipt = { ...savedReceipt, url: info.url, smoke };
      await ctx.save({ delivery: { ...(ctx.run.delivery ?? {}), release: receipt } });
      return receipt;
    }
    source = path.join(directory, 'source');
    await ctx.command('git', ['fetch', 'origin', ctx.baseBranch, '--tags']);
    await ctx.command('git', ['worktree', 'add', '--detach', source, candidate]);
    const manifest = parse(await readFile(path.join(source, 'package.json'), 'utf8'), 'package.json');
    const version = manifest.version;
    const inventory = await releaseInventory(ctx);
    const releases = sortedPublished(inventory);
    const latest = releases.at(-1);
    const expectedVersion = ctx.run.releaseAssignment?.version ?? (latest ? (ctx.config.delivery?.nextVersion ?? version) : (ctx.config.delivery?.firstVersion ?? version));
    if (version !== expectedVersion) throw fail('release_version_mismatch', `Reviewed package version ${version} does not match configured release ${expectedVersion}`);
    // Reconciliation of this exact release remains valid after main advances.
    const tag = `v${version}`;
    const taggedCommit = (await ctx.command('git', ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`], { allowFailure: true })).trim();
    if (taggedCommit && taggedCommit !== candidate) throw fail('release_conflict', 'The proposed release tag already points to another commit');
    let existing = releases.some(item => item.tagName === tag) && taggedCommit === candidate;
    const draft = inventory.find(item => item.tagName === tag && item.isDraft);
    if (draft) assertOwnedDraft(ctx, await getRelease(ctx, tag), version, candidate);
    if (taggedCommit && !existing && !draft) throw fail('release_conflict', 'The proposed tag is already in use without a matching Kodo release');
    if (!existing) await assertCandidateFresh(ctx, candidate, version, latest);
    let existingInfo, notes, remotePackage;
    if (existing || draft) {
      existingInfo = await getRelease(ctx, tag);
      assertOwnedDraft(ctx, existingInfo, version, candidate);
      if (draft) existing = existingInfo.isDraft === false;
      remotePackage = await reusableRemotePackage(ctx, existingInfo, { tag }, directory);
    }
    let artifactPath, filename, checksum, checksumFile, updateDraftAttestation = false;
    if (remotePackage?.archivePath) {
      ({ archivePath: artifactPath, filename, checksum, checksumFile } = remotePackage);
    } else {
      if (Object.keys(manifest.dependencies ?? {}).length || Object.keys(manifest.devDependencies ?? {}).length) {
        let hasLock = false;
        try { await access(path.join(source, 'package-lock.json')); hasLock = true; } catch { /* no lock */ }
        await ctx.command('npm', [hasLock ? 'ci' : 'install', '--ignore-scripts', '--no-audit', '--no-fund', ...(hasLock ? [] : ['--no-package-lock'])], { cwd: source, timeoutMs: 300000 });
      }
      for (const check of [...(ctx.config.commands?.test ?? []), ...(ctx.config.commands?.build ?? [])]) {
        await ctx.command(check.command, check.args ?? [], { cwd: source, timeoutMs: check.timeoutMs ?? 600000 });
      }
      const artifacts = path.join(directory, 'artifacts'); await mkdir(artifacts);
      const packed = await pack(ctx, source, artifacts);
      artifactPath = packed.filename; filename = path.basename(artifactPath);
      checksum = sha256(await readFile(artifactPath));
      checksumFile = path.join(artifacts, 'SHA256SUMS');
      await writeFile(checksumFile, `${checksum}  ${filename}\n`);
      if (remotePackage && (remotePackage.expectedSha !== checksum || remotePackage.filename && remotePackage.filename !== filename)) {
        // An owned, empty draft has no immutable uploaded bytes yet. A fresh
        // build of its exact commit may update that draft's checksum notes.
        if (existingInfo.isDraft && !existingInfo.assets?.length) updateDraftAttestation = true;
        else throw fail('release_conflict', 'The missing original archive cannot be reproduced without replacing an existing checksum/asset');
      }
    }
    const smoke = await smokePackage(ctx, artifactPath, directory, manifest);
    if (!existing) {
      await assertCandidateFresh(ctx, candidate, version, latest);
      const latestBeforePublish = (await publishedReleases(ctx)).at(-1);
      if (latestBeforePublish?.tagName !== latest?.tagName) throw fail('stale_release', 'Published release state changed while preparing the package; prepare its version again');
      notes = path.join(directory, 'notes.md');
      const content = updateDraftAttestation ? existingInfo.body.replace(/^SHA-256: [a-f0-9]{64}\s*$/m, `SHA-256: ${checksum}`) : `Kodo ${version}\n\n${ctx.run.task}\n\nCommit: ${candidate}\nRun: ${ctx.run.id}\n\nSHA-256: ${checksum}\n\nPackage installation and CLI smoke checks passed on ${process.platform}, Node.js ${process.version}.\n\n<!-- kodo-release:${ctx.run.id}:${candidate} -->\n`;
      await writeFile(notes, content);
    }
    return await ctx.irreversible(async () => {
      if (existingInfo) {
        // A process can die after creating the release but before uploading every
        // asset. Upload only absent names; never replace an existing asset.
        if (updateDraftAttestation) await ctx.command('gh', ['release', 'edit', tag, '--repo', ctx.repository, '--notes-file', notes, '--draft', '--latest=false', '--target', candidate], { ignoreAbort: true });
        if (!existingInfo.assets?.some(asset => asset.name === filename)) await ctx.command('gh', ['release', 'upload', tag, artifactPath, '--repo', ctx.repository], { ignoreAbort: true });
        if (!existingInfo.assets?.some(asset => asset.name === 'SHA256SUMS')) await ctx.command('gh', ['release', 'upload', tag, checksumFile, '--repo', ctx.repository], { ignoreAbort: true });
      } else {
        await ctx.command('gh', ['release', 'create', tag, artifactPath, checksumFile, '--repo', ctx.repository, '--target', candidate, '--title', `Kodo ${version}`, '--notes-file', notes, '--draft', '--latest=false'], { ignoreAbort: true });
      }
      const ready = await getRelease(ctx, tag);
      if (ready.isDraft) {
        assertOwnedDraft(ctx, ready, version, candidate);
        await verifyReleaseAssets(ctx, ready, { tag, artifact: filename, sha256: checksum }, directory);
        const latestAtPublication = (await publishedReleases(ctx)).at(-1);
        await assertCandidateFresh(ctx, candidate, version, latestAtPublication);
        await ctx.command('gh', ['release', 'edit', tag, '--repo', ctx.repository, '--draft=false', '--latest=false', '--target', candidate], { ignoreAbort: true });
      }
      const published = await verifyPublishedArtifact(ctx, { tag, commit: candidate, artifact: filename, sha256: checksum }, directory);
      const receipt = { version, tag, commit: candidate, url: published.url, artifact: filename, artifactUrl: `https://github.com/${ctx.repository}/releases/download/${tag}/${filename}`, sha256: checksum, smoke, published: true };
      await ctx.save({ delivery: { ...(ctx.run.delivery ?? {}), mergeCommit: candidate, release: receipt } });
      await ctx.event('delivery.released', receipt);
      return receipt;
    });
  } finally {
    try {
      if (source) await ctx.command('git', ['worktree', 'remove', '--force', source], { allowFailure: true, ignoreAbort: true, reconcile: true }).catch(() => {});
      if (directory) await safeRemove(directory, 'kodo-release-');
    } finally { await releaseOwnedLease(ctx, lease); }
  }
}
