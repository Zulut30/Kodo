import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SANDBOX_PREFIX = 'kodo-overhead-';
export const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
const ALLOWED_GIT_ENV_KEYS = new Set([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'SYSTEMDRIVE',
  'COMPUTERNAME',
  'OS',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TZ',
  'TMP',
  'TEMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
]);
function setEnvVar(env, key, value, caseInsensitive) {
  const target = caseInsensitive ? key.toUpperCase() : key;
  for (const existing of Object.keys(env)) {
    if ((caseInsensitive ? existing.toUpperCase() : existing) === target) delete env[existing];
  }
  env[key] = value;
}

function deleteEnvVar(env, key, caseInsensitive) {
  const target = caseInsensitive ? key.toUpperCase() : key;
  for (const existing of Object.keys(env)) {
    if ((caseInsensitive ? existing.toUpperCase() : existing) === target) delete env[existing];
  }
}

/**
 * Strict allowlist environment for helper `git` invocations: permits only safe
 * OS/runtime variables (matched case-insensitively on Windows), strips all
 * credentials, SSH keys, XDG overrides and GIT_* redirections/config overrides,
 * and pins GIT_CONFIG_NOSYSTEM=1, GIT_CONFIG_GLOBAL and GIT_TERMINAL_PROMPT=0.
 * @param {NodeJS.ProcessEnv} [base]
 * @param {{ home?: string, temp?: string, gitConfigGlobal?: string, gitTemplateDir?: string, platform?: NodeJS.Platform }} [options]
 */
export function sanitizedGitEnv(
  base = process.env,
  { home, temp, gitConfigGlobal, gitTemplateDir, platform = process.platform } = {},
) {
  const caseInsensitive = platform === 'win32';
  /** @type {Record<string, string>} */
  const env = {};
  const seen = new Set();

  for (const [name, value] of Object.entries(base || {})) {
    if (typeof value !== 'string') continue;
    const canonical = caseInsensitive ? name.toUpperCase() : name;
    if (!ALLOWED_GIT_ENV_KEYS.has(canonical)) continue;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    env[name] = value;
  }

  if (home !== undefined) {
    setEnvVar(env, 'HOME', home, caseInsensitive);
    setEnvVar(env, 'USERPROFILE', home, caseInsensitive);
    deleteEnvVar(env, 'HOMEDRIVE', caseInsensitive);
    deleteEnvVar(env, 'HOMEPATH', caseInsensitive);
  }
  if (temp !== undefined) {
    setEnvVar(env, 'TMP', temp, caseInsensitive);
    setEnvVar(env, 'TEMP', temp, caseInsensitive);
    setEnvVar(env, 'TMPDIR', temp, caseInsensitive);
  }
  if (gitTemplateDir !== undefined) setEnvVar(env, 'GIT_TEMPLATE_DIR', gitTemplateDir, caseInsensitive);

  setEnvVar(env, 'GIT_CONFIG_NOSYSTEM', '1', caseInsensitive);
  setEnvVar(env, 'GIT_CONFIG_GLOBAL', gitConfigGlobal ?? (platform === 'win32' ? 'NUL' : '/dev/null'), caseInsensitive);
  setEnvVar(env, 'GIT_TERMINAL_PROMPT', '0', caseInsensitive);
  return env;
}

/**
 * Strict allowlist environment for a child Node trial process: starts from
 * `sanitizedGitEnv` and pins HOME/USERPROFILE, TMP/TEMP/TMPDIR, XDG_*, AppData,
 * GIT_CONFIG_GLOBAL, GIT_TEMPLATE_DIR and all KODO_* paths into the sandbox.
 * @param {NodeJS.ProcessEnv} base
 * @param {Awaited<ReturnType<typeof createSandbox>>} box
 * @param {{ platform?: NodeJS.Platform }} [options]
 */
export function buildTrialEnv(base, box, { platform = process.platform } = {}) {
  const caseInsensitive = platform === 'win32';
  const env = sanitizedGitEnv(base, {
    home: box.isolated,
    temp: box.temp,
    gitConfigGlobal: box.gitconfig,
    gitTemplateDir: box.template,
    platform,
  });
  for (const [key, value] of [
    ['XDG_CONFIG_HOME', box.xdgConfigHome],
    ['XDG_DATA_HOME', box.xdgDataHome],
    ['XDG_CACHE_HOME', box.xdgCacheHome],
    ['XDG_STATE_HOME', box.xdgStateHome],
    ['LOCALAPPDATA', box.localAppData],
    ['APPDATA', box.appData],
    ['KODO_HOME', box.stateDir],
    ['KODO_CREDENTIAL_HOME', box.credentialsDir],
    ['KODO_WORKTREE_HOME', box.worktreesDir],
    ['KODO_TOOL_HOME', box.toolsDir],
    // Node 24 automatically forwards NODE_V8_COVERAGE to spawned Node children when omitted.
    ['NODE_V8_COVERAGE', ''],
  ])
    setEnvVar(env, key, value, caseInsensitive);
  return env;
}

function writeIsolatedGitConfig(file, { template, hooks, home, temp }) {
  const env = sanitizedGitEnv(process.env, { home, temp, gitConfigGlobal: file, gitTemplateDir: template });
  const hooksArg = `core.hooksPath=${hooks.split(path.sep).join('/')}`;
  for (const [key, value] of [
    ['init.templateDir', template],
    ['core.hooksPath', hooks],
  ]) {
    const result = spawnSync('git', ['-c', hooksArg, 'config', '--file', file, key, value.split(path.sep).join('/')], {
      env,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.status !== 0) throw new Error(`Failed to write isolated git config: ${result.stderr}`);
  }
}

/**
 * Create an isolated temporary sandbox directory layout without mutating the
 * caller's `process.env`.
 */
export async function createSandbox() {
  const parent = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(parent, SANDBOX_PREFIX));
  const root = path.join(directory, 'repo');
  const stateDir = path.join(directory, 'state');
  const toolsDir = path.join(directory, 'tools');
  const worktreesDir = path.join(directory, 'worktrees');
  const isolated = path.join(directory, 'empty-home');
  const temp = path.join(directory, 'tmp');
  const template = path.join(isolated, 'git-template');
  const hooks = path.join(isolated, 'git-hooks');
  const gitconfig = path.join(isolated, 'gitconfig');
  const credentialsDir = path.join(isolated, 'empty-credentials');
  const xdgConfigHome = path.join(isolated, 'xdg-config');
  const xdgDataHome = path.join(isolated, 'xdg-data');
  const xdgCacheHome = path.join(isolated, 'xdg-cache');
  const xdgStateHome = path.join(isolated, 'xdg-state');
  const localAppData = path.join(isolated, 'localappdata');
  const appData = path.join(isolated, 'appdata');

  try {
    for (const dir of [
      root,
      toolsDir,
      isolated,
      temp,
      template,
      hooks,
      xdgConfigHome,
      xdgDataHome,
      xdgCacheHome,
      xdgStateHome,
      localAppData,
      appData,
    ])
      await mkdir(dir);
    await writeFile(gitconfig, '');
    writeIsolatedGitConfig(gitconfig, { template, hooks, home: isolated, temp });
  } catch (error) {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
    throw error;
  }

  return {
    directory,
    root,
    stateDir,
    toolsDir,
    worktreesDir,
    isolated,
    temp,
    template,
    hooks,
    gitconfig,
    credentialsDir,
    xdgConfigHome,
    xdgDataHome,
    xdgCacheHome,
    xdgStateHome,
    localAppData,
    appData,
    async cleanup() {
      if (
        path.dirname(path.resolve(directory)) !== path.resolve(parent) ||
        !path.basename(directory).startsWith(SANDBOX_PREFIX)
      )
        throw new Error('Refusing to remove directory outside overhead benchmark temp root');
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}
