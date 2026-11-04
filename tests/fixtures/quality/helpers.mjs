import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { execute } from '../../../runtime/delivery.mjs';
import { execute as command } from '../../../runtime/command.mjs';
import { workerEnvironment } from '../../../runtime/security.mjs';

export async function windowsShortPath(project) {
  const script = "$ErrorActionPreference='Stop'; $p=[Console]::In.ReadToEnd(); $f=New-Object -ComObject Scripting.FileSystemObject; [Console]::Out.Write($f.GetFolder($p).ShortPath)";
  const result = await command(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { input: project, env: workerEnvironment(), timeoutMs: 10000 });
  const short = result.stdout.trim();
  assert.equal(await realpath(short), await realpath(project));
  return short;
}

export async function put(root, name, value) {
  const filename = path.join(root, name);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, typeof value === 'string' ? value : JSON.stringify(value));
}
export async function fixture(t, files = {}, quality = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'kodo-quality-test-'));
  const project = path.join(base, 'project'), evidenceDir = path.join(base, 'evidence');
  await mkdir(project); await mkdir(evidenceDir);
  t.after(async () => {
    assert.equal(path.dirname(base), path.resolve(os.tmpdir()));
    assert.match(path.basename(base), /^kodo-quality-test-/);
    await rm(base, { recursive: true, force: true });
  });
  for (const [name, value] of Object.entries(files)) await put(project, name, value);
  await put(project, 'kodo.config.json', { schemaVersion: 1, quality });
  await execute('git', ['init', '-q', '--initial-branch=fixture'], { cwd: project });
  await execute('git', ['add', '.'], { cwd: project });
  await execute('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'fixture'], { cwd: project });
  return { project, evidenceDir, base, nativeResolve: async id => ({ command: id, args: [], env: {} }) };
}
export const projects = {
  csharp: { 'global.json': { sdk: { version: '9.0.100' } }, 'App.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net9.0</TargetFramework><Nullable>enable</Nullable></PropertyGroup></Project>', 'Program.cs': 'class Program { static void Main() {} }' },
  rust: { 'Cargo.toml': '[package]\nname="fixture"\nversion="0.1.0"\nedition="2021"', 'rust-toolchain.toml': '[toolchain]\nchannel="1.85.0"', 'Cargo.lock': 'version = 4\n', 'src/lib.rs': 'pub fn value() -> i32 { 42 }' },
  go: { 'go.mod': 'module example.test/fixture\n\ngo 1.24.0\n', 'main.go': 'package main\nfunc main() {}\n' },
  typescript: { 'package.json': { devDependencies: { typescript: '7.0.2' } }, 'tsconfig.json': { compilerOptions: { strict: true } }, 'src/main.ts': 'export const value: number = 42;' },
  javascript: { 'package.json': { type: 'module' }, 'src/main.js': 'export const value = 42;' },
  css: { '.stylelintrc.json': { rules: { 'color-no-invalid-hex': true } }, 'src/main.css': 'a { color: red; }' },
  html: { '.htmlvalidate.json': { extends: ['html-validate:recommended'] }, 'index.html': '<!doctype html><html lang="en"><title>Fixture</title><body></body></html>' },
  php: { 'composer.json': { require: { php: '8.4.1' } }, 'index.php': '<?php echo "hello";' },
  sql: { 'schema.sql': 'SELECT 1;\n' }
};
export const pins = { rustfmt: { version: '1.8.0' }, cargo: { version: '1.85.0' }, clippy: { version: '0.1.85' }, php: { version: '8.4.1' } };
// Prepared vendor layout, without a proxy, installer or external module cache.
export const vendoredGo = {
  'go.mod': 'module example.test/fixture\n\ngo 1.24.0\n\nrequire example.test/dependency v1.0.0\n',
  'main.go': 'package main\nimport "example.test/dependency"\nvar value int = dependency.Value\nfunc main() {}\n',
  'vendor/modules.txt': '# example.test/dependency v1.0.0\n## explicit; go 1.24.0\nexample.test/dependency\n',
  'vendor/example.test/dependency/value.go': 'package dependency\nconst Value = 42\n'
};
export function fakeTools(overrides = {}) {
  return async id => ({ id, version: ({ oxlint: '1.91.0', oxfmt: '0.76.0', typescript: '7.0.2', stylelint: '18.0.0', 'html-validate': '11.18.0', sqlfluff: '4.5.0' })[id], ready: true, status: 'ready', command: id, args: [], env: {}, ...overrides });
}
export function toolRunner(handlers = {}) {
  const calls = [];
  const runner = async (command, args, options) => {
    if (command === 'git') return execute(command, args, options);
    const id = path.basename(command).replace(/\.exe$/, ''); calls.push({ command, args, options, id });
    if (handlers[id]) return handlers[id]({ args, options });
    if (id === 'rustc') return { code: 0, stdout: 'rustc 1.85.0 (abc 2025-01-01)', stderr: '' };
    if (id === 'cargo' && args[0] === 'clippy' && args[1] === '--version') return { code: 0, stdout: 'clippy 0.1.85 (abc 2025-01-01)', stderr: '' };
    const version = { oxlint: '1.91.0', oxfmt: '0.76.0', typescript: 'Version 7.0.2', stylelint: '18.0.0', 'html-validate': '11.18.0', sqlfluff: 'sqlfluff, version 4.5.0', dotnet: '9.0.100', rustfmt: 'rustfmt 1.8.0-stable (abc 2025-01-01)', cargo: 'cargo 1.85.0 (abc 2025-01-01)', go: 'go version go1.24.0 windows/amd64', php: 'PHP 8.4.1 (cli) (built: Jan 1 2025) (NTS)\nCopyright (c) The PHP Group' }[id];
    if (id === 'go' && args[0] === 'version' && args.length > 1) return { code: 0, stdout: `${args[1]}: go1.24.0`, stderr: '' };
    if (args.includes('--version') || args[0] === 'version') return { code: 0, stdout: version ?? '', stderr: '' };
    const result = { oxlint: '{"diagnostics":[],"number_of_files":1}', oxfmt: 'Checking formatting...\n\nAll matched files use the correct format.\nFinished in 1ms on 1 files using 1 threads.\n', typescript: '', stylelint: '[{"source":"src/main.css","warnings":[],"deprecations":[],"invalidOptionWarnings":[],"parseErrors":[],"errored":false}]', 'html-validate': '[]', sqlfluff: '[{"filepath":"schema.sql","violations":[]}]', dotnet: args[0] === 'build' ? 'Build succeeded.\n    0 Warning(s)\n    0 Error(s)' : '', rustfmt: '', cargo: '{"reason":"build-finished","success":true}\n', go: args[0] === 'test' ? 'ok\texample.test/fixture\t0.001s\n' : '', gofmt: '', php: `No syntax errors detected in ${args.at(-1)}` }[id];
    return { code: 0, stdout: result ?? '', stderr: '' };
  };
  return { runner, calls };
}
