import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_EXECUTION,
  bindInterfaceEvidence,
  compileBlueprint,
  lintFactorySpec,
  readBlueprint,
} from '../runtime/project-blueprint.mjs';
import { normalizeProjectSpec } from '../runtime/project-contracts.mjs';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'blueprint');
const codes = result => result.findings.map(item => item.code);
const byCode = (result, code) => result.findings.find(item => item.code === code);

async function temp(t, prefix = 'kodo-blueprint-') {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Copy valid/ (+ an invalid/<overlay>) into <root>/.kodo/blueprint and bind root. */
async function blueprint(t, { overlay, mutate } = {}) {
  const root = await temp(t);
  const dir = path.join(root, '.kodo', 'blueprint');
  await cp(path.join(fixtures, 'valid'), dir, { recursive: true });
  if (overlay) await cp(path.join(fixtures, 'invalid', overlay), dir, { recursive: true });
  const spec = JSON.parse(await readFile(path.join(dir, 'spec.json'), 'utf8'));
  spec.root = root;
  mutate?.(spec);
  await writeFile(path.join(dir, 'spec.json'), JSON.stringify(spec, null, 2));
  return { root, dir };
}
const task = (spec, id) => spec.tasks.find(item => item.id === id);

async function tree(dir, prefix = '') {
  const result = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) result.push(...(await tree(path.join(dir, entry.name), `${name}/`)));
    else
      result.push([
        name,
        createHash('sha256')
          .update(await readFile(path.join(dir, entry.name)))
          .digest('hex'),
      ]);
  }
  return result;
}

test('valid blueprint compiles into a strict ProjectSpec with wave execution and resolved interfaces', async t => {
  const { root, dir } = await blueprint(t);
  const before = await tree(root);
  const result = await compileBlueprint(root);
  assert.deepEqual(result.findings, []);
  assert.equal(result.ok, true);
  assert.deepEqual(result.spec.execution, DEFAULT_EXECUTION);
  assert.equal(result.spec.root, root);
  assert.deepEqual(
    result.interfaces.map(item => [item.module, item.path]),
    [
      ['api', 'interfaces/api.md'],
      ['storage', 'interfaces/storage.md'],
      ['web', 'interfaces/web.md'],
    ],
  );
  for (const item of result.interfaces) {
    const bytes = await readFile(path.join(dir, item.path));
    assert.equal(item.bytes, bytes.length);
    assert.equal(item.sha256, createHash('sha256').update(bytes).digest('hex'));
  }
  const ref = task(result.spec, 'scaffold').interfaceRefs[0];
  assert.deepEqual(ref, {
    kind: 'interface',
    runId: null,
    headSha: null,
    path: path.join(dir, 'interfaces', 'storage.md'),
    sha256: result.interfaces.find(item => item.module === 'storage').sha256,
  });
  // The compiled spec, `execution` included, is accepted by the strict parser as is.
  assert.deepEqual(normalizeProjectSpec(result.spec, { knownValues: [] }), result.spec);
  assert.deepEqual(await tree(root), before, 'compile writes nothing');
  const again = await compileBlueprint(root);
  assert.deepEqual(again, result, 'deterministic');
});

test('missing Wave 0 is reported', async t => {
  const { root } = await blueprint(t, { overlay: 'no-wave0' });
  const result = await compileBlueprint(root);
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ['blueprint_wave0_missing']);
});

test('a task that bypasses Wave 0 is reported with its dependants', async t => {
  const { root } = await blueprint(t, { overlay: 'bypass-wave0' });
  const result = await compileBlueprint(root);
  assert.deepEqual(codes(result), ['blueprint_wave0_bypassed']);
  assert.deepEqual(byCode(result, 'blueprint_wave0_bypassed').taskIds, ['web-module', 'web-ui-qa']);
});

test('Wave 0 tasks may not depend on later tasks', async t => {
  const { root } = await blueprint(t, {
    mutate(spec) {
      spec.tasks.push({ ...task(spec, 'mvp-review'), id: 'early', dependsOn: [], writePaths: ['docs/early'] });
      task(spec, 'test-bench').dependsOn = ['scaffold', 'early'];
    },
  });
  const result = await compileBlueprint(root);
  // foundation-setup → release-review → storage → foundation-setup is also an epic cycle.
  assert.deepEqual(codes(result), ['blueprint_wave0_bypassed', 'blueprint_wave0_order', 'blueprint_epic_cycle']);
  assert.deepEqual(byCode(result, 'blueprint_wave0_bypassed').taskIds, ['early']);
  assert.deepEqual(byCode(result, 'blueprint_wave0_order').taskIds, ['test-bench']);
});

test('overlapping writePaths of parallel tasks are reported as pairs; dependent tasks may share paths', async t => {
  const { root } = await blueprint(t, { overlay: 'parallel-overlap' });
  const result = await compileBlueprint(root);
  assert.deepEqual(codes(result), ['blueprint_parallel_overlap']);
  assert.deepEqual(byCode(result, 'blueprint_parallel_overlap').taskIds, ['storage-module', 'api-module']);
  const dependent = await blueprint(t, {
    mutate(spec) {
      task(spec, 'web-ui-qa').writePaths = ['src/web/e2e'];
    },
  });
  assert.deepEqual((await compileBlueprint(dependent.root)).findings, []);
  const glob = await blueprint(t, {
    mutate(spec) {
      task(spec, 'web-module').writePaths = ['src/**/*.css'];
    },
  });
  const globResult = await compileBlueprint(glob.root);
  assert.deepEqual(codes(globResult), ['blueprint_parallel_overlap', 'blueprint_parallel_overlap']);
});

test('a task whose Director input exceeds 12000 bytes requires a split; Kodo does not split it', async t => {
  const description = 'Подробное описание. '.repeat(400);
  const { root } = await blueprint(t, {
    mutate(spec) {
      task(spec, 'api-module').description = description;
    },
  });
  const result = await compileBlueprint(root);
  assert.deepEqual(codes(result), ['split_required']);
  assert.deepEqual(byCode(result, 'split_required').taskIds, ['api-module']);
  assert.equal(result.spec.tasks.length, 7);
  assert.equal(task(result.spec, 'api-module').description, description);
});

test('interface references must point at existing and current interfaces/*.md', async t => {
  const missing = await blueprint(t, { overlay: 'missing-interface' });
  const result = await compileBlueprint(missing.root);
  assert.deepEqual(codes(result), ['blueprint_interface_missing']);
  assert.deepEqual(byCode(result, 'blueprint_interface_missing').taskIds, ['web-module']);

  const stale = await blueprint(t, {
    mutate(spec) {
      task(spec, 'storage-module').interfaceRefs[0].sha256 = 'a'.repeat(64);
    },
  });
  const staleResult = await compileBlueprint(stale.root);
  assert.deepEqual(codes(staleResult), ['blueprint_interface_stale']);
  assert.deepEqual(byCode(staleResult, 'blueprint_interface_stale').taskIds, ['storage-module']);

  const escape = await blueprint(t, {
    mutate(spec) {
      task(spec, 'web-module').interfaceRefs = [{ kind: 'interface', path: '../outside.md' }];
      task(spec, 'api-module').interfaceRefs = [
        { kind: 'interface', runId: null, headSha: null, path: 'C:/elsewhere/api.md', sha256: 'b'.repeat(64) },
      ];
    },
  });
  const escapeResult = await compileBlueprint(escape.root);
  assert.deepEqual(codes(escapeResult), ['blueprint_interface_missing', 'blueprint_interface_missing']);
  assert.deepEqual(byCode(escapeResult, 'blueprint_interface_missing').taskIds, ['web-module']);
  assert.deepEqual(escapeResult.findings[1].taskIds, ['api-module']);
});

test('PROJECT.md must contain non-empty required sections', async t => {
  const { root } = await blueprint(t, { overlay: 'missing-sections' });
  const result = await compileBlueprint(root);
  assert.deepEqual(codes(result), ['blueprint_section_missing', 'blueprint_section_empty']);
  assert.match(result.findings[0].message, /Стек/);
  assert.match(result.findings[1].message, /Критерии готовности/);
});

test('section detection handles numbering, setext, English names and ignores code fences', async t => {
  const compiled = await compileBlueprint((await blueprint(t)).root);
  const lint = markdown =>
    codes(lintFactorySpec(compiled.spec, { interfaces: compiled.interfaces, projectMarkdown: markdown }));
  assert.deepEqual(
    lint(
      [
        '1. Цель проекта',
        '===============',
        'Текст.',
        '## 2. **Модули** и интерфейсы:',
        '### storage',
        'API.',
        '## Tech stack ##',
        'Node.js',
        'Критерии готовности',
        '-------------------',
        '- проходят тесты',
      ].join('\n'),
    ),
    [],
  );
  assert.deepEqual(
    lint(
      [
        '## Целевая аудитория',
        'Люди.',
        '```md',
        '## Цель',
        '## Модули',
        '```',
        '## Модули',
        'm',
        '## Стек',
        's',
        '## Критерии готовности',
        'k',
      ].join('\n'),
    ),
    ['blueprint_section_missing'],
  );
});

test('lintFactorySpec is pure and treats omitted PROJECT.md and interfaces as empty', async t => {
  const compiled = await compileBlueprint((await blueprint(t)).root);
  const markdown = await readFile(path.join(fixtures, 'valid', 'PROJECT.md'), 'utf8');
  const full = lintFactorySpec(compiled.spec, { interfaces: compiled.interfaces, projectMarkdown: markdown });
  assert.deepEqual(full, { ok: true, findings: [] });
  const bare = lintFactorySpec(compiled.spec);
  assert.equal(bare.ok, false);
  assert.deepEqual(codes(bare), [
    'blueprint_section_missing',
    'blueprint_section_missing',
    'blueprint_section_missing',
    'blueprint_section_missing',
    'blueprint_interface_missing',
  ]);
  assert.deepEqual(lintFactorySpec(compiled.spec), bare);
});

test('execution defaults to wave/branch and rejects other values', async t => {
  const absent = await blueprint(t, {
    mutate(spec) {
      delete spec.execution;
    },
  });
  const absentResult = await compileBlueprint(absent.root);
  assert.equal(absentResult.ok, true);
  assert.deepEqual(absentResult.spec.execution, { cadence: 'wave', integration: 'branch' });
  for (const execution of [{ cadence: 'continuous' }, { integration: 'main' }, { cadence: 'wave', extra: 1 }, 'wave'])
    assert.deepEqual(
      codes(
        await compileBlueprint(
          (
            await blueprint(t, {
              mutate(spec) {
                spec.execution = execution;
              },
            })
          ).root,
        ),
      ),
      ['blueprint_execution_invalid'],
    );
});

test('execution goes through the strict ProjectSpec parser: watchdog is kept, an invalid one is rejected', async t => {
  const watchdog = { stalledRounds: 2, rejectUnchanged: true };
  const kept = await blueprint(t, {
    mutate(spec) {
      spec.execution = { cadence: 'wave', integration: 'branch', watchdog };
    },
  });
  const result = await compileBlueprint(kept.root);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.spec.execution, { cadence: 'wave', integration: 'branch', watchdog });
  assert.deepEqual(normalizeProjectSpec(result.spec, { knownValues: [] }), result.spec);
  const partial = await blueprint(t, {
    mutate(spec) {
      spec.execution = { cadence: 'wave' };
    },
  });
  assert.deepEqual((await compileBlueprint(partial.root)).spec.execution, DEFAULT_EXECUTION);
  const broken = await blueprint(t, {
    mutate(spec) {
      spec.execution = { cadence: 'wave', integration: 'branch', watchdog: { stalledRounds: 9 } };
    },
  });
  const brokenResult = await compileBlueprint(broken.root);
  assert.deepEqual(codes(brokenResult), ['blueprint_spec_invalid']);
  assert.match(brokenResult.findings[0].message, /project_/);
});

test('compile accepts an explicit spec file next to the blueprint documents', async t => {
  const { root, dir } = await blueprint(t);
  const spec = JSON.parse(await readFile(path.join(dir, 'spec.json'), 'utf8'));
  spec.title = 'Заметки из отдельного файла';
  const other = path.join(await temp(t, 'kodo-spec-file-'), 'notes.json');
  await writeFile(other, JSON.stringify(spec));
  const result = await compileBlueprint(root, { specFile: other });
  assert.deepEqual(result.findings, []);
  assert.equal(result.spec.title, 'Заметки из отдельного файла');
  assert.equal(task(result.spec, 'scaffold').interfaceRefs[0].path, path.join(dir, 'interfaces', 'storage.md'));
  assert.deepEqual(codes(await compileBlueprint(root, { specFile: path.join(dir, 'absent.json') })), [
    'blueprint_missing',
  ]);
});

test('bindInterfaceEvidence turns blueprint interfaces into immutable evidence refs', async t => {
  const { root, dir } = await blueprint(t);
  const compiled = await compileBlueprint(root);
  const stored = [];
  const persist = async value => {
    const text = JSON.stringify(value);
    stored.push(value);
    return {
      path: path.join(root, '..', `interface-${stored.length}.json`),
      sha256: createHash('sha256').update(text).digest('hex'),
    };
  };
  const bound = await bindInterfaceEvidence(compiled, { persist });
  assert.equal(bound.ok, true);
  assert.deepEqual(
    stored.map(value => [value.module, value.source]),
    [
      ['api', 'interfaces/api.md'],
      ['storage', 'interfaces/storage.md'],
      ['web', 'interfaces/web.md'],
    ],
  );
  const storage = stored.find(value => value.module === 'storage');
  assert.equal(storage.text, await readFile(path.join(dir, 'interfaces', 'storage.md'), 'utf8'));
  assert.equal(storage.sha256, compiled.interfaces.find(item => item.module === 'storage').sha256);
  const evidence = bound.interfaces.find(item => item.module === 'storage');
  assert.deepEqual(task(bound.spec, 'storage-module').interfaceRefs, [
    { kind: 'interface', runId: null, headSha: null, path: evidence.path, sha256: evidence.sha256 },
  ]);
  for (const item of bound.spec.tasks)
    for (const ref of item.interfaceRefs) assert.ok(bound.interfaces.some(row => row.sha256 === ref.sha256));
  assert.deepEqual(normalizeProjectSpec(bound.spec, { knownValues: [] }), bound.spec);
  assert.equal(task(compiled.spec, 'storage-module').interfaceRefs[0].path, path.join(dir, 'interfaces', 'storage.md'));

  // The interface changed between compile and binding: nothing is persisted.
  await writeFile(path.join(dir, 'interfaces', 'web.md'), '# Изменённый интерфейс\n');
  stored.length = 0;
  const stale = await bindInterfaceEvidence(compiled, { persist });
  assert.equal(stale.ok, false);
  assert.deepEqual(codes(stale), ['blueprint_interface_stale']);
  assert.deepEqual(stored, []);
  await assert.rejects(bindInterfaceEvidence({ ...compiled, ok: false }, { persist }), {
    code: 'blueprint_not_compiled',
  });
});

test('roles, strict schema and root binding are enforced', async t => {
  const owner = await blueprint(t, {
    mutate(spec) {
      task(spec, 'web-ui-qa').owner = 'tester';
    },
  });
  const ownerResult = await compileBlueprint(owner.root);
  assert.deepEqual(codes(ownerResult), ['blueprint_owner_unknown']);
  assert.deepEqual(ownerResult.findings[0].taskIds, ['web-ui-qa']);

  const schema = await blueprint(t, {
    mutate(spec) {
      task(spec, 'scaffold').extra = true;
    },
  });
  const schemaResult = await compileBlueprint(schema.root);
  assert.deepEqual(codes(schemaResult), ['blueprint_spec_invalid']);
  assert.equal(schemaResult.spec, null);
  assert.match(schemaResult.findings[0].message, /project_schema/);

  const other = await temp(t);
  const mismatch = await blueprint(t, {
    mutate(spec) {
      spec.root = other;
    },
  });
  assert.deepEqual(codes(await compileBlueprint(mismatch.root)), [
    'blueprint_root_mismatch',
    'blueprint_interface_missing',
  ]);
});

test('read errors become findings: missing, encoding, JSON, names and size', async t => {
  const empty = await temp(t);
  assert.deepEqual(codes(await compileBlueprint(empty)), ['blueprint_missing']);
  await assert.rejects(readBlueprint(empty), { code: 'blueprint_missing' });
  await assert.rejects(readBlueprint(path.join(empty, 'absent')), { code: 'blueprint_missing' });

  const encoding = await blueprint(t);
  await writeFile(path.join(encoding.dir, 'PROJECT.md'), Buffer.from([0x23, 0x20, 0xff, 0xfe]));
  assert.deepEqual(codes(await compileBlueprint(encoding.root)), ['blueprint_encoding']);

  const json = await blueprint(t);
  await writeFile(path.join(json.dir, 'spec.json'), '{ "schemaVersion": 1,');
  assert.deepEqual(codes(await compileBlueprint(json.root)), ['blueprint_invalid_json']);

  const name = await blueprint(t);
  await writeFile(path.join(name.dir, 'interfaces', 'Bad Name.md'), '# x');
  assert.deepEqual(codes(await compileBlueprint(name.root)), ['blueprint_interface_name']);

  const large = await blueprint(t);
  await writeFile(path.join(large.dir, 'PROJECT.md'), '#'.repeat(64 * 1024 + 1));
  assert.deepEqual(codes(await compileBlueprint(large.root)), ['blueprint_too_large']);
});

test('links and paths leaving .kodo/blueprint are rejected', async t => {
  const outside = await temp(t, 'kodo-outside-');
  await writeFile(path.join(outside, 'storage.md'), '# Чужой интерфейс\n');

  // Directory junctions work without elevation on Windows; symlinks elsewhere.
  const junction = await blueprint(t);
  await rm(path.join(junction.dir, 'interfaces'), { recursive: true });
  await symlink(outside, path.join(junction.dir, 'interfaces'), 'junction');
  assert.deepEqual(codes(await compileBlueprint(junction.root)), ['blueprint_unsafe_path']);
  await assert.rejects(readBlueprint(junction.root), { code: 'blueprint_unsafe_path' });

  const linkedDir = await temp(t);
  await mkdir(path.join(linkedDir, '.kodo'));
  await symlink(path.join(junction.dir), path.join(linkedDir, '.kodo', 'blueprint'), 'junction');
  await assert.rejects(readBlueprint(linkedDir), { code: 'blueprint_unsafe_path' });

  const hard = await blueprint(t);
  await rm(path.join(hard.dir, 'PROJECT.md'));
  await link(path.join(outside, 'storage.md'), path.join(hard.dir, 'PROJECT.md'));
  assert.deepEqual(codes(await compileBlueprint(hard.root)), ['blueprint_unsafe_path']);
});

test('a file symlink inside the blueprint is rejected', async t => {
  const outside = await temp(t, 'kodo-outside-');
  await writeFile(path.join(outside, 'spec.json'), '{}');
  const file = await blueprint(t);
  await rm(path.join(file.dir, 'spec.json'));
  try {
    await symlink(path.join(outside, 'spec.json'), path.join(file.dir, 'spec.json'), 'file');
  } catch (error) {
    if (error.code === 'EPERM') return t.skip('host does not allow file symlinks');
    throw error;
  }
  assert.deepEqual(codes(await compileBlueprint(file.root)), ['blueprint_unsafe_path']);
});

test('epics whose tasks depend on each other in a cycle are reported before apply-spec', async t => {
  // A1 → B1 → A2 → B2: tasks are acyclic, their epics are not (storage ↔ api).
  const { root } = await blueprint(t, {
    mutate(spec) {
      task(spec, 'api-module').dependsOn = ['storage-module'];
      spec.tasks.push({
        ...task(spec, 'storage-module'),
        id: 'storage-adapter',
        dependsOn: ['api-module'],
        writePaths: ['src/adapter'],
      });
    },
  });
  const result = await compileBlueprint(root);
  assert.deepEqual(codes(result), ['blueprint_epic_cycle']);
  assert.deepEqual(byCode(result, 'blueprint_epic_cycle').taskIds, ['api-module', 'storage-adapter']);
  assert.match(byCode(result, 'blueprint_epic_cycle').message, /api, storage/);
  const markdown = await readFile(path.join(fixtures, 'valid', 'PROJECT.md'), 'utf8');
  const lint = lintFactorySpec(result.spec, { interfaces: result.interfaces, projectMarkdown: markdown });
  assert.deepEqual(codes(lint), ['blueprint_epic_cycle']);
});

test('an empty epic or milestone of the blueprint is reported before apply-spec', async t => {
  // Review finding (major): the Store accepted a wave project with an empty epic that stayed
  // `proposed` forever; it now refuses it (project_container_empty), and lint says so first.
  const { root } = await blueprint(t, {
    mutate(spec) {
      spec.epics.push({ ...spec.epics.at(-1), id: 'idle-epic', title: 'Idle epic' });
      spec.milestones.push({ ...spec.milestones.at(-1), id: 'idle-milestone', title: 'Idle milestone' });
    },
  });
  const result = await compileBlueprint(root);
  assert.deepEqual(codes(result), ['blueprint_container_empty']);
  assert.equal(byCode(result, 'blueprint_container_empty').taskIds, undefined);
  assert.match(byCode(result, 'blueprint_container_empty').message, /майлстоун idle-milestone, эпик idle-epic/);
  const markdown = await readFile(path.join(fixtures, 'valid', 'PROJECT.md'), 'utf8');
  const lint = lintFactorySpec(result.spec, { interfaces: result.interfaces, projectMarkdown: markdown });
  assert.deepEqual(codes(lint), ['blueprint_container_empty']);
});
