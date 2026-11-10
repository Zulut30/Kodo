// Private installation primitives. No processes, network or writes on import.
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { gunzipSync, inflateRawSync } from 'node:zlib';

export const sha256 = data => createHash('sha256').update(data).digest('hex');
export async function fileHash(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
export function inside(parent, child) {
  const relative = path.relative(parent, child);
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
export function relativeFile(name) {
  if (
    typeof name !== 'string' ||
    !name ||
    name.length > 2048 ||
    /[\\:\x00-\x1f\x7f]/.test(name) ||
    name.startsWith('/')
  )
    throw new Error('Unsafe relative installation path');
  const parts = name.replace(/\/$/, '').split('/');
  if (
    parts.some(
      p =>
        !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
    )
  )
    throw new Error('Unsafe relative installation path');
  return parts.join('/');
}
/** The pinned bin and package metadata must describe the same local script.
 * Node executes this script directly: npm's generated shims are never trusted. */
export function npmEntrypoint(tool, pkg) {
  const entry = relativeFile(tool.entry);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(tool.binName ?? '') || entry.startsWith('-'))
    throw new Error('Invalid pinned npm entrypoint');
  const bin =
    typeof pkg.bin === 'string' && tool.binName === tool.id
      ? pkg.bin
      : typeof pkg.bin === 'object' && pkg.bin !== null && Object.hasOwn(pkg.bin, tool.binName)
        ? pkg.bin[tool.binName]
        : undefined;
  if (typeof bin !== 'string' || relativeFile(bin.startsWith('./') ? bin.slice(2) : bin) !== entry)
    throw new Error('Unexpected npm bin entrypoint');
  return entry;
}
export function pythonEntrypoint(entry) {
  if (
    typeof entry !== 'string' ||
    entry.length > 200 ||
    !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(entry)
  )
    throw new Error('Invalid Python entry module');
  return entry;
}
// Only the deliberately small grammar used by pinned engines is supported.
// Unknown ranges and prerelease runtimes fail closed rather than guessing.
export function supportsNodeEngine(range, version = process.versions.node) {
  if (typeof range !== 'string' || typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) return false;
  const clauses = range.split('||').map(part => /^(\^|>=)\s*(\d+)\.(\d+)\.(\d+)$/.exec(part.trim()));
  if (!clauses.length || clauses.some(part => !part)) return false;
  const actual = version.split('.').map(Number);
  return clauses.some(([, operator, ...parts]) => {
    const minimum = parts.map(Number);
    const comparison = actual[0] - minimum[0] || actual[1] - minimum[1] || actual[2] - minimum[2];
    return (
      comparison >= 0 &&
      (operator === '>=' ||
        (actual[0] === minimum[0] &&
          (minimum[0] !== 0 || (actual[1] === minimum[1] && (minimum[1] !== 0 || actual[2] === minimum[2])))))
    );
  });
}
export async function noLinks(target) {
  const absolute = path.resolve(target),
    parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error('Unsafe symlink installation path');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

// Record every installed file, including dependency code/metadata and bytecode.
// -B suppresses new pyc writes but does not prevent Python from reading old pyc.
export async function inventory(root) {
  const files = [];
  let total = 0;
  async function visit(directory, prefix = '') {
    for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const name = prefix + item.name,
        filename = path.join(directory, item.name);
      if (item.isSymbolicLink()) throw new Error('Symlink in installation');
      if (item.isDirectory()) {
        await visit(filename, name + '/');
        continue;
      }
      if (!item.isFile()) throw new Error('Non-regular installation file');
      relativeFile(name);
      const info = await lstat(filename);
      if (info.nlink > 1) throw new Error('Hardlinked installation file');
      total += info.size;
      if (files.length >= 100000 || total > 8 * 1024 ** 3) throw new Error('Installation inventory exceeds limit');
      files.push({ path: name, bytes: info.size, sha256: await fileHash(filename) });
    }
  }
  await noLinks(root);
  await visit(root);
  return files;
}

const MAX_ARCHIVE = 128 * 1024 ** 2,
  MAX_EXPANDED = 512 * 1024 ** 2;
function tarNumber(bytes) {
  const text = bytes.toString('ascii').replace(/\0.*$/, '').trim();
  if (!/^[0-7]*$/.test(text)) throw new Error('Unsupported tar number');
  return text ? parseInt(text, 8) : 0;
}
function tarString(bytes) {
  return bytes.toString('utf8').replace(/\0.*$/, '');
}
function tarEntries(bytes) {
  const entries = [];
  let position = 0,
    pendingPath;
  while (position + 512 <= bytes.length) {
    const header = bytes.subarray(position, position + 512);
    position += 512;
    if (header.every(b => b === 0)) break;
    const sum = header.reduce((total, byte, i) => total + (i >= 148 && i < 156 ? 32 : byte), 0);
    if (sum !== tarNumber(header.subarray(148, 156))) throw new Error('Invalid tar checksum');
    const length = tarNumber(header.subarray(124, 136));
    if (position + length > bytes.length) throw new Error('Truncated tar archive');
    const data = bytes.subarray(position, position + length);
    position += Math.ceil(length / 512) * 512;
    const type = String.fromCharCode(header[156]);
    if (type === 'x') {
      let at = 0;
      while (at < data.length) {
        const space = data.indexOf(32, at),
          count = Number(data.subarray(at, space).toString());
        if (space < at || !Number.isSafeInteger(count) || count <= space - at + 1 || at + count > data.length)
          throw new Error('Malformed tar extended header');
        const line = data.subarray(space + 1, at + count - 1).toString('utf8'),
          equals = line.indexOf('=');
        const key = line.slice(0, equals),
          value = line.slice(equals + 1);
        if (key === 'path') pendingPath = relativeFile(value);
        else if (!['mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname', 'comment'].includes(key))
          throw new Error('Unsupported tar extended field');
        at += count;
      }
      continue;
    }
    if (!['0', '\0', '5'].includes(type)) throw new Error('Archive links or special entries are forbidden');
    const prefix = tarString(header.subarray(345, 500));
    const name = pendingPath ?? (prefix ? prefix + '/' : '') + tarString(header.subarray(0, 100));
    pendingPath = undefined;
    entries.push({ name, directory: type === '5', data });
  }
  if (pendingPath) throw new Error('Incomplete tar extended header');
  return entries;
}
function zipEntries(bytes) {
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0 || bytes.length < 22 || end < bytes.length - 65557) throw new Error('Malformed zip archive');
  if (
    bytes.readUInt16LE(end + 4) ||
    bytes.readUInt16LE(end + 6) ||
    bytes.readUInt16LE(end + 8) !== bytes.readUInt16LE(end + 10)
  )
    throw new Error('Multipart zip unsupported');
  const count = bytes.readUInt16LE(end + 10),
    centralSize = bytes.readUInt32LE(end + 12),
    centralStart = bytes.readUInt32LE(end + 16);
  if (count === 65535 || centralStart + centralSize !== end) throw new Error('Unsupported zip directory');
  let pos = centralStart,
    total = 0;
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (pos + 46 > end || bytes.readUInt32LE(pos) !== 0x02014b50) throw new Error('Malformed zip entry');
    const flags = bytes.readUInt16LE(pos + 8),
      method = bytes.readUInt16LE(pos + 10),
      compressed = bytes.readUInt32LE(pos + 20),
      length = bytes.readUInt32LE(pos + 24);
    const nameLength = bytes.readUInt16LE(pos + 28),
      extraLength = bytes.readUInt16LE(pos + 30),
      commentLength = bytes.readUInt16LE(pos + 32);
    const mode = bytes.readUInt32LE(pos + 38) >>> 16,
      local = bytes.readUInt32LE(pos + 42);
    if (flags & 1 || ![0, 8].includes(method) || ![0, 0o100000, 0o040000].includes(mode & 0o170000))
      throw new Error('Archive links or special entries are forbidden');
    if (
      pos + 46 + nameLength + extraLength + commentLength > end ||
      local + 30 > centralStart ||
      bytes.readUInt32LE(local) !== 0x04034b50
    )
      throw new Error('Malformed zip bounds');
    const name = bytes.subarray(pos + 46, pos + 46 + nameLength).toString('utf8');
    const localNameLength = bytes.readUInt16LE(local + 26),
      localExtraLength = bytes.readUInt16LE(local + 28),
      start = local + 30 + localNameLength + localExtraLength;
    if (
      start + compressed > centralStart ||
      bytes.subarray(local + 30, local + 30 + localNameLength).toString('utf8') !== name
    )
      throw new Error('Inconsistent zip entry');
    total += length;
    if (total > MAX_EXPANDED) throw new Error('Expanded archive exceeds limit');
    const payload = bytes.subarray(start, start + compressed);
    const data = method === 0 ? payload : inflateRawSync(payload, { maxOutputLength: Math.max(1, length) });
    if (data.length !== length) throw new Error('Invalid zip size');
    entries.push({ name, directory: name.endsWith('/'), data });
    pos += 46 + nameLength + extraLength + commentLength;
  }
  if (pos !== end) throw new Error('Malformed zip directory size');
  return entries;
}

/** Verify compressed bytes BEFORE parsing. Extract only regular files and
 * directories to a new empty destination, never through links or traversal. */
export async function extractNativeArchive({ archive, destination, format, sha256: expected }) {
  await noLinks(archive);
  await noLinks(destination);
  const stat = await lstat(archive);
  if (!stat.isFile() || stat.size > MAX_ARCHIVE) throw new Error('Invalid archive size');
  const bytes = await readFile(archive);
  if (!/^[a-f0-9]{64}$/.test(expected) || sha256(bytes) !== expected) throw new Error('Archive checksum mismatch');
  const entries =
    format === 'zip'
      ? zipEntries(bytes)
      : format === 'tar.gz'
        ? tarEntries(gunzipSync(bytes, { maxOutputLength: MAX_EXPANDED }))
        : null;
  if (!entries?.length || entries.length > 10000) throw new Error('Unsupported or empty archive');
  const names = new Map();
  let size = 0;
  for (const entry of entries) {
    entry.name = relativeFile(entry.name);
    const key = entry.name.toLowerCase();
    if (names.has(key)) throw new Error('Duplicate archive path');
    names.set(key, entry.directory);
    size += entry.data.length;
    if (size > MAX_EXPANDED || (entry.directory && entry.data.length)) throw new Error('Invalid archive entry size');
  }
  for (const entry of entries) {
    const parts = entry.name.toLowerCase().split('/');
    parts.pop();
    while (parts.length) {
      if (names.get(parts.join('/')) === false) throw new Error('Archive path collides with file');
      parts.pop();
    }
  }
  await mkdir(destination, { mode: 0o700 }); // Must not overwrite an existing tree.
  for (const entry of entries) {
    const target = path.join(destination, entry.name);
    await mkdir(entry.directory ? target : path.dirname(target), { recursive: true, mode: 0o700 });
    await noLinks(target);
    if (!entry.directory) await writeFile(target, entry.data, { flag: 'wx', mode: 0o600 });
  }
}

// Network runs through the existing execute port so offline callers can replace
// the process, not the integrity/extraction boundary. No shell or provider keys.
export const downloadScript = `
const {open}=await import('node:fs/promises');
const [url,target]=process.argv.slice(1);
const response=await fetch(url,{signal:AbortSignal.timeout(120000)});
if(!response.ok || !response.url.startsWith('https://')) throw Error('Download failed');
const file=await open(target,'wx',0o600); let bytes=0;
try { for await(const chunk of response.body){bytes+=chunk.length;if(bytes>134217728)throw Error('Download limit');await file.write(chunk);} } finally {await file.close();}
`;

export const createVenvScript = `
import pathlib,sys,venv
if sys.version_info[:2] != (3,12): raise RuntimeError('Python 3.12 required')
root=pathlib.Path(sys.argv[1])
venv.EnvBuilder(symlinks=False,with_pip=False).create(root)
# CPython adds this optional alias on POSIX, even with copies. Keep managed
# installations link-free; the interpreter uses lib directly.
alias=root/'lib64'
if alias.is_symlink() and alias.resolve()==(root/'lib').resolve(): alias.unlink()
`;

// Metadata and asset checks do not import third-party modules, load .env files,
// start browsers/daemons, or initialize model clients (notably Vibetest MCP2).
export const pythonProbeScript = `
import importlib.metadata as m,json,pathlib,sys
request=json.loads(sys.argv[1]); versions={}; revisions={}
if sys.version_info[:2] != (3,12): raise RuntimeError('Python 3.12 required')
for pin in request:
 d=m.distribution(pin['id']); versions[pin['id']]=d.version
 if d.version!=pin['version']: raise RuntimeError('Wrong package version')
 files=d.files or []
 if not any(str(f).replace('\\\\','/').startswith(pin['module']+'/') and d.locate_file(f).is_file() for f in files): raise RuntimeError('Missing module')
 if pin.get('entryModule'):
  entry=pin['entryModule'].replace('.', '/')
  if not any(str(f).replace('\\\\','/') in (entry+'.py',entry+'/__main__.py') and d.locate_file(f).is_file() for f in files): raise RuntimeError('Missing module entrypoint')
 if pin.get('git'):
  direct=json.loads(d.read_text('direct_url.json') or '{}'); commit=direct.get('vcs_info',{}).get('commit_id')
  if commit!=pin['revision']: raise RuntimeError('Wrong source revision')
  revisions[pin['id']]=commit
 if pin['id']=='jev-ultrafast' and not any(str(f).endswith('snapshot.js') and d.locate_file(f).is_file() for f in files): raise RuntimeError('Missing snapshot asset')
print(json.dumps({'python':'3.12','versions':versions,'revisions':revisions,'assets':True}))
`;
