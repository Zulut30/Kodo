import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../runtime/store.mjs';
import { defaultSkillIds } from '../runtime/skill-policy.mjs';

const cli = fileURLToPath(new URL('../cli/index.mjs', import.meta.url));
const stages = ['analyze', 'plan', 'developer', 'tester', 'documenter', 'review', 'complete'];
const hash = 'ab'.repeat(32), revision = 'cd'.repeat(20), headSha = '34'.repeat(20);
const marker = 'DO-NOT-EXPORT-CLI-FIXTURE';
const reportKeys = ['schemaVersion', 'runId', 'state', 'baseSha', 'headSha', 'evidenceLevel', 'skills', 'checks', 'review', 'delivery', 'release'];

// Exercise the real CLI and Store. Only prohibited boundaries are trapped: a
// future regression must fail before it can contact a provider or invoke Git.
// No audit, Store, config or credential implementation is mocked.
const guardSource = `
  import cp from 'node:child_process';
  import net from 'node:net';
  import http from 'node:http';
  import https from 'node:https';
  import tls from 'node:tls';
  import dgram from 'node:dgram';
  import fs from 'node:fs';
  import fsp from 'node:fs/promises';
  import path from 'node:path';
  import { fileURLToPath } from 'node:url';
  import { syncBuiltinESMExports } from 'node:module';
  const deny = name => () => {
    process.stderr.write('AUDIT_FORBIDDEN_SIDE_EFFECT: ' + name + '\\n');
    process.exit(86);
  };
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[name] = deny(name);
  for (const module of [http, https]) for (const name of ['request', 'get']) module[name] = deny('network');
  for (const name of ['connect', 'createConnection']) net[name] = deny('network');
  net.Socket.prototype.connect = deny('network');
  tls.connect = deny('network');
  dgram.createSocket = deny('network');
  globalThis.fetch = deny('fetch');
  globalThis.WebSocket = deny('WebSocket');
  const protectedNames = new Set(['secrets.json', 'credentials.json', 'credentials.dpapi.json', 'kodo.config.json']);
  const protect = original => function(filename, ...args) {
    const name = filename instanceof URL ? fileURLToPath(filename) : Buffer.isBuffer(filename) ? filename.toString() : filename;
    if (typeof name === 'string' && protectedNames.has(path.basename(name).toLowerCase())) deny('credential/config read')();
    return original.call(this, filename, ...args);
  };
  for (const name of ['readFile', 'readFileSync', 'open', 'openSync', 'createReadStream']) fs[name] = protect(fs[name]);
  for (const name of ['readFile', 'open']) fsp[name] = protect(fsp[name]);
  syncBuiltinESMExports();
`;
const guardUrl = `data:text/javascript,${encodeURIComponent(guardSource)}`;

function savedRun(id = 'audit-cli-run') {
  return {
    id, state: 'succeeded', baseSha: '12'.repeat(20), headSha,
    task: marker, analysis: { text: marker }, config: { private: marker }, nodes: { worker: { prompt: marker } },
    plan: { tasks: [{ role: 'documenter' }, { role: 'tester' }, { role: 'developer' }] },
    defaultSkills: Object.fromEntries(stages.map(stage => [stage, {
      hash, skills: defaultSkillIds.map((id, index) => ({
        id, applies: index < 7, reason: index < 7 ? 'Relevant to this stage' : 'Not relevant to this stage',
        revision, source: marker
      }))
    }])),
    checks: { headSha, results: [{ exitCode: 0, stdout: marker, command: { args: [marker] } }] },
    review: { passed: true, headSha, diffHash: hash, findings: [marker] },
    delivery: { pr: { number: 42, url: 'https://example.invalid/pull/42', body: marker }, reviewedHead: headSha, mergeCommit: headSha },
    release: {
      version: '1.2.3', tag: 'v1.2.3', commit: headSha, url: 'https://example.invalid/releases/v1.2.3',
      artifact: 'kodo-1.2.3.tgz', artifactUrl: 'https://example.invalid/kodo-1.2.3.tgz', sha256: hash,
      published: true, smoke: { passed: true, node: 'v24.19.0', platform: 'win32', stdout: marker }
    }
  };
}

async function fixture(t, run = savedRun()) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodo-audit-cli-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('kodo-audit-cli-'));
    await rm(root, { recursive: true, force: true });
  });
  const home = path.join(root, 'state'), cwd = path.join(root, 'unrelated-cwd');
  const credentials = path.join(root, 'credentials'), worktrees = path.join(root, 'worktrees');
  const project = path.join(root, 'saved-project');
  for (const directory of [cwd, credentials, worktrees, project]) await mkdir(directory);
  // Deliberately broken *fixture* data, never real credentials. Reading either
  // credential format, legacy secrets or the saved project's config is a bug.
  for (const name of ['credentials.dpapi.json', 'credentials.json']) await writeFile(path.join(credentials, name), 'intentionally invalid JSON fixture');
  await writeFile(path.join(project, 'kodo.config.json'), 'intentionally invalid config fixture');
  await writeFile(path.join(worktrees, 'sentinel.txt'), 'unchanged fixture');
  const store = new Store(home);
  try {
    store.createRun({ ...run, project });
    store.event(run.id, 'fixture-event', { text: marker });
    // An expired lease detects accidental lease cleanup through engine startup.
    store.db.prepare('INSERT INTO leases VALUES(?,?,?,?,?)').run('fixture-lease', 'fixture', 'fixture', 1, 0);
  } finally { store.close(); }
  await writeFile(path.join(home, 'secrets.json'), 'intentionally invalid legacy fixture');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:SystemRoot|WINDIR|COMSPEC|PATHEXT|LANG|TEMP|TMP)$/i.test(key)));
  Object.assign(env, {
    KODO_HOME: home, KODO_CREDENTIAL_HOME: credentials, KODO_WORKTREE_HOME: worktrees,
    HOME: root, USERPROFILE: root, LOCALAPPDATA: root, XDG_CONFIG_HOME: root,
    PATH: path.join(root, 'no-executables'), NODE_NO_WARNINGS: '1'
  });
  return { root, home, cwd, project, env, id: run.id };
}

function invoke(f, args, options = {}) {
  const result = spawnSync(process.execPath, [
    '--permission', '--allow-fs-read=*', `--allow-fs-write=${f.root}`,
    '--import', guardUrl, cli, ...args
  ], { cwd: f.cwd, env: f.env, encoding: 'utf8', timeout: 15_000, windowsHide: true, ...options });
  assert.ifError(result.error);
  assert.equal(result.signal, null, 'CLI must terminate without timeout or signal');
  assert.notEqual(result.status, 86, result.stderr);
  assert.doesNotMatch(result.stderr, /AUDIT_FORBIDDEN_SIDE_EFFECT/);
  return result;
}
function success(result) {
  assert.equal(result.status, 0, `Audit command must succeed; stderr: ${result.stderr}`);
  return result.stdout;
}
function failure(result) {
  assert.notEqual(result.status, 0, 'invalid invocation must fail');
  assert.equal(result.stdout, '', 'errors must not contaminate machine-readable stdout');
  assert.match(result.stderr, /error|ошибка/i);
  assert.doesNotMatch(result.stderr, /неизвестная команда|unknown command/i, 'failure must concern audit arguments or run lookup, not a missing command');
  assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|SyntaxError|ERR_ACCESS_DENIED|credential_store/);
}

function stateSnapshot(home) {
  const store = new Store(home);
  try {
    // Compare logical state, not SQLite/WAL bytes: Store's existing open path
    // initializes schema and journal mode and is not a zero-filesystem-write API.
    return Object.fromEntries(['runs', 'events', 'leases', 'knowledge', 'sqlite_sequence'].map(table => [
      table, store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
    ]));
  } finally { store.close(); }
}
async function nonDatabaseSnapshot(root, relative = '') {
  const result = {};
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name);
    if (name === path.join('state', 'state.sqlite') || name === path.join('state', 'state.sqlite-wal') || name === path.join('state', 'state.sqlite-shm')) continue;
    result[name] = entry.isDirectory() ? await nonDatabaseSnapshot(root, name) : (await readFile(path.join(root, name))).toString('base64');
  }
  return result;
}

test('Audit CLI JSON reads a saved run from an unrelated no-config cwd', async t => {
  const f = await fixture(t);
  assert.deepEqual(await readdir(f.cwd), []);
  // This must fail RED specifically because the existing entry point lacks audit.
  const report = JSON.parse(success(invoke(f, ['audit', f.id, '--json'])));
  assert.deepEqual(Object.keys(report).sort(), [...reportKeys].sort());
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.runId, f.id);
  assert.equal(report.state, 'succeeded');
  assert.equal(report.evidenceLevel, 'recorded-instructions');
  assert.equal(report.skills.complete, true);
  assert.deepEqual(report.skills.expectedStages, stages);
  assert.deepEqual(report.skills.missingStages, []);
  assert.equal(report.skills.stages.length, 7);
  for (const entry of report.skills.stages) {
    assert.equal(entry.valid, true);
    assert.equal(entry.hash, hash);
    assert.deepEqual(entry.skills.map(skill => skill.id), defaultSkillIds);
    assert.equal(entry.skills.filter(skill => skill.applies).length, 7);
  }
  assert.deepEqual(report.checks, { headSha, results: [{ exitCode: 0 }] });
  assert.deepEqual(report.review, { passed: true, headSha, diffHash: hash });
  assert.equal(report.delivery.pr.number, 42);
  assert.equal(report.release.tag, 'v1.2.3');
  assert.ok(!JSON.stringify(report).includes(marker));
});

test('Audit CLI ignores broken credentials and configs without changing saved state or worktrees', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.cwd, 'kodo.config.json'), 'intentionally invalid unrelated config fixture');
  const beforeState = stateSnapshot(f.home), beforeFiles = await nonDatabaseSnapshot(f.root);
  const report = JSON.parse(success(invoke(f, ['audit', f.id, '--json'])));
  assert.equal(report.runId, f.id);
  success(invoke(f, ['audit', f.id]));
  assert.deepEqual(stateSnapshot(f.home), beforeState, 'runs, events, leases and knowledge must be unchanged');
  assert.deepEqual(await nonDatabaseSnapshot(f.root), beforeFiles, 'no config, credential or worktree writes');
});

test('Audit CLI unknown run does not initialize a missing state home', async t => {
  const f = await fixture(t);
  const absentHome = path.join(f.root, 'never-initialized-state');
  const beforeFiles = (await readdir(f.root)).sort();
  const result = invoke(f, ['audit', 'missing-audit-run', '--json'], {
    env: { ...f.env, KODO_HOME: absentHome }
  });
  failure(result);
  assert.match(result.stderr, /не найден|not found|unknown run|no saved state|хранилище.*отсутств/i);
  assert.deepEqual((await readdir(f.root)).sort(), beforeFiles, 'read-only audit must not create a state directory or database');
});

test('Audit CLI reads a legacy saved run without changing database bytes or adding schema', async t => {
  const f = await fixture(t);
  const legacyHome = path.join(f.root, 'legacy-state');
  await mkdir(legacyHome);
  const filename = path.join(legacyHome, 'state.sqlite');
  const db = new DatabaseSync(filename);
  try {
    db.exec('CREATE TABLE runs(id TEXT PRIMARY KEY, body TEXT NOT NULL, updated INTEGER NOT NULL)');
    db.prepare('INSERT INTO runs VALUES(?,?,?)').run('legacy-read-only', JSON.stringify({
      id: 'legacy-read-only', state: 'awaiting_plan'
    }), 1);
  } finally { db.close(); }
  const beforeBytes = await readFile(filename), beforeFiles = (await readdir(legacyHome)).sort();
  const report = JSON.parse(success(invoke(f, ['audit', 'legacy-read-only', '--json'], {
    env: { ...f.env, KODO_HOME: legacyHome }
  })));
  assert.equal(report.runId, 'legacy-read-only');
  assert.equal(report.skills.complete, false);
  const inspected = new DatabaseSync(filename, { readOnly: true });
  let tableNames;
  try {
    tableNames = inspected.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(row => row.name);
  } finally { inspected.close(); }
  assert.deepEqual(tableNames, ['runs'], 'read-only audit must not initialize unrelated tables in legacy state');
  assert.ok((await readFile(filename)).equals(beforeBytes), 'read-only audit must preserve the existing database and journal mode');
  assert.deepEqual((await readdir(legacyHome)).sort(), beforeFiles, 'read-only audit must not leave new files in legacy state');
});

test('Audit CLI returns exit zero and incomplete JSON for old saved runs', async t => {
  const f = await fixture(t, { id: 'legacy-audit-run', state: 'awaiting_plan' });
  const report = JSON.parse(success(invoke(f, ['audit', f.id, '--json'])));
  assert.equal(report.runId, f.id);
  assert.equal(report.state, 'awaiting_plan');
  assert.equal(report.skills.complete, false);
  assert.deepEqual(report.skills.missingStages, ['analyze', 'plan', 'review', 'complete']);
  assert.equal(report.headSha, null);
  for (const receipt of ['checks', 'review', 'delivery', 'release']) assert.equal(report[receipt], null);
});

test('Audit CLI returns exit zero with invalid recorded policy flagged', async t => {
  const run = savedRun();
  run.defaultSkills.tester.hash = 'invalid';
  const f = await fixture(t, run);
  const report = JSON.parse(success(invoke(f, ['audit', f.id, '--json'])));
  assert.equal(report.skills.complete, false);
  assert.equal(report.skills.stages.find(stage => stage.stage === 'tester').valid, false);
});

test('Audit CLI text explains coverage missing and invalid stages applied skills and evidence limits', async t => {
  const run = savedRun();
  delete run.defaultSkills.developer;
  run.defaultSkills.tester.hash = 'invalid';
  const f = await fixture(t, run);
  const output = success(invoke(f, ['audit', f.id]));
  assert.ok(output.includes(f.id));
  assert.match(output, /succeeded/);
  assert.match(output, /recorded-instructions/);
  assert.match(output, /incomplete|неполн|не полн|complete\s*[:=]\s*false/i);
  assert.match(output, /(?:missing|отсутств|не запис)[^\r\n]*developer|developer[^\r\n]*(?:missing|отсутств|не запис)/i);
  assert.match(output, /(?:invalid|некоррект|невалид)[^\r\n]*tester|tester[^\r\n]*(?:invalid|некоррект|невалид)/i);
  assert.match(output, /7\s*(?:\/|of|из)\s*13|(?:applied|примен)[^\r\n]*\b7\b|\b7\b[^\r\n]*(?:applied|примен)/i);
  assert.match(output, /e2e-testing-patterns/);
  assert.match(output, /(?:not|не)[^\r\n]*(?:semantic|семантическ)|(?:semantic|семантическ)[^\r\n]*(?:not|не)/i);
  assert.match(output, /https:\/\/example\.invalid\/pull\/42/);
  assert.match(output, /v1\.2\.3/);
  assert.match(output, /https:\/\/example\.invalid\/releases\/v1\.2\.3/);
  assert.ok(!output.includes(marker));
});

test('Audit CLI text identifies complete coverage', async t => {
  const f = await fixture(t);
  const output = success(invoke(f, ['audit', f.id]));
  assert.match(output, /complete|полно|полное|полное покрытие/i);
  assert.doesNotMatch(output, /incomplete|неполн|не полн|complete\s*[:=]\s*false/i);
  assert.match(output, /recorded-instructions/);
});

for (const flags of [[], ['--json']]) test(`Audit CLI rejects an unknown run in ${flags.length ? 'JSON' : 'text'} mode without state changes`, async t => {
  const f = await fixture(t);
  const before = stateSnapshot(f.home);
  const result = invoke(f, ['audit', 'missing-audit-run', ...flags]);
  failure(result);
  assert.match(result.stderr, /missing-audit-run/);
  assert.match(result.stderr, /не найден|not found|unknown run/i);
  assert.deepEqual(stateSnapshot(f.home), before);
});

for (const [name, args] of [
  ['missing ID', []], ['JSON without ID', ['--json']], ['empty ID', ['']],
  ['blank ID', [' \t ']], ['flag before ID', ['--json', 'audit-cli-run']],
  ['duplicate JSON flag', ['audit-cli-run', '--json', '--json']],
  ['extra ID', ['audit-cli-run', 'other']], ['extra ID with JSON', ['audit-cli-run', '--json', 'other']],
  ['unknown flag', ['audit-cli-run', '--unknown']], ['valued JSON flag', ['audit-cli-run', '--json=true']],
  ['project flag', ['audit-cli-run', '--project', '.']], ['target flag', ['audit-cli-run', '--target', '.']],
  ['client flag', ['audit-cli-run', '--client', 'codex']], ['model flag', ['audit-cli-run', '--model', 'fake']],
  ['live flag', ['audit-cli-run', '--live']], ['prepare flag', ['audit-cli-run', '--prepare']],
  ['retry flag', ['audit-cli-run', '--retry-failed']], ['plan flag', ['audit-cli-run', '--plan', 'missing.json']]
]) test(`Audit CLI rejects ${name}`, async t => {
  const f = await fixture(t);
  failure(invoke(f, ['audit', ...args]));
});

test('Audit CLI help advertises audit RUN_ID and optional JSON output', async t => {
  const f = await fixture(t);
  const output = success(invoke(f, ['--help']));
  assert.match(output, /(?:kodo|node cli\/index\.mjs) audit (?:RUN_ID|<RUN_ID>|<runId>|<run-id>) \[--json\]/);
});
