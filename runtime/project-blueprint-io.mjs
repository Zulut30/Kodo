// Bounded, link-free reads of the project factory blueprint
// (`project-blueprint.mjs`): blueprint files and interfaces, committed root
// entries, optional architecture and toolchain files and interface evidence.

import { createHash } from 'node:crypto';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { execute } from './command.mjs';
import { workerEnvironment } from './security.mjs';
import { inside } from './toolchains.mjs';
import {
  BLUEPRINT_LIMITS,
  compare,
  failure,
  finding,
  isPlain,
  shown,
  slashed,
  windowsLike,
} from './project-blueprint-shared.mjs';

const MODULE = /^[a-z][a-z0-9-]{0,47}$/;
const ZERO_DIGEST = '0'.repeat(64);
/** Read one regular, unlinked file with a byte cap, as strict UTF-8. Errors carry
 * blueprint_* codes. The open handle is compared with lstat to resist swaps. */
export async function readBoundedFile(file, maxBytes) {
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') throw failure('blueprint_missing', `Нет файла ${path.basename(file)}`);
    throw error;
  }
  const name = path.basename(file);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink > 1)
    throw failure('blueprint_unsafe_path', `${name}: ссылка, жёсткая ссылка или не обычный файл`);
  if (info.size > maxBytes) throw failure('blueprint_too_large', `${name}: больше ${maxBytes} байт`);
  const handle = await open(file, 'r');
  let bytes;
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.ino !== info.ino || current.dev !== info.dev || current.nlink > 1)
      throw failure('blueprint_unsafe_path', `${name}: файл подменён во время чтения`);
    const buffer = Buffer.alloc(Math.min(current.size, maxBytes) + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > maxBytes) throw failure('blueprint_too_large', `${name}: больше ${maxBytes} байт`);
    bytes = buffer.subarray(0, total);
  } finally {
    await handle.close();
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw failure('blueprint_encoding', `${name}: не UTF-8`);
  }
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), text };
}
async function safeDirectory(directory, required) {
  let info;
  try {
    info = await lstat(directory);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (required) throw failure('blueprint_missing', `Нет каталога ${path.basename(directory)}`);
    return false;
  }
  if (info.isSymbolicLink() || !info.isDirectory())
    throw failure('blueprint_unsafe_path', `${path.basename(directory)}: ссылка или не каталог`);
  return true;
}
async function projectRoot(root) {
  if (typeof root !== 'string' || !root) throw failure('blueprint_missing', 'Не указан каталог проекта');
  let real;
  try {
    real = await realpath(path.resolve(root));
  } catch (error) {
    if (error.code === 'ENOENT') throw failure('blueprint_missing', 'Каталог проекта не существует');
    throw error;
  }
  if (!(await stat(real)).isDirectory()) throw failure('blueprint_missing', 'Каталог проекта не является каталогом');
  return real;
}
async function readInterfaces(directory) {
  const folder = path.join(directory, 'interfaces');
  if (!(await safeDirectory(folder, false))) return [];
  const entries = (await readdir(folder, { withFileTypes: true })).sort((a, b) => compare(a.name, b.name));
  if (entries.length > BLUEPRINT_LIMITS.interfaces)
    throw failure('blueprint_too_large', `interfaces/: больше ${BLUEPRINT_LIMITS.interfaces} файлов`);
  const result = [];
  let total = 0;
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw failure('blueprint_unsafe_path', `interfaces/${shown(entry.name)}: ссылка`);
    const match = /^(.+)\.md$/.exec(entry.name);
    if (!entry.isFile() || !match || !MODULE.test(match[1]))
      throw failure('blueprint_interface_name', `interfaces/${shown(entry.name)}: ожидается <module>.md (slug)`);
    const file = await readBoundedFile(path.join(folder, entry.name), BLUEPRINT_LIMITS.interface);
    total += file.bytes;
    if (total > BLUEPRINT_LIMITS.interfacesTotal)
      throw failure('blueprint_too_large', `interfaces/: больше ${BLUEPRINT_LIMITS.interfacesTotal} байт`);
    result.push({ module: match[1], path: `interfaces/${entry.name}`, sha256: file.sha256, bytes: file.bytes });
  }
  return result;
}
/** Read PROJECT.md, spec.json and interfaces/*.md from <root>/.kodo/blueprint.
 * `specFile` replaces spec.json by another file (same limits and link rules).
 * Rejects links, hard links, special files, oversized or non-UTF-8 content.
 * @param {string} root
 * @param {{ specFile?: string }} [options] */
export async function readBlueprint(root, { specFile } = {}) {
  const real = await projectRoot(root);
  const directory = path.join(real, '.kodo', 'blueprint');
  await safeDirectory(path.join(real, '.kodo'), true);
  await safeDirectory(directory, true);
  if (!inside(real, await realpath(directory))) throw failure('blueprint_unsafe_path', 'Чертёж вне каталога проекта');
  const project = await readBoundedFile(path.join(directory, 'PROJECT.md'), BLUEPRINT_LIMITS.project);
  if (specFile !== undefined && (typeof specFile !== 'string' || !specFile))
    throw failure('blueprint_missing', 'Не указан файл spec');
  const specPath = specFile === undefined ? path.join(directory, 'spec.json') : path.resolve(specFile);
  const spec = await readBoundedFile(specPath, BLUEPRINT_LIMITS.spec);
  const specName = path.basename(specPath);
  let value;
  try {
    value = JSON.parse(spec.text);
  } catch {
    throw failure('blueprint_invalid_json', `${specName} не является JSON`);
  }
  return {
    root: real,
    dir: directory,
    project: { path: 'PROJECT.md', sha256: project.sha256, bytes: project.bytes, text: project.text },
    spec: { path: specFile === undefined ? 'spec.json' : specName, sha256: spec.sha256, bytes: spec.bytes, value },
    interfaces: await readInterfaces(directory),
  };
}
// ---- Compile -------------------------------------------------------------------

function interfaceModule(value, root) {
  const text = value.replaceAll('\\', '/');
  let relative;
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    const fold = windowsLike(root) ? item => item.toLowerCase() : item => item;
    const base = `${slashed(root)}/.kodo/blueprint/`;
    relative = fold(text).startsWith(fold(base)) ? text.slice(base.length) : null;
  } else relative = text.replace(/^\.\//, '').replace(/^\.kodo\/blueprint\//, '');
  const match = relative && /^interfaces\/([a-z][a-z0-9-]{0,47})\.md$/.exec(relative);
  return match ? match[1] : null;
}
// Blueprint shorthand: { kind?: 'interface', path: 'interfaces/<module>.md' } with
// optional runId/headSha/sha256. It resolves to a full Ref with the current file
// digest. A missing interface gets a zero digest; lint then reports it.
function resolveRefs(task, root, interfaces) {
  const refs = [],
    unresolved = [];
  for (const ref of task.interfaceRefs) {
    if (!isPlain(ref) || typeof ref.path !== 'string') {
      refs.push(ref);
      continue;
    }
    const module = interfaceModule(ref.path, root);
    const relative = !(path.isAbsolute(ref.path) || path.win32.isAbsolute(ref.path));
    if (module === null) {
      if (relative) unresolved.push(task.id);
      else refs.push(ref);
      continue;
    }
    refs.push({
      ...ref,
      kind: ref.kind ?? 'interface',
      runId: ref.runId ?? null,
      headSha: ref.headSha ?? null,
      path: path.join(root, '.kodo', 'blueprint', 'interfaces', `${module}.md`),
      sha256: ref.sha256 ?? interfaces.find(item => item.module === module)?.sha256 ?? ZERO_DIGEST,
    });
  }
  return { refs, unresolved };
}
async function sameDirectory(declared, real) {
  if (!path.isAbsolute(declared)) return true; // normalizeProjectSpec reports non-absolute roots.
  const resolved = await realpath(declared).catch(() => path.resolve(declared));
  const fold = process.platform === 'win32' ? value => value.toLowerCase() : value => value;
  return fold(path.resolve(resolved)) === fold(real);
}
export async function resolveSource({ root, spec, interfaces }) {
  if (!isPlain(spec.value)) return { value: spec.value, findings: [] };
  const value = structuredClone(spec.value),
    findings = [],
    unresolved = new Set();
  if (typeof value.root === 'string') {
    if (await sameDirectory(value.root, root)) value.root = root;
    else findings.push(finding('blueprint_root_mismatch', 'root в spec.json не совпадает с каталогом проекта'));
  }
  if (Array.isArray(value.tasks))
    for (const task of value.tasks) {
      if (!isPlain(task) || !Array.isArray(task.interfaceRefs)) continue;
      const result = resolveRefs(task, root, interfaces);
      task.interfaceRefs = result.refs;
      for (const id of result.unresolved) unresolved.add(id);
    }
  if (unresolved.size)
    findings.push(
      finding(
        'blueprint_interface_missing',
        'Относительный path в interfaceRefs должен иметь вид interfaces/<module>.md',
        [...unresolved].map(String),
      ),
    );
  return { value, findings };
}
export async function readOptionalArchitecturePolicy(root) {
  try {
    const file = await readBoundedFile(path.join(root, 'architecture.policy.json'), BLUEPRINT_LIMITS.spec);
    const parsed = JSON.parse(file.text);
    return isPlain(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
async function readCommittedRootEntry(root, file) {
  try {
    const top = await execute('git', ['rev-parse', '--show-toplevel'], {
      cwd: root,
      env: workerEnvironment(),
      rawOutput: true,
      allowFailure: true,
      timeoutMs: 10000,
    });
    if (top.code !== 0 || typeof top.stdout !== 'string' || !(await sameDirectory(top.stdout.trim(), root)))
      return null;
    const ls = await execute('git', ['ls-tree', '-z', 'HEAD', '--', file], {
      cwd: root,
      env: workerEnvironment(),
      rawOutput: true,
      allowFailure: true,
      timeoutMs: 10000,
    });
    if (ls.code !== 0 || typeof ls.stdout !== 'string') return null;
    const rows = ls.stdout.split('\0').filter(Boolean);
    if (rows.length !== 1) return null;
    const match = /^(100644|100755) blob ([a-f0-9]{40,64})\t([\s\S]+)$/.exec(rows[0]);
    if (!match || match[3] !== file) return null;
    return { oid: match[2] };
  } catch {
    return null;
  }
}
export async function hasCommittedCargoManifest(root) {
  return Boolean(await readCommittedRootEntry(root, 'Cargo.toml'));
}
export async function readOptionalRustToolchain(root) {
  const entry = await readCommittedRootEntry(root, 'rust-toolchain.toml');
  if (!entry) return false;
  try {
    const sizeOut = await execute('git', ['cat-file', '-s', entry.oid], {
      cwd: root,
      env: workerEnvironment(),
      rawOutput: true,
      allowFailure: true,
      timeoutMs: 10000,
    });
    const size = Number(sizeOut.stdout?.trim());
    if (sizeOut.code !== 0 || !Number.isSafeInteger(size) || size < 0 || size > BLUEPRINT_LIMITS.project) return false;
    const blob = await execute('git', ['cat-file', 'blob', entry.oid], {
      cwd: root,
      env: workerEnvironment(),
      rawOutput: true,
      allowFailure: true,
      timeoutMs: 10000,
    });
    if (blob.code !== 0 || typeof blob.stdout !== 'string' || Buffer.byteLength(blob.stdout) > BLUEPRINT_LIMITS.project)
      return false;
    const doc = parseToml(blob.stdout);
    const tc = /** @type {Record<string, any> | null} */ (isPlain(doc?.toolchain) ? doc.toolchain : null);
    const channel = typeof tc?.channel === 'string' ? tc.channel.trim() : '';
    const exactChannel = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(channel);
    const components = Array.isArray(tc?.components) ? tc.components : [];
    return exactChannel && components.includes('clippy') && components.includes('rustfmt');
  } catch {
    return false;
  }
}
// ---- Interface evidence --------------------------------------------------------

/** Freeze every interface of a compiled blueprint as an immutable evidence
 * envelope and point task interfaceRefs at it, so Project Director can verify
 * them (engine.assertEvidence). `persist(value)` is the caller's port, e.g.
 * engine.persistEvidence(owner, 'interface', value, { headSha: null }), and
 * returns { path, sha256 }. Files are re-read first: a change since compile
 * yields blueprint_interface_stale and nothing is persisted.
 * Returns { ok, spec, interfaces: [{ module, source, path, sha256 }], findings }.
 * @param {Record<string, any>} compiled
 * @param {{ persist?: (value: Record<string, any>) => Promise<{ path: string, sha256: string }> }} [options] */
export async function bindInterfaceEvidence(compiled, { persist } = {}) {
  if (!compiled?.ok || !isPlain(compiled.spec) || !Array.isArray(compiled.interfaces))
    throw failure('blueprint_not_compiled', 'Привязать интерфейсы можно только у принятого чертежа');
  if (typeof persist !== 'function') throw failure('blueprint_persist_invalid', 'Нужен порт persist');
  const root = compiled.spec.root;
  const directory = path.join(root, '.kodo', 'blueprint');
  const fold = windowsLike(root) ? value => value.toLowerCase() : value => value;
  const used = new Set(
    compiled.spec.tasks.flatMap(task => task.interfaceRefs.map(ref => interfaceModule(ref.path, root))),
  );
  const values = [],
    stale = [];
  for (const item of compiled.interfaces.filter(entry => used.has(entry.module))) {
    let file;
    try {
      file = await readBoundedFile(path.join(directory, ...item.path.split('/')), BLUEPRINT_LIMITS.interface);
    } catch (error) {
      if (!String(error?.code).startsWith('blueprint_')) throw error;
      file = null;
    }
    if (!file || file.sha256 !== item.sha256) stale.push(item.module);
    else
      values.push({
        schemaVersion: 1,
        module: item.module,
        source: item.path,
        sha256: item.sha256,
        bytes: file.bytes,
        text: file.text,
      });
  }
  if (stale.length) {
    const ids = compiled.spec.tasks
      .filter(task => task.interfaceRefs.some(ref => stale.includes(interfaceModule(ref.path, root))))
      .map(task => task.id);
    const message = 'Интерфейсы изменились после проверки чертежа; повторите apply-spec';
    return { ok: false, spec: null, interfaces: [], findings: [finding('blueprint_interface_stale', message, ids)] };
  }
  const interfaces = [];
  for (const value of values) {
    const evidence = await persist(value);
    interfaces.push({ module: value.module, source: value.source, path: evidence.path, sha256: evidence.sha256 });
  }
  const byModule = new Map(interfaces.map(item => [item.module, item]));
  const spec = structuredClone(compiled.spec);
  for (const task of spec.tasks)
    task.interfaceRefs = task.interfaceRefs.map(ref => {
      const evidence = byModule.get(interfaceModule(ref.path, root));
      if (!evidence || fold(slashed(ref.path)) !== fold(`${slashed(directory)}/${evidence.source}`))
        throw failure('blueprint_not_compiled', 'interfaceRefs не указывают на интерфейсы чертежа');
      return { kind: 'interface', runId: null, headSha: null, path: evidence.path, sha256: evidence.sha256 };
    });
  return { ok: true, spec, interfaces, findings: [] };
}
