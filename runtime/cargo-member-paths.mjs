// Resolve Cargo's literal directory lookups to the spelling stored in a snapshot.
// Cargo enumerates wildcard components and compares excludes with the spelling
// emitted by that lookup, which may differ from the directory entry on Windows.
import path from 'node:path';

const windows = path.sep === '\\';
export const nativeManifestPath = raw => (windows && typeof raw === 'string' ? raw.replaceAll('\\', '/') : raw);
export const hasCargoGlob = name => /[*?[]/.test(name);
export const cargoNameKey = name => (windows ? name.toUpperCase() : name);
const join = (parent, name) => (parent ? parent + '/' + name : name);

export class CargoDirectoryNames {
  paths = new Set();
  aliases = new Map();
  observations = new Map();

  constructor(dirs, probeAlias = undefined) {
    this.probeAlias = probeAlias;
    if (windows) for (const dir of dirs) this.add(dir);
  }

  add(dir) {
    if (!windows) return;
    while (dir && !this.paths.has(dir)) {
      this.paths.add(dir);
      const slash = dir.lastIndexOf('/');
      const parent = slash < 0 ? '' : dir.slice(0, slash);
      const name = dir.slice(slash + 1);
      const key = join(parent, cargoNameKey(name));
      this.aliases.set(key, this.aliases.has(key) ? null : name);
      dir = parent;
    }
  }

  matches(parent, actual, requested) {
    if (actual === requested) return true;
    if (!windows || actual.length !== requested.length || cargoNameKey(actual) !== cargoNameKey(requested))
      return false;
    const known = this.aliases.get(join(parent, cargoNameKey(requested)));
    if (known === null || (known !== undefined && known !== actual)) return false;
    if (!this.probeAlias) return true;
    const child = join(parent, actual);
    const key = child + '\0' + requested;
    if (!this.observations.has(key)) this.observations.set(key, this.probeAlias(child, join(parent, requested)));
    return this.observations.get(key);
  }

  resolve(dir) {
    if (!windows || !dir || this.paths.has(dir)) return dir;
    let parent = '';
    for (const part of dir.split('/')) {
      const stored = this.aliases.get(join(parent, cargoNameKey(part)));
      parent = join(parent, stored && this.matches(parent, stored, part) ? stored : part);
    }
    return parent;
  }

  samePath(actual, requested) {
    if (actual === requested) return true;
    if (!windows || cargoNameKey(actual) !== cargoNameKey(requested)) return false;
    const parts = actual.split('/');
    let parent = '';
    for (const [i, part] of requested.split('/').entries()) {
      if (!this.matches(parent, parts[i], part)) return false;
      parent = join(parent, parts[i]);
    }
    return true;
  }
}

function escapeRegexChar(ch) {
  return ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

function compileGlobSegment(segment) {
  let regex = '';
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === '*') {
      regex += '[^/]*';
    } else if (ch === '?') {
      regex += '[^/]';
    } else if (ch === '[') {
      let j = i + 1;
      if (j >= segment.length) return null;
      let cls = '[';
      if (segment[j] === '!') {
        cls += '^';
        j++;
      } else if (segment[j] === '^') {
        cls += '\\^';
        j++;
      }
      if (j < segment.length && segment[j] === ']') {
        cls += '\\]';
        j++;
      }
      let closed = false;
      while (j < segment.length) {
        const inner = segment[j];
        if (inner === ']') {
          closed = true;
          break;
        }
        if (inner === '\\') cls += '\\\\';
        else if (inner === '[') cls += '\\[';
        else cls += inner;
        j++;
      }
      if (!closed) return null;
      cls += ']';
      regex += cls;
      i = j;
    } else if (ch === ']') {
      return null;
    } else {
      regex += escapeRegexChar(ch);
    }
  }
  return regex;
}

/**
 * Compile a Cargo member glob pattern following the Rust `glob` crate semantics:
 * `*` matches 0+ chars in a segment, `?` matches 1 char, `[...]` / `[!...]` character class,
 * and `**` matches 0+ path segments.
 * Returns `null` if the pattern is syntactically invalid.
 * @param {string} pattern
 * @returns {RegExp | null}
 */
function globRegex(pattern, literals = undefined) {
  if (pattern === '') return /^$/;
  const parts = pattern.split('/').filter((part, i, all) => part !== '**' || all[i - 1] !== '**');
  let expr = '^';
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === '**') {
      if (i === parts.length - 1) {
        expr += i === 0 ? '.*' : '(?:/.*)?';
      } else {
        expr += i === 0 ? '(?:.+/)?' : '(?:/.+)?';
      }
      continue;
    }
    if (part.includes('**')) return null;
    const compiled = compileGlobSegment(part);
    if (compiled === null) return null;
    if (i > 0) {
      expr += parts[i - 1] === '**' ? (i - 1 === 0 ? '' : '/') : '/';
    }
    // A recursive walk compares its next pattern with names from read_dir.
    // Only a subsequent literal component goes back to a native path lookup.
    if (literals && parts[i - 1] !== '**' && !hasCargoGlob(part)) {
      literals.push(part);
      expr += `((?i:${compiled}))`;
    } else expr += compiled;
  }
  expr += '$';
  try {
    return new RegExp(expr, literals ? 'd' : '');
  } catch {
    return null;
  }
}

export function compileCargoGlob(pattern) {
  return globRegex(pattern);
}

export function cargoMemberMatcher(pattern, names) {
  const exact = compileCargoGlob(pattern);
  if (!exact) return null;
  const literals = [];
  // Only literal components inherit the directory lookup semantics. Keep the
  // exact spelling of components selected by *, ? or a class for exclusions.
  const native = windows ? globRegex(pattern, literals) : null;
  return dir => {
    if (exact.test(dir)) return dir;
    const match = native?.exec(dir);
    if (!match) return null;
    let spelling = '';
    let offset = 0;
    for (const [i, literal] of literals.entries()) {
      const [start, end] = match.indices[i + 1];
      const parent = start ? dir.slice(0, start - 1) : '';
      if (!names.matches(parent, match[i + 1], literal)) return null;
      spelling += dir.slice(offset, start) + literal;
      offset = end;
    }
    return spelling + dir.slice(offset);
  };
}
