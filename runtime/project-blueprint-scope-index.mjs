// Blueprint candidate lookup. The final ownership and overlap decisions use
// the same canonical matchers as the rest of the project.
import path from 'node:path';
import { expandBlueprintScope } from './cargo-workspace.mjs';
import { ownsPath, ownsScopePath } from './scope-paths.mjs';

// scopesOverlap also uses its raw prefix (cut at * ? [ {) as a filename.
// Truncation can turn the start of a component into a complete ".." segment.
const parentSegment = /(?:^|\/)\.\.(?:$|\/|[*?[{])/;

// Node expands braces, normalizes path components, then parses classes and
// extglobs. Brace alternatives copy fragments between { , } and / intact.
// Ranges cannot supply a dot-only fragment. A "." or ".." component
// therefore needs at least one such fragment consisting of one or two dots.
const dotFragment = /(?:^|[/{},])\.{1,2}(?:$|[/{},])/;

// Node expands braces before parsing extglobs. In a whole positive @(...) component
// with literal arms, a match chooses just one arm: the choices in every sibling
// can be discarded. Keep the @() wrapper for Node's platform-specific case rules.
// Only native glob queries use this spelling. Directory discovery, its budgets
// and literal file/subtree ownership still use the written scope.
export function cargoScopeGlob(scope) {
  const firstBrace = scope.indexOf('{');
  if (firstBrace < 0 || !scope.includes('{', firstBrace + 1) || !scope.includes('@(')) return scope;
  const maxPatternLength = 64 * 1024;
  if (scope.length > maxPatternLength) return scope;
  let product = 1;
  const skeleton = scope.replace(/\{[\p{L}\p{N}._/-]*(?:,[\p{L}\p{N}._/-]*)+\}/gu, list => {
    product *= list.split(',').length;
    return '_';
  });
  // Ranges, nesting, escapes and structural brace fragments keep native precedence.
  // Past Node's brace-expansion limit the union can be incomplete.
  if (product > 100_000 || /[^\p{L}\p{N}._/|@()-]/u.test(skeleton)) return scope;
  const glob = scope.replace(/(^|\/)(@\(([^/()]+)\))(?=\/|$)/g, (written, slash, component, body) => {
    if (!body.includes('{')) return written;
    const arms = body.split('|');
    if (arms.filter(arm => arm.includes('{')).length < 2 || !arms.every(arm => /^[\p{L}\p{N}_-]/u.test(arm)))
      return written;
    // Bound the total size before constructing spellings with repeated long affixes.
    if (component.length * (1 + (body.match(/[,|]/g)?.length ?? 0)) > maxPatternLength) return written;
    const words = expandBlueprintScope(component, 1);
    return words ? slash + '@(' + words.join('|') + ')' : written;
  });
  return glob.length <= maxPatternLength ? glob : scope;
}

/** Keep only a prefix shared by the raw spelling (including scopesOverlap's
 * literal comparisons) and every possible normalized match. */
export function scopeIndexPrefix(raw) {
  const scope = raw.replace(/^\.\//, '');
  if (scope.includes('\\') || parentSegment.test(scope) || (scope.includes('{') && dotFragment.test(scope)))
    return { segments: [], prefix: '' };

  const segments = [];
  for (const part of scope.split('/')) {
    const lead = /^[\w.-]*/.exec(part)[0];
    if (!lead || lead === '.' || lead === '..') break;
    if (lead !== part) return { segments, prefix: lead.toLowerCase() };
    segments.push(lead.toLowerCase());
  }
  return { segments, prefix: '' };
}

export function* pathParents(file) {
  for (let end = file.lastIndexOf('/'); end > 0; end = file.lastIndexOf('/', end - 1)) yield file.slice(0, end);
}
export function scopeOwnership(scopes, matches = ownsPath) {
  const all = [...scopes];
  const buckets = new Map();
  const lengths = new Set();
  let globs;
  for (const scope of all) {
    if (matches === ownsPath) {
      const glob = cargoScopeGlob(scope);
      if (glob !== scope) (globs ??= new Map()).set(scope, glob.replace(/^\.\//, ''));
    }
    const { segments, prefix } = scopeIndexPrefix(scope);
    const key = [...segments, prefix].join('/');
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(scope);
    lengths.add(key.length);
  }
  if (globs) matches = (choices, file) => choices.some(scope => ownsScopePath(scope, file, globs.get(scope)));
  return file => {
    // Git supplies normalized names. For other spellings ownsPath can match
    // either the original text or a name with dot segments removed by Node.
    if (file !== path.posix.normalize(file)) return matches(all, file);
    // Keys are ASCII. Upper/lower folding includes Unicode regexp equivalents
    // of those letters. The final slash also visits the exact directory key.
    const name = file.toUpperCase().toLowerCase() + '/';
    for (let width = name.length; width >= 0; width--) {
      if (!lengths.has(width)) continue;
      const candidates = buckets.get(name.slice(0, width));
      if (candidates && matches(candidates, file)) return true;
    }
    return false;
  };
}
