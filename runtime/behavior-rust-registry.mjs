import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parse as parseToml } from 'smol-toml';
import { execute } from './command.mjs';
import { stateHome, workerEnvironment } from './security.mjs';
import { withWorktreeLock } from './workspace.mjs';

/** The package name in a Cargo package id: `path+file:///…/game#0.1.0`, `…#engine@0.1.0`, `game 0.1.0 (…)`. */
export function packageName(id) {
  const hash = id.lastIndexOf('#');
  if (hash < 0) return id.split(' ')[0];
  const fragment = id.slice(hash + 1),
    at = fragment.indexOf('@');
  if (at >= 0) return fragment.slice(0, at);
  const url = id.slice(0, hash).replace(/\/+$/, '');
  return decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
}

/**
 * A path as the file system names it, case kept: symbolic links, `/private/var`, 8.3 names and
 * `\\?\` resolved. For `path.relative` and the directories the receipt shows.
 */
function canonicalPath(value) {
  // A path that does not exist yet is resolved through its nearest existing ancestor.
  let existing = path.resolve(value),
    rest = '';
  for (;;) {
    try {
      const resolved = realpathSync.native(existing);
      return (rest ? path.join(resolved, rest) : resolved).replace(/^\\\\\?\\(?!UNC\\)/, '');
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return path.resolve(value).replace(/^\\\\\?\\(?!UNC\\)/, '');
      rest = rest ? path.join(path.basename(existing), rest) : path.basename(existing);
      existing = parent;
    }
  }
}
/** A key to compare paths with: case-insensitive on Windows, where the file system is. */
const pathKey = value => (process.platform === 'win32' ? value.toLowerCase() : value);
const canonicalKey = value => pathKey(canonicalPath(value));

/** The kind of a Cargo target as the registry compares it. */
const kindOf = kinds => ['bin', 'test', 'bench', 'example'].find(kind => kinds.split(',').includes(kind)) ?? 'lib';

/**
 * Targets declared with `harness = false` in a manifest, read with a TOML parser: libtest does
 * not run them, so their `--list` says nothing. @returns {Set<string>} `kind:name`
 */
export function harnessFreeTargets(manifest, packageNameValue) {
  const found = new Set();
  let value;
  try {
    value = parseToml(manifest);
  } catch {
    return found;
  }
  const lib = value.lib;
  if (lib && typeof lib === 'object' && lib.harness === false)
    found.add(`lib:${typeof lib.name === 'string' ? lib.name : packageNameValue.replace(/-/g, '_')}`);
  for (const kind of ['bin', 'test', 'bench', 'example'])
    for (const target of Array.isArray(value[kind]) ? value[kind] : [])
      if (target && target.harness === false && typeof target.name === 'string') found.add(`${kind}:${target.name}`);
  return found;
}

/** The environment a test executable needs to find the libraries next to it, as Cargo gives it. */
function libraryEnvironment(env, executable) {
  const key =
    process.platform === 'win32'
      ? (Object.keys(env).find(name => name.toUpperCase() === 'PATH') ?? 'PATH')
      : process.platform === 'darwin'
        ? 'DYLD_FALLBACK_LIBRARY_PATH'
        : 'LD_LIBRARY_PATH';
  const directories = [path.dirname(executable), path.dirname(path.dirname(executable))];
  return { ...env, [key]: [...directories, env[key]].filter(Boolean).join(path.delimiter) };
}

const BUILD_ARGS = ['test', '--workspace', '--no-run', '--message-format=json'];
const LIST_TIMEOUT_MS = 120000;

/**
 * The test registry of one checkout: `cargo test --workspace --no-run
 * --message-format=json` names the test executables with their package, target
 * and root file (`target.src_path`), and each one lists its tests (`--list
 * --format terse`) and its ignored tests (`… --ignored`). A `harness = false`
 * target is not run: it is one entry with an empty name, so the target itself
 * is tracked.
 * @param {{ checkout: string, targetDir?: string, runner: any, signal?: AbortSignal, secrets?: any,
 *   env: Record<string, string> }} input `targetDir`: a target directory of its own (the base).
 * @returns {Promise<any>} `{ entries }`, each `{ package, kind, target, dir, src, name, ignored }`, or `{ reason }`.
 */
async function listRegistry({ checkout, targetDir, runner, signal, secrets, env }) {
  const run = async (command, args, options) => {
    try {
      const result = await runner(command, args, { signal, secrets, allowFailure: true, rawOutput: true, ...options });
      return result.code === 0 ? { stdout: result.stdout } : { reason: `exit_${result.code}` };
    } catch (error) {
      if (signal?.aborted || error.code === 'cancelled') throw error;
      return { reason: error.code || 'execution_failed' };
    }
  };
  const built = await run('cargo', BUILD_ARGS, {
    cwd: checkout,
    env: targetDir ? { ...env, CARGO_TARGET_DIR: targetDir } : env,
  });
  if ('reason' in built) return { reason: `build_${built.reason}` };
  const executables = new Map();
  for (const line of built.stdout.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.reason !== 'compiler-artifact' || message.profile?.test !== true || !message.executable) continue;
    executables.set(message.executable, message);
  }
  const root = canonicalPath(checkout),
    relative = value => path.relative(root, canonicalPath(value)).split(path.sep).join('/'),
    manifests = new Map(),
    entries = [],
    // Every test target with its root file, also one that lists no test: its files belong to it.
    targets = [];
  for (const [executable, message] of executables) {
    const manifest = message.manifest_path ?? path.join(checkout, 'Cargo.toml'),
      where = path.dirname(manifest),
      packageValue = packageName(String(message.package_id ?? '')),
      kind = [].concat(message.target?.kind ?? []).join(','),
      target = String(message.target?.name ?? '');
    // Both sides canonical, case kept: a path through `/private/var`, an 8.3 name or `\\?\` is the same.
    const entry = {
      package: packageValue,
      kind,
      target,
      dir: relative(where),
      src: message.target?.src_path ? relative(message.target.src_path) : '',
    };
    targets.push(entry);
    if (!manifests.has(manifest)) {
      let text = '';
      try {
        text = readFileSync(manifest, 'utf8');
      } catch {
        // A manifest that cannot be read declares no harness-free target.
      }
      manifests.set(manifest, harnessFreeTargets(text, packageValue));
    }
    if (manifests.get(manifest).has(`${kindOf(kind)}:${target}`)) {
      entries.push({ ...entry, name: '', ignored: false });
      continue;
    }
    const options = { cwd: where, env: libraryEnvironment(env, executable), timeoutMs: LIST_TIMEOUT_MS };
    const all = await run(executable, ['--list', '--format', 'terse'], options);
    if ('reason' in all) return { reason: `list_${all.reason}` };
    const ignored = await run(executable, ['--list', '--format', 'terse', '--ignored'], options);
    if ('reason' in ignored) return { reason: `list_${ignored.reason}` };
    const names = output =>
      output
        .split(/\r?\n/)
        .map(line => /^(.+): test$/.exec(line.trim())?.[1])
        .filter(Boolean);
    const off = new Map();
    for (const name of names(ignored.stdout)) off.set(name, (off.get(name) ?? 0) + 1);
    for (const name of names(all.stdout)) {
      const left = off.get(name) ?? 0;
      if (left > 0) off.set(name, left - 1);
      entries.push({ ...entry, name, ignored: left > 0 });
    }
  }
  return { entries, targets };
}

/**
 * Whether `checkout` lies strictly inside `home`, both canonical: a link that leads elsewhere, or
 * another drive (`path.relative` gives an absolute path there), is outside.
 */
export function strictlyInside(home, checkout) {
  const relative = path.relative(canonicalPath(home), canonicalPath(checkout));
  return (
    relative !== '' &&
    !path.isAbsolute(relative) &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !relative.startsWith('../')
  );
}

/** Whether the repository at `cwd` has `checkout` registered as one of its worktrees. */
async function registeredIn(cwd, checkout) {
  const listed = await execute('git', ['worktree', 'list', '--porcelain'], {
    cwd,
    allowFailure: true,
    timeoutMs: 60000,
  });
  return (
    listed.code === 0 &&
    listed.stdout
      .split(/\r?\n/)
      .filter(line => line.startsWith('worktree '))
      .some(line => canonicalKey(line.slice(9)) === canonicalKey(checkout))
  );
}

/**
 * A checkout of this repository's own: its `.git` exists, Git names it as the top of its work
 * tree, and the repository at `cwd` has it registered.
 */
async function commonDir(cwd) {
  const result = await execute('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd,
    allowFailure: true,
    timeoutMs: 60000,
  });
  return result.code === 0 ? canonicalKey(result.stdout.trim()) : null;
}

/**
 * A checkout path whose own Git metadata belongs to another repository (a stale registration
 * reused by another clone) is never touched: no checkout, clean, removal or deletion.
 */
async function foreignCheckout(cwd, checkout) {
  if (!existsSync(path.join(checkout, '.git'))) return false;
  try {
    const [own, theirs] = await Promise.all([commonDir(cwd), commonDir(checkout)]);
    return Boolean(own && theirs && own !== theirs);
  } catch {
    return false;
  }
}

async function healthyCheckout(cwd, checkout) {
  if (!existsSync(path.join(checkout, '.git'))) return false;
  if (await foreignCheckout(cwd, checkout)) return false;
  try {
    const top = await execute('git', ['rev-parse', '--show-toplevel'], {
      cwd: checkout,
      allowFailure: true,
      timeoutMs: 60000,
    });
    return (
      top.code === 0 &&
      canonicalKey(top.stdout.trim()) === canonicalKey(checkout) &&
      (await registeredIn(cwd, checkout))
    );
  } catch {
    return false;
  }
}

/**
 * Remove and add the base checkout again, under the repository's worktree lock, also after a
 * cancelled gate (no signal, bounded waits): `worktree remove --force --force`; a directory that
 * survives is deleted only when it lies inside the registry home; then `worktree prune` and `add`.
 */
async function rebuildCheckout(cwd, home, checkout, baseSha) {
  await withWorktreeLock(
    cwd,
    async () => {
      // Checked again under the lock, just before Git and the file system act on it.
      if (!strictlyInside(home, checkout)) throw new Error(`base checkout ${checkout} is outside the registry home`);
      if (await foreignCheckout(cwd, checkout))
        throw new Error(`base checkout ${checkout} belongs to another repository and is left untouched`);
      const options = { cwd, allowFailure: true, timeoutMs: 60000 };
      await execute('git', ['worktree', 'remove', '--force', '--force', checkout], options);
      if (existsSync(checkout)) rmSync(checkout, { recursive: true, force: true });
      await execute('git', ['worktree', 'prune'], options);
      await execute('git', ['worktree', 'add', '--detach', '--quiet', checkout, baseSha], { cwd, timeoutMs: 600000 });
    },
    undefined,
    120000,
  );
}

/**
 * The base checkout at a stable path, at `baseSha`, clean. A stable path keeps Cargo's
 * fingerprints of the workspace crates, so a repeated base builds incrementally. Git is run
 * inside it only when its own `.git` is there: otherwise Git would climb to an outer repository.
 */
async function prepareCheckout(cwd, home, checkout, baseSha, signal) {
  // Before any Git command or deletion: the checkout, as the file system resolves it, is in the home.
  if (!strictlyInside(home, checkout)) throw new Error(`base checkout ${checkout} is outside the registry home`);
  if (await foreignCheckout(cwd, checkout))
    throw new Error(`base checkout ${checkout} belongs to another repository and is left untouched`);
  if (await healthyCheckout(cwd, checkout)) {
    try {
      const options = { cwd: checkout, allowFailure: true, signal };
      const moved = await execute('git', ['checkout', '--detach', '--force', '--quiet', baseSha], options);
      const cleaned = moved.code === 0 && (await execute('git', ['clean', '-ffdxq'], options));
      if (cleaned && cleaned.code === 0) return;
    } catch (error) {
      if (signal?.aborted || error.code === 'cancelled') throw error;
      // A broken checkout is added again below.
    }
  }
  await rebuildCheckout(cwd, home, checkout, baseSha);
  if (!(await healthyCheckout(cwd, checkout))) throw new Error('base checkout could not be prepared');
}

/**
 * A lock across processes on the base build directory, for the whole preparation, build and
 * listing: two gates must not overwrite each other's base executables (the same path for
 * different bases). An SQLite write transaction, as the worktree lock: process death releases it.
 */
export async function withBaseLock(home, action, signal = undefined, waitMs = 4 * 60 * 60 * 1000) {
  const { DatabaseSync } = await import('node:sqlite');
  mkdirSync(home, { recursive: true });
  const guard = new DatabaseSync(path.join(home, 'registry-base.lock.sqlite'), { timeout: 0 });
  const started = performance.now();
  try {
    for (;;) {
      signal?.throwIfAborted();
      try {
        guard.exec('BEGIN IMMEDIATE');
        break;
      } catch (error) {
        if ((error.errcode & 0xff) !== 5) throw error;
      }
      if (performance.now() - started > waitMs)
        throw Object.assign(new Error('Timed out waiting for the base build of the test registry'), {
          code: 'timeout',
        });
      await delay(Math.min(200, waitMs), undefined, { signal });
    }
    return await action();
  } finally {
    guard.close();
  }
}

/** Kodo's state directory for the registry of one repository: the base checkout, its target directory, the cache. */
async function registryHomeFor(cwd) {
  const common = (
    await execute('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, rawOutput: true })
  ).stdout.replace(/\r?\n$/, '');
  const key = createHash('sha256').update(canonicalKey(common)).digest('hex').slice(0, 16);
  return path.join(stateHome(), 'registry', key);
}

/** The directory whose files are modules of a target root: `src/lib.rs` → `src`, `tests/t.rs` → `tests/t`. */
function moduleDir(src) {
  const dir = path.posix.dirname(src),
    base = path.posix.basename(src);
  return ['lib.rs', 'main.rs', 'mod.rs'].includes(base)
    ? dir
    : `${dir === '.' ? '' : `${dir}/`}${base.replace(/\.rs$/i, '')}`;
}

/**
 * The Cargo targets a file can belong to, from the roots Cargo reported (`target.src_path`): the
 * target whose root it is; else the targets whose module directory holds it most closely
 * (`src/util.rs` of a package with a library and a binary: both); else, for a module shared by
 * the test targets (`tests/common/mod.rs`), every target of that kind in its package.
 */
function targetsOf(targets) {
  const memo = new Map();
  const prefix = dir => (dir ? `${pathKey(dir)}/` : '');
  return file => {
    const key = pathKey(file);
    if (memo.has(key)) return memo.get(key);
    let found = targets.filter(target => target.src && pathKey(target.src) === key);
    if (!found.length) {
      const covering = targets
        .filter(target => target.src && key.startsWith(prefix(moduleDir(target.src))))
        .map(target => ({ target, depth: moduleDir(target.src).length }));
      const deepest = Math.max(-1, ...covering.map(item => item.depth));
      found = covering.filter(item => item.depth === deepest).map(item => item.target);
    }
    if (!found.length) {
      const owner = targets
        .filter(target => key.startsWith(prefix(target.dir)))
        .reduce((best, target) => (best === null || target.dir.length > best.length ? target.dir : best), null);
      const kind =
        owner === null
          ? null
          : { tests: 'test', benches: 'bench', examples: 'example' }[key.slice(prefix(owner).length).split('/')[0]];
      if (kind) found = targets.filter(target => pathKey(target.dir) === pathKey(owner) && target.kind === kind);
    }
    const result = new Set(found.map(target => target.key));
    memo.set(key, result);
    return result;
  };
}

/**
 * Compare the registry of the base and the head. A test gone from the head, or ignored there and
 * not on the base, that the reading of the source has not explained is a finding. Every
 * explanation is matched to one base entry — (package, target kind, target, name), the target
 * from the roots Cargo reported — and used once:
 * - `reported`, `cfg`: a removal or a provably false `cfg` the reading already reported as a
 *   finding; it may stand for any target its file can belong to.
 * - `skips`: an `#[ignore]` the reading reported; only for a test ignored now.
 * - `moved`: a test the reading saw move to another file of the same target; it explains the
 *   loss only when the registry of the head shows the test gained in that file's target, and
 *   with the same activity: an active test that arrives ignored is `test_skipped`.
 * - `permitted`: a removal this run may make (`testRemovalAllowed`, also a whole permitted file
 *   that is gone: an empty name). It covers a loss only in a target confirmed for its file: the
 *   file's one target, or the one target of the file that had that test on the base; a gone
 *   file covers only the target whose root it was.
 * A `harness = false` target is one entry with an empty name. `targets` are every test target
 * Cargo built, with its root file, also those that list no test: a file is matched against them.
 * @param {{ base: any[], head: any[], targets?: any[], reported?: any[], cfg?: any[], skips?: any[], moved?: any[], permitted?: any[] }} input
 */
export function compareRegistry({
  base,
  head,
  targets: built = [],
  reported = [],
  cfg = [],
  skips = [],
  moved = [],
  permitted = [],
}) {
  const targetKey = entry => `${entry.package}\u0000${entry.kind}\u0000${entry.target}`;
  const key = entry => `${targetKey(entry)}\u0000${entry.name}`;
  const targets = new Map();
  for (const entry of [...built, ...base, ...head])
    if (!targets.has(targetKey(entry)))
      targets.set(targetKey(entry), {
        key: targetKey(entry),
        dir: entry.dir,
        src: entry.src ?? '',
        kind: kindOf(entry.kind),
      });
  const candidates = targetsOf([...targets.values()]);
  const roots = file =>
    new Set(
      [...targets.values()]
        .filter(target => target.src && pathKey(target.src) === pathKey(file))
        .map(target => target.key),
    );
  const tally = list => {
    const map = new Map();
    for (const entry of list) {
      const counts = map.get(key(entry)) ?? { entry, total: 0, active: 0 };
      counts.total++;
      if (!entry.ignored) counts.active++;
      map.set(key(entry), counts);
    }
    return map;
  };
  const before = tally(base),
    after = tally(head);
  // What the head gained per test, as active and as ignored entries: a move must keep its activity.
  const gains = new Map();
  for (const [slot, counts] of after) {
    const old = before.get(slot) ?? { total: 0, active: 0 };
    const more = Math.max(0, counts.total - old.total),
      active = Math.min(more, Math.max(0, counts.active - old.active));
    if (more > 0) gains.set(slot, { active, ignored: more - active });
  }
  const byName = list => {
    const map = new Map();
    for (const item of list) {
      if (!map.has(item.name)) map.set(item.name, []);
      map.get(item.name).push(item);
    }
    return map;
  };
  const pools = {
    reported: byName([...reported, ...cfg]),
    skips: byName(skips),
    moved: byName(moved),
    permitted: byName(permitted),
  };
  const take = (pool, entry, accept) => {
    const list = pool.get(entry.name);
    const at = list ? list.findIndex(item => candidates(item.file).has(targetKey(entry)) && accept(item)) : -1;
    return at < 0 ? null : list.splice(at, 1)[0];
  };
  const any = () => true;
  /** The target of the file a test moved to that gained it as `kind` (`active` or `ignored`), or null. */
  const gainedIn = (item, kind) =>
    [...candidates(item.to)].find(target => (gains.get(`${target}\u0000${item.name}`)?.[kind] ?? 0) > 0) ?? null;
  const consume = (item, kind) => {
    const gain = gains.get(`${gainedIn(item, kind)}\u0000${item.name}`);
    if (gain) gain[kind]--;
  };
  const confirmed = entry => item => {
    // A gone file covers only the target whose root it was.
    if (item.name === '') return roots(item.file).has(targetKey(entry));
    const own = [...candidates(item.file)];
    return own.length === 1 || own.filter(target => before.has(`${target}\u0000${entry.name}`)).length === 1;
  };
  const gone = [],
    off = [],
    allowedByFile = new Map();
  for (const [slot, counts] of before) {
    const now = after.get(slot) ?? { total: 0, active: 0 };
    const removed = Math.max(0, counts.total - now.total);
    const switched = Math.max(0, Math.max(0, counts.active - removed) - now.active);
    // The entries gone from here that ran on the base come first.
    const removedActive = Math.min(removed, Math.max(0, counts.active - now.active));
    for (let index = 0; index < removed; index++) {
      if (take(pools.reported, counts.entry, any)) continue;
      const active = index < removedActive,
        same = active ? 'active' : 'ignored',
        other = active ? 'ignored' : 'active';
      const move =
        take(pools.moved, counts.entry, item => gainedIn(item, same) !== null) ??
        take(pools.moved, counts.entry, item => gainedIn(item, other) !== null);
      if (move) {
        const kept = gainedIn(move, same) !== null;
        consume(move, kept ? same : other);
        // A test that ran on the base and arrives ignored is switched off.
        if (!kept && active) off.push(counts.entry);
        continue;
      }
      const item = take(pools.permitted, counts.entry, confirmed(counts.entry));
      if (!item) gone.push(counts.entry);
      // A permitted removal the reading saw is already in `allowed`; only a target the reading cannot see is added.
      else if (item.name === '') {
        if (!allowedByFile.has(item.file)) allowedByFile.set(item.file, new Set());
        allowedByFile.get(item.file).add(counts.entry);
      }
    }
    for (let left = switched; left > 0; left--) if (!take(pools.skips, counts.entry, any)) off.push(counts.entry);
  }
  const label = entry => `${entry.package} ${entry.kind} ${entry.target}: ${entry.name || '(target, harness = false)'}`;
  const names = list =>
    `${list
      .slice(0, 5)
      .map(entry => JSON.stringify(label(entry).slice(0, 120)))
      .join(', ')}${list.length > 5 ? `, and ${list.length - 5} more` : ''}`;
  const findings = [];
  if (gone.length)
    findings.push({
      rule: 'test_deleted',
      file: null,
      detail: `test registry: ${gone.length} tests are gone: ${names(gone)}`,
    });
  if (off.length)
    findings.push({
      rule: 'test_skipped',
      file: null,
      detail: `test registry: ${off.length} tests are ignored now: ${names(off)}`,
    });
  const count = map => [...map.values()].reduce((sum, item) => sum + item.total, 0);
  return {
    findings,
    permitted: [...allowedByFile].map(([file, list]) => ({
      rule: 'test_deleted',
      file,
      detail: `test registry: tests are gone: ${names([...list])}`,
    })),
    base: count(before),
    head: count(after),
  };
}

/** Variables of the worker's environment that change what Cargo builds; output and network settings do not. */
const buildVariable = name =>
  /^(?:CARGO_|RUST)/i.test(name) && !/^(?:CARGO_TERM_|CARGO_HTTP_|CARGO_NET_|RUST_LOG$|RUST_BACKTRACE$)/i.test(name);

/** A file's SHA-256, or null when it does not exist. */
function fileHash(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * What a cached base registry depends on: the commit, its `Cargo.lock`, the build variables of
 * the worker's environment (`RUSTFLAGS`, `CARGO_ENCODED_RUSTFLAGS`, `CARGO_BUILD_*`,
 * `CARGO_TARGET_*_RUSTFLAGS`, `CARGO_UNSTABLE_*`, `RUSTC`, `RUSTUP_TOOLCHAIN`, …), Cargo's own
 * configuration in `CARGO_HOME`, and the `cargo` and `rustc` versions as the base checkout
 * selects them (its `rust-toolchain`).
 */
async function cacheKey({ checkout, baseSha, env, runner, signal, secrets }) {
  const version = async command => {
    try {
      const result = await runner(command, ['--version'], { cwd: checkout, env, signal, secrets, allowFailure: true });
      return result.code === 0 ? String(result.stdout).trim() : `exit_${result.code}`;
    } catch (error) {
      if (signal?.aborted || error.code === 'cancelled') throw error;
      return 'unavailable';
    }
  };
  const variables = Object.entries(env)
    .filter(([name]) => buildVariable(name))
    .map(([name, value]) => [name.toUpperCase(), value])
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const cargoHome = env.CARGO_HOME || path.join(os.homedir(), '.cargo');
  return createHash('sha256')
    .update(
      JSON.stringify([
        3, // the format of a cached registry: 3 keeps every target with its root file
        baseSha,
        fileHash(path.join(checkout, 'Cargo.lock')),
        variables,
        fileHash(path.join(cargoHome, 'config')),
        fileHash(path.join(cargoHome, 'config.toml')),
        await version('cargo'),
        await version('rustc'),
      ]),
    )
    .digest('hex');
}

function readCache(file) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(value?.entries) && Array.isArray(value?.targets) ? value : null;
  } catch {
    return null;
  }
}

function writeCache(file, { entries, targets }) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ entries, targets }));
    renameSync(temporary, file);
  } catch {
    // A cache that cannot be written only costs the next gate a build.
  }
}

/**
 * The base registry under the base lock: the stable checkout is prepared, the cache key is
 * computed in it, and a cached registry is used or the base is built and listed.
 */
async function baseRegistry({ cwd, home, baseSha, runner, signal, secrets, env }) {
  return withBaseLock(
    home,
    async () => {
      const checkout = path.join(home, 'base-checkout');
      try {
        await prepareCheckout(cwd, home, checkout, baseSha, signal);
      } catch (error) {
        if (signal?.aborted || error.code === 'cancelled') throw error;
        return { reason: `checkout: ${String(error.message).slice(0, 300)}` };
      }
      const cache = path.join(
        home,
        'cache',
        `${await cacheKey({ checkout, baseSha, env, runner, signal, secrets })}.json`,
      );
      const ready = readCache(cache);
      if (ready) return { ...ready, cached: true };
      const listed = await listRegistry({
        checkout,
        targetDir: path.join(home, 'registry-base'),
        runner,
        signal,
        secrets,
        env,
      });
      if (!('reason' in listed)) writeCache(cache, listed);
      return listed;
    },
    signal,
  );
}

/**
 * The registry check of a full gate on a Rust project: a root `Cargo.toml` on the base or the
 * head. A side without it is an empty registry (a new crate; a manifest removed). The head is
 * listed in the checked worktree. The base is listed in a checkout at a stable path under
 * Kodo's state directory, built into its own target directory (`registry-base`), never the
 * head's, under a lock across processes for the whole preparation, build and listing; a
 * finished base registry is cached (see `cacheKey`). `incomplete` — Cargo missing, a build or a
 * listing failed, the checkout broken — is never a pass.
 */
export async function rustRegistryCheck({
  cwd,
  baseSha,
  signal,
  secrets,
  runner,
  registryHome,
  baseIsRust,
  headIsRust,
  pools = {},
}) {
  const env = workerEnvironment();
  try {
    await runner('cargo', ['--version'], { cwd, signal, env, secrets, allowFailure: false });
  } catch (error) {
    if (signal?.aborted || error.code === 'cancelled') throw error;
    return { registry: { status: 'incomplete', reason: 'cargo_unavailable' } };
  }
  let after = /** @type {any} */ ({ entries: [] });
  if (headIsRust) {
    after = await listRegistry({ checkout: cwd, runner, signal, secrets, env });
    if ('reason' in after) return { registry: { status: 'incomplete', reason: `head_${after.reason}` } };
  }
  let before = /** @type {any} */ ({ entries: [] });
  if (baseIsRust) {
    try {
      const home = registryHome ?? (await registryHomeFor(cwd));
      before = await baseRegistry({ cwd, home, baseSha, runner, signal, secrets, env });
    } catch (error) {
      if (signal?.aborted || error.code === 'cancelled') throw error;
      before = { reason: `checkout: ${String(error.message).slice(0, 300)}` };
    }
    if ('reason' in before) return { registry: { status: 'incomplete', reason: `base_${before.reason}` } };
  }
  const compared = compareRegistry({
    base: before.entries,
    head: after.entries,
    targets: [...(before.targets ?? []), ...(after.targets ?? [])],
    ...pools,
  });
  return {
    registry: {
      status: 'compared',
      base: compared.base,
      head: compared.head,
      ...(baseIsRust ? {} : { baseRegistry: 'absent' }),
      ...(headIsRust ? {} : { headRegistry: 'absent' }),
      ...(before.cached ? { baseCached: true } : {}),
    },
    findings: compared.findings,
    permitted: compared.permitted,
  };
}

/**
 * The packages a plain `cargo test` selects, from a manifest read with a TOML parser:
 * `default-members`, else the root package, else every member. Paths are compared as written
 * (`./` and a trailing `/` dropped), globs are not expanded. Null for a manifest that is not TOML.
 */
function defaultSelection(manifest) {
  let value;
  try {
    value = parseToml(manifest);
  } catch {
    return null;
  }
  const clean = list =>
    Array.isArray(list)
      ? list.filter(item => typeof item === 'string').map(item => item.replace(/^\.\/+/, '').replace(/\/+$/, '') || '.')
      : null;
  const workspace = value.workspace && typeof value.workspace === 'object' ? value.workspace : {};
  return clean(workspace['default-members']) ?? (value.package ? ['.'] : (clean(workspace.members) ?? ['.']));
}

/**
 * `test_selection_narrowed`: the project tests with a plain `cargo test` (no `--workspace`, no
 * `--all`, no `-p`/`--package`), and the root manifest now selects fewer packages by default.
 * @param {{ base: string | null, head: string | null, commands: { command: string, args?: string[] }[] }} input
 */
export function selectionNarrowed({ base, head, commands }) {
  const plain = commands.some(
    item =>
      /(?:^|[\\/])cargo(?:\.exe)?$/i.test(item.command) &&
      (item.args ?? []).includes('test') &&
      !(item.args ?? []).some(arg => /^(?:--workspace|--all|-p.*|--package(?:=.*)?)$/.test(arg)),
  );
  if (!plain || base === null || head === null) return null;
  const before = defaultSelection(base),
    after = defaultSelection(head);
  if (!before || !after) return null;
  const now = new Set(after);
  const lost = before.filter(member => !now.has(member));
  return lost.length ? lost : null;
}
