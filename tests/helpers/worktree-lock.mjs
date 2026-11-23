import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function assertWorktreeLockHeld(common) {
  const probe = new DatabaseSync(path.join(common, 'kodo-worktree-guard.sqlite'), { timeout: 0 });
  try {
    assert.throws(
      () => probe.exec('BEGIN IMMEDIATE'),
      error => (error.errcode & 0xff) === 5,
    );
  } finally {
    probe.close();
  }
}
