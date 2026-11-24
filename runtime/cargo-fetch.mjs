import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { noLinks } from './toolchains.mjs';
import { tryCargoLock } from './cargo-slots.mjs';
import { execute } from './command.mjs';

const lockDefect = () =>
  Object.assign(new Error('Обновите Cargo.lock и закоммитьте его в проверяемую ревизию.'), { code: 'check_failed' });
const staleLock =
  /\block\s*file\b[^\n]*(?:needs to be updated|needs to be generated)|cannot (?:create|update) the lock\s*file/i;

export function cargoLockFailure(stderr) {
  return staleLock.test(stderr) && /--locked/.test(stderr) ? lockDefect() : null;
}

export function cargoFetchError(message) {
  return Object.assign(new Error('Не удалось подготовить зависимости Cargo: ' + message), {
    code: 'cargo_fetch_failed',
    scope: 'environment',
  });
}

export function cargoOfflineMiss(stderr) {
  return (
    /(?:--offline\b|offline mode)/i.test(stderr) &&
    /(?:^|\n)error: (?:failed to (?:download|get|select a version|load source)|no matching package|unable to (?:update|download))\b/i.test(
      stderr,
    )
  );
}

async function lockBytes(cwd, headSha) {
  if (headSha) {
    const row = await execute('git', ['ls-tree', '-z', headSha, '--', 'Cargo.lock'], {
      cwd,
      rawOutput: true,
      timeoutMs: 30000,
    });
    if (!/^100(?:644|755) blob [a-f0-9]+\tCargo\.lock\0$/.test(row.stdout)) throw lockDefect();
  }
  const file = path.join(cwd, 'Cargo.lock');
  await noLinks(file);
  try {
    return await readFile(file);
  } catch (error) {
    if (error.code === 'ENOENT') throw lockDefect();
    throw error;
  }
}

async function configHashes(cwd, cargoHome) {
  const hashes = [];
  async function inspect(directory, label) {
    let files;
    try {
      files = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const file of files
      .filter(
        file =>
          (process.platform === 'win32' ? file.name.toLowerCase() : file.name).startsWith('config') &&
          !file.isDirectory(),
      )
      .map(file => file.name)
      .sort()) {
      const configFile = path.join(directory, file);
      if (!(await stat(configFile)).isFile()) throw cargoFetchError('Конфигурация Cargo должна быть обычным файлом');
      const bytes = await readFile(configFile);
      hashes.push([label, file, createHash('sha256').update(bytes).digest('hex')]);
    }
  }
  let directory = path.resolve(cwd);
  for (let depth = 0; ; depth++) {
    await inspect(path.join(directory, '.cargo'), depth);
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  await inspect(cargoHome, 'home');
  return hashes;
}

// Revalidate a stale generation under the same SQLite writer lock. A slot
// observing a generation already refreshed by another slot reuses that fetch.
async function fetchGeneration(filename, options, staleGeneration) {
  const { command, prefix, cwd, env, signal, timeoutMs, secrets, runCommand } = options;
  let db;
  while (!(db = tryCargoLock(filename))) await delay(100, undefined, { signal });
  try {
    signal?.throwIfAborted();
    const generation = Number(db.prepare('PRAGMA user_version').get().user_version);
    if (generation && generation !== staleGeneration) return generation;
    try {
      const result = await runCommand(command, [...prefix, 'fetch', '--locked'], {
        cwd,
        env: { ...env, CARGO_NET_OFFLINE: 'false' },
        timeoutMs,
        signal,
        secrets,
        allowFailure: true,
      });
      signal?.throwIfAborted();
      if (result.code !== 0) {
        const output = String(result.stderr || result.stdout || 'Cargo завершился без успешного кода выхода');
        const defect = cargoLockFailure(output);
        if (defect) throw defect;
        const parseError = /failed to (?:parse (?:manifest|lock file)|load manifest)\b/i.exec(output);
        if (parseError)
          throw Object.assign(new Error(output.slice(parseError.index, parseError.index + 6000)), {
            code: 'check_failed',
          });
        throw cargoFetchError(output.slice(-6000));
      }
    } catch (error) {
      // Closing an uncommitted transaction would restore the stale ready mark.
      db.exec('PRAGMA user_version=0; COMMIT');
      throw error;
    }
    const next = generation >= 2147483647 ? 1 : generation + 1;
    db.exec('PRAGMA user_version=' + next + '; COMMIT');
    return next;
  } finally {
    db.close();
  }
}

function classified(error, signal) {
  if (signal?.aborted || ['cancelled', 'check_failed', 'cargo_fetch_failed'].includes(error.code)) return error;
  return cargoFetchError(error.message);
}

// Called with the target slot held, both for the initial fetch and one recovery.
export async function warmCargoDependencies({
  home,
  cwd,
  command,
  env,
  signal,
  timeoutMs,
  secrets,
  headSha = undefined,
  toolchain = undefined,
  runCommand = execute,
}) {
  try {
    const windows = process.platform === 'win32';
    const variable = name =>
      windows ? Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1] : env[name];
    const profile = variable(windows ? 'USERPROFILE' : 'HOME') || os.homedir();
    const cargoHome = path.resolve(cwd, variable('CARGO_HOME') || path.join(profile, '.cargo'));
    const lock = await lockBytes(cwd, headSha);
    const prefix = toolchain ? [toolchain] : [];
    const version = await runCommand(command, [...prefix, '--version'], { cwd, env, signal, timeoutMs, secrets });
    if (version.code !== 0 || !version.stdout.trim()) throw cargoFetchError('Не удалось определить версию Cargo');
    const config = await configHashes(cwd, cargoHome);
    const key = createHash('sha256')
      .update(JSON.stringify([os.hostname(), cargoHome, version.stdout.trim(), config]))
      .update(lock)
      .digest('hex');
    const directory = path.join(home, 'cargo-fetch'),
      filename = path.join(directory, key + '.sqlite');
    await noLinks(filename);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const options = { cwd, command, prefix, env, signal, timeoutMs, secrets, runCommand };
    let generation = await fetchGeneration(filename, options, undefined);
    return async () => {
      try {
        generation = await fetchGeneration(filename, options, generation);
      } catch (error) {
        throw classified(error, signal);
      }
    };
  } catch (error) {
    throw classified(error, signal);
  }
}
