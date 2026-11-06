#!/usr/bin/env node
// Type-check ratchet: `tsc --checkJs` over first-party code against a recorded
// baseline. A new diagnostic fails; a fixed one fails until the baseline is
// tightened with `--update`, so the debt can only shrink. Line numbers are not
// part of the key, which keeps the baseline stable across unrelated edits.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselineFile = path.join(root, 'scripts', 'typecheck-baseline.json');
const update = process.argv.includes('--update');
const tsc = path.join(path.dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin', 'tsc');

const result = spawnSync(process.execPath, [tsc, '-p', path.join(root, 'tsconfig.json'), '--pretty', 'false'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
if (result.error) throw result.error;

// tsc quotes absolute module paths in some messages; keep the baseline portable
// across checkouts (local worktrees, CI runners) by masking the checkout root.
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const rootPattern = new RegExp(
  [root, root.replaceAll('\\', '/')].map(escape).join('|'),
  process.platform === 'win32' ? 'gi' : 'g',
);
const portable = text => text.replace(rootPattern, '<root>');

const diagnostics = [];
for (const raw of `${result.stdout}${result.stderr}`.split(/\r?\n/)) {
  const line = portable(raw);
  const match = /^(.+?)\((\d+,\d+)\): error (TS\d+): (.*)$/.exec(line);
  if (match) {
    const file = match[1].replaceAll('\\', '/');
    diagnostics.push({ file, at: `${file}(${match[2]})`, code: match[3], message: match[4] });
  } else if (/^\s+\S/.test(line) && diagnostics.length) diagnostics.at(-1).message += `\n${line.trim()}`;
  else if (line.trim() && !/^Found \d+ errors?/.test(line))
    diagnostics.push({ file: '<tsc>', code: 'output', message: line });
}
if (result.status !== 0 && !diagnostics.length) {
  process.stderr.write(`tsc exited with ${result.status} without diagnostics\n`);
  process.exit(1);
}

const key = d => `${d.file}\n${d.code}\n${d.message}`;
const count = rows =>
  rows.reduce((map, row) => map.set(key(row), (map.get(key(row)) ?? 0) + (row.count ?? 1)), new Map());
const current = count(diagnostics);

if (update) {
  const rows = [...current]
    .map(([id, total]) => {
      const [file, code, ...message] = id.split('\n');
      return { file, code, message: message.join('\n'), count: total };
    })
    .sort((a, b) => key(a).localeCompare(key(b)));
  writeFileSync(baselineFile, `${JSON.stringify(rows, null, 2)}\n`);
  process.stdout.write(`typecheck baseline: ${diagnostics.length} known diagnostics in ${rows.length} groups\n`);
  process.exit(0);
}

const baseline = count(JSON.parse(readFileSync(baselineFile, 'utf8')));
const added = [],
  fixed = [];
for (const [id, total] of current)
  if (total > (baseline.get(id) ?? 0)) added.push([id, total - (baseline.get(id) ?? 0)]);
for (const [id, total] of baseline)
  if (total > (current.get(id) ?? 0)) fixed.push([id, total - (current.get(id) ?? 0)]);
const show = ([id, n]) => `  ${id.split('\n').join(' | ')}${n > 1 ? ` (x${n})` : ''}`;

if (added.length) {
  process.stderr.write(`typecheck: ${added.length} new diagnostic group(s) not in the baseline:\n`);
  process.stderr.write(`${added.map(show).join('\n')}\n`);
  const ids = new Set(added.map(([id]) => id));
  for (const d of diagnostics) if (ids.has(key(d)) && d.at) process.stderr.write(`  at ${d.at}\n`);
}
if (fixed.length) {
  process.stderr.write(
    `typecheck: ${fixed.length} baseline group(s) are fixed; run \`npm run typecheck -- --update\`:\n`,
  );
  process.stderr.write(`${fixed.map(show).join('\n')}\n`);
}
if (added.length || fixed.length) process.exit(1);
process.stdout.write(`typecheck: no new diagnostics (${diagnostics.length} known in baseline)\n`);
