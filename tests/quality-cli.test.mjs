import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execute } from '../runtime/delivery.mjs';
import { fixture, projects } from './fixtures/quality/helpers.mjs';
const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../cli/index.mjs');

test('Quality CLI detect and plan return one offline JSON result without runtime startup', async t => {
  const fx = await fixture(t, projects.typescript);
  for (const stage of ['detect', 'plan']) {
    const result = await execute(process.execPath, [cli, 'quality', stage, '--project', fx.project, '--json'], { allowFailure: true, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, KODO_HOME: path.join(fx.base, 'absent-state') } });
    assert.equal(result.code, 0, result.stderr); const data = JSON.parse(result.stdout);
    assert.ok(data.languages.includes('typescript')); assert.equal(result.stderr, '');
    const { existsSync } = await import('node:fs'); assert.equal(existsSync(path.join(fx.base, 'absent-state')), false);
  }
});
test('Quality CLI rejects extra duplicate invalid and inapplicable flags as one JSON error', async () => {
  for (const args of [['detect', '--mode', 'quick'], ['plan', '--mode', 'wrong'], ['plan', 'extra'], ['run', '--fix'], ['detect', '--json', '--json'], ['run', '--timeout-ms', '0']]) {
    const result = await execute(process.execPath, [cli, 'quality', ...args, '--json'], { allowFailure: true });
    assert.notEqual(result.code, 0); assert.equal(JSON.parse(result.stdout).status, 'blocked');
  }
});
test('Quality CLI plan reports blocked dialect without executing a tool', async t => {
  const fx = await fixture(t, projects.sql);
  const result = await execute(process.execPath, [cli, 'quality', 'plan', '--project', fx.project, '--capability', 'lint', '--json'], { allowFailure: true });
  assert.equal(result.code, 1); const data = JSON.parse(result.stdout);
  assert.equal(data.status, 'blocked'); assert.equal(data.checks[0].reason, 'sql_dialect_required');
});
test('Quality CLI run returns nonzero missing native pin with independent receipts', async t => {
  const fx = await fixture(t, { 'Program.cs': 'class P {}', 'App.csproj': projects.csharp['App.csproj'] });
  const result = await execute(process.execPath, [cli, 'quality', 'run', '--project', fx.project, '--capability', 'format', '--evidence-dir', fx.evidenceDir, '--json'], { allowFailure: true });
  assert.notEqual(result.code, 0); const data = JSON.parse(result.stdout);
  assert.equal(data.status, 'blocked'); assert.equal(data.receipts[0].status, 'missing');
});
