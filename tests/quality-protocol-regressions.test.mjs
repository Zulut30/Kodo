import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseQualityOutput } from '../runtime/quality-runner.mjs';

test('Quality HTML paths come from filePath while raw source remains data', () => {
  const project = path.resolve('quality-protocol-fixture');
  const check = { tool: 'html-validate', root: '', files: ['index.html'], capability: 'lint' };
  const record = {
    filePath: path.join(project, 'index.html'),
    source: '<html><body><img src="SOURCE_MARKER"></body></html>',
    errorCount: 1,
    warningCount: 0,
    messages: [{ ruleId: 'wcag/h37', line: 1, severity: 2, message: 'Image requires alt' }],
  };
  const result = () => ({ code: 1, stdout: JSON.stringify([record]), stderr: '' });
  const parsed = parseQualityOutput(check, result(), project);
  assert.equal(parsed.clean, false);
  assert.equal(parsed.findings[0].file, 'index.html');
  assert.equal(parsed.findings[0].ruleId, 'wcag/h37');
  assert.ok(!JSON.stringify(parsed).includes('SOURCE_MARKER'));
  record.filePath = path.join(project, '../outside.html');
  assert.throws(() => parseQualityOutput(check, result(), project));
});

test('Quality dotnet clean build requires one complete zero warning and error summary', () => {
  const check = { tool: 'dotnet', root: '', files: ['Program.cs'], capability: 'typecheck' };
  const clean = 'Build succeeded.\r\n    0 Warning(s)\r\n    0 Error(s)\r\n';
  const parse = (stdout, stderr = '') =>
    parseQualityOutput(check, { code: 0, stdout, stderr }, path.resolve('quality-protocol-fixture'));
  assert.equal(parse(clean).clean, true);
  for (const text of [
    'Build succeeded.\n    1 Warning(s)\n    0 Error(s)\n',
    'Build succeeded.\n    0 Error(s)\n',
    clean + '    1 Warning(s)\n',
    clean + 'Program.cs(1,1): warning CS0001: warning\n',
    clean + 'Build FAILED.\n',
  ])
    assert.throws(() => parse(text));
  assert.throws(() => parse(clean, 'unexpected diagnostic'));
});
