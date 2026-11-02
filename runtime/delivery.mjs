import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { workerEnvironment } from './security.mjs';

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
  const environment = ['git', 'gh'].includes(command) ? (env ?? process.env) : workerEnvironment(env ?? process.env);
  let executable = command, argv = args;
  if (command === 'npm') {
    const [node, prefix] = await npmCommand(); executable = node; argv = [...prefix, ...args];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv, { cwd, env: environment, signal, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
    const environment = ['git', 'gh'].includes(name) ? (settings.env ?? process.env) : workerEnvironment(settings.env ?? process.env);
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

export function assertFreshRelease({ candidateSha, remoteHead, latestSha, latestVersion, version }) {
  if (!candidateSha || candidateSha !== remoteHead) throw fail('stale_release', 'Release candidate is no longer the current target branch head');
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw fail('release_version_mismatch', 'Release version must be X.Y.Z');
  if (latestVersion) {
    const previous = latestVersion.replace(/^v/, '').split('.').map(Number);
    const current = version.split('.').map(Number);
    if (previous.some(Number.isNaN) || previous.length !== 3) throw fail('release_version_mismatch', 'Latest release has an unsupported version');
    let comparison = 0;
    for (let index = 0; index < 3 && !comparison; index++) comparison = Math.sign(current[index] - previous[index]);
    if (comparison < 0 || comparison === 0 && latestSha !== candidateSha) throw fail('stale_release', 'Release would replace the same or a newer published version');
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
  return parse(await ctx.command('gh', ['pr', 'view', String(number), '--repo', ctx.repository, '--json', 'number,url,state,mergedAt,mergeCommit,headRefOid,baseRefName,statusCheckRollup']), 'gh pr view');
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
  let saved = ctx.run.delivery ?? {};
  if (saved.pr?.number) {
    const previous = await getPr(ctx, saved.pr.number);
    if (previous.state === 'MERGED') {
      if (previous.headRefOid !== ctx.run.headSha || previous.baseRefName !== ctx.baseBranch) throw fail('stale_review', 'Saved PR no longer matches this run head and target');
      const mergeCommit = previous.mergeCommit?.oid;
      if (!mergeCommit) throw fail('invalid_output', 'Merged PR is missing merge commit');
      const receipt = { ...saved, pr: { number: previous.number, url: previous.url }, mergeCommit };
      await ctx.save({ delivery: receipt });
      return receipt;
    }
  }
  const { head, diffHash } = await verifyReview(ctx);
  const required = await requiredChecks(ctx);
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
    if (merged.headRefOid !== head || merged.baseRefName !== ctx.baseBranch) throw fail('stale_review', 'Merged PR does not match this run');
    const receipt = { ...saved, mergeCommit: merged.mergeCommit?.oid };
    if (!receipt.mergeCommit) throw fail('invalid_output', 'Merged PR is missing merge commit');
    await ctx.save({ delivery: receipt }); return receipt;
  }
  await ctx.command('gh', ['api', '--method', 'POST', `repos/${ctx.repository}/statuses/${head}`, '-f', 'state=success', '-f', 'context=kodo/review', '-f', 'description=Independent Kodo review passed for this exact diff']);
  await awaitChecks(ctx, pr.number, head, required);
  const lease = await acquire(ctx, `merge:${ctx.repository}:${ctx.baseBranch}`);
  try {
    const currentBase = await fetchBase(ctx);
    if (currentBase !== ctx.run.baseSha) throw fail('stale_base', 'Target branch advanced; synchronize, retest and review before merge', { baseSha: currentBase });
    await awaitChecks(ctx, pr.number, head, required);
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
      const receipt = { ...saved, mergeCommit: merged.mergeCommit.oid };
      await ctx.save({ delivery: receipt });
      await ctx.event('delivery.merged', { pr: receipt.pr, mergeCommit: receipt.mergeCommit });
      return receipt;
    });
  } finally { await releaseOwnedLease(ctx, lease); }
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
  const entry = path.join(install, 'node_modules', ...manifest.name.split('/'), bin);
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
    const releases = parse(await ctx.command('gh', ['release', 'list', '--repo', ctx.repository, '--limit', '100', '--json', 'tagName,isDraft,isPrerelease']), 'release versions');
    const versions = releases.filter(item => !item.isDraft && !item.isPrerelease && /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(item.tagName)).map(item => item.tagName.replace(/^v/, '')).sort(compareVersion);
    const latest = versions.at(-1);
    const saved = ctx.run.releaseAssignment;
    const previousVersion = saved?.version === manifest.version ? saved.previousVersion : manifest.version;
    let version;
    if (saved && (manifest.version === saved.version || saved.baseSha === ctx.run.baseSha && manifest.version === saved.previousVersion) && (!latest || compareVersion(saved.version, latest) > 0)) version = saved.version;
    else if (ctx.config.delivery?.nextVersion) version = ctx.config.delivery.nextVersion;
    else if (!latest) version = ctx.config.delivery?.firstVersion ?? '0.2.0';
    else {
      const greatest = compareVersion(previousVersion, latest) > 0 ? previousVersion : latest;
      const [major, minor, patch] = versionParts(greatest); version = `${major}.${minor}.${patch + 1}`;
    }
    versionParts(version);
    if (latest && compareVersion(version, latest) <= 0) throw fail('release_version_mismatch', 'Assigned release version must be newer than published releases');
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

async function verifyPublishedArtifact(ctx, { tag, commit, artifact, sha256: checksum }, directory) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? '') || path.basename(artifact ?? '') !== artifact || !/^[a-f0-9]{64}$/.test(checksum ?? '')) throw fail('release_conflict', 'Release receipt is invalid');
  await ctx.command('git', ['fetch', 'origin', '--tags']);
  const actualCommit = (await ctx.command('git', ['rev-parse', `refs/tags/${tag}^{commit}`])).trim();
  if (actualCommit !== commit) throw fail('release_conflict', 'Published tag points to a different commit');
  const info = parse(await ctx.command('gh', ['release', 'view', tag, '--repo', ctx.repository, '--json', 'url,tagName,assets']), 'published release');
  if (info.tagName !== tag || !info.assets?.some(asset => asset.name === artifact) || !info.assets?.some(asset => asset.name === 'SHA256SUMS')) throw fail('release_conflict', 'Published release has incomplete assets');
  const downloaded = path.join(directory, `verify-${randomUUID()}`); await mkdir(downloaded);
  for (const filename of [artifact, 'SHA256SUMS']) await ctx.command('gh', ['release', 'download', tag, '--repo', ctx.repository, '--pattern', filename, '--dir', downloaded]);
  if (sha256(await readFile(path.join(downloaded, artifact))) !== checksum) throw fail('release_conflict', 'Published package differs from its release receipt');
  if ((await readFile(path.join(downloaded, 'SHA256SUMS'), 'utf8')).trim() !== `${checksum}  ${artifact}`) throw fail('release_conflict', 'Published checksum file differs from its release receipt');
  return info;
}

async function publishedReleases(ctx) {
  const releases = parse(await ctx.command('gh', ['release', 'list', '--repo', ctx.repository, '--limit', '100', '--json', 'tagName,isDraft,isPrerelease']), 'published releases');
  return releases.filter(item => !item.isDraft && !item.isPrerelease && /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(item.tagName))
    .sort((a, b) => compareVersion(a.tagName.replace(/^v/, ''), b.tagName.replace(/^v/, '')));
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
      return { ...savedReceipt, url: info.url };
    }
    source = path.join(directory, 'source');
    await ctx.command('git', ['fetch', 'origin', ctx.baseBranch, '--tags']);
    await ctx.command('git', ['worktree', 'add', '--detach', source, candidate]);
    const manifest = parse(await readFile(path.join(source, 'package.json'), 'utf8'), 'package.json');
    const version = manifest.version;
    const releases = await publishedReleases(ctx);
    const latest = releases.at(-1);
    const latestSha = latest ? (await ctx.command('git', ['rev-parse', `${latest.tagName}^{commit}`])).trim() : null;
    const expectedVersion = ctx.run.releaseAssignment?.version ?? (latest ? (ctx.config.delivery?.nextVersion ?? version) : (ctx.config.delivery?.firstVersion ?? version));
    if (version !== expectedVersion) throw fail('release_version_mismatch', `Reviewed package version ${version} does not match configured release ${expectedVersion}`);
    const remoteHead = await fetchBase(ctx);
    // Reconciliation of this exact release remains valid after main advances.
    const tag = `v${version}`;
    const taggedCommit = (await ctx.command('git', ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`], { allowFailure: true })).trim();
    if (taggedCommit && taggedCommit !== candidate) throw fail('release_conflict', 'The proposed release tag already points to another commit');
    const existing = releases.some(item => item.tagName === tag) && taggedCommit === candidate;
    if (!existing) assertFreshRelease({ candidateSha: candidate, remoteHead, latestSha, latestVersion: latest?.tagName, version });
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
    const filename = path.basename(packed.filename);
    const checksum = sha256(await readFile(packed.filename));
    const checksumFile = path.join(artifacts, 'SHA256SUMS');
    await writeFile(checksumFile, `${checksum}  ${filename}\n`);
    const smoke = await smokePackage(ctx, packed.filename, directory, manifest);
    let existingInfo, notes;
    if (existing) {
      existingInfo = parse(await ctx.command('gh', ['release', 'view', tag, '--repo', ctx.repository, '--json', 'url,tagName,assets']), 'existing release');
    } else {
      assertFreshRelease({ candidateSha: candidate, remoteHead: await fetchBase(ctx), latestSha, latestVersion: latest?.tagName, version });
      const latestBeforePublish = (await publishedReleases(ctx)).at(-1);
      if (latestBeforePublish?.tagName !== latest?.tagName) throw fail('stale_release', 'Published release state changed while preparing the package; prepare its version again');
      notes = path.join(directory, 'notes.md');
      await writeFile(notes, `Kodo ${version}\n\n${ctx.run.task}\n\nCommit: ${candidate}\nRun: ${ctx.run.id}\n\nSHA-256: ${checksum}\n\nPackage installation and CLI smoke checks passed on ${process.platform}, Node.js ${process.version}.\n`);
    }
    return await ctx.irreversible(async () => {
      if (existing) {
        // A process can die after creating the release but before uploading every
        // asset. Upload only absent names; never replace an existing asset.
        if (!existingInfo.assets?.some(asset => asset.name === filename)) await ctx.command('gh', ['release', 'upload', tag, packed.filename, '--repo', ctx.repository], { ignoreAbort: true });
        if (!existingInfo.assets?.some(asset => asset.name === 'SHA256SUMS')) await ctx.command('gh', ['release', 'upload', tag, checksumFile, '--repo', ctx.repository], { ignoreAbort: true });
      } else {
        await ctx.command('gh', ['release', 'create', tag, packed.filename, checksumFile, '--repo', ctx.repository, '--target', candidate, '--title', `Kodo ${version}`, '--notes-file', notes, '--latest=false'], { ignoreAbort: true });
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
