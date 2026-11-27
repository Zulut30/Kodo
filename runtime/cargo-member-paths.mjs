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
const parentDir = dir => dir.slice(0, Math.max(0, dir.lastIndexOf('/')));

export class CargoDirectoryNames {
  paths = new Set();
  aliases = new Map();
  observations = new Map();
  children = null;

  constructor(dirs, probeAlias = undefined) {
    this.probeAlias = probeAlias;
    for (const dir of dirs) this.add(dir);
  }

  add(dir) {
    while (dir && !this.paths.has(dir)) {
      this.paths.add(dir);
      this.children = null;
      const slash = dir.lastIndexOf('/');
      const parent = slash < 0 ? '' : dir.slice(0, slash);
      const name = dir.slice(slash + 1);
      if (windows) {
        const key = join(parent, cargoNameKey(name));
        this.aliases.set(key, this.aliases.has(key) ? null : name);
      }
      dir = parent;
    }
  }

  childDirs(parent) {
    this.children ??= Map.groupBy(this.paths, parentDir);
    return this.children.get(parent) ?? [];
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

// The glob crate reads a-b as one range of Unicode scalar values. A
// descending range matches nothing, including when it is one arm of a class.
function cargoClass(text, negated) {
  const chars = Array.from(text);
  const escaped = code => '\\u{' + code.toString(16) + '}';
  let members = '';
  for (let i = 0; i < chars.length; i++) {
    const start = chars[i].codePointAt(0);
    if (chars[i + 1] === '-' && i + 2 < chars.length) {
      const end = chars[i + 2].codePointAt(0);
      if (start <= end) members += escaped(start) + '-' + escaped(end);
      i += 2;
    } else members += escaped(start);
  }
  return '(?!/)[' + (negated ? '^' : '') + members + ']';
}

function compileGlobSegment(segment) {
  let regex = '';
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === '*') {
      if (segment[i + 1] === '*') return null;
      regex += '[^/]*';
    } else if (ch === '?') {
      regex += '[^/]';
    } else if (ch === '[') {
      const negated = segment[i + 1] === '!';
      const first = i + (negated ? 2 : 1);
      const end = segment.indexOf(']', first + 1);
      if (end < 0) return null;
      regex += cargoClass(segment.slice(first, end), negated);
      i = end;
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

function confirmMemberAliases(steps, entries, rows, names) {
  const aliases = [];
  let positions = new Set([0]);
  let parent = '';
  for (const [depth, entry] of entries.entries()) {
    const next = new Set();
    for (const pos of positions) {
      // The prefix has reached this position. Only probe it if the suffix fits too.
      if (!rows[depth].has(pos)) continue;
      if (steps[pos] === null) {
        positions.add(pos + 1);
        if (rows[depth + 1].has(pos)) next.add(pos);
        continue;
      }
      const spelling = rows[depth].get(pos);
      if (spelling !== entry) {
        if (!names.matches(parent, entry, spelling)) continue;
        (aliases[depth] ??= new Set()).add(spelling);
      }
      next.add(pos + 1);
    }
    if (!next.size) return null;
    positions = next;
    parent = join(parent, entry);
  }
  // Prune walks that would eventually hit a rejected alias before emitting spellings.
  return aliases.length ? memberSuffixes(steps, entries, (d, spelling) => aliases[d]?.has(spelling)) : null;
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
  const confirmed = confirmMemberAliases(steps, entries, possible.rows, names);
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

// The glob crate offers . and .. when a directory listing has a pattern
// beginning with a literal dot. A globstar's own iterator yields real entries.
function memberNavigation(parts, steps) {
  return parts.map((part, i) => {
    if (!part.startsWith('.') || parts[i - 1] === '**') return null;
    const self = steps[i]('.') !== null;
    const up = steps[i]('..') !== null;
    return self || up ? { self, up } : null;
  });
}

function parentSearchRoot(parts, navigation) {
  if (!navigation.some(step => step?.up)) return null;
  const prefix = parts.findIndex(hasCargoGlob);
  let lowest = prefix;
  let depth = prefix;
  for (let i = prefix; i < parts.length; i++) {
    if (navigation[i]?.up) depth = Math.max(0, depth - 1);
    else if (parts[i] !== '**' && !navigation[i]?.self) depth++;
    lowest = Math.min(lowest, depth);
  }
  return parts.slice(0, lowest).join('/');
}

// Work backwards from the requested path. A parent step needs a real
// child directory where the preceding pattern could have arrived. Keep
// each normalized spelling for Cargo's subsequent exclusion comparison.
function navigationMatcher(parts, steps, navigation, names, directoriesOnly) {
  let generation = -1;
  const cache = steps.map(() => new Map());
  function prefixes(pos, dir, directory) {
    if (!pos) return dir ? [] : [''];
    const stored = directory && (!dir || names.paths.has(dir)) ? cache[pos - 1] : null;
    if (stored?.has(dir)) return stored.get(dir);
    const result = new Set();
    const step = steps[pos - 1];
    if (step === null) {
      // A globstar consumes real entries with their snapshot spelling.
      for (let ancestor = dir; ; ancestor = parentDir(ancestor)) {
        for (const prior of prefixes(pos - 1, ancestor, true))
          result.add(ancestor === dir ? prior : join(prior, dir.slice(ancestor ? ancestor.length + 1 : 0)));
        if (!ancestor) break;
      }
    } else {
      const parent = parentDir(dir);
      const entry = dir.slice(dir.lastIndexOf('/') + 1);
      const emitted = dir ? step(entry) : null;
      if (emitted !== null) {
        const prior = prefixes(pos - 1, parent, true);
        if (prior.length && names.matches(parent, entry, emitted))
          for (const spelling of prior) result.add(join(spelling, emitted));
      }
      if (directory && navigation[pos - 1]?.self)
        for (const spelling of prefixes(pos - 1, dir, true)) result.add(spelling);
      if (directory && navigation[pos - 1]?.up)
        for (const child of names.childDirs(dir))
          for (const spelling of prefixes(pos - 1, child, true)) result.add(parentDir(spelling));
    }
    const spellings = [...result];
    stored?.set(dir, spellings);
    return spellings;
  }
  function* spellings(dir, directory = true) {
    if (generation !== names.paths.size) {
      for (const row of cache) row.clear();
      generation = names.paths.size;
    }
    const matches = prefixes(steps.length, dir, directory);
    if (matches.includes(dir)) yield dir;
    for (const match of matches) if (match !== dir) yield match;
  }
  return Object.assign((dir, directory = true) => spellings(dir, directory).next().value ?? null, {
    directoriesOnly,
    parentSearchRoot: parentSearchRoot(parts, navigation),
    spellings,
  });
}

export function cargoMemberMatcher(pattern, names) {
  // Cargo's directory walk emits descendants for a terminal **. Even the
  // shortest such walk must consume one nonempty directory name.
  const directoriesOnly = pattern === '**' || pattern.endsWith('/**');
  const member = directoriesOnly ? pattern + '/?*' : pattern;
  const exact = compileCargoGlob(member);
  if (!exact) return null;
  const parts = globParts(member);
  const steps = memberSteps(parts);
  if (parts.some(part => part.startsWith('.'))) {
    const navigation = memberNavigation(parts, steps);
    if (navigation.some(Boolean)) return navigationMatcher(parts, steps, navigation, names, directoriesOnly);
  }
  const recursive = parts.indexOf('**');
  if (recursive !== parts.lastIndexOf('**')) {
    const spellings = dir => walkMemberSpellings(steps, dir, names);
    return Object.assign(dir => spellings(dir).next().value ?? null, { spellings, directoriesOnly });
  }
  const match = dir => {
    if (exact.test(dir)) return dir;
    return windows ? singleMemberSpelling(steps, recursive, dir, names) : null;
  };
  function* spellings(dir) {
    const result = match(dir);
    if (result !== null) yield result;
  }
  return Object.assign(match, { spellings, directoriesOnly });
}
