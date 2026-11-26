import path from 'node:path';
import os from 'node:os';
import { readFile, writeFile, rename, mkdtemp, realpath, lstat, chmod, unlink, rmdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { workerEnvironment } from './security.mjs';
import { resolveCommand } from './command.mjs';
import { isManagedRtkReady, rtkWorkerEnvironment } from './rtk.mjs';
import { assertPrivateArtifactPath } from './progress.mjs';

export const contentHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function executionEnvironment(engine, run, cwd, resolvedTools) {
  const environment = workerEnvironment();
  // Native workspace-write sessions can write OS temp while the user's global
  // npm cache may be outside their writable roots. A private random cache
  // avoids predictable shared /tmp paths and reuses npm's concurrent CAS across
  // all runs/worktrees using this user's state store.
  const home = path.resolve(os.homedir()),
    tempRoot = await realpath(os.tmpdir());
  const homeHash = contentHash(process.platform === 'win32' ? home.toLowerCase() : home).slice(0, 24),
    prefix = `kodo-npm-cache-${homeHash}-`;
  const pointerFile = path.join(engine.store.home, 'npm-cache.json');
  const privateOwned = info =>
    process.platform === 'win32' || (info.uid === process.getuid() && (info.mode & 0o077) === 0);
  const validCache = async candidate => {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) return false;
    const resolved = path.resolve(candidate),
      parent = path.dirname(resolved);
    if (
      (process.platform === 'win32' ? parent.toLowerCase() !== tempRoot.toLowerCase() : parent !== tempRoot) ||
      !path.basename(resolved).startsWith(prefix) ||
      path.basename(resolved).length < prefix.length + 6
    )
      return false;
    try {
      const info = await lstat(resolved);
      return info.isDirectory() && !info.isSymbolicLink() && privateOwned(info);
    } catch {
      return false;
    }
  };
  const cache = await engine.withLease(run, 'npm-cache:initialization', 1, async () => {
    try {
      const info = await lstat(pointerFile);
      if (info.isFile() && !info.isSymbolicLink() && info.size <= 8192 && privateOwned(info)) {
        const pointer = JSON.parse(await readFile(pointerFile, 'utf8'));
        if (pointer.schemaVersion === 1 && pointer.homeHash === homeHash && (await validCache(pointer.cache)))
          return path.resolve(pointer.cache);
      }
    } catch {} // Missing, foreign, malformed or unsafe pointers get a fresh cache.
    const fresh = await mkdtemp(path.join(tempRoot, prefix)),
      temporary = path.join(engine.store.home, `.npm-cache-${randomUUID()}.tmp`);
    try {
      if (process.platform !== 'win32') await chmod(fresh, 0o700);
      if (!(await validCache(fresh))) throw new Error('Не удалось создать закрытый npm cache Kodo');
      await writeFile(temporary, JSON.stringify({ schemaVersion: 1, homeHash, cache: fresh }) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
      await rename(temporary, pointerFile);
      return fresh;
    } catch (error) {
      if (await validCache(fresh)) await rmdir(fresh).catch(() => {}); // Only our new, still-empty directory.
      throw error;
    } finally {
      await unlink(temporary).catch(() => {});
    }
  });
  for (const name of Object.keys(environment)) if (name.toUpperCase() === 'NPM_CONFIG_CACHE') delete environment[name];
  environment.NPM_CONFIG_CACHE = cache;
  const pathName = Object.keys(environment).find(name => name.toLowerCase() === 'path') || 'PATH';
  const tools = resolvedTools || (await engine.resolveWorkerTools(cwd, { rtk: false }));
  const rg = tools.find(tool => tool.id === 'ripgrep'),
    rtk = tools.find(isManagedRtkReady);
  for (const name of Object.keys(environment)) if (/^RTK_/i.test(name)) delete environment[name];
  if (rtk) {
    const root = await engine.privateDirectory(path.join(run.artifacts || engine.store.home, 'worker-tools'));
    const directory = await mkdtemp(path.join(root, 'rtk-'));
    if (process.platform !== 'win32') await chmod(directory, 0o700);
    assertPrivateArtifactPath(directory);
    Object.assign(environment, rtkWorkerEnvironment(rtk, directory));
  }
  environment[pathName] = [
    path.dirname(process.execPath),
    rtk ? path.dirname(rtk.command) : null,
    rg?.ready ? path.dirname(rg.command) : null,
    environment[pathName],
  ]
    .filter(Boolean)
    .join(path.delimiter);
  try {
    const npm = resolveCommand('npm', []);
    if (npm.command === process.execPath && npm.args[0]) environment.npm_execpath = npm.args[0];
  } catch {} // Non-Node projects do not require an npm installation to start a worker.
  return environment;
}
