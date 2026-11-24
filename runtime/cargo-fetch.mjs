import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { noLinks } from './toolchains.mjs';
import { tryCargoLock } from './cargo-slots.mjs';
import { execute } from './command.mjs';

// Called while the build slot is held. The second lock coalesces fetches across
// different target slots. A crashed/failed fetch cannot commit its ready flag.
export async function warmCargoDependencies({ home, cwd, command, env, signal, timeoutMs, secrets }) {
  try {
    const windows = process.platform === 'win32';
    const variable = name =>
      windows ? Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1] : env[name];
    const profile = variable(windows ? 'USERPROFILE' : 'HOME') || os.homedir();
    const cargoHome = path.resolve(cwd, variable('CARGO_HOME') || path.join(profile, '.cargo'));
    const lockfile = path.join(cwd, 'Cargo.lock');
    await noLinks(lockfile);
    const key = createHash('sha256')
      .update(os.hostname())
      .update('\0')
      .update(cargoHome)
      .update('\0')
      .update(await readFile(lockfile))
      .digest('hex');
    const directory = path.join(home, 'cargo-fetch');
    const filename = path.join(directory, key + '.sqlite');
    await noLinks(filename);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let db;
    while (!(db = tryCargoLock(filename))) await delay(100, undefined, { signal });
    try {
      signal?.throwIfAborted();
      if (db.prepare('PRAGMA user_version').get().user_version === 1) return;
      const fetch = await execute(command, ['fetch', '--locked'], {
        cwd,
        env: { ...env, CARGO_NET_OFFLINE: 'false' },
        timeoutMs,
        signal,
        secrets,
      });
      signal?.throwIfAborted();
      if (fetch.code !== 0) throw new Error('Процесс Cargo завершился без успешного кода выхода');
      db.exec('PRAGMA user_version=1; COMMIT');
    } finally {
      db.close();
    }
  } catch (error) {
    if (signal?.aborted || error.code === 'cancelled') throw error;
    throw Object.assign(new Error('Не удалось подготовить зависимости Cargo: ' + error.message, { cause: error }), {
      code: 'cargo_fetch_failed',
      scope: 'environment',
    });
  }
}
