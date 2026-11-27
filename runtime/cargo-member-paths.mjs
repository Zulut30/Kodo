// Resolve Cargo's literal directory lookups to the spelling stored in a snapshot.
// Cargo enumerates wildcard components and compares excludes with the spelling
// emitted by that lookup, which may differ from the directory entry on Windows.
import path from 'node:path';

const windows = path.sep === '\\';
export const nativeManifestPath = raw => (windows && typeof raw === 'string' ? raw.replaceAll('\\', '/') : raw);
export const hasCargoGlob = name => /[*?[]/.test(name);
export const cargoNameKey = name => (windows ? name.toUpperCase() : name);
const maySpell = (actual, requested) =>
  actual === requested ||
  (windows && actual.length === requested.length && cargoNameKey(actual) === cargoNameKey(requested));
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
    if (!maySpell(actual, requested)) return false;
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
      // A negated class or a range such as [.-0] can include the separator.
      regex += '(?!/)' + cls;
      i = j;
    } else if (ch === ']') {
      return null;
    } else {
      regex += escapeRegexChar(ch);
    }
  }
  return regex;
}

function globParts(pattern) {
  return pattern.split('/').filter((part, i, all) => part !== '**' || all[i - 1] !== '**');
}

/**
 * Compile a Cargo member glob pattern following the Rust `glob` crate semantics:
 * `*` matches 0+ chars in a segment, `?` matches 1 char, `[...]` / `[!...]` character class,
 * and `**` matches 0+ path segments.
 * Returns `null` if the pattern is syntactically invalid.
 * @param {string} pattern
 * @returns {RegExp | null}
 */
export function compileCargoGlob(pattern) {
  if (pattern === '') return /^$/;
  const parts = globParts(pattern);
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
    expr += compiled;
  }
  expr += '$';
  try {
    return new RegExp(expr, 'su');
  } catch {
    return null;
  }
}

function memberSteps(parts) {
  return parts.map((part, i) => {
    if (part === '**') return null;
    if (hasCargoGlob(part)) {
      const matcher = new RegExp('^' + compileGlobSegment(part) + '$', 'u');
      return actual => (matcher.test(actual) ? actual : null);
    }
    // The component after ** is compared with entries from read_dir. Later
    // literal components use native lookup and retain the manifest's spelling.
    if (parts[i - 1] === '**') return actual => (part === actual ? actual : null);
    return actual => (maySpell(actual, part) ? part : null);
  });
}

// With at most one ** the directory length determines its entire span.
function singleMemberSpelling(steps, recursive, dir, names) {
  const entries = dir.split('/');
  const span = entries.length - steps.length + 1;
  if (recursive < 0 ? span !== 1 : span < 0) return null;
  const changes = [];
  let depth = 0;
  for (const step of steps) {
    if (step === null) {
      depth += span;
      continue;
    }
    const actual = entries[depth];
    const spelling = step(actual);
    if (spelling === null) return null;
    if (spelling !== actual) changes.push({ depth, parent: entries.slice(0, depth).join('/'), spelling });
    depth++;
  }
  for (const change of changes) {
    if (!names.matches(change.parent, entries[change.depth], change.spelling)) return null;
    entries[change.depth] = change.spelling;
  }
  return changes.length ? entries.join('/') : dir;
}

// Row d contains the pattern positions that can match entries[d..]. A literal
// records its emitted spelling. A globstar can stay put or advance without
// consuming an entry. Dead suffixes never generate alternative paths.
function memberSuffixes(steps, entries, checkAlias = undefined) {
  let hasAlias = false;
  const rows = [];
  let next = new Map([[steps.length, '']]);
  if (steps.at(-1) === null) next.set(steps.length - 1, '');
  rows[entries.length] = next;
  for (let d = entries.length - 1; d >= 0; d--) {
    const row = new Map();
    for (const pos of next.keys()) {
      if (steps[pos] === null) row.set(pos, '');
      const previous = steps[pos - 1];
      if (!previous) continue;
      const spelling = previous(entries[d]);
      if (spelling === null) continue;
      if (spelling !== entries[d]) {
        if (checkAlias && !checkAlias(d, spelling)) continue;
        hasAlias = true;
      }
      row.set(pos - 1, spelling);
      if (steps[pos - 2] === null) row.set(pos - 2, '');
    }
    if (!row.size) return null;
    rows[d] = next = row;
  }
  return next.has(0) ? { rows, hasAlias } : null;
}

function* walkMemberSpellings(steps, dir, names) {
  const entries = dir ? dir.split('/') : [];
  const possible = memberSuffixes(steps, entries);
  if (!possible) return;
  if (!possible.hasAlias) {
    yield dir;
    return;
  }
  // A caller asking for one spelling keeps the exact snapshot path when it is
  // available. Other walks remain available to callers applying exclusions.
  const exact = memberSuffixes(steps, entries, () => false) !== null;
  if (exact) yield dir;
  // Filesystem lookups are only needed for a directory that matches an entire
  // pattern with a case variant. Verify those lookups before enumerating paths.
  let parent = '';
  const parents = entries.map(entry => {
    const current = parent;
    parent = join(parent, entry);
    return current;
  });
  const confirmed = memberSuffixes(steps, entries, (d, spelling) => names.matches(parents[d], entries[d], spelling));
  if (!confirmed?.hasAlias) return;
  const { rows } = confirmed;
  const seen = Array.from({ length: steps.length + 1 }, () => new Set());
  if (exact) seen[steps.length].add(dir);
  const pending = [{ pos: 0, depth: 0, spelling: '' }];
  while (pending.length) {
    const { pos, depth, spelling } = pending.pop();
    if (seen[pos].has(spelling)) continue;
    seen[pos].add(spelling);
    if (pos === steps.length) yield spelling;
    else if (steps[pos] === null) {
      if (rows[depth + 1]?.has(pos)) pending.push({ pos, depth: depth + 1, spelling: join(spelling, entries[depth]) });
      if (rows[depth].has(pos + 1)) pending.push({ pos: pos + 1, depth, spelling });
    } else {
      pending.push({ pos: pos + 1, depth: depth + 1, spelling: join(spelling, rows[depth].get(pos)) });
    }
  }
}

export function cargoMemberMatcher(pattern, names) {
  const exact = compileCargoGlob(pattern);
  if (!exact) return null;
  const parts = globParts(pattern);
  const steps = memberSteps(parts);
  const recursive = parts.indexOf('**');
  if (recursive !== parts.lastIndexOf('**')) {
    const spellings = dir => walkMemberSpellings(steps, dir, names);
    return Object.assign(dir => spellings(dir).next().value ?? null, { spellings });
  }
  const match = dir => {
    if (exact.test(dir)) return dir;
    return windows ? singleMemberSpelling(steps, recursive, dir, names) : null;
  };
  function* spellings(dir) {
    const result = match(dir);
    if (result !== null) yield result;
  }
  return Object.assign(match, { spellings });
}
