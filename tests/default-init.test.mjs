import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'cli/index.mjs');
const slugs = [
  'architecture-patterns',
  'architecture-decision-records',
  'monorepo-management',
  'e2e-testing-patterns',
  'subagent-driven-development',
  'systematic-debugging',
  'test-driven-development',
  'using-git-worktrees',
  'differential-review',
  'react-best-practices',
  'composition-patterns',
  'ce-compound',
  'spec-kit',
];
const text = filename => readFile(filename, 'utf8');
async function exists(filename) {
  try {
    await access(filename);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodo-default-init-'));
  t.after(async () => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('kodo-default-init-'));
    await rm(resolved, { recursive: true, force: true });
  });
  return directory;
}

function init(project) {
  return spawnSync(process.execPath, [cli, 'init', '--project', project, '--json'], {
    cwd: os.tmpdir(),
    encoding: 'utf8',
    windowsHide: true,
  });
}

async function snapshot(directory) {
  const files = {};
  async function visit(parent, relative = '') {
    const entries = (await readdir(parent, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const filename = path.join(parent, entry.name);
      if (entry.isDirectory()) await visit(filename, name);
      else {
        assert.equal(entry.isFile(), true, 'fixture must not contain links or special files');
        files[name] = createHash('sha256')
          .update(await readFile(filename))
          .digest('hex');
      }
    }
  }
  await visit(directory);
  return files;
}

test('CLI init installs all default skills and the chat entry for Codex Claude Code and OpenCode', async t => {
  const project = await temporary(t);
  const result = init(project);
  assert.equal(result.status, 0, result.stderr);
  const initialized = JSON.parse(result.stdout);
  assert.equal(initialized.configCreated, true);
  assert.deepEqual(initialized.clients, ['codex', 'claude-code', 'opencode']);
  for (const slug of [...slugs, 'kodo-build-feature']) {
    assert.ok(initialized.components.includes(`skills/${slug}`), slug);
    const original = await text(path.join(root, 'skills', slug, 'SKILL.md'));
    assert.equal(await text(path.join(project, '.agents/skills', slug, 'SKILL.md')), original);
    assert.equal(await text(path.join(project, '.claude/skills', slug, 'SKILL.md')), original);
  }
  // OpenCode uses the shared .agents/skills path and its native role adapter.
  assert.match(await text(path.join(project, '.opencode/agents/kodo-documenter.md')), /mode: subagent/);
  assert.equal(await exists(path.join(project, '.agents/skills/spec-kit/references/upstream/tasks-template.md')), true);
  assert.equal(
    await exists(path.join(project, '.claude/skills/differential-review/references/upstream/LICENSE.upstream')),
    true,
  );
  const config = JSON.parse(await text(path.join(project, 'kodo.config.json')));
  assert.equal(config.schemaVersion, 1);
  assert.equal(config.client, 'codex');
  assert.equal(config.delivery.enabled, false);
  assert.equal(await exists(path.join(project, '.mcp.json')), false);
  assert.equal(await exists(path.join(project, '.codex/config.toml')), false);
});

test('CLI init repeat preserves an existing custom project configuration and identical installed files', async t => {
  const project = await temporary(t);
  const custom =
    JSON.stringify(
      {
        schemaVersion: 1,
        client: 'claude-code',
        primaryModel: 'opus',
        concurrency: 1,
        researchBudget: 3,
        delivery: { enabled: false, release: false },
      },
      null,
      4,
    ) + '\n';
  await writeFile(path.join(project, 'kodo.config.json'), custom);
  await writeFile(path.join(project, 'user-notes.txt'), 'Leave this project file unchanged.\n');
  const first = init(project);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).configCreated, false);
  assert.equal(JSON.parse(first.stdout).config.client, 'claude-code');
  const before = await snapshot(project);
  const repeated = init(project);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(JSON.parse(repeated.stdout).configCreated, false);
  assert.deepEqual(await snapshot(project), before);
  assert.equal(await text(path.join(project, 'kodo.config.json')), custom);
  assert.equal(await text(path.join(project, 'user-notes.txt')), 'Leave this project file unchanged.\n');
});

test('CLI init detects an edited installed skill before recreating any missing file or changing config', async t => {
  const project = await temporary(t);
  const first = init(project);
  assert.equal(first.status, 0, first.stderr);
  const config =
    JSON.stringify(
      {
        schemaVersion: 1,
        client: 'claude-code',
        primaryModel: 'sonnet',
        concurrency: 1,
        delivery: { enabled: false, release: false },
      },
      null,
      2,
    ) + '\n';
  await writeFile(path.join(project, 'kodo.config.json'), config);
  const edited = path.join(project, '.claude/skills/systematic-debugging/SKILL.md');
  const customSkill = (await text(edited)) + '\nProject-specific diagnostic instruction written by the user.\n';
  await writeFile(edited, customSkill);
  // This earlier dependency would be recreated by an installer that writes
  // incrementally before discovering the later edited-skill conflict.
  const missing = path.join(project, '.agents/skills/kodo-documenter/SKILL.md');
  await rm(missing);
  const before = await snapshot(project);
  const repeated = init(project);
  assert.equal(repeated.status, 1);
  assert.match(repeated.stderr, /Файл изменён пользователем: \.claude\/skills\/systematic-debugging\/SKILL.md/);
  assert.equal(repeated.stdout, '');
  assert.deepEqual(await snapshot(project), before);
  assert.equal(await text(edited), customSkill);
  assert.equal(await text(path.join(project, 'kodo.config.json')), config);
  assert.equal(await exists(missing), false);
  assert.equal(await exists(path.join(project, '.kodo/install.guard')), false);
});
