import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { execute } from './command.mjs';

const LIMIT = 64 * 1024 * 1024;
const error = code => Object.assign(new Error('Project transport'), { code });

export function remoteRefs(projectId, run) {
  if (!['ssh', 't3-env'].includes(run.workerPlacement?.machine?.kind)) return null;
  return {
    repository: run.transportRemote ?? 'origin',
    baseRef: `refs/kodo/${projectId}/base/${run.id}`,
    workRef: `refs/kodo/${projectId}/work/${run.id}`,
  };
}

export async function transport(cwd, args, signal, input = undefined) {
  try {
    signal?.throwIfAborted();
    return (await execute('git', args, { cwd, signal, input, timeoutMs: 120000 })).stdout.trim();
  } catch (cause) {
    if (signal?.aborted)
      throw signal.reason?.code === 'project_lease_lost' || signal.reason?.code === 'project_transport_too_large'
        ? signal.reason
        : error('project_cancelled');
    if (cause?.code === 'invalid_output') throw error('project_transport_too_large');
    throw error('project_transport_failed');
  }
}

async function configured(run, remote, signal) {
  const names = await transport(run.project, ['remote'], signal);
  if (!names.split(/\r?\n/).includes(remote.repository)) throw error('project_transport_failed');
}

export async function pushBase(run, remote, signal) {
  await configured(run, remote, signal);
  await transport(run.project, ['push', remote.repository, run.baseSha + ':' + remote.baseRef], signal);
}

// Receive into an isolated pack directory. Watch the incoming pack during transfer;
// check it again at EOF, and bound expanded objects before importing anything into the project.
export async function fetchSubmission(run, remote, head, signal, checkLease) {
  await configured(run, remote, signal);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'kodo-fetch-'));
  const guard = new AbortController();
  const stopped = AbortSignal.any([signal, guard.signal]);
  const isolated = args => transport(run.project, ['--git-dir=' + scratch, ...args], stopped);
  const packDir = path.join(scratch, 'objects', 'pack');
  const measure = async () => {
    let bytes = 0;
    for (const file of await readdir(packDir)) {
      try {
        bytes += (await stat(path.join(packDir, file))).size;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    if (bytes > LIMIT) guard.abort(error('project_transport_too_large'));
  };
  let timer, pending;
  try {
    await transport(
      run.project,
      ['init', '--bare', '--object-format=' + (run.baseSha.length === 64 ? 'sha256' : 'sha1'), scratch],
      stopped,
    );
    const common = await transport(run.project, ['rev-parse', '--path-format=absolute', '--git-common-dir'], stopped);
    await writeFile(
      path.join(scratch, 'objects/info/alternates'),
      path.join(common, 'objects').split(path.sep).join('/') + '\n',
    );
    await isolated(['update-ref', 'refs/heads/base', run.baseSha]);
    timer = setInterval(() => {
      pending ??= measure()
        .catch(() => guard.abort(error('project_transport_failed')))
        .finally(() => {
          pending = null;
        });
    }, 50);
    await isolated([
      '-c',
      'include.path=' + path.join(common, 'config'),
      '-c',
      'fetch.unpackLimit=1',
      'fetch',
      '--no-tags',
      '--no-auto-maintenance',
      '--no-write-fetch-head',
      '--refmap=',
      remote.repository,
      remote.workRef + ':refs/kodo/incoming',
    ]);
    await measure();
    stopped.throwIfAborted();
    if ((await isolated(['rev-parse', 'refs/kodo/incoming'])) !== head) return 'project_transport_head_mismatch';
    const objects = await isolated(['rev-list', '--objects', '--no-object-names', head, '^' + run.baseSha]);
    if (objects) {
      const sizes = await transport(
        run.project,
        ['--git-dir=' + scratch, 'cat-file', '--batch-check=%(objectsize)'],
        stopped,
        objects + '\n',
      );
      const total = sizes.split(/\s+/).reduce((sum, n) => sum + Number(n), 0);
      if (!Number.isSafeInteger(total) || total > LIMIT) return 'project_transport_too_large';
    }
    checkLease();
    await transport(
      run.project,
      [
        'fetch',
        '--no-tags',
        '--no-write-fetch-head',
        '--no-auto-maintenance',
        scratch,
        '+refs/kodo/incoming:refs/kodo/fetched/' + run.id,
      ],
      stopped,
    );
    return null;
  } catch (cause) {
    if (guard.signal.reason?.code === 'project_transport_too_large') return 'project_transport_too_large';
    throw cause;
  } finally {
    clearInterval(timer);
    await pending;
    await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
  }
}

export async function cleanupRemoteRefs(run, signal) {
  const remote = remoteRefs(run.directorBinding.projectId, run);
  if (!remote) return;
  await transport(run.project, ['update-ref', '-d', 'refs/kodo/fetched/' + run.id], signal);
  try {
    await configured(run, remote, signal);
    const refs = [remote.baseRef, remote.workRef];
    const listed = await transport(run.project, ['ls-remote', '--refs', remote.repository, ...refs], signal);
    const live = listed
      .split(/\r?\n/)
      .map(row => row.split('\t'))
      .filter(([sha, ref]) => /^[a-f0-9]{40,64}$/.test(sha) && refs.includes(ref));
    if (live.length)
      await transport(
        run.project,
        [
          'push',
          ...live.map(([sha, ref]) => '--force-with-lease=' + ref + ':' + sha),
          remote.repository,
          ...live.map(([, ref]) => ':' + ref),
        ],
        signal,
      );
  } catch {
    // A terminal Run is retained as the retry record for gc-worktrees.
  }
}
