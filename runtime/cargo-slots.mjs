import path from 'node:path';
import { constants } from 'node:fs';
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
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
// checkout can hand a task that checkout's library when the task's sources are older than the
// artifact (a false failure, or a false pass). The slot remembers the checkout it last built;
// on a change the fingerprints of path packages (a `local` entry that checks dep-info) are
// removed, so Cargo rebuilds the workspace crates and keeps the registry dependencies.
const CHECKOUT_MARKER = '.kodo-checkout';

async function entries(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    throw error;
  }
}

// A unit fingerprint that checks dep-info is a path package; unreadable ones count as one.
async function localUnit(dir) {
  for (const entry of await entries(dir)) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const local = JSON.parse(await readFile(path.join(dir, entry.name), 'utf8'))?.local;
      if (!Array.isArray(local)) return true;
      if (local.some(item => item && typeof item === 'object' && 'CheckDepInfo' in item)) return true;
    } catch {
      return true;
    }
  }
  return false;
}

// `<package>-<metadata hash>`: the package part of a unit directory.
const unitPackage = name => name.replace(/-[0-9a-f]{16}$/, '');

// `.fingerprint` of each profile (`debug`, `release`, `<triple>/<profile>`) under the slot.
async function purgeLocalFingerprints(target) {
  const profiles = [];
  for (const first of await entries(target)) {
    if (!first.isDirectory()) continue;
    profiles.push(path.join(target, first.name));
    for (const second of await entries(path.join(target, first.name)))
      if (second.isDirectory() && second.name !== '.fingerprint')
        profiles.push(path.join(target, first.name, second.name));
  }
  for (const profile of profiles) {
    const fingerprints = path.join(profile, '.fingerprint');
    const units = (await entries(fingerprints)).filter(unit => unit.isDirectory());
    // Every unit of a path package goes, its build-script run (`RerunIfChanged`) included.
    const local = new Set();
    for (const unit of units)
      if (await localUnit(path.join(fingerprints, unit.name))) local.add(unitPackage(unit.name));
    for (const unit of units)
      if (local.has(unitPackage(unit.name)))
        await rm(path.join(fingerprints, unit.name), { recursive: true, force: true });
  }
}

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
  await purgeLocalFingerprints(target);
  await writeFile(marker, current, { mode: 0o600 });
}

/**
 * `checkout`: the worktree the build runs in; a slot last built from another checkout first drops
 * the fingerprints of its path packages (see CHECKOUT_MARKER).
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
                'CARGO_NET_OFFLINE',
                'RUSTUP_AUTO_INSTALL',
              ].includes(key.toUpperCase()),
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
