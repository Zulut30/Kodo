import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseQualityOutput } from '../runtime/quality-runner.mjs';

// Characterization of every tool branch of parseQualityOutput: findings, clean
// and malformed output. The golden file pins the exact verdicts, findings and
// fingerprints, so a refactor of the parsers cannot change observable results.
// Regenerate only for an intended protocol change: KODO_UPDATE_GOLDEN=1.
const project = path.resolve('quality-parsers-fixture');
const golden = new URL('./fixtures/quality-parsers-golden.json', import.meta.url);
const check = (tool, files, extra = {}) => ({ tool, root: '', files, capability: 'lint', ...extra });
const run = (stdout, { code = 0, stderr = '' } = {}) => ({ code, stdout, stderr });
const json = value => JSON.stringify(value);
const lines = rows => rows.map(row => json(row)).join('\n');

const configured = (status, findings) =>
  json({ schemaVersion: 1, complete: true, status, findings, scannedFiles: ['a.js'] });
const oxlint = diagnostics => json({ diagnostics, number_of_files: 1 });
const stylelint = warnings =>
  json([{ source: 'a.css', warnings, parseErrors: [], invalidOptionWarnings: [], errored: warnings.length > 0 }]);
const htmlValidate = messages =>
  json([{ filePath: 'index.html', errorCount: messages.length, warningCount: 0, messages }]);
const cargo = (messages, success) =>
  lines([...messages.map(message => ({ reason: 'compiler-message', message })), { reason: 'build-finished', success }]);
const rustMessage = {
  level: 'error',
  code: { code: 'E0425' },
  message: 'cannot find value',
  spans: [{ is_primary: true, file_name: 'src/main.rs', line_start: 3 }],
};
const oxfmtClean =
  'Checking formatting...\nAll matched files use the correct format.\nFinished in 12ms on 1 files using 4 threads.';
const dotnetClean = 'Build succeeded.\n    0 Warning(s)\n    0 Error(s)\n';

const cases = [
  [
    'configured failed',
    check('custom', ['a.js'], { configured: true }),
    run(configured('failed', [{ file: 'a.js', ruleId: 'r1', line: 2, severity: 'error', message: 'm' }]), { code: 1 }),
  ],
  ['configured passed', check('custom', ['a.js'], { configured: true }), run(configured('passed', []))],
  [
    'configured status contradicts findings',
    check('custom', ['a.js'], { configured: true }),
    run(configured('passed', [{ file: 'a.js', ruleId: 'r1', line: 2, severity: 'error' }])),
  ],
  [
    'configured scanned set differs',
    check('custom', ['a.js', 'b.js'], { configured: true }),
    run(configured('passed', [])),
  ],
  [
    'oxlint finding',
    check('oxlint', ['a.js']),
    run(
      oxlint([
        {
          filename: 'a.js',
          code: 'eslint(no-undef)',
          severity: 'error',
          message: 'x is not defined',
          labels: [{ span: { line: 3 } }],
        },
      ]),
      { code: 1 },
    ),
  ],
  ['oxlint clean', check('oxlint', ['a.js']), run(oxlint([]))],
  ['oxlint stderr', check('oxlint', ['a.js']), run(oxlint([]), { stderr: 'boom' })],
  ['oxlint file count', check('oxlint', ['a.js', 'b.js']), run(oxlint([]))],
  [
    'stylelint finding',
    check('stylelint', ['a.css']),
    run(stylelint([{ rule: 'color-no-invalid-hex', line: 1, severity: 'error', text: 'bad hex' }]), { code: 2 }),
  ],
  ['stylelint clean', check('stylelint', ['a.css']), run(stylelint([]))],
  ['stylelint report on stderr', check('stylelint', ['a.css']), run('', { stderr: stylelint([]) })],
  [
    'stylelint parse error',
    check('stylelint', ['a.css']),
    run(json([{ source: 'a.css', warnings: [], parseErrors: [{}], invalidOptionWarnings: [] }])),
  ],
  [
    'html-validate finding',
    check('html-validate', ['index.html']),
    run(htmlValidate([{ ruleId: 'wcag/h37', line: 1, severity: 2, message: 'alt' }]), { code: 1 }),
  ],
  [
    'html-validate counts mismatch',
    check('html-validate', ['index.html']),
    run(json([{ filePath: 'index.html', errorCount: 2, warningCount: 0, messages: [] }])),
  ],
  [
    'sqlfluff finding',
    check('sqlfluff', ['q.sql']),
    run(json([{ filepath: 'q.sql', violations: [{ code: 'LT01', start_line_no: 2, description: 'spacing' }] }]), {
      code: 1,
    }),
  ],
  [
    'sqlfluff duplicate file',
    check('sqlfluff', ['q.sql']),
    run(
      json([
        { filepath: 'q.sql', violations: [] },
        { filepath: 'q.sql', violations: [] },
      ]),
    ),
  ],
  ['gofmt unformatted', check('gofmt', ['main.go']), run('main.go\n')],
  ['gofmt clean', check('gofmt', ['main.go']), run('')],
  ['gofmt stderr', check('gofmt', ['main.go']), run('', { stderr: 'boom' })],
  ['oxfmt clean', check('oxfmt', ['a.js']), run(oxfmtClean)],
  ['oxfmt dirty', check('oxfmt', ['a.js']), run('a.js (12ms)', { code: 1 })],
  ['oxfmt wrong count', check('oxfmt', ['a.js', 'b.js']), run(oxfmtClean)],
  ['typescript clean', check('typescript', ['a.ts']), run('')],
  [
    'typescript errors',
    check('typescript', ['a.ts']),
    run("a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.", { code: 2 }),
  ],
  ['typescript unexplained failure', check('typescript', ['a.ts']), run('', { code: 1 })],
  ['rustfmt clean', check('rustfmt', ['src/main.rs']), run('')],
  ['rustfmt diff', check('rustfmt', ['src/main.rs']), run('Diff in src/main.rs at line 1:', { code: 1 })],
  ['rustfmt noise', check('rustfmt', ['src/main.rs']), run('done')],
  ['cargo finding', check('cargo', ['src/main.rs']), run(cargo([rustMessage], false), { code: 101 })],
  ['cargo clean', check('cargo', ['src/main.rs']), run(cargo([], true), { stderr: '    Finished dev profile' })],
  ['cargo unknown stderr', check('cargo', ['src/main.rs']), run(cargo([], true), { stderr: 'surprise' })],
  ['cargo exit zero without success', check('cargo', ['src/main.rs']), run(cargo([], false))],
  ['go clean', check('go', ['main.go']), run('')],
  ['go failure', check('go', ['main.go']), run('', { code: 1, stderr: 'main.go:3:2: undefined: x' })],
  ['dotnet typecheck clean', check('dotnet', ['Program.cs'], { capability: 'typecheck' }), run(dotnetClean)],
  [
    'dotnet typecheck failed',
    check('dotnet', ['Program.cs'], { capability: 'typecheck' }),
    run('Build FAILED.', { code: 1 }),
  ],
  ['dotnet format clean', check('dotnet', ['Program.cs'], { capability: 'format' }), run('')],
  ['dotnet format dirty', check('dotnet', ['Program.cs'], { capability: 'format' }), run('', { code: 2 })],
  ['php clean', check('php', ['main.php']), run('No syntax errors detected in main.php')],
  ['php parse error', check('php', ['main.php']), run('PHP Parse error: syntax error', { code: 255 })],
  [
    'phpcs finding',
    check('phpcs', ['main.php']),
    run(
      json({
        totals: { errors: 1, warnings: 0 },
        files: {
          'main.php': {
            messages: [{ source: 'PSR12.Files.EndFileNewline', line: 1, type: 'ERROR', message: 'newline' }],
          },
        },
      }),
      { code: 2 },
    ),
  ],
  [
    'phpcs clean',
    check('phpcs', ['main.php']),
    run(json({ totals: { errors: 0, warnings: 0 }, files: { 'main.php': { messages: [] } } })),
  ],
  [
    'phpcs totals mismatch',
    check('phpcs', ['main.php']),
    run(json({ totals: { errors: 2, warnings: 0 }, files: { 'main.php': { messages: [] } } })),
  ],
  [
    'phpstan finding',
    check('phpstan', ['main.php']),
    run(
      json({
        totals: { errors: 0, file_errors: 1 },
        files: { 'main.php': { messages: [{ identifier: 'variable.undefined', line: 4, message: 'undefined' }] } },
        errors: [],
      }),
      { code: 1 },
    ),
  ],
  [
    'phpstan clean',
    check('phpstan', ['main.php']),
    run(json({ totals: { errors: 0, file_errors: 0 }, files: {}, errors: [] })),
  ],
  [
    'phpstan general error',
    check('phpstan', ['main.php']),
    run(json({ totals: { errors: 1, file_errors: 0 }, files: {}, errors: ['boom'] })),
  ],
  ['go unexplained output', check('go', ['main.go']), run('ok')],
  ['dotnet typecheck noise', check('dotnet', ['Program.cs'], { capability: 'typecheck' }), run('hello')],
  ['dotnet format noise', check('dotnet', ['Program.cs'], { capability: 'format' }), run('changed')],
  ['php unexplained output', check('php', ['main.php']), run('maybe')],
  ['unknown tool', check('mystery', ['a.js']), run('')],
  ['truncated output', check('oxlint', ['a.js']), { ...run(oxlint([])), outputTruncated: true }],
  ['finding outside the check', check('gofmt', ['main.go']), run('other.go\n')],
];

function observe([, input, result]) {
  try {
    return { verdict: parseQualityOutput(input, result, project) };
  } catch (error) {
    return { error: { code: error.code, message: error.message } };
  }
}

test('Quality parsers keep the recorded verdict for every tool branch', () => {
  const observed = Object.fromEntries(cases.map(entry => [entry[0], observe(entry)]));
  if (process.env.KODO_UPDATE_GOLDEN === '1') writeFileSync(golden, `${JSON.stringify(observed, null, 2)}\n`);
  assert.deepEqual(observed, JSON.parse(readFileSync(golden, 'utf8')));
});

test('Quality parser characterization covers findings, clean and malformed output', () => {
  const recorded = JSON.parse(readFileSync(golden, 'utf8'));
  const outcomes = Object.values(recorded);
  assert.ok(outcomes.some(o => o.verdict?.findings.length));
  assert.ok(outcomes.some(o => o.verdict?.clean === true));
  assert.ok(outcomes.some(o => o.error?.code === 'invalid_output'));
  for (const tool of ['oxlint', 'stylelint', 'html-validate', 'sqlfluff', 'gofmt', 'cargo', 'phpcs', 'phpstan']) {
    const names = cases.filter(([, input]) => input.tool === tool).map(([name]) => name);
    assert.ok(
      names.some(name => recorded[name].verdict?.findings.length),
      `${tool} needs a findings case`,
    );
  }
});
