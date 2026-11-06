import { lstat, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { workerEnvironment } from './security.mjs';
import { gitBoundary } from './command.mjs';
import {
  fail,
  parse,
  wait,
  commandRedactions,
  redactCommandOutput,
  redactCommandError,
  commandFailure,
  execute,
} from './delivery-process.mjs';

/** Delivery context, repository validation, leases, owned temporary directories and version inventory shared by PR delivery and releases. */
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
    const unprivileged = workerEnvironment(baseEnv);
    const redactions = commandRedactions(baseEnv, unprivileged, options.secrets);
    const environment = /(?:^|[\\/])git(?:\.exe)?$/i.test(name)
      ? gitBoundary(args, baseEnv).env
      : /(?:^|[\\/])gh(?:\.exe)?$/i.test(name)
        ? gitBoundary(['ls-remote'], baseEnv).env
        : unprivileged;
    try {
      const result = await runner(name, args, {
        cwd,
        ...settings,
        secrets: redactions,
        env: environment,
        signal: settings.ignoreAbort || finishingIrreversible ? undefined : signal,
      });
      if (result.code && !settings.allowFailure) throw commandFailure(name, 'command_failed', result, {}, redactions);
      return result.stdout?.trimEnd() ?? '';
    } catch (error) {
      const clean = redactCommandError(error, redactions);
      // Engine's summary stores only message. Keep the full bounded diagnostics
      // separately before cleanup, without argv or environment/credentials.
      if (clean?.stdout || clean?.stderr) {
        try {
          await event(
            'delivery.command_failed',
            redactCommandOutput(
              {
                command: name,
                code: clean.code,
                exitCode: clean.exitCode,
                stdout: clean.stdout,
                stderr: clean.stderr,
                outputTruncated: clean.result?.outputTruncated === true,
              },
              redactions,
            ),
          );
        } catch {
          /* Diagnostic persistence failure must not replace the command. */
        }
      }
      throw clean;
    }
  };
  const event = async (type, data) => {
    await store?.event?.(run.id, type, data);
    await options.onEvent?.({ type, ...data });
  };
  const save = async patch => {
    Object.assign(run, patch);
    await store?.updateRun?.(run.id, patch);
  };
  const irreversible = async action => {
    checkpoint();
    // Cancellation is honored before an irreversible unit. Once it has begun,
    // finish its bounded confirmation/receipt sequence instead of killing a
    // process whose remote mutation may already have succeeded.
    const previous = finishingIrreversible;
    finishingIrreversible = true;
    try {
      return await action();
    } finally {
      finishingIrreversible = previous;
    }
  };
  return {
    ...options,
    run,
    config,
    cwd,
    signal,
    command,
    event,
    save,
    irreversible,
    leaseRegistry,
    repository: config.repository,
    baseBranch: config.baseBranch ?? 'main',
  };
}

function validateRepository(repository, branch) {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository ?? ''))
    throw fail('configuration', 'A GitHub owner/repository is required');
  if (!branch || branch.startsWith('-') || /[\s~^:?*\[\\]|\.\.|@\{|\/$/.test(branch))
    throw fail('configuration', 'Invalid target branch');
}

export function assertFreshRelease({
  candidateSha,
  remoteHead,
  candidateIsAncestor = false,
  latestSha,
  containsLatest = false,
  latestVersion,
  version,
}) {
  if (!candidateSha || (candidateSha !== remoteHead && !candidateIsAncestor))
    throw fail('stale_release', 'Release candidate is not contained in the current target branch');
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw fail('release_version_mismatch', 'Release version must be X.Y.Z');
  if (latestVersion) {
    const previous = latestVersion.replace(/^v/, '').split('.').map(Number);
    const current = version.split('.').map(Number);
    if (previous.some(Number.isNaN) || previous.length !== 3)
      throw fail('release_version_mismatch', 'Latest release has an unsupported version');
    let comparison = 0;
    for (let index = 0; index < 3 && !comparison; index++) comparison = Math.sign(current[index] - previous[index]);
    if (comparison <= 0 || (latestSha && latestSha !== candidateSha && !containsLatest))
      throw fail('stale_release', 'Release would replace the same or a newer published result');
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
            if ((await ctx.store.renewLease(token)) === false)
              lease.error = fail('lease_lost', `Delivery queue lease expired: ${name}`);
          } catch (error) {
            lease.error = fail('lease_lost', `Delivery queue lease could not be renewed: ${name}`, { cause: error });
          }
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
  if (lease) {
    lease.active = false;
    clearInterval(lease.timer);
    ctx.leaseRegistry.delete(token);
  }
  await ctx.store.releaseLease(token);
}

async function fetchBase(ctx) {
  await ctx.command('git', ['fetch', 'origin', ctx.baseBranch]);
  return (await ctx.command('git', ['rev-parse', `origin/${ctx.baseBranch}`])).trim();
}

async function validateTemporary(directory, prefix, ownership) {
  const resolved = path.resolve(directory);
  if (
    !path.isAbsolute(directory) ||
    directory !== resolved ||
    !['kodo-pr-', 'kodo-release-'].includes(prefix) ||
    path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
    !path.basename(resolved).startsWith(prefix) ||
    path.basename(resolved) === prefix
  )
    throw fail('unsafe_path', 'Refusing to remove unexpected temporary directory');
  let current;
  try {
    current = await lstat(resolved);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (
    !ownership ||
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    current.dev !== ownership.dev ||
    current.ino !== ownership.ino ||
    (await realpath(resolved)) !== path.join(await realpath(os.tmpdir()), path.basename(resolved))
  )
    throw fail('unsafe_path', 'Refusing to remove replaced or linked temporary directory');
  return true;
}

async function safeRemove(directory, prefix, ownership) {
  for (let attempt = 0; ; attempt++) {
    if (!(await validateTemporary(directory, prefix, ownership))) return;
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= 3 || !['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(error.code)) throw error;
      await wait(50 * 2 ** attempt);
    }
  }
}

async function cleanupDelivery(ctx, primaryError, actions, confirmed = false) {
  const errors = [];
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      const detail = {
        code: error.code ?? 'cleanup_failed',
        message: redactCommandOutput(error.message, ctx.secrets).slice(0, 4000),
      };
      errors.push(detail);
      try {
        await ctx.event('delivery.cleanup_failed', detail);
      } catch {
        /* Reporting cleanup must not hide the primary command/receipt. */
      }
    }
  }
  if (!errors.length) return;
  if (primaryError) primaryError.cleanupErrors = [...(primaryError.cleanupErrors ?? []), ...errors];
  else if (!confirmed)
    throw fail('cleanup_failed', 'Delivery temporary cleanup failed; see cleanupErrors', { cleanupErrors: errors });
}

const versionParts = value => {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value ?? ''))
    throw fail('release_version_mismatch', `Unsupported release version: ${value}`);
  return value.split('.').map(Number);
};

function compareVersion(left, right) {
  const a = versionParts(left),
    b = versionParts(right);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return Math.sign(a[index] - b[index]);
  return 0;
}

async function releaseInventory(ctx) {
  return parse(
    await ctx.command('gh', [
      'release',
      'list',
      '--repo',
      ctx.repository,
      '--limit',
      '100',
      '--json',
      'tagName,isDraft,isPrerelease',
    ]),
    'release inventory',
  );
}

function sortedPublished(releases) {
  return releases
    .filter(
      item => !item.isDraft && !item.isPrerelease && /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(item.tagName),
    )
    .sort((a, b) => compareVersion(a.tagName.replace(/^v/, ''), b.tagName.replace(/^v/, '')));
}

async function publishedReleases(ctx) {
  return sortedPublished(await releaseInventory(ctx));
}

export {
  context,
  validateRepository,
  acquire,
  releaseOwnedLease,
  fetchBase,
  validateTemporary,
  safeRemove,
  cleanupDelivery,
  versionParts,
  compareVersion,
  releaseInventory,
  sortedPublished,
  publishedReleases,
};
