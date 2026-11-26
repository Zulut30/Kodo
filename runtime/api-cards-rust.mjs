import { collapse, isIdentChar } from './api-cards-lexical.mjs';

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
  const step = (source.codePointAt(i) ?? 0) > 0xffff ? 2 : 1;
  return source[i + step] === "'" ? i + step + 1 : -1;
}

function maskRust(source) {
  // Use UTF-16 code-unit arrays so mask indices stay aligned with source[i] and .slice() even for non-BMP chars.
  const code = source.split('');
  const noComments = source.split('');
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

function parseRustAttributes(text) {
  const attrs = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] !== '#') break;
    let j = i + 1;
    const inner = text[j] === '!';
    if (inner) j++;
    while (j < text.length && /\s/.test(text[j])) j++;
    if (text[j] !== '[') break;
    const start = j + 1;
    let depth = 0;
    while (j < text.length) {
      if (text[j] === '[') depth++;
      else if (text[j] === ']') {
        depth--;
        if (depth === 0) {
          attrs.push({ inner, body: text.slice(start, j).trim() });
          j++;
          break;
        }
      }
      j++;
    }
    i = j;
  }
  return { offset: i, attrs };
}

function stripNotGroups(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('not', i) && !isIdentChar(text[i - 1]) && !isIdentChar(text[i + 3])) {
      let j = i + 3;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '(') {
        let depth = 0;
        while (j < text.length) {
          if (text[j] === '(') depth++;
          else if (text[j] === ')') {
            depth--;
            if (depth === 0) {
              j++;
              break;
            }
          }
          j++;
        }
        i = j;
        continue;
      }
    }
    out += text[i++];
  }
  return out;
}

function hasCfgTestAttr(attrs) {
  return attrs.some(({ body }) => {
    const match = /^cfg\s*\(([\s\S]*)\)$/.exec(body);
    return Boolean(match && /\btest\b/.test(stripNotGroups(match[1])));
  });
}

function hasMacroExportAttr(attrs) {
  return attrs.some(({ inner, body }) => !inner && /^macro_export\b/.test(body));
}

const RUST_PUB_TOP =
  /^pub\s+(?:(?:unsafe|async|const|extern(?:\s+"[^"]*")?)\s+)*(?:struct|enum|trait|fn|type|const|static|mod|use)\b/;
const RUST_PUB_IMPL = /^pub\s+(?:(?:unsafe|async|const|extern(?:\s+"[^"]*")?)\s+)*(?:fn|const|type)\b/;
const RUST_TRAIT_ITEM = /^(?:(?:unsafe|async|const|extern(?:\s+"[^"]*")?)\s+)*(?:fn|const|type)\b/;
const RUST_IMPL_HEAD = /^(?:unsafe\s+)?impl\b/;
const RUST_MACRO_RULES = /^macro_rules!\s+([A-Za-z_][A-Za-z0-9_]*)/;

function cleanRustSignature(raw, endedWithBrace) {
  let sig = collapse(raw);
  if (endedWithBrace) sig = sig.replace(/,\s*$/, '');
  return sig.replace(/;\s*$/, '').trim();
}

function activeModPath(frames) {
  const parts = [];
  for (const frame of frames) if (frame.kind === 'mod') parts.push(frame.name);
  return parts.join('::');
}

function qualifyMod(frames, sig) {
  const modPath = activeModPath(frames);
  return modPath ? `${modPath} :: ${sig}` : sig;
}

function isRustUseStatement(code, stmtStart) {
  const { offset } = parseRustAttributes(code.slice(stmtStart));
  const rest = code.slice(stmtStart + offset).trimStart();
  return /^pub\s+use\b/.test(rest);
}

function classifyRustBlock(frames, trimmedCode, rawHeader, attrs) {
  if (hasCfgTestAttr(attrs)) return { kind: 'skip' };
  const parent = frames.at(-1);
  const inPrivateMod = frames.some(f => f.kind === 'private_mod');
  if (parent && parent.kind !== 'mod' && parent.kind !== 'private_mod') {
    if (parent.kind === 'trait' && RUST_TRAIT_ITEM.test(trimmedCode)) {
      const sig = cleanRustSignature(rawHeader, true);
      if (sig) return { kind: 'other', emit: `${parent.label} :: ${sig}` };
    }
    if (parent.kind === 'impl' && !/^pub\s*\(/.test(trimmedCode) && RUST_PUB_IMPL.test(trimmedCode)) {
      const sig = cleanRustSignature(rawHeader, true);
      if (sig) return { kind: 'other', emit: `${parent.label} :: ${sig}` };
    }
    return { kind: 'other' };
  }
  const macroMatch = RUST_MACRO_RULES.exec(trimmedCode);
  if (macroMatch) {
    // #[macro_export] always exports to crate root regardless of enclosing module visibility.
    return hasMacroExportAttr(attrs) ? { kind: 'skip', emit: `crate::${macroMatch[1]}!` } : { kind: 'skip' };
  }
  if (/^(?:pub(?:\s*\([^)]*\))?\s+)?mod\b/.test(trimmedCode)) {
    if (inPrivateMod || !/^pub\s+mod\b/.test(trimmedCode)) return { kind: 'private_mod' };
    const modMatch = /^pub\s+mod\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(trimmedCode);
    const sig = cleanRustSignature(rawHeader, true);
    return modMatch ? { kind: 'mod', name: modMatch[1], emit: qualifyMod(frames, sig) } : { kind: 'private_mod' };
  }
  if (inPrivateMod) return { kind: 'skip' };
  if (RUST_IMPL_HEAD.test(trimmedCode)) {
    const implHead = cleanRustSignature(rawHeader, true);
    return { kind: 'impl', label: qualifyMod(frames, implHead) };
  }
  if (!/^pub\s*\(/.test(trimmedCode) && RUST_PUB_TOP.test(trimmedCode)) {
    const sig = cleanRustSignature(rawHeader, true);
    const qualified = qualifyMod(frames, sig);
    if (/^pub\s+(?:unsafe\s+)?trait\b/.test(trimmedCode)) return { kind: 'trait', label: qualified, emit: qualified };
    return { kind: 'other', emit: qualified };
  }
  return { kind: 'skip' };
}

function inspectRustSemicolon(frames, trimmedCode, rawHeader, attrs) {
  if (hasCfgTestAttr(attrs)) return null;
  const parent = frames.at(-1);
  if (parent && parent.kind !== 'mod' && parent.kind !== 'private_mod') {
    if (parent.kind === 'trait' && RUST_TRAIT_ITEM.test(trimmedCode)) {
      const sig = cleanRustSignature(rawHeader, false);
      return sig ? `${parent.label} :: ${sig}` : null;
    }
    if (parent.kind === 'impl' && !/^pub\s*\(/.test(trimmedCode) && RUST_PUB_IMPL.test(trimmedCode)) {
      const sig = cleanRustSignature(rawHeader, false);
      return sig ? `${parent.label} :: ${sig}` : null;
    }
    return null;
  }
  const macroMatch = RUST_MACRO_RULES.exec(trimmedCode);
  if (macroMatch) {
    return hasMacroExportAttr(attrs) ? `crate::${macroMatch[1]}!` : null;
  }
  if (frames.some(f => f.kind === 'private_mod')) return null;
  if (!/^pub\s*\(/.test(trimmedCode) && RUST_PUB_TOP.test(trimmedCode)) {
    const sig = cleanRustSignature(rawHeader, false);
    return sig ? qualifyMod(frames, sig) : null;
  }
  return null;
}

/**
 * Extract public Rust items (`pub struct/enum/trait/fn/type/const/static/mod/use`,
 * `pub trait` methods, `pub mod` nested items with module paths, `#[macro_export] macro_rules!`,
 * and inherent `impl` `pub fn/const/type` methods) as single-line signatures without bodies.
 * Excludes non-pub items, restricted visibility (`pub(crate)`, `pub(super)`, `pub(in ...)`),
 * and anything guarded by `#[cfg(test)]`.
 * @param {string} source
 * @returns {string[]}
 */
export function extractRustPublicApi(source) {
  if (typeof source !== 'string' || !source) return [];
  const { code, noComments } = maskRust(source);
  const signatures = [];
  const frames = [];
  let paren = 0,
    bracket = 0,
    useBrace = 0,
    stmtStart = 0;

  const skipped = () => frames.some(f => f.kind === 'skip' || f.kind === 'other');

  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '(') paren++;
    else if (ch === ')' && paren > 0) paren--;
    else if (ch === '[') bracket++;
    else if (ch === ']' && bracket > 0) bracket--;
    else if (ch === '{' && paren === 0 && bracket === 0) {
      if (useBrace > 0 || (!skipped() && isRustUseStatement(code, stmtStart))) {
        useBrace++;
        continue;
      }
      if (skipped()) {
        frames.push({ kind: 'other' });
      } else {
        const sliceCode = code.slice(stmtStart, i);
        const { offset, attrs } = parseRustAttributes(sliceCode);
        const trimmedCode = sliceCode.slice(offset).trim();
        const rawHeader = noComments.slice(stmtStart + offset, i);
        const info = trimmedCode ? classifyRustBlock(frames, trimmedCode, rawHeader, attrs) : { kind: 'other' };
        if (info.emit) signatures.push(info.emit);
        frames.push(info);
      }
      stmtStart = i + 1;
    } else if (ch === '}' && paren === 0 && bracket === 0) {
      if (useBrace > 0) {
        useBrace--;
        continue;
      }
      if (frames.length > 0) frames.pop();
      stmtStart = i + 1;
    } else if (ch === ';' && paren === 0 && bracket === 0 && useBrace === 0) {
      if (!skipped()) {
        const sliceCode = code.slice(stmtStart, i);
        const { offset, attrs } = parseRustAttributes(sliceCode);
        const trimmedCode = sliceCode.slice(offset).trim();
        const rawHeader = noComments.slice(stmtStart + offset, i);
        if (trimmedCode) {
          const emitted = inspectRustSemicolon(frames, trimmedCode, rawHeader, attrs);
          if (emitted) signatures.push(emitted);
        }
      }
      stmtStart = i + 1;
    }
  }
  return signatures;
}
