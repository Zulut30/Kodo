// Blueprint candidate lookup. The final ownership and overlap decisions use
// the same canonical matchers as the rest of the project.
import path from 'node:path';
import { ownsPath } from './scope-paths.mjs';

// scopesOverlap also uses its raw prefix (cut at * ? [ {) as a filename.
// Truncation can turn the start of a component into a complete ".." segment.
const parentSegment = /(?:^|\/)\.\.(?:$|\/|[*?[{])/;

// Node expands braces, normalizes path components, then parses classes and
// extglobs. Brace alternatives copy fragments between { , } and / intact.
// Ranges cannot supply a dot-only fragment. A "." or ".." component
// therefore needs at least one such fragment consisting of one or two dots.
const dotFragment = /(?:^|[/{},])\.{1,2}(?:$|[/{},])/;

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
  for (const scope of all) {
    const { segments, prefix } = scopeIndexPrefix(scope);
    const key = [...segments, prefix].join('/');
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(scope);
    lengths.add(key.length);
  }
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
