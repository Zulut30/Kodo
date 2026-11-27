import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { ownsPath, scopesOverlap } from '../runtime/contracts.mjs';
import { parallelOverlaps } from '../runtime/project-blueprint.mjs';
import { scopeIndexPrefix, scopeOwnership } from '../runtime/project-blueprint-scope-index.mjs';

const task = (id, scope) => ({ id, writePaths: [scope] });
const parentBranches = [
  '{v[1,..,2],cache}',
  '{v!(1,..,2),cache}',
  '{v[1,.,2],cache}{v[1,.,2],cache}',
  '{{dev,ci},}.{,bak}.',
  '.{dir/x,}.',
  '.{Z..a}.',
];

test('brace expansion can expose a parent before character classes or extglobs are parsed', () => {
  const file = task('file', 'shared.txt');
  for (const component of parentBranches) {
    const scope = `stage/${component}/shared.txt`;
    const glob = task('glob', scope);
    assert.ok(path.posix.matchesGlob('shared.txt', scope), scope);
    assert.ok(scopesOverlap(file.writePaths, glob.writePaths), scope);
    for (const [a, b] of [
      [file, glob],
      [glob, file],
    ]) {
      assert.deepEqual(parallelOverlaps([a, b]), [[a.id, b.id]], scope);
      assert.deepEqual(parallelOverlaps([a], { others: [b] }), [[a.id, b.id]], scope);
    }
    assert.equal(scopeOwnership([scope])('shared.txt'), true, scope);
  }
});

test('indexed pairs include canonical literal-prefix comparisons between disjoint glob branches', () => {
  const scopes = [
    'stage/pre{a,b}/only.js',
    'stage/pre{c,d}/other.rs',
    'stage/pre/output.rs',
    'stage/prefix/file.rs',
    ...[...parentBranches, '.{,tmp}', '@(..|tmp)', '[.]', '{1..3}', '!(legacy.js|disabled.js)'].flatMap(part =>
      ['stage', 'src/stage'].map(dir => `${dir}/${part}/shared.txt`),
    ),
    'shared.txt',
    'stage/shared.txt',
    'src/shared.txt',
    'stage/tmp/shared.txt',
    'stage/2/shared.txt',
    'src/stage/compile/shared.txt',
    'stage/..*.txt',
    './stage//src/../shared.txt',
  ];
  const tasks = scopes.map((scope, i) => task(String(i), scope));
  const expected = [];
  for (const [i, left] of tasks.entries()) {
    for (const right of tasks.slice(i + 1)) {
      if (scopesOverlap(left.writePaths, right.writePaths)) expected.push([left.id, right.id]);
    }
  }
  assert.ok(scopesOverlap([scopes[0]], [scopes[1]]));
  assert.ok(scopesOverlap([scopes[0]], [scopes[2]]));
  assert.deepEqual(parallelOverlaps(tasks), expected);
});

test('ownership lookup agrees with ownsPath for glob matches, literal spellings and descendants', () => {
  const scopes = [
    ...parentBranches.map(part => `stage/${part}/shared.txt`),
    './src/shared',
    '././src/shared/read.rs',
    'src/shared/view-*.js',
    'src/shared/!(legacy.mjs|disabled.mjs)',
    'src/shared/s[[:alpha:]].rs',
    'src/{client/read,server/write}.test.js',
    './src/{client,client/}/@(web{,-ui}|tool{,-cli})/read.rs',
    'src/shared/**',
    'src/.*/*.rs',
    'src/a{,b}/../shared',
    'src/other//file.rs',
  ];
  const files = [
    'shared.txt',
    'src/client/read.test.js',
    'src/client/WEB-UI/read.rs',
    'src/client/web-cli/read.rs',
    'src/{client,client/}/@(web|web-ui|tool|tool-cli)/read.rs/child',
    'src/server/write.test.js',
    'src/shared/view-lib.js',
    'src/shared/legacy.mjs',
    'src/shared/read.rs',
    'src/shared/\u017fx.rs',
    'src/shared/View-LIB.js',
    'src/.hidden/lib.rs',
    'src/other/../shared/read.rs',
    'src//shared',
    './src/shared/read.rs',
    'other/file.rs',
  ];
  for (const scope of scopes) {
    const owns = scopeOwnership(new Set([scope]));
    const spelling = scope.replace(/^\.\//, '');
    for (const file of [...files, spelling, spelling + '/child']) {
      assert.equal(owns(file), ownsPath([scope], file), `${scope} vs ${file}`);
    }
  }
});

test('ordinary braces and extglobs keep their raw directory and filename lead', () => {
  for (const [pattern, lead] of [
    ['{read,write}.js', ''],
    ['task42-handler{,-test}.js', 'task42-handler'],
    ['{client/read,server/write}.test.js', ''],
    ['!(legacy.mjs|disabled.mjs)', ''],
  ]) {
    assert.deepEqual(scopeIndexPrefix('src/shared/task42/' + pattern), {
      segments: ['src', 'shared', 'task42'],
      prefix: lead,
    });
  }
});

test('disjoint task directories bound negative extglob comparisons and retain a real conflict', t => {
  const tasks = Array.from({ length: 400 }, (_, i) => task('t' + i, `src/shared/task${i}/!(legacy.mjs|disabled.mjs)`));
  const match = path.posix.matchesGlob;
  let calls = 0;
  t.mock.method(path.posix, 'matchesGlob', (name, pattern) => {
    assert.ok(++calls <= tasks.length, 'disjoint directories triggered pairwise matching');
    return match(name, pattern);
  });
  assert.deepEqual(parallelOverlaps(tasks), []);
  tasks[399] = task('t399', 'src/shared/task17/edited.mjs');
  assert.deepEqual(parallelOverlaps(tasks), [['t17', 't399']]);
  tasks[399] = task('t399', 'src/shared/task17/legacy.mjs');
  assert.deepEqual(parallelOverlaps(tasks), []);
});

test('ownership prunes unrelated filename leads under a shared directory', t => {
  const owns = scopeOwnership(Array.from({ length: 64 }, (_, i) => `src/shared/view${i}-*.js`));
  const match = path.posix.matchesGlob;
  let calls = 0;
  t.mock.method(path.posix, 'matchesGlob', (name, pattern) => {
    calls++;
    return match(name, pattern);
  });
  for (let i = 0; i < 32; i++) assert.equal(owns(`src/shared/view${i}-changes.rs`), false);
  assert.equal(owns('src/shared/view17-editor.js'), true);
  assert.ok(calls <= 33, `expected at most one candidate per file, matched ${calls} patterns`);
});
