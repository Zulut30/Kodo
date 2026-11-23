import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function makeFixture(t, { config } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodo-cli-doctor-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('kodo-cli-doctor-'));
    await rm(directory, { recursive: true, force: true });
  });
  if (config) await writeFile(path.join(directory, 'kodo.config.json'), JSON.stringify(config, null, 2));
  return directory;
}

function runDoctor(directory, args, { env = {}, hook } = {}) {
  const nodeArgs = [
    ...(hook ? ['--import', pathToFileURL(hook).href] : []),
    path.join(root, 'cli/index.mjs'),
    'doctor',
    '--project',
    directory,
    ...args,
  ];
  const cleanEnv = { ...process.env };
  for (const name of [
    'KODO_GEMINI_API_KEY',
    'KODO_TYPESAFE_API_KEY',
    'KODO_SCRAPEDO_TOKEN',
    'KODO_REDDIT_API_KEY',
    'KODO_GETX_API_KEY',
    'GEMINI_API_KEY',
    'TYPESAFE_API_KEY',
    'SCRAPEDO_TOKEN',
    'REDDIT_API_KEY',
    'GETX_API_KEY',
  ])
    delete cleanEnv[name];
  return spawnSync(process.execPath, nodeArgs, {
    cwd: directory,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
    env: {
      ...cleanEnv,
      KODO_HOME: path.join(directory, 'state'),
      KODO_CREDENTIAL_HOME: path.join(directory, 'credentials'),
      ...env,
    },
  });
}

async function writeDoctorHook(directory, { loggedInClients = ['claude-code'] } = {}) {
  const hook = path.join(directory, 'doctor-hook.mjs');
  await writeFile(
    hook,
    `import { registerHooks } from 'node:module';
const loggedIn = new Set(${JSON.stringify(loggedInClients)});
registerHooks({
  load(url, context, next) {
    const loaded = next(url, context);
    if (!url.endsWith('/runtime/providers.mjs')) return loaded;
    const replacement = \`export async function subscriptionStatus(client) {
      if (!globalThis.__doctorLoggedIn.has(client)) throw new ProviderError('Not logged in: ' + client, 'auth');
      return { client, available: true, auth: 'subscription' };
    }\`;
    const source = String(loaded.source).replace(
      /export async function subscriptionStatus\\([^]*?\\n\\}/,
      replacement,
    );
    return { ...loaded, source };
  },
});
globalThis.__doctorLoggedIn = loggedIn;\n`,
  );
  return hook;
}

test('kodo doctor --client X checks only X and exits 0 when optional research/Jev keys are absent', async t => {
  const directory = await makeFixture(t);
  const hook = await writeDoctorHook(directory, { loggedInClients: ['claude-code'] });
  const result = runDoctor(directory, ['--client', 'claude-code', '--json'], {
    hook,
    env: { KODO_GEMINI_API_KEY: 'fixture-gemini-key' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const { checks } = JSON.parse(result.stdout);
  assert.equal(
    checks.some(item => item.provider === 'codex'),
    false,
  );
  const claude = checks.find(item => item.provider === 'claude-code');
  assert.equal(claude.ok, true);
  assert.equal(claude.status, 'ok');
  for (const optional of ['jev', 'scrape', 'reddit', 'x']) {
    const check = checks.find(item => item.provider === optional);
    assert.equal(check.ok, true, optional);
    assert.equal(check.status, 'warning', optional);
    assert.equal(check.required, false, optional);
  }
});

test('kodo doctor exits 2 when a required route key or selected client is unavailable, and exits 0 in quick mode', async t => {
  const directory = await makeFixture(t);
  const hook = await writeDoctorHook(directory, { loggedInClients: ['claude-code'] });

  const missingGemini = runDoctor(directory, ['--client', 'claude-code', '--json'], { hook });
  assert.equal(missingGemini.status, 2, missingGemini.stdout);
  const missingChecks = JSON.parse(missingGemini.stdout).checks;
  assert.equal(missingChecks.find(item => item.provider === 'gemini').status, 'error');
  assert.equal(missingChecks.find(item => item.provider === 'gemini').required, true);

  const quickOk = runDoctor(directory, ['--client', 'claude-code', '--mode', 'quick', '--json'], { hook });
  assert.equal(quickOk.status, 0, quickOk.stderr || quickOk.stdout);
  const quickChecks = JSON.parse(quickOk.stdout).checks;
  assert.equal(quickChecks.find(item => item.provider === 'gemini').status, 'warning');
  assert.equal(quickChecks.find(item => item.provider === 'gemini').required, false);

  const missingClient = runDoctor(directory, ['--client', 'codex', '--mode', 'quick', '--json'], { hook });
  assert.equal(missingClient.status, 2, missingClient.stdout);
  assert.equal(JSON.parse(missingClient.stdout).checks.find(item => item.provider === 'codex').status, 'error');
});

test('kodo-build-feature SKILL.md uses resume --plan --json, report --json and documents delivery none branch transfer', async () => {
  const skill = await readFile(path.join(root, 'skills/kodo-build-feature/SKILL.md'), 'utf8');
  assert.match(skill, /kodo resume <runId> --plan [^\n]+ --json/);
  assert.match(skill, /kodo report <runId> --json/);
  assert.doesNotMatch(skill, /через `status` и `logs`/);
  assert.match(skill, /kodo\/<runId>/);
  assert.match(skill, /delivery.*none|--delivery none/i);
});
