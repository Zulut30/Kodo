import test from 'node:test';
import assert from 'node:assert/strict';
import { JOB_HOSTS, PULL_HOSTS, hostStatus, isPullHost } from '../runtime/job-contracts.mjs';

test('Pull hosts are exactly the external chat hosts and never the native Engine', () => {
  assert.deepEqual([...PULL_HOSTS], ['t3', 'orca']);
  assert.ok(Object.isFrozen(PULL_HOSTS), 'the host list is a frozen contract');
  for (const host of PULL_HOSTS) assert.ok(JOB_HOSTS.includes(host), `${host} is a known job host`);
  assert.equal(isPullHost('t3'), true);
  assert.equal(isPullHost('orca'), true);
  for (const value of ['native', 'T3', ' t3', 'orca ', '', null, undefined, 3, {}, ['t3']])
    assert.equal(isPullHost(value), false, `${JSON.stringify(value)} is not a pull host`);
});

test('Pull host helpers leave host availability unchanged', () => {
  assert.deepEqual(hostStatus('native'), { id: 'native', available: true });
  assert.deepEqual(hostStatus('t3'), { id: 't3', available: false, reason: 'not_connected' });
  assert.deepEqual(hostStatus('orca', { orca: { available: true } }), { id: 'orca', available: true });
});
