import path from 'node:path';
import { constants } from 'node:fs';
import { access, mkdir, stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { noLinks } from './toolchains.mjs';

// An OS-backed exclusive writer lock per slot. No TTL can expire mid-build;
// process death closes the handle. Never hold the main Store writer lock.
function trySlot(filename) {
  const db = new DatabaseSync(filename, { timeout: 0 });
  try {
    db.exec('BEGIN IMMEDIATE');
    return db;
  } catch (error) {
    db.close();
    if ((error.errcode & 0xff) === 5) return null;
    throw error;
  }
}

async function sccachePath(env) {
  const variable = Object.keys(env).find(name => name.toUpperCase() === 'PATH');
  for (const folder of (env[variable] ?? '').split(path.delimiter).filter(path.isAbsolute)) {
    const file = path.join(folder, process.platform === 'win32' ? 'sccache.exe' : 'sccache');
    try {
      await access(file, constants.X_OK);
      if ((await stat(file)).isFile()) return file;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error;
    }
  }
  return null;
}

/** @param {{home:string, projectId:string, maxHeavyBuilds?:number, sccache?:boolean|'auto', env?:NodeJS.ProcessEnv, signal?:AbortSignal}} options */
export async function withCargoSlot({ home, projectId, maxHeavyBuilds = 1, sccache = false, env = {}, signal }, work) {
  if (
    typeof projectId !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(projectId) ||
    !Number.isSafeInteger(maxHeavyBuilds) ||
    maxHeavyBuilds < 1
  )
    throw new Error('Invalid Cargo slot configuration');
  const pool = path.join(home, 'cargo-target');
  await noLinks(pool);
  await mkdir(pool, { recursive: true, mode: 0o700 });
  for (;;) {
    signal?.throwIfAborted();
    for (let n = 1; n <= maxHeavyBuilds; n++) {
      const lock = path.join(pool, `slot-${n}.sqlite`);
      await noLinks(lock);
      const db = trySlot(lock);
      if (!db) continue;
      try {
        const target = path.join(pool, projectId, `slot-${n}`);
        await noLinks(target);
        await mkdir(target, { recursive: true, mode: 0o700 });
        const inherited = Object.fromEntries(
          Object.entries(env).filter(
            ([key]) =>
              !['RUSTC_WRAPPER', 'CARGO_TARGET_DIR', 'CARGO_NET_OFFLINE', 'RUSTUP_AUTO_INSTALL'].includes(
                key.toUpperCase(),
              ),
          ),
        );
        /** @type {NodeJS.ProcessEnv} */
        const buildEnv = {
          ...inherited,
          CARGO_TARGET_DIR: target,
          CARGO_NET_OFFLINE: 'true',
          RUSTUP_AUTO_INSTALL: '0',
        };
        const wrapper = (sccache === 'auto' || sccache === true) && (await sccachePath(env));
        if (wrapper) buildEnv.RUSTC_WRAPPER = wrapper;
        return await work(buildEnv);
      } finally {
        db.close();
      }
    }
    await delay(100, undefined, { signal });
  }
}
