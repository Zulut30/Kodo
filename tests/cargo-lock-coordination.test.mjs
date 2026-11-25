import test from 'node:test';
import assert from 'node:assert/strict';
import { lockChange } from '../runtime/cargo-lock.mjs';

const pkg = (name, version, checksum = 'a') =>
  `[[package]]\nname = "${name}"\nversion = "${version}"\nsource = "registry+x"\nchecksum = "${checksum}"\n`;
const old = 'version = 3\n' + pkg('one', '1');
test('implicit lock preserves package identities and accepts dependency additions', () => {
  assert.equal(lockChange(old, old + pkg('two', '2')), null);
  for (const replacement of [
    pkg('one', '2'),
    pkg('one', '1', 'b'),
    pkg('one', '1').replace('registry+x', 'registry+y'),
  ])
    assert.equal(lockChange(old, 'version = 4\n' + replacement), 'cargo_lock_version_change');
  assert.equal(lockChange(old + pkg('two', '2'), old), null);
  assert.equal(lockChange(old, old + 'dependencies = ["two"]\n' + pkg('two', '2')), null);
  assert.equal(lockChange(old, old.replace('version = 3', 'version = 2')), 'scope');
  assert.equal(lockChange(old, old + '[unknown]\n'), 'scope');
});
