import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { inspectCurrentSource } from '../runtime/ci-graph.mjs';

const native = { ...fs }, spawn = childProcess.spawn;
const turn = () => new Promise(resolve => setImmediate(resolve));
const git = (cwd, ...args) => childProcess.execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
const statusArgs = ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'];
const configArgs = ['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'];

async function fixture(t, repository = true) {
  const project = await native.realpath(await native.mkdtemp(path.join(os.tmpdir(), 'kodo-source-overlap-')));
  t.after(async () => {
    assert.equal(path.dirname(project), await native.realpath(os.tmpdir()));
    assert.match(path.basename(project), /^kodo-source-overlap-/);
    await native.rm(project, { recursive: true, force: true });
  });
  if (!repository) return { project, headSha: 'a'.repeat(40) };
  git(project, 'init', '-q');
  git(project, 'config', 'user.email', 'fixture@example.invalid');
  git(project, 'config', 'user.name', 'Fixture');
  for (const file of ['a.txt', 'z.txt']) await native.writeFile(path.join(project, file), file + '\n');
  git(project, 'add', '-A'); git(project, 'commit', '-qm', 'fixture');
  // No attributes select this driver; both guarded statuses must still disable it.
  git(project, 'config', 'filter.fixture.clean', 'echo unexpected-filter');
  git(project, 'config', 'filter.fixture.required', 'true');
  return { project, headSha: git(project, 'rev-parse', 'HEAD') };
}

// Every observed command really spawns Git. Optional wire faults and a held
// close notification are isolated built-in mocks, never a production DI port.
function observe(t, { wire = {}, fail = [], hold } = {}) {
  const events = [], calls = [], waiting = new Map();
  let active = 0, peak = 0, release;
  const held = new Promise(resolve => { release = resolve; });
  t.mock.method(childProcess, 'spawn', (command, args, options) => {
    const child = spawn(command, args, options);
    assert.match(command, /(?:^|[\\/])git(?:\.exe)?$/i);
    const kind = ['rev-parse', 'ls-tree', 'config', 'status'].find(kind => args.includes(kind));
    assert.ok(kind, 'Only the four approved observations may spawn');
    const call = { id: calls.length, kind, args: [...args], pid: child.pid };
    calls.push(call);
    child.once('spawn', () => {
      active++; peak = Math.max(peak, active);
      events.push({ event: 'start', id: call.id, pid: child.pid, active });
    });
    if (Object.hasOwn(wire, kind)) {
      const emit = child.stdout.emit;
      child.stdout.emit = function (event, ...values) {
        if (event === 'data') return true;
        if (event === 'end') emit.call(this, 'data', wire[kind]);
        return emit.call(this, event, ...values);
      };
    }
    const emit = child.emit;
    child.emit = function (event, ...values) {
      if (event !== 'close') return emit.call(this, event, ...values);
      active--;
      events.push({ event: 'close', id: call.id, pid: child.pid, code: values[0], active });
      const deliver = () => {
        events.push({ event: 'settle', id: call.id, code: fail.includes(kind) ? 1 : values[0] });
        const result = emit.call(this, event, fail.includes(kind) ? 1 : values[0], ...values.slice(1));
        waiting.get(kind)?.();
        return result;
      };
      if (kind === hold) { release(deliver); return true; }
      return deliver();
    };
    return child;
  });
  t.mock.method(fs, 'realpath', async (...args) => {
    const result = await native.realpath(...args);
    events.push({ event: 'canonical', input: String(args[0]), result });
    return result;
  });
  t.mock.method(fs, 'open', async (...args) => {
    events.push({ event: 'source-open', file: path.basename(String(args[0])) });
    const handle = await native.open(...args), read = handle.read.bind(handle), close = handle.close.bind(handle);
    handle.read = async (...values) => {
      events.push({ event: 'source-read', file: path.basename(String(args[0])) });
      return read(...values);
    };
    handle.close = async () => {
      await close(); events.push({ event: 'source-close', file: path.basename(String(args[0])) });
    };
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return {
    calls, events, held,
    get peak() { return peak; },
    settled(kind) {
      if (events.some(event => event.event === 'settle' && calls[event.id].kind === kind)) return Promise.resolve();
      return new Promise(resolve => waiting.set(kind, resolve));
    },
    drained() {
      assert.equal(active, 0, 'No spawned Git process survives the inspection return');
      assert.equal(events.filter(event => event.event === 'start').length, calls.length);
      assert.equal(events.filter(event => event.event === 'close').length, calls.length);
      assert.equal(events.filter(event => event.event === 'settle').length, calls.length, 'Every command promise is drained');
      t.diagnostic(JSON.stringify({ peak, total: calls.length, config: calls.filter(call => call.kind === 'config').length, calls, events }));
    }
  };
}

test('Source inspection overlaps real Git processes with exactly six commands and two fresh guards', async t => {
  const input = await fixture(t), trace = observe(t);
  assert.equal(await inspectCurrentSource(input), 'clean');
  trace.drained();
  assert.equal(trace.calls.length, 6);
  assert.equal(trace.calls.filter(call => call.kind === 'config').length, 2);
  assert.deepEqual(trace.calls.map(call => call.kind).sort(), ['config', 'config', 'ls-tree', 'rev-parse', 'status', 'status']);
  for (const call of trace.calls) {
    const expected = { 'rev-parse': ['rev-parse', '--show-toplevel'], 'ls-tree': ['ls-tree', '-rz', '--full-tree', input.headSha], config: configArgs, status: statusArgs }[call.kind];
    assert.deepEqual(call.args.slice(call.args.indexOf(call.kind)), expected);
    assert.ok(call.args.includes('core.fsmonitor=false'));
    assert.ok(call.args.includes('credential.helper='));
    if (call.kind === 'status') for (const setting of ['clean=', 'smudge=', 'process=', 'required=false']) assert.ok(call.args.includes('filter.fixture.' + setting));
  }
  // This assertion is intentionally RED on the old serial source (peak 1).
  assert.ok(trace.peak >= 2, `Expected actual spawned Git overlap; observed peak ${trace.peak}`);
  const statuses = trace.calls.filter(call => call.kind === 'status'), configs = trace.calls.filter(call => call.kind === 'config');
  const index = (event, id) => trace.events.findIndex(item => item.event === event && item.id === id);
  const firstRead = trace.events.findIndex(item => item.event === 'source-open');
  const lastByteClose = trace.events.findLastIndex(item => item.event === 'source-close');
  const canonical = trace.events.filter(item => item.event === 'canonical');
  assert.equal(canonical.length, 2);
  assert.equal(canonical[1].result, input.project);
  assert.ok(trace.events.indexOf(canonical[1]) < firstRead, 'Root canonical validation precedes source access');
  assert.ok(index('settle', statuses[0].id) < firstRead, 'Initial HEAD/dirty fence precedes source access');
  assert.deepEqual(trace.events.filter(item => item.event === 'source-open').map(item => item.file), ['a.txt', 'z.txt']);
  for (let fence = 0; fence < 2; fence++) assert.ok(index('settle', configs[fence].id) < index('start', statuses[fence].id), 'Each status waits for its own config');
  assert.ok(lastByteClose < index('start', configs[1].id), 'Final fresh config guard starts after the complete byte loop');
  assert.ok(index('settle', statuses[1].id) > lastByteClose);
});

const cases = [
  { name: 'dirty state outranks speculative tree rejection', dirty: true, fail: ['ls-tree'], expected: 'dirty', hold: 'ls-tree', wait: 'status' },
  { name: 'dirty state outranks malformed tree', dirty: true, wire: { 'ls-tree': 'malformed\0' }, expected: 'dirty', hold: 'ls-tree', wait: 'status' },
  { name: 'root rejection outranks dirty state and drains tree', dirty: true, fail: ['rev-parse', 'ls-tree'], expected: 'unknown', hold: 'ls-tree', wait: 'rev-parse' },
  { name: 'nonroot identity outranks dirty state', nested: true, dirty: true, expected: 'unknown', hold: 'ls-tree', wait: 'status' },
  { name: 'nonrepository failure drains every started branch', repository: false, expected: 'unknown', hold: 'ls-tree', wait: 'rev-parse' },
  { name: 'tree command rejection follows clean initial fence', fail: ['ls-tree'], expected: 'unknown', hold: 'rev-parse', wait: 'ls-tree' },
  { name: 'malformed tree fails closed after clean initial fence', wire: { 'ls-tree': 'malformed\0' }, expected: 'unknown', hold: 'rev-parse', wait: 'ls-tree' },
  { name: 'initial status rejection drains tree', fail: ['status'], expected: 'unknown', hold: 'ls-tree', wait: 'status' },
  { name: 'malformed initial status drains tree', wire: { status: '# branch.head fixture\0' }, expected: 'unknown', hold: 'ls-tree', wait: 'status' },
  { name: 'invalid config blocks status and drains tree', wire: { config: 'invalid-key\0' }, expected: 'unknown', hold: 'ls-tree', wait: 'config', noStatus: true }
];
for (const scenario of cases) test('Source overlap precedence and drainage: ' + scenario.name, async t => {
  const input = await fixture(t, scenario.repository);
  if (scenario.dirty) await native.writeFile(path.join(input.project, 'untracked.txt'), 'dirty');
  if (scenario.nested) { input.project = path.join(input.project, 'nested'); await native.mkdir(input.project); }
  const trace = observe(t, scenario);
  let returned = false;
  const inspection = inspectCurrentSource(input).then(result => { returned = true; return result; });
  const release = await trace.held;
  try {
    await trace.settled(scenario.wait);
    await turn();
    assert.equal(returned, false, 'Inspection cannot return while a started branch remains unsettled');
    assert.equal(trace.events.filter(item => item.event === 'source-open').length, 0);
  } finally { release(); }
  assert.equal(await inspection, scenario.expected);
  trace.drained();
  assert.ok(trace.calls.some(call => call.kind === 'rev-parse'));
  assert.ok(trace.calls.some(call => call.kind === 'ls-tree'));
  assert.equal(trace.calls.filter(call => call.kind === 'config').length, 1);
  assert.equal(trace.calls.filter(call => call.kind === 'status').length, scenario.noStatus ? 0 : 1);
  assert.equal(trace.events.filter(item => item.event === 'source-open').length, 0, 'Failed initial authority never reads tracked bytes');
});

test('Source overlap final guarded fence still detects a change after all tracked bytes', async t => {
  const input = await fixture(t), trace = observe(t);
  const read = fs.open;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await read(...args), close = handle.close.bind(handle);
    handle.close = async () => {
      await close();
      if (path.basename(String(args[0])) === 'z.txt') await native.writeFile(path.join(input.project, 'untracked.txt'), 'changed after bytes');
    };
    return handle;
  });
  syncBuiltinESMExports();
  assert.equal(await inspectCurrentSource(input), 'dirty');
  trace.drained();
  assert.equal(trace.calls.length, 6);
  const configs = trace.calls.filter(call => call.kind === 'config');
  assert.equal(configs.length, 2);
  const lastClose = trace.events.findLastIndex(item => item.event === 'source-close');
  assert.ok(lastClose < trace.events.findIndex(item => item.event === 'start' && item.id === configs[1].id));
});
