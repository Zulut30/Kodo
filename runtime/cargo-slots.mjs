import path from 'node:path';
import { constants } from 'node:fs';
import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { noLinks } from './toolchains.mjs';

// An OS-backed exclusive writer lock per slot. No TTL can expire mid-build;
// process death closes the handle. Never hold the main Store writer lock.
export function tryCargoLock(filename, open = () => new DatabaseSync(filename, { timeout: 0 })) {
  let db;
  try {
    db = open();
    db.exec('BEGIN IMMEDIATE');
    return db;
  } catch (error) {
    db?.close();
    if ((error.errcode & 0xff) === 5) return null;
    throw error;
  }
}

async function sccachePath(env) {
  const variable = Object.keys(env).find(name => name.toUpperCase() === 'PATH');
  for (const entry of (env[variable] ?? '').split(path.delimiter)) {
    const folder = process.platform === 'win32' ? entry.replace(/^"(.*)"$/, '$1') : entry;
    if (!path.isAbsolute(folder)) continue;
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

// Cargo names the artifacts of a workspace (path) package by a hash taken relative to its
// workspace root and judges their freshness by file mtimes. Two worktrees of one repository that
// share a target directory therefore share artifact names: a slot last built from another
// checkout can hand a task that checkout's library, test binary or build-script output (OUT_DIR)
// when the task's sources are older than the artifact (a false failure, or a false pass). A
// selective purge cannot see every such state (OUT_DIR contents, renamed units), so the slot
// remembers the checkout it last built and starts empty for another one; the same checkout keeps
// its incremental state. sccache (`rust.sccache`) keys by content and keeps a switch cheap.
const CHECKOUT_MARKER = '.kodo-checkout';

async function claimForCheckout(target, checkout) {
  if (checkout === undefined) return;
  const current = path.resolve(checkout);
  const marker = path.join(target, CHECKOUT_MARKER);
  await noLinks(marker);
  let previous = null;
  try {
    previous = await readFile(marker, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (previous === current) return;
  // `target` itself passed noLinks; rm removes links inside without following them.
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true, mode: 0o700 });
  await writeFile(marker, current, { mode: 0o600 });
}

/**
 * `checkout`: the worktree the build runs in; a slot last built from another checkout starts
 * empty (see CHECKOUT_MARKER).
 * @param {{home:string, projectId:string, maxHeavyBuilds?:number, sccache?:boolean|'auto', env?:NodeJS.ProcessEnv,
 *   signal?:AbortSignal, checkout?:string}} options
 */
export async function withCargoSlot(
  { home, projectId, maxHeavyBuilds = 1, sccache = false, env = {}, signal, checkout },
  work,
) {
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
      const db = tryCargoLock(lock);
      if (!db) continue;
      try {
        const target = path.join(pool, projectId, `slot-${n}`);
        await noLinks(target);
        await mkdir(target, { recursive: true, mode: 0o700 });
        await claimForCheckout(target, checkout);
        const inherited = Object.fromEntries(
          Object.entries(env).filter(
            ([key]) =>
              ![
                'RUSTC_WRAPPER',
                'RUSTC_WORKSPACE_WRAPPER',
                'CARGO_BUILD_RUSTC_WRAPPER',
                'CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER',
                'CARGO_BUILD_TARGET_DIR',
                'CARGO_TARGET_DIR',
                'CARGO_BUILD_BUILD_DIR',
                'CARGO_NET_OFFLINE',
                'RUSTUP_AUTO_INSTALL',
              ].includes(key.toUpperCase()),
          ),
        );
        /** @type {NodeJS.ProcessEnv} */
        const buildEnv = {
          ...inherited,
          CARGO_TARGET_DIR: target,
          // A project's `build.build-dir` would keep intermediate artifacts (test binaries) outside
          // the slot and its checkout guard; the environment overrides the config.
          CARGO_BUILD_BUILD_DIR: target,
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
