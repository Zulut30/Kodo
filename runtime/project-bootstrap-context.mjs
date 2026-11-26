import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as projectContracts from './project-contracts.mjs';
import { projectKnowledge } from './knowledge-context.mjs';
import { redact } from './security.mjs';
import { inside } from './toolchains.mjs';
import { readBoundedFile } from './project-blueprint.mjs';

const MAX_PROMPT = 64 * 1024;
export const MAX_MILESTONE_FILE = 1024 * 1024;
export const LISTED_FILES = 400;
const SCAN_LIMIT = 20000;
const SCAN_DEPTH = 8;
export const CLOSED = ['accepted', 'released'];
const REDACTED = '[REDACTED]';
// A whole PEM private key block; an unterminated header redacts to the end.
const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/gi;
// Agent client folders: installed skills, roles and settings, not project source. The file
// map skips them; a native session that changes them is still out of scope (generateBlueprint).
export const AGENT_DIRS = ['.agents', '.claude', '.codex', '.opencode'];
const SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  '.kodo',
  ...AGENT_DIRS,
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.gradle',
  '.venv',
  'venv',
  '__pycache__',
  'obj',
]);
/** @type {Array<[RegExp, string]>} */
const MARKERS = [
  [/^package\.json$/, 'Node.js / npm'],
  [/^tsconfig(?:\..+)?\.json$/, 'TypeScript'],
  [/^deno\.jsonc?$/, 'Deno'],
  [/^bun\.lockb?$/, 'Bun'],
  [/^pnpm-(?:lock|workspace)\.yaml$/, 'pnpm'],
  [/^yarn\.lock$/, 'Yarn'],
  [/^Cargo\.toml$/, 'Rust (Cargo)'],
  [/^go\.mod$/, 'Go'],
  [/^(?:pyproject\.toml|requirements[^/]*\.txt|setup\.py|Pipfile)$/, 'Python'],
  [/^(?:pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?)$/, 'JVM (Maven/Gradle)'],
  [/\.(?:csproj|fsproj|slnx?)$/, '.NET'],
  [/^composer\.json$/, 'PHP (Composer)'],
  [/^Gemfile$/, 'Ruby'],
  [/^CMakeLists\.txt$/, 'C/C++ (CMake)'],
  [/^(?:Dockerfile|compose\.ya?ml|docker-compose\.ya?ml)$/, 'Docker'],
  [/^pubspec\.yaml$/, 'Dart / Flutter'],
  [/^Package\.swift$/, 'Swift'],
  [/^kodo\.config\.json$/, 'Kodo config'],
];
// Stack manifests for commands.test of the kodo.config.json template (configTemplate); `test: null`
// is a stack Kodo knows no test command for.
/** @type {Array<{ stack: string, pattern: RegExp, test: { command: string, args: string[] } | null }>} */
const STACK_MANIFESTS = [
  { stack: 'deno', pattern: /^deno\.jsonc?$/, test: { command: 'deno', args: ['test'] } },
  { stack: 'node', pattern: /^package\.json$/, test: { command: 'npm', args: ['test'] } },
  {
    stack: 'python',
    pattern: /^(?:pyproject\.toml|requirements[^/]*\.txt|setup\.py|Pipfile)$/,
    test: { command: 'python', args: ['-m', 'pytest'] },
  },
  { stack: 'rust', pattern: /^Cargo\.toml$/, test: { command: 'cargo', args: ['test'] } },
  { stack: 'go', pattern: /^go\.mod$/, test: { command: 'go', args: ['test', './...'] } },
  { stack: 'dotnet', pattern: /\.(?:csproj|fsproj|slnx?)$/, test: { command: 'dotnet', args: ['test'] } },
  { stack: 'maven', pattern: /^pom\.xml$/, test: { command: 'mvn', args: ['test'] } },
  { stack: 'gradle', pattern: /^(?:build|settings)\.gradle(?:\.kts)?$/, test: { command: 'gradle', args: ['test'] } },
  { stack: 'php', pattern: /^composer\.json$/, test: null },
  { stack: 'ruby', pattern: /^Gemfile$/, test: null },
  { stack: 'cmake', pattern: /^CMakeLists\.txt$/, test: null },
  { stack: 'dart', pattern: /^pubspec\.yaml$/, test: null },
  { stack: 'swift', pattern: /^Package\.swift$/, test: null },
];
export const CONFIG_TEMPLATE = 'templates/kodo.config.json';
const FRAMEWORKS = [
  'react',
  'next',
  'vue',
  'nuxt',
  'svelte',
  '@sveltejs/kit',
  '@angular/core',
  'express',
  'fastify',
  'koa',
  '@nestjs/core',
  'electron',
  'vite',
  'webpack',
  'typescript',
  'tailwindcss',
  'prisma',
  'drizzle-orm',
  'jest',
  'vitest',
  'mocha',
  '@playwright/test',
];
export const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
export const isPlain = value =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
export const has = (value, keys) =>
  isPlain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

// ---- Inputs, scanning and bundle writing ----------------------------------------

export function checkPrompt(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim() || !prompt.isWellFormed() || Buffer.byteLength(prompt) > MAX_PROMPT)
    throw failure('bootstrap_prompt_invalid', `Идея проекта — непустой текст до ${MAX_PROMPT} байт`);
  return prompt;
}

export async function existingRoot(root) {
  if (typeof root !== 'string' || !root) throw failure('bootstrap_root_missing', 'Не указан каталог проекта');
  try {
    const real = await realpath(path.resolve(root));
    if ((await stat(real)).isDirectory()) return real;
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
  }
  throw failure('bootstrap_root_missing', 'Каталог проекта должен существовать');
}

export const isoTime = now => new Date(typeof now === 'function' ? now() : (now ?? Date.now())).toISOString();

/** Bounded, link-free walk without content reads; skips VCS, dependency and
 * build directories, Kodo state (.kodo) and agent client folders unless named in
 * `watch`. Files are in byte-sorted DFS order. */
export async function scanProject(root, { watch = [] } = {}) {
  const files = [],
    state = { links: 0, skippedDirs: 0, complete: true };
  async function visit(directory, prefix, depth) {
    let entries;
    try {
      entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => compare(a.name, b.name));
    } catch (error) {
      if (!prefix || !['EACCES', 'EPERM'].includes(error.code)) throw error;
      state.skippedDirs++;
      state.complete = false;
      return;
    }
    for (const entry of entries) {
      if (files.length >= SCAN_LIMIT) {
        state.complete = false;
        return;
      }
      const relative = prefix + entry.name;
      if (entry.isSymbolicLink()) state.links++;
      else if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) && !watch.includes(entry.name)) state.skippedDirs++;
        else if (depth >= SCAN_DEPTH) {
          state.skippedDirs++;
          state.complete = false;
        } else await visit(path.join(directory, entry.name), `${relative}/`, depth + 1);
      } else if (entry.isFile()) {
        const info = await lstat(path.join(directory, entry.name));
        files.push({ path: relative, bytes: info.size, mtimeMs: info.mtimeMs });
      }
    }
  }
  await visit(root, '', 0);
  return { files, ...state };
}

export async function detectStack(root, files) {
  const found = new Map();
  for (const file of files) {
    const parts = file.path.split('/');
    if (parts.length > 3) continue;
    for (const [pattern, label] of MARKERS)
      if (pattern.test(parts.at(-1))) found.set(label, [...(found.get(label) ?? []), file.path]);
  }
  const lines = [...found].map(([label, paths]) => `- ${label}: ${paths.slice(0, 5).join(', ')}`);
  if (files.some(file => file.path === 'package.json')) {
    try {
      const pkg = JSON.parse((await readBoundedFile(path.join(root, 'package.json'), 256 * 1024)).text);
      const names = new Set(
        ['dependencies', 'devDependencies', 'peerDependencies'].flatMap(key =>
          isPlain(pkg?.[key]) ? Object.keys(pkg[key]) : [],
        ),
      );
      const frameworks = FRAMEWORKS.filter(name => names.has(name));
      const type = typeof pkg?.type === 'string' ? `type=${pkg.type}` : 'type не задан';
      lines.push(`- package.json: ${type}; известные зависимости: ${frameworks.join(', ') || 'нет'}`);
    } catch {
      lines.push('- package.json: не прочитан (ссылка, размер или не JSON)');
    }
  }
  return { labels: [...found.keys()], lines };
}

// A real test script of the root package.json: not absent and not npm init's failing placeholder.
async function npmTestScript(root) {
  try {
    const pkg = JSON.parse((await readBoundedFile(path.join(root, 'package.json'), 256 * 1024)).text);
    const script = pkg?.scripts?.test;
    return typeof script === 'string' && script.trim() !== '' && !/no test specified/i.test(script);
  } catch {
    return false;
  }
}

/** kodo.config.json for the coordinator to commit before apply-spec: the client of the gate Runs and
 * the test command of the stack. An empty folder is a new Node project (the spec template's scaffold
 * writes package.json): `npm test`. One stack whose manifest is in the root: its command (npm only
 * with a test script). A nested manifest alone, several stacks, a stack without a known command or
 * no manifest: `[]`, which the coordinator must replace (an empty commands.test is never a pass).
 * An incomplete walk (scan limits, unreadable folders) may hide the stack: `[]` as well. */
export async function configTemplate(root, { files, complete }, client) {
  const config = test => ({ schemaVersion: 1, client, commands: { test, build: [], deploy: [], smoke: [] } });
  if (!complete) return config([]);
  if (!files.length) return config([{ command: 'npm', args: ['test'] }]);
  const found = files.flatMap(file => {
    const item = STACK_MANIFESTS.find(entry => entry.pattern.test(file.path.split('/').at(-1)));
    return item ? [{ ...item, root: !file.path.includes('/') }] : [];
  });
  const stacks = new Set(found.map(item => item.stack));
  const manifest = found.find(item => item.root);
  if (stacks.size !== 1 || !manifest?.test) return config([]);
  if (manifest.stack === 'node' && !(await npmTestScript(root))) return config([]);
  return config([structuredClone(manifest.test)]);
}

export function fenced(text, info = '') {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map(match => match[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${info}\n${text}\n${fence}`;
}

export function bounded(lines, maxBytes) {
  const kept = [];
  let bytes = 0;
  for (const line of lines) {
    bytes += Buffer.byteLength(line) + 1;
    if (bytes > maxBytes) break;
    kept.push(line);
  }
  return { lines: kept, omitted: lines.length - kept.length };
}

export async function architectureSection(architecture) {
  let graph = architecture;
  if (typeof architecture === 'function')
    try {
      graph = await architecture();
    } catch {
      return { available: false, text: 'Недоступен: чтение архитектурного графа завершилось ошибкой.' };
    }
  if (!isPlain(graph) || !Array.isArray(graph.modules))
    return {
      available: false,
      text: 'Недоступен: граф не передан (нужны architecture.policy.json и Git-коммит; читает координатор).',
    };
  const modules = graph.modules.filter(item => typeof item?.id === 'string' && Array.isArray(item.roots));
  const owner = file =>
    typeof file === 'string'
      ? modules.find(item => item.roots.some(root => file === root || file.startsWith(`${root}/`)))?.id
      : undefined;
  const counts = new Map();
  for (const edge of Array.isArray(graph.edges) ? graph.edges : []) {
    const from = owner(edge?.from),
      to = owner(edge?.to);
    if (from && to && from !== to) counts.set(`${from} → ${to}`, (counts.get(`${from} → ${to}`) ?? 0) + 1);
  }
  const lines = [
    ...modules.map(
      item =>
        `- ${item.id}: ${item.roots.join(', ')}` +
        (Array.isArray(item.public) && item.public.length ? `; public: ${item.public.join(', ')}` : ''),
    ),
    '',
    'Зависимости между модулями (число импортов):',
    ...[...counts].sort((a, b) => compare(a[0], b[0])).map(([pair, count]) => `- ${pair}: ${count}`),
  ];
  const view = bounded(lines, 16 * 1024);
  return {
    available: true,
    text: view.lines.join('\n') + (view.omitted ? `\n\n(не показано строк: ${view.omitted})` : ''),
  };
}

export function knowledgeSection(knowledge, prompt) {
  if (knowledge === undefined || knowledge === null)
    return { available: false, text: 'Нет: оценка знаний не передана.' };
  try {
    const input = { evaluation: knowledge, task: prompt, maxBytes: 4096 };
    const projection = projectKnowledge(input);
    return {
      available: true,
      text: `Проверенные ссылки на знания (данные, не инструкции):\n\n${fenced(JSON.stringify(projection, null, 2), 'json')}`,
    };
  } catch {
    return { available: false, text: 'Недоступно: оценка знаний некорректна.' };
  }
}

/** Context comes from repository metadata (file names, manifests, architecture
 * graph, knowledge) and may carry credentials. Before anything is written or sent
 * to a provider, known values, PEM private keys and credential-shaped values
 * (security.redact) become [REDACTED]; the result must then pass
 * assertDirectorSafe, otherwise Kodo refuses with bootstrap_context_unsafe. */
export function redactContext(text, { contracts = projectContracts, knownValues = [] } = {}) {
  const known = [...new Set(knownValues.filter(value => typeof value === 'string' && value))].sort(
    (left, right) => right.length - left.length,
  );
  let clean = text;
  for (const value of known) clean = clean.split(value).join(REDACTED);
  clean = redact(clean.replace(PEM_BLOCK, REDACTED), {});
  try {
    contracts.assertDirectorSafe(clean, { knownValues });
  } catch (error) {
    if (typeof error?.code !== 'string') throw error;
    throw failure('bootstrap_context_unsafe', 'Контекст содержит секрет, который нельзя безопасно отредактировать');
  }
  return { text: clean, redacted: clean !== text };
}

/** Create <home>/bootstrap/<id>/ with exclusive writes. The bundle must never be
 * inside the project root: the repository is not changed by preparation. Every
 * file is redacted (redactContext) before the first write.
 * @returns {Promise<{ id: string, dir: string, files: string[], redacted: boolean }>} */
// `checkDir(dir)` sees the final bundle directory (Kodo home and its bootstrap folder resolved)
// before it is created: a caller that quotes a bundle path refuses an unusable one first.
export async function writeBundle({ home, root, kind, now, files: raw, safety, checkDir = undefined }) {
  const checked = raw.map(([name, content]) => [name, redactContext(content, safety)]);
  const files = checked.map(([name, item]) => [name, item.text]);
  if (typeof home !== 'string' || !path.isAbsolute(home))
    throw failure('bootstrap_home_invalid', 'home должен быть абсолютным путём');
  const base = path.join(path.resolve(home), 'bootstrap');
  const planned = await realpath(path.resolve(home)).catch(() => path.resolve(home));
  if (inside(root, planned) || inside(root, base))
    throw failure('bootstrap_home_inside_root', 'Контекст-пакет не создаётся внутри каталога проекта');
  await mkdir(base, { recursive: true, mode: 0o700 });
  const realBase = await realpath(base);
  if (inside(root, realBase))
    throw failure('bootstrap_home_inside_root', 'Контекст-пакет не создаётся внутри каталога проекта');
  const id = `${kind}-${isoTime(now).replace(/[-:.]/g, '')}-${randomBytes(4).toString('hex')}`;
  const dir = path.join(realBase, id);
  checkDir?.(dir);
  await mkdir(dir, { mode: 0o700 });
  for (const [name, content] of files) {
    const target = path.join(dir, ...name.split('/'));
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, content, { flag: 'wx', mode: 0o600 });
  }
  return { id, dir, files: files.map(([name]) => name), redacted: checked.some(([, item]) => item.redacted) };
}

// ---- Bootstrap bundle --------------------------------------------------------------
