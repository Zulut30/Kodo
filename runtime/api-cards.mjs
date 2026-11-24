/**
 * Deterministic public API card extractor at a fixed Git commit (`baseSha`).
 * Reads strictly from Git objects (`git ls-tree`, `git show <sha>:<path>`),
 * never from the working tree, with zero model or network calls.
 */
import { execute } from './command.mjs';
import { ownsPath } from './contracts.mjs';
import { redact, workerEnvironment } from './security.mjs';

export const DEFAULT_API_CARD_MAX_BYTES = 12 * 1024;
const MAX_SOURCE_BYTES = 512 * 1024;
const READ_BATCH = 8;
const IGNORED_DIRS = /(?:^|\/)(?:node_modules|target|dist|build|coverage|\.git)(?:\/|$)/;
const RUST_EXT = /\.rs$/;
const JS_EXT = /\.[cm]?jsx?$/;
const TS_EXT = /\.[cm]?tsx?$/;
const INVARIANT_FILES = [
  '.kodo/blueprint/invariants.md',
  '.kodo/blueprint/INVARIANTS.md',
  'INVARIANTS.md',
  'docs/INVARIANTS.md',
  'docs/invariants.md',
];
const PROJECT_MD = '.kodo/blueprint/PROJECT.md';
const INVARIANT_HEADING = /^(?:инвариант(?:ы)?|invariants?)(?:[\s:(—–-]|$)/iu;

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byteLength = text => Buffer.byteLength(text, 'utf8');
const collapse = text => text.replace(/\s+/g, ' ').trim();
const isIdentChar = ch => ch !== undefined && /[A-Za-z0-9_$]/.test(ch);

function detectLanguage(filePath) {
  if (RUST_EXT.test(filePath)) return 'rust';
  if (TS_EXT.test(filePath)) return 'ts';
  if (JS_EXT.test(filePath)) return 'js';
  return null;
}

// ---- Rust public API extractor ----------------------------------------------

function scanRustRawString(source, start) {
  let i = start;
  if (source[i] === 'b' && source[i + 1] === 'r') i += 2;
  else if (source[i] === 'r') i += 1;
  else return -1;
  let hashes = 0;
  while (source[i] === '#') {
    hashes++;
    i++;
  }
  if (source[i] !== '"') return -1;
  i++;
  const close = '"' + '#'.repeat(hashes);
  const found = source.indexOf(close, i);
  return found === -1 ? source.length : found + close.length;
}

function scanRustChar(source, start) {
  let i = start + 1;
  if (i >= source.length || source[i] === '\n' || source[i] === '\r') return -1;
  if (source[i] === '\\') {
    i += 2;
    while (i < source.length && source[i] !== "'" && source[i] !== '\n' && i - start < 14) i++;
    return source[i] === "'" ? i + 1 : -1;
  }
  return source[i + 1] === "'" ? i + 2 : -1;
}

function maskRust(source) {
  const code = Array.from(source);
  const noComments = Array.from(source);
  const blank = (arr, from, to) => {
    for (let k = from; k < to; k++) if (arr[k] !== '\n') arr[k] = ' ';
  };
  let i = 0;
  while (i < source.length) {
    const ch = source[i],
      next = source[i + 1];
    if (ch === '/' && next === '/') {
      let j = i + 2;
      while (j < source.length && source[j] !== '\n') j++;
      blank(code, i, j);
      blank(noComments, i, j);
      i = j;
      continue;
    }
    if (ch === '/' && next === '*') {
      let j = i + 2,
        depth = 1;
      while (j < source.length && depth > 0) {
        if (source[j] === '/' && source[j + 1] === '*') {
          depth++;
          j += 2;
        } else if (source[j] === '*' && source[j + 1] === '/') {
          depth--;
          j += 2;
        } else j++;
      }
      blank(code, i, j);
      blank(noComments, i, j);
      i = j;
      continue;
    }
    if ((ch === 'r' || (ch === 'b' && next === 'r')) && !isIdentChar(source[i - 1])) {
      const end = scanRustRawString(source, i);
      if (end !== -1) {
        blank(code, i, end);
        i = end;
        continue;
      }
    }
    if (ch === '"' || (ch === 'b' && next === '"' && !isIdentChar(source[i - 1]))) {
      let j = ch === 'b' ? i + 2 : i + 1;
      while (j < source.length) {
        if (source[j] === '\\') j += 2;
        else if (source[j] === '"') {
          j++;
          break;
        } else j++;
      }
      blank(code, i, j);
      i = j;
      continue;
    }
    if (ch === "'") {
      const end = scanRustChar(source, i);
      if (end !== -1) {
        blank(code, i, end);
        i = end;
        continue;
      }
    }
    i++;
  }
  return { code: code.join(''), noComments: noComments.join('') };
}

function skipRustAttributes(text) {
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] !== '#') break;
    let j = i + 1;
    if (text[j] === '!') j++;
    while (j < text.length && /\s/.test(text[j])) j++;
    if (text[j] !== '[') break;
    let depth = 0;
    while (j < text.length) {
      if (text[j] === '[') depth++;
      else if (text[j] === ']') {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      }
      j++;
    }
    i = j;
  }
  return i;
}

const RUST_PUB_TOP =
  /^pub\s+(?:(?:unsafe|async|const|extern(?:\s+"[^"]*")?)\s+)*(?:struct|enum|trait|fn|type|const|static|mod|use)\b/;
const RUST_PUB_IMPL = /^pub\s+(?:(?:unsafe|async|const|extern(?:\s+"[^"]*")?)\s+)*(?:fn|const|type)\b/;
const RUST_IMPL_HEAD = /^(?:unsafe\s+)?impl\b/;

function cleanRustSignature(raw, endedWithBrace) {
  let sig = collapse(raw);
  if (endedWithBrace) sig = sig.replace(/,\s*$/, '');
  return sig.replace(/;\s*$/, '').trim();
}

/**
 * Extract top-level public Rust items (`pub struct/enum/trait/fn/type/const/static/mod/use`)
 * and inherent `impl` `pub fn/const/type` methods as single-line signatures without bodies.
 * Excludes non-pub items and restricted visibility (`pub(crate)`, `pub(super)`, `pub(in ...)`).
 * @param {string} source
 * @returns {string[]}
 */
export function extractRustPublicApi(source) {
  if (typeof source !== 'string' || !source) return [];
  const { code, noComments } = maskRust(source);
  const signatures = [];
  let depth = 0,
    paren = 0,
    bracket = 0,
    stmtStart = 0,
    activeImpl = null;

  const inspect = (end, endedWithBrace) => {
    if (depth !== 0 && !(depth === 1 && activeImpl)) return;
    const sliceCode = code.slice(stmtStart, end);
    const offset = skipRustAttributes(sliceCode);
    const trimmedCode = sliceCode.slice(offset).trim();
    if (!trimmedCode) return;
    const rawHeader = noComments.slice(stmtStart + offset, end);
    if (depth === 0) {
      if (endedWithBrace && RUST_IMPL_HEAD.test(trimmedCode)) {
        activeImpl = cleanRustSignature(rawHeader, true);
        return;
      }
      if (!/^pub\s*\(/.test(trimmedCode) && RUST_PUB_TOP.test(trimmedCode)) {
        const sig = cleanRustSignature(rawHeader, endedWithBrace);
        if (sig) signatures.push(sig);
      }
    } else if (depth === 1 && activeImpl && !/^pub\s*\(/.test(trimmedCode) && RUST_PUB_IMPL.test(trimmedCode)) {
      const sig = cleanRustSignature(rawHeader, endedWithBrace);
      if (sig) signatures.push(`${activeImpl} :: ${sig}`);
    }
  };

  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '(') paren++;
    else if (ch === ')' && paren > 0) paren--;
    else if (ch === '[') bracket++;
    else if (ch === ']' && bracket > 0) bracket--;
    else if (ch === '{' && paren === 0 && bracket === 0) {
      inspect(i, true);
      depth++;
      stmtStart = i + 1;
    } else if (ch === '}' && paren === 0 && bracket === 0) {
      if (depth > 0) depth--;
      if (depth === 0) activeImpl = null;
      stmtStart = i + 1;
    } else if (ch === ';' && paren === 0 && bracket === 0 && (depth === 0 || (depth === 1 && activeImpl))) {
      inspect(i, false);
      stmtStart = i + 1;
    }
  }
  return signatures;
}

// ---- JS/TS public API extractor ---------------------------------------------

function maskJsTs(source) {
  const code = Array.from(source);
  const noComments = Array.from(source);
  const blank = (arr, from, to) => {
    for (let k = from; k < to; k++) if (arr[k] !== '\n') arr[k] = ' ';
  };
  let i = 0;
  while (i < source.length) {
    const ch = source[i],
      next = source[i + 1];
    if (ch === '/' && next === '/') {
      let j = i + 2;
      while (j < source.length && source[j] !== '\n') j++;
      blank(code, i, j);
      blank(noComments, i, j);
      i = j;
      continue;
    }
    if (ch === '/' && next === '*') {
      let j = i + 2;
      while (j < source.length && !(source[j] === '*' && source[j + 1] === '/')) j++;
      j = Math.min(source.length, j + 2);
      blank(code, i, j);
      blank(noComments, i, j);
      i = j;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === '\\') j += 2;
        else if (source[j] === ch) {
          j++;
          break;
        } else j++;
      }
      blank(code, i, j);
      i = j;
      continue;
    }
    if (ch === '`') {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === '\\') j += 2;
        else if (source[j] === '$' && source[j + 1] === '{') {
          j += 2;
          let inner = 1;
          while (j < source.length && inner > 0) {
            if (source[j] === '\\') j += 2;
            else if (source[j] === '{') {
              inner++;
              j++;
            } else if (source[j] === '}') {
              inner--;
              j++;
            } else j++;
          }
        } else if (source[j] === '`') {
          j++;
          break;
        } else j++;
      }
      blank(code, i, j);
      i = j;
      continue;
    }
    i++;
  }
  return { code: code.join(''), noComments: noComments.join('') };
}

function findReexportEnd(code, start) {
  let brace = 0,
    i = start;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '{') brace++;
    else if (ch === '}' && brace > 0) brace--;
    else if (brace === 0 && (ch === ';' || (ch === '\n' && /\bfrom\b|\}/.test(code.slice(start, i))))) break;
    i++;
  }
  return { sigEnd: i, skipTo: i };
}

function findNamedDeclEnd(code, start) {
  let paren = 0,
    bracket = 0,
    angle = 0,
    i = start;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '(') paren++;
    else if (ch === ')' && paren > 0) paren--;
    else if (ch === '[') bracket++;
    else if (ch === ']' && bracket > 0) bracket--;
    else if (ch === '<' && paren === 0) angle++;
    else if (ch === '>' && angle > 0 && code[i - 1] !== '=') angle--;
    else if (paren === 0 && bracket === 0 && angle === 0 && (ch === '{' || ch === ';')) return { sigEnd: i, skipTo: i };
    i++;
  }
  return { sigEnd: code.length, skipTo: code.length };
}

function findTypeAliasEnd(code, start) {
  let paren = 0,
    bracket = 0,
    brace = 0,
    i = start;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '(') paren++;
    else if (ch === ')' && paren > 0) paren--;
    else if (ch === '[') bracket++;
    else if (ch === ']' && bracket > 0) bracket--;
    else if (ch === '{') {
      if (paren === 0 && bracket === 0 && brace === 0) return { sigEnd: i, skipTo: i };
      brace++;
    } else if (ch === '}' && brace > 0) brace--;
    else if (paren === 0 && bracket === 0 && brace === 0 && ch === ';') return { sigEnd: i, skipTo: i };
    i++;
  }
  return { sigEnd: code.length, skipTo: code.length };
}

function findConstExportEnd(code, noComments, start) {
  let paren = 0,
    bracket = 0,
    brace = 0,
    eqPos = -1,
    i = start;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '(') paren++;
    else if (ch === ')' && paren > 0) paren--;
    else if (ch === '[') bracket++;
    else if (ch === ']' && bracket > 0) bracket--;
    else if (ch === '{') {
      if (paren === 0 && bracket === 0 && brace === 0) return { sigEnd: eqPos !== -1 ? eqPos : i, skipTo: i };
      brace++;
    } else if (ch === '}' && brace > 0) brace--;
    else if (paren === 0 && bracket === 0 && brace === 0) {
      if (ch === '=' && code[i + 1] === '>') return { sigEnd: i + 2, skipTo: i + 2 };
      if (ch === '=' && code[i - 1] !== '=' && code[i + 1] !== '=' && eqPos === -1) eqPos = i;
      if (ch === ';') {
        const rhs = eqPos !== -1 ? noComments.slice(eqPos + 1, i).trim() : '';
        const keepValue = rhs && !rhs.includes('\n') && rhs.length <= 80 && !/[{[]/.test(rhs);
        return { sigEnd: eqPos !== -1 && !keepValue ? eqPos : i, skipTo: i };
      }
    }
    i++;
  }
  return { sigEnd: code.length, skipTo: code.length };
}

function findExportHeaderEnd(code, noComments, start) {
  const rest = code.slice(start);
  if (/^export\s+(?:type\s+)?(?:\{|\*)/.test(rest)) return findReexportEnd(code, start);
  if (
    /^export\s+(?:default\s+)?(?:declare\s+)?(?:(?:abstract|async|const)\s+)?(?:function|class|interface|enum)\b/.test(
      rest,
    )
  )
    return findNamedDeclEnd(code, start);
  if (/^export\s+(?:declare\s+)?type\b/.test(rest)) return findTypeAliasEnd(code, start);
  return findConstExportEnd(code, noComments, start);
}

/**
 * Extract top-level `export` declarations (functions, classes, constants, types, interfaces,
 * enums, re-exports) from JS/TS source as single-line signatures without bodies.
 * @param {string} source
 * @returns {string[]}
 */
export function extractJsTsPublicApi(source) {
  if (typeof source !== 'string' || !source) return [];
  const { code, noComments } = maskJsTs(source);
  const signatures = [];
  let brace = 0,
    paren = 0,
    bracket = 0;

  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '{') {
      brace++;
      continue;
    }
    if (ch === '}') {
      if (brace > 0) brace--;
      continue;
    }
    if (ch === '(') {
      paren++;
      continue;
    }
    if (ch === ')') {
      if (paren > 0) paren--;
      continue;
    }
    if (ch === '[') {
      bracket++;
      continue;
    }
    if (ch === ']') {
      if (bracket > 0) bracket--;
      continue;
    }
    if (brace !== 0 || paren !== 0 || bracket !== 0) continue;
    if (
      ch === 'e' &&
      code.startsWith('export', i) &&
      !isIdentChar(code[i - 1]) &&
      code[i - 1] !== '.' &&
      !/[A-Za-z0-9_$]/.test(code[i + 6] ?? '')
    ) {
      const { sigEnd, skipTo } = findExportHeaderEnd(code, noComments, i);
      const sig = collapse(noComments.slice(i, sigEnd)).replace(/;\s*$/, '').trim();
      if (sig) signatures.push(sig);
      i = Math.max(i, skipTo - 1);
    }
  }
  return signatures;
}

// ---- Git tree & invariants --------------------------------------------------

async function listTreeBlobs(cwd, baseSha) {
  const result = await execute('git', ['ls-tree', '-r', '-z', '--full-tree', baseSha], {
    cwd,
    env: workerEnvironment(),
    rawOutput: true,
    timeoutMs: 15000,
  });
  const blobs = [];
  for (const row of result.stdout.split('\0')) {
    if (!row) continue;
    const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(row);
    if (!match) continue;
    const [, mode, type, oid, filePath] = match;
    if (type === 'blob' && /^100(?:644|755)$/.test(mode)) blobs.push({ path: filePath, oid });
  }
  return blobs;
}

async function readBlobAtCommit(cwd, baseSha, filePath) {
  const result = await execute('git', ['show', `${baseSha}:${filePath}`], {
    cwd,
    env: workerEnvironment(),
    rawOutput: true,
    allowFailure: true,
    timeoutMs: 15000,
  });
  if (result.code !== 0) return null;
  if (byteLength(result.stdout) > MAX_SOURCE_BYTES) return null;
  return result.stdout;
}

function extractInvariantLines(markdown, sectionOnly) {
  const lines = String(markdown).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let inSection = !sectionOnly,
    sectionLevel = 0,
    fence = null;
  for (const line of lines) {
    const opener = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (opener && opener[1][0] === fence[0] && opener[1].length >= fence.length) fence = null;
      continue;
    }
    if (opener) {
      fence = opener[1];
      continue;
    }
    const atx = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*$/.exec(line);
    if (atx) {
      const level = atx[1].length;
      const title = atx[2]
        .replace(/[ \t]+#+[ \t]*$/, '')
        .replace(/[*_`~]/g, '')
        .trim();
      if (sectionOnly) {
        if (!inSection && INVARIANT_HEADING.test(title)) {
          inSection = true;
          sectionLevel = level;
        } else if (inSection && level <= sectionLevel) {
          inSection = false;
        }
      }
      continue;
    }
    if (!inSection) continue;
    const cleaned = line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim();
    if (cleaned) out.push(cleaned);
  }
  return out;
}

function resolveDependencyScopes({ task, tasks, paths }) {
  if (Array.isArray(paths) && paths.length) return paths.filter(p => typeof p === 'string' && p.trim());
  if (!task || !Array.isArray(tasks)) return [];
  const byId = new Map(tasks.map(row => [row.id, row]));
  const scopes = [];
  const seen = new Set();
  const addScope = scope => {
    if (typeof scope === 'string' && scope.trim() && !seen.has(scope)) {
      seen.add(scope);
      scopes.push(scope);
    }
  };
  for (const depId of task.dependsOn ?? []) {
    const dep = byId.get(depId);
    if (!dep) continue;
    for (const scope of dep.writePaths ?? []) addScope(scope);
  }
  // Also resolve modules explicitly named in `interfaceRefs` (e.g. `interfaces/<mod>.md`).
  for (const ref of task.interfaceRefs ?? []) {
    const raw = typeof ref?.path === 'string' ? ref.path.replaceAll('\\', '/') : '';
    const match = /(?:^|\/)interfaces\/([a-z][a-z0-9-]{0,47})\.md$/.exec(raw);
    if (!match) continue;
    const mod = match[1];
    for (const other of tasks) {
      if (other.id === task.id) continue;
      if (other.epicId === mod || other.id === mod || other.id === `${mod}-module`) {
        for (const scope of other.writePaths ?? []) addScope(scope);
      }
    }
  }
  return scopes;
}

// ---- Deterministic rendering & truncation -----------------------------------

function sliceUtf8(text, maxBytes) {
  if (byteLength(text) <= maxBytes) return text;
  const chars = Array.from(text);
  let low = 0,
    high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (byteLength(chars.slice(0, mid).join('')) <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return chars.slice(0, low).join('');
}

function renderCardText({ baseSha, invariants, modules, truncated, omitted, maxBytes }) {
  const lines = [`API cards (base ${baseSha.slice(0, 12)}):`];
  if (invariants.length) {
    lines.push('Invariants:');
    for (const item of invariants) lines.push(`- ${item}`);
  }
  if (!modules.length) {
    lines.push('(no dependency public exports)');
  } else {
    for (const mod of modules) {
      lines.push(`### ${mod.path} (${mod.language})`);
      for (const sig of mod.signatures) lines.push(`- ${sig}`);
    }
  }
  if (truncated) {
    const parts = [];
    if (omitted.files > 0) parts.push(`${omitted.files} files`);
    if (omitted.signatures > 0) parts.push(`${omitted.signatures} signatures`);
    if (omitted.invariants > 0) parts.push(`${omitted.invariants} invariants`);
    lines.push(`[truncated: omitted ${parts.join(', ') || 'content'}; limit ${maxBytes} bytes]`);
  }
  return lines.join('\n');
}

function packApiCard({ baseSha, invariants, modules, maxBytes }) {
  const fullText = renderCardText({
    baseSha,
    invariants,
    modules,
    truncated: false,
    omitted: { files: 0, signatures: 0, invariants: 0 },
    maxBytes,
  });
  const originalBytes = byteLength(fullText);
  if (originalBytes <= maxBytes) {
    return {
      text: fullText,
      bytes: originalBytes,
      originalBytes,
      truncated: false,
      omitted: { files: 0, signatures: 0, invariants: 0 },
      invariants,
      modules,
    };
  }

  const totalSigs = modules.reduce((sum, m) => sum + m.signatures.length, 0);
  const keptInvariants = [];
  const keptModules = [];
  let keptSigs = 0;

  const fits = (inv, mods, sigCount) => {
    const omitted = {
      files: modules.length - mods.length,
      signatures: totalSigs - sigCount,
      invariants: invariants.length - inv.length,
    };
    const candidate = renderCardText({ baseSha, invariants: inv, modules: mods, truncated: true, omitted, maxBytes });
    return byteLength(candidate) <= maxBytes ? { candidate, omitted } : null;
  };

  for (const item of invariants) {
    const next = [...keptInvariants, item];
    if (fits(next, keptModules, keptSigs)) keptInvariants.push(item);
    else break;
  }

  for (const mod of modules) {
    const partial = { path: mod.path, language: mod.language, signatures: [] };
    let addedAny = false;
    for (const sig of mod.signatures) {
      const trialMod = { ...partial, signatures: [...partial.signatures, sig] };
      if (fits(keptInvariants, [...keptModules, trialMod], keptSigs + 1)) {
        partial.signatures.push(sig);
        keptSigs++;
        addedAny = true;
      } else break;
    }
    if (addedAny) {
      if (partial.signatures.length < mod.signatures.length) {
        partial.omittedSignatures = mod.signatures.length - partial.signatures.length;
      }
      keptModules.push(partial);
      if (partial.signatures.length < mod.signatures.length) break;
    } else break;
  }

  const omitted = {
    files: modules.length - keptModules.length,
    signatures: totalSigs - keptSigs,
    invariants: invariants.length - keptInvariants.length,
  };
  let text = renderCardText({
    baseSha,
    invariants: keptInvariants,
    modules: keptModules,
    truncated: true,
    omitted,
    maxBytes,
  });
  if (byteLength(text) > maxBytes) text = sliceUtf8(text, maxBytes);
  return {
    text,
    bytes: byteLength(text),
    originalBytes,
    truncated: true,
    omitted,
    invariants: keptInvariants,
    modules: keptModules,
  };
}

/**
 * Build a deterministic public API card for a task's dependencies at `baseSha`.
 * Reads files strictly from Git (`baseSha`), never from the working directory.
 *
 * @param {{
 *   cwd: string,
 *   baseSha: string,
 *   task?: any,
 *   tasks?: any[],
 *   paths?: string[],
 *   constraints?: string[],
 *   invariants?: string[],
 *   maxBytes?: number,
 *   secrets?: Record<string, any>,
 * }} input
 */
export async function buildApiCards({
  cwd,
  baseSha,
  task,
  tasks,
  paths,
  constraints = [],
  invariants = [],
  maxBytes = DEFAULT_API_CARD_MAX_BYTES,
  secrets = {},
}) {
  if (typeof cwd !== 'string' || !cwd)
    throw Object.assign(new Error('API cards require cwd'), { code: 'api_cards_invalid' });
  if (typeof baseSha !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseSha))
    throw Object.assign(new Error('API cards require a valid baseSha'), { code: 'api_cards_invalid' });
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 64)
    throw Object.assign(new Error('API cards maxBytes must be a safe integer >= 64'), { code: 'api_cards_invalid' });

  const blobs = await listTreeBlobs(cwd, baseSha);
  const blobSet = new Set(blobs.map(b => b.path));

  // Gather blueprint invariants from `baseSha` + caller constraints/invariants.
  const collectedInvariants = [];
  const seenInv = new Set();
  const addInvariant = line => {
    const clean = redact(String(line ?? '').trim(), secrets);
    if (clean && !seenInv.has(clean)) {
      seenInv.add(clean);
      collectedInvariants.push(clean);
    }
  };
  for (const invPath of INVARIANT_FILES) {
    if (!blobSet.has(invPath)) continue;
    const text = await readBlobAtCommit(cwd, baseSha, invPath);
    if (text) for (const line of extractInvariantLines(text, false)) addInvariant(line);
  }
  if (blobSet.has(PROJECT_MD)) {
    const text = await readBlobAtCommit(cwd, baseSha, PROJECT_MD);
    if (text) for (const line of extractInvariantLines(text, true)) addInvariant(line);
  }
  for (const item of [...invariants, ...constraints]) addInvariant(item);

  // Resolve dependency source files from `baseSha`.
  const scopes = resolveDependencyScopes({ task, tasks, paths });
  const targets = scopes.length
    ? blobs
        .map(b => b.path)
        .filter(
          filePath => !IGNORED_DIRS.test(filePath) && detectLanguage(filePath) !== null && ownsPath(scopes, filePath),
        )
        .sort(compare)
    : [];

  const modules = [];
  for (let i = 0; i < targets.length; i += READ_BATCH) {
    const batch = targets.slice(i, i + READ_BATCH);
    const contents = await Promise.all(batch.map(filePath => readBlobAtCommit(cwd, baseSha, filePath)));
    for (let j = 0; j < batch.length; j++) {
      const filePath = batch[j];
      const source = contents[j];
      if (!source) continue;
      const language = detectLanguage(filePath);
      const rawSigs = language === 'rust' ? extractRustPublicApi(source) : extractJsTsPublicApi(source);
      const signatures = rawSigs.map(sig => redact(sig, secrets)).filter(Boolean);
      if (signatures.length) modules.push({ path: filePath, language, signatures });
    }
  }

  const packed = packApiCard({ baseSha, invariants: collectedInvariants, modules, maxBytes });
  return {
    schemaVersion: 1,
    kind: 'api-cards',
    baseSha,
    maxBytes,
    ...packed,
  };
}
