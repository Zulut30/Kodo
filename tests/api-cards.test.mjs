import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  DEFAULT_API_CARD_MAX_BYTES,
  buildApiCards,
  createApiCardCache,
  extractJsTsPublicApi,
  extractRustPublicApi,
} from '../runtime/api-cards.mjs';

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

async function write(cwd, relativePath, content) {
  const full = path.join(cwd, relativePath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, 'utf8');
}

async function createRepo(t, files) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kodo-api-cards-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.name', 'Kodo Test');
  git(dir, 'config', 'user.email', 'kodo-test@example.invalid');
  git(dir, 'config', 'core.autocrlf', 'false');
  for (const [name, content] of Object.entries(files)) await write(dir, name, content);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'Initial fixture');
  const baseSha = git(dir, 'rev-parse', 'HEAD');
  return { dir, baseSha };
}

test('extractRustPublicApi extracts pub items as single-line signatures without bodies and excludes non-pub/pub(crate)', () => {
  const rust = `
// pub fn commented_out() {}
/* pub struct BlockCommented {
   /* nested pub fn inner() {} */
} */
pub mod chunk;
pub(crate) mod internal_mod;
mod private_mod;

pub const MAX_HEIGHT: usize = 256;
pub(crate) const CRATE_LIMIT: usize = 16;
const PRIVATE_CONST: u8 = 1;

pub type BlockId = u16;
pub(super) type LocalId = u8;

pub struct Chunk<T>
where
    T: Copy,
{
    pub blocks: Vec<T>,
    dirty: bool,
}

pub(crate) struct InternalGrid {
    size: usize,
}

struct PrivateHelper;

pub enum ChunkState {
    Empty,
    Ready { count: usize },
}

pub(in crate::world) enum RestrictedState {
    Pending,
}

pub trait WorldStore: Send + Sync {
    fn get_block(&self, x: i32, y: i32) -> BlockId;
}

pub async fn load_chunk(
    x: i32,
    z: i32,
) -> Result<Chunk<u16>, String> {
    let fake = "pub fn inside_string() {}";
    let raw = r#"pub struct InsideRaw {}"#;
    let _ = (fake, raw);
    todo!()
}

pub(crate) fn internal_load() {}
fn private_helper() {}

impl<T: Copy> Chunk<T> {
    pub fn len(&self) -> usize {
        self.blocks.len()
    }

    pub(crate) fn mark_dirty(&mut self) {
        self.dirty = true;
    }

    fn reset(&mut self) {}
}
`;
  const signatures = extractRustPublicApi(rust);
  assert.deepEqual(signatures, [
    'pub mod chunk',
    'pub const MAX_HEIGHT: usize = 256',
    'pub type BlockId = u16',
    'pub struct Chunk<T> where T: Copy',
    'pub enum ChunkState',
    'pub trait WorldStore: Send + Sync',
    'pub trait WorldStore: Send + Sync :: fn get_block(&self, x: i32, y: i32) -> BlockId',
    'pub async fn load_chunk( x: i32, z: i32, ) -> Result<Chunk<u16>, String>',
    'impl<T: Copy> Chunk<T> :: pub fn len(&self) -> usize',
  ]);
  for (const sig of signatures) {
    assert.ok(!sig.includes('\n'), `signature must be single-line: ${sig}`);
    assert.doesNotMatch(
      sig,
      /pub\(|commented_out|BlockCommented|inside_string|InsideRaw|private_helper|InternalGrid|PrivateHelper|RestrictedState|mark_dirty|reset/,
    );
  }
});

test('extractJsTsPublicApi extracts exported functions, classes, constants and types without bodies and ignores non-exported items', () => {
  const ts = `
// export function commented() {}
/* export class Hidden {} */
const SECRET_LOCAL = 'ignore';
function privateFn(a: number): number {
  return a + 1;
}

export const VERSION = '1.0.0';
export const compute = (x: number, y: number): number => {
  const s = 'export const FAKE = 1;';
  return x + y + s.length;
};

export async function fetchChunk(
  id: string,
  opts?: { force?: boolean },
): Promise<Uint8Array> {
  return new Uint8Array();
}

export class WorldEngine extends BaseEngine {
  run() {
    return 42;
  }
}

export type ChunkKey = \`\${number}:\${number}\`;
export interface StorageAdapter<T> {
  read(key: ChunkKey): Promise<T>;
}
export enum BuildMode {
  Fast,
  Full,
}
export { VERSION as WORLD_VERSION };
`;
  const signatures = extractJsTsPublicApi(ts);
  assert.deepEqual(signatures, [
    "export const VERSION = '1.0.0'",
    'export const compute = (x: number, y: number): number =>',
    'export async function fetchChunk( id: string, opts?: { force?: boolean }, ): Promise<Uint8Array>',
    'export class WorldEngine extends BaseEngine',
    'export type ChunkKey = `${number}:${number}`',
    'export interface StorageAdapter<T>',
    'export enum BuildMode',
    'export { VERSION as WORLD_VERSION }',
  ]);
  for (const sig of signatures) {
    assert.ok(!sig.includes('\n'));
    assert.doesNotMatch(sig, /SECRET_LOCAL|privateFn|commented|Hidden|FAKE/);
  }
});

test('buildApiCards reads strictly from baseSha (working tree edits do not leak) and includes blueprint invariants', async t => {
  const { dir, baseSha } = await createRepo(t, {
    '.kodo/blueprint/PROJECT.md': [
      '# Voxel Sandbox',
      '## Цель',
      'Оригинальная воксельная песочница.',
      '## Инварианты',
      '- Координаты чанков всегда в i32, без паники при переполнении.',
      '- Рендер не читает диск напрямую.',
    ].join('\n'),
    'crates/world/src/lib.rs': [
      'pub struct World { seed: u64 }',
      'pub(crate) fn internal_seed() -> u64 { 0 }',
      'pub fn new_world(seed: u64) -> World { World { seed } }',
    ].join('\n'),
    'src/storage/index.mjs': [
      'function hidden() { return 0; }',
      'export function saveNote(title, body) { return { title, body }; }',
      'export const MAX_NOTES = 100;',
    ].join('\n'),
  });

  // Mutate working tree after baseSha commit: must NOT affect the card built for baseSha!
  await write(dir, 'crates/world/src/lib.rs', 'pub fn dirty_working_tree_fn() {}\npub struct DirtyStruct {}\n');
  await write(dir, 'src/storage/index.mjs', 'export function dirtyJsFn() {}\n');
  await write(dir, 'crates/world/src/untracked.rs', 'pub fn untracked_fn() {}\n');

  const task = {
    id: 'render-module',
    dependsOn: ['world-module', 'storage-module'],
    writePaths: ['crates/render'],
    interfaceRefs: [],
  };
  const tasks = [
    { id: 'world-module', epicId: 'world', writePaths: ['crates/world'] },
    { id: 'storage-module', epicId: 'storage', writePaths: ['src/storage'] },
    task,
  ];

  const started = performance.now();
  const card = await buildApiCards({
    cwd: dir,
    baseSha,
    task,
    tasks,
    constraints: ['Без паник в публичном API.'],
  });
  const elapsedMs = performance.now() - started;

  assert.equal(card.kind, 'api-cards');
  assert.equal(card.baseSha, baseSha);
  assert.equal(card.truncated, false);
  assert.ok(card.bytes <= DEFAULT_API_CARD_MAX_BYTES);
  assert.equal(card.bytes, Buffer.byteLength(card.text, 'utf8'));
  assert.ok(elapsedMs < 1000, `expected < 1000ms, got ${elapsedMs.toFixed(1)}ms`);

  assert.deepEqual(
    card.modules.map(m => [m.path, m.language, m.signatures]),
    [
      ['crates/world/src/lib.rs', 'rust', ['pub struct World', 'pub fn new_world(seed: u64) -> World']],
      ['src/storage/index.mjs', 'js', ['export function saveNote(title, body)', 'export const MAX_NOTES = 100']],
    ],
  );
  assert.ok(card.invariants.some(line => line.includes('Координаты чанков всегда в i32')));
  assert.ok(card.invariants.some(line => line.includes('Без паник в публичном API.')));
  assert.doesNotMatch(card.text, /dirty_working_tree_fn|DirtyStruct|dirtyJsFn|untracked_fn|internal_seed|hidden/);

  // Deterministic across repeated calls.
  const second = await buildApiCards({
    cwd: dir,
    baseSha,
    task,
    tasks,
    constraints: ['Без паник в публичном API.'],
  });
  assert.deepEqual(second, card);
});

test('buildApiCards truncates deterministically within maxBytes and marks truncation clearly', async t => {
  const manyFns = Array.from(
    { length: 80 },
    (_, i) => `pub fn compute_block_light_level_${String(i).padStart(3, '0')}(x: i32, y: i32, z: i32) -> u8 { 0 }`,
  ).join('\n');
  const { dir, baseSha } = await createRepo(t, {
    'crates/world/src/a.rs': manyFns,
    'crates/world/src/b.rs': manyFns,
  });

  const maxBytes = 600;
  const first = await buildApiCards({ cwd: dir, baseSha, paths: ['crates/world'], maxBytes });
  const second = await buildApiCards({ cwd: dir, baseSha, paths: ['crates/world'], maxBytes });

  assert.deepEqual(second, first, 'truncation must be deterministic');
  assert.equal(first.truncated, true);
  assert.ok(first.bytes <= maxBytes, `bytes ${first.bytes} > ${maxBytes}`);
  assert.equal(first.bytes, Buffer.byteLength(first.text, 'utf8'));
  assert.ok(first.originalBytes > maxBytes);
  assert.ok(first.omitted.files > 0 || first.omitted.signatures > 0);
  assert.match(first.text, /\[truncated:/);
});

test('buildApiCards skips >MAX_SOURCE_BYTES blobs via ls-tree -l before reading and degrades gracefully on errors', async t => {
  const hugeContent = `// ${'x'.repeat(17 * 1024 * 1024)}\nexport const HUGE = 1;\n`;
  const { dir, baseSha } = await createRepo(t, {
    'src/huge.mjs': hugeContent,
    'src/small.mjs': 'export function ping() { return "pong"; }\n',
  });

  const card = await buildApiCards({ cwd: dir, baseSha, paths: ['src'] });
  assert.equal(card.unavailable, undefined);
  assert.deepEqual(
    card.modules.map(m => [m.path, m.signatures]),
    [['src/small.mjs', ['export function ping()']]],
  );

  // Missing commit / git error degrades to unavailable card instead of throwing.
  const missingSha = 'f'.repeat(40);
  const degraded = await buildApiCards({ cwd: dir, baseSha: missingSha, paths: ['src'] });
  assert.equal(degraded.unavailable, true);
  assert.equal(typeof degraded.code, 'string');
  assert.ok(degraded.code.length > 0);
  assert.equal(degraded.text, `API cards unavailable: ${degraded.code}`);
});

test('buildApiCards batches blob reads and caches tree by baseSha and signatures by blob OID', async t => {
  const files = {};
  for (let i = 0; i < 20; i++) {
    files[`src/mod/f${String(i).padStart(2, '0')}.mjs`] = `export function fn${i}(x) { return x + ${i}; }\n`;
  }
  const { dir, baseSha } = await createRepo(t, files);
  const cache = createApiCardCache();

  const first = await buildApiCards({ cwd: dir, baseSha, paths: ['src/mod'], cache });
  assert.equal(first.modules.length, 20);
  assert.equal(cache.trees.size, 1);
  assert.equal(cache.signatures.size, 20);
  assert.deepEqual(cache.stats, { listTreeCalls: 1, batchCalls: 1, blobsRead: 20 });

  const second = await buildApiCards({ cwd: dir, baseSha, paths: ['src/mod'], cache });
  assert.deepEqual(second, first);
  assert.deepEqual(cache.stats, { listTreeCalls: 1, batchCalls: 1, blobsRead: 20 });

  // AbortSignal cancels buildApiCards cleanly instead of degrading to unavailable.
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    buildApiCards({ cwd: dir, baseSha, paths: ['src/mod'], signal: aborted.signal }),
    error => error.code === 'cancelled',
  );
});

test('extractRustPublicApi handles pub use trees, pub trait methods, pub mod paths, #[macro_export] and excludes #[cfg(test)]', () => {
  const rust = `
pub use a::{B, C};
pub use crate::net::{Client, Server as Srv};

pub trait Store: Send {
    fn get(&self, id: u32) -> Option<String>;
    fn clear(&mut self) {
        let _ = 1;
    }
}

pub mod nested {
    pub struct Item {
        pub id: u32,
    }
    pub fn build() -> Item {
        Item { id: 1 }
    }
    pub mod deep {
        pub const FLAG: bool = true;
    }
    #[macro_export]
    macro_rules! nested_api {
        () => {};
    }
    fn hidden_in_mod() {}
}

mod private_mod {
    pub fn not_publicly_reachable() {}
    #[macro_export]
    macro_rules! api {
        () => {};
    }
    mod inner {
        #[macro_export]
        macro_rules! deep_api {
            () => {};
        }
    }
}

#[macro_export]
macro_rules! my_macro {
    ($x:expr) => { $x };
}

macro_rules! local_macro {
    () => {};
}

#[cfg(test)]
pub fn direct_test_helper() {}

#[cfg(test)]
pub mod tests {
    pub struct TestFixture;
    pub fn test_only() {}
    #[macro_export]
    macro_rules! test_only_macro {
        () => {};
    }
}
`;
  const sigs = extractRustPublicApi(rust);
  assert.deepEqual(sigs, [
    'pub use a::{B, C}',
    'pub use crate::net::{Client, Server as Srv}',
    'pub trait Store: Send',
    'pub trait Store: Send :: fn get(&self, id: u32) -> Option<String>',
    'pub trait Store: Send :: fn clear(&mut self)',
    'pub mod nested',
    'nested :: pub struct Item',
    'nested :: pub fn build() -> Item',
    'nested :: pub mod deep',
    'nested::deep :: pub const FLAG: bool = true',
    'crate::nested_api!',
    'crate::api!',
    'crate::deep_api!',
    'crate::my_macro!',
  ]);
  for (const sig of sigs) {
    assert.doesNotMatch(
      sig,
      /hidden_in_mod|not_publicly_reachable|local_macro|direct_test_helper|TestFixture|test_only|test_only_macro/,
    );
  }
});

test('extractJsTsPublicApi preserves full TS type annotations and splits semicolon-free export const declarations', () => {
  const ts = `
export type Config = { retries: number };
export type Handler = (req: { id: string }) => { ok: boolean }
export function get(): { x: number } {
  return { x: 1 };
}
export function pick(): { a: number } | { b: string } {
  return { a: 1 };
}
export const A = 1
export const B = 'two'
export const C: { count: number } = { count: 3 }
export const make = (v: number): { x: number } => {
  return { x: v }
}
`;
  const sigs = extractJsTsPublicApi(ts);
  assert.deepEqual(sigs, [
    'export type Config = { retries: number }',
    'export type Handler = (req: { id: string }) => { ok: boolean }',
    'export function get(): { x: number }',
    'export function pick(): { a: number } | { b: string }',
    'export const A = 1',
    "export const B = 'two'",
    'export const C: { count: number }',
    'export const make = (v: number): { x: number } =>',
  ]);
});

test('buildApiCards resolves module names from verified apply-spec interface evidence envelopes', async t => {
  const { dir, baseSha } = await createRepo(t, {
    'crates/world/src/lib.rs': 'pub struct World;\npub fn create_world() -> World { World }\n',
  });
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kodo-api-ev-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const evidenceDir = path.join(home, 'project-interfaces', 'evidence');
  await mkdir(evidenceDir, { recursive: true });

  const envelopeText = JSON.stringify({
    schemaVersion: 1,
    kind: 'interface',
    value: { schemaVersion: 1, module: 'world', source: 'interfaces/world.md', text: '# World API' },
  });
  const digest = createHash('sha256').update(envelopeText, 'utf8').digest('hex');
  const evidencePath = path.join(evidenceDir, `interface-${digest}.json`);
  await writeFile(evidencePath, envelopeText, 'utf8');

  const task = {
    id: 'render-1',
    epicId: 'render',
    dependsOn: [],
    writePaths: ['crates/render'],
    interfaceRefs: [{ kind: 'interface', runId: null, headSha: null, path: evidencePath, sha256: digest }],
  };
  const tasks = [{ id: 'world-1', epicId: 'world', writePaths: ['crates/world'] }, task];

  const card = await buildApiCards({ cwd: dir, baseSha, task, tasks, home });
  assert.deepEqual(
    card.modules.map(m => [m.path, m.signatures]),
    [['crates/world/src/lib.rs', ['pub struct World', 'pub fn create_world() -> World']]],
  );

  // Tampered sha256 must NOT be trusted.
  const tampered = await buildApiCards({
    cwd: dir,
    baseSha,
    task: {
      ...task,
      interfaceRefs: [{ kind: 'interface', runId: null, headSha: null, path: evidencePath, sha256: '0'.repeat(64) }],
    },
    tasks,
    home,
  });
  assert.deepEqual(tampered.modules, []);
});

test('buildApiCards degrades to unavailable when a dependency blob is missing (ls-tree BAD or cat-file missing)', async t => {
  const { dir, baseSha } = await createRepo(t, {
    'src/dep/mod.mjs': 'export function helper() { return 42; }\n',
    'src/other/keep.mjs': 'export const OK = true;\n',
  });
  const oid = git(dir, 'rev-parse', `${baseSha}:src/dep/mod.mjs`);
  const objectFile = path.join(dir, '.git', 'objects', oid.slice(0, 2), oid.slice(2));

  // Prime a cache with the intact tree, then remove the loose blob object so cat-file --batch sees "missing".
  const cachedTree = createApiCardCache();
  await buildApiCards({ cwd: dir, baseSha, paths: ['src/other'], cache: cachedTree });
  await rm(objectFile, { force: true });

  // Case 1: fresh ls-tree -l sees BAD size for src/dep/mod.mjs -> MUST return unavailable (not empty success).
  const fromLsTree = await buildApiCards({ cwd: dir, baseSha, paths: ['src/dep'] });
  assert.equal(fromLsTree.unavailable, true);
  assert.equal(fromLsTree.code, 'api_cards_missing_object');

  // Case 2: cached tree skips ls-tree, so cat-file --batch requests the deleted OID -> MUST verify all OIDs and return unavailable.
  const fromBatch = await buildApiCards({ cwd: dir, baseSha, paths: ['src/dep'], cache: cachedTree });
  assert.equal(fromBatch.unavailable, true);
  assert.equal(fromBatch.code, 'api_cards_missing_object');
});

test('extractJsTsPublicApi distinguishes string literal return types, function type arrows and object return types from bodies', () => {
  const ts = `
export function mode(): "fast" | "slow" {
  return "fast";
}
export function get(): { x: number } {
  return { x: 1 };
}
export function labeled(): { kind: "a" } | "none" {
  return { kind: "a" };
}
export const run: (input: string) => number = (input) => {
  return input.length;
};
export const runInline: (input: string) => number = (input) => input.length;
export const buildObj: (id: string) => { x: number } = (id) => ({ x: id.length });
export const next = (v: number): "ok" | "err" => (v > 0 ? "ok" : "err");
`;
  const sigs = extractJsTsPublicApi(ts);
  assert.deepEqual(sigs, [
    'export function mode(): "fast" | "slow"',
    'export function get(): { x: number }',
    'export function labeled(): { kind: "a" } | "none"',
    'export const run: (input: string) => number',
    'export const runInline: (input: string) => number',
    'export const buildObj: (id: string) => { x: number }',
    'export const next = (v: number): "ok" | "err" =>',
  ]);
});

test('V4: extractJsTsPublicApi masks regex literals and preserves following top-level exports without semicolons', () => {
  const src = `
export const pattern = () => /[a-z]+/
export const VERSION = 2;
export const complexRe = () => /a{1,3};"\\/'[\\]/]+/gi
export function afterRegex(): number { return 1; }
export const directRe = /^foo\\/bar$/
export const NEXT = 'ok'
`;
  const sigs = extractJsTsPublicApi(src);
  assert.deepEqual(sigs, [
    'export const pattern = () =>',
    'export const VERSION = 2',
    'export const complexRe = () =>',
    'export function afterRegex(): number',
    'export const directRe = /^foo\\/bar$/',
    "export const NEXT = 'ok'",
  ]);
});

test('A property named like a keyword is not a regex start, and `.` before a line break continues the expression', () => {
  const division = `
const config = { default: 60 };
const half = config.default / 2; // user's preferred interval
export function interval() { return half; }
`;
  assert.deepEqual(extractJsTsPublicApi(division), ['export function interval()']);
  const method = `
const writer = { export() { return 'ok'; } };
export const result = writer.
  export();
export function next() {}
`;
  const sigs = extractJsTsPublicApi(method);
  assert.equal(sigs.length, 2, JSON.stringify(sigs));
  assert.match(sigs[0], /^export const result\b/);
  assert.ok(!sigs.some(sig => sig.startsWith('export()')), 'no phantom export() entry');
  assert.equal(sigs[1], 'export function next()');
});

test('V5: non-BMP characters (emoji/surrogate pairs) do not desynchronize JS/TS or Rust mask indices', () => {
  const ts = `
// 🚀 launch module
export const icon = "🚀";
export function launch() {
  return "🛸";
}
export const badge = "🧭🔥";
export function status(): "🚀" | "ok" { return "ok"; }
`;
  assert.deepEqual(extractJsTsPublicApi(ts), [
    'export const icon = "🚀"',
    'export function launch()',
    'export const badge = "🧭🔥"',
    'export function status(): "🚀" | "ok"',
  ]);

  const rs = `
// 🚀 rust module
pub const ICON: &str = "🚀";
pub const EMOJI: char = '🚀';
pub fn launch() -> &'static str {
    "🛸"
}
pub struct Rocket {
    pub tag: &'static str,
}
`;
  assert.deepEqual(extractRustPublicApi(rs), [
    'pub const ICON: &str = "🚀"',
    "pub const EMOJI: char = '🚀'",
    "pub fn launch() -> &'static str",
    'pub struct Rocket',
  ]);
});
