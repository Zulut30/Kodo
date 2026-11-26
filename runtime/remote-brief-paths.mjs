import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// A relative path component cannot introduce an absolute root.
const start = String.raw`(?<![\p{L}\p{M}\p{N}_.\\/-])`;
const ansi = /(?:\u001b|\\+u001b)\[[0-?]*[ -/]*[@-~]/gi;
const end = String.raw`(?![\p{L}\p{M}\p{N}._~%+-])`;
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function rootForms(roots, platform, minimumSegments = 2) {
  const windows = platform === 'win32';
  const paths = windows ? path.win32 : path.posix;
  const forms = new Set();
  for (const root of roots.filter(Boolean)) {
    const absolute = paths.resolve(root);
    if (absolute.slice(paths.parse(absolute).root.length).split(paths.sep).filter(Boolean).length < minimumSegments)
      continue;
    const url = pathToFileURL(absolute, { windows });
    forms.add(absolute);
    forms.add(url.href);
    forms.add(decodeURI(url.href));
    // Stack parsers may have stripped "file://" while keeping an encoded pathname.
    if (!url.host) {
      forms.add(url.pathname);
      forms.add(decodeURI(url.pathname));
    }
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

function rootExpression(rootVariants, platform, suffix = '') {
  const separator = platform === 'win32' ? String.raw`[\\/]+` : '/';
  const forms = rootVariants.map(form =>
    form
      .split(platform === 'win32' ? /[\\/]+/ : '/')
      .map(escape)
      .join(separator),
  );
  if (!forms.length) return null;
  return new RegExp(start + '(?:' + forms.join('|') + ')' + end + suffix, platform === 'win32' ? 'giu' : 'gu');
}

export function privateBriefRoots(run, stateHome) {
  return [run.project, stateHome, path.dirname(run.worktreeRoot), path.dirname(import.meta.dirname), os.homedir()];
}

function embeddedText(value) {
  return value.replace(/(?<!\\)((?:\\\\)*)\\[nrt]/g, '$1 ');
}

function matches(pattern, value) {
  pattern.lastIndex = 0;
  return pattern.test(value);
}

export function assertRemoteBriefPaths(brief, roots, platform = process.platform) {
  const pattern = rootExpression(rootForms(roots, platform), platform);
  if (!pattern) return;
  // Inspect the original strings so a newline or ANSI sequence directly before a
  // path remains a delimiter. Nested JSON in the prompt may itself contain escapes.
  const inspect = value => {
    const plain = value.replace(ansi, ' ');
    if (matches(pattern, plain) || (plain.includes('\\') && matches(pattern, embeddedText(plain))))
      throw Object.assign(new Error('Project brief_path_leak'), { code: 'project_brief_path_leak' });
  };
  JSON.stringify(brief, (key, value) => {
    inspect(key);
    if (typeof value === 'string') inspect(value);
    return value;
  });
}

// Historical diagnostic packs can end halfway through a known root. Only match
// a prefix at an absolute-path boundary and immediately followed by the truncation mark.
function maskTruncated(text, forms, platform) {
  if (!text.includes('…')) return text;
  const beginnings = new RegExp(start + String.raw`(?=file:[\\/]|[a-z]:[\\/]|[\\/])`, 'giu');
  const normalize = value => (platform === 'win32' ? value.replace(/[\\/]+/g, '/').toLowerCase() : value);
  let result = '',
    consumed = 0;
  for (const { index } of text.matchAll(beginnings)) {
    if (index < consumed) continue;
    const end = text.indexOf('…', index);
    if (end < 0) break;
    const prefix = normalize(text.slice(index, end));
    if (forms.some(form => normalize(form).startsWith(prefix))) {
      result += text.slice(consumed, index) + '<local-path>';
      consumed = end + 1;
    }
  }
  return result + text.slice(consumed);
}

export function portableDiagnostics(pack, worktrees, platform = process.platform, privateRoots = []) {
  const suffix = String.raw`(?:[\\/]+([^\s"'()<>,;]*))?`;
  const checkoutForms = rootForms(worktrees, platform, 1);
  const forms = rootForms([...privateRoots, ...worktrees], platform);
  const relativePath = rootExpression(checkoutForms, platform, suffix);
  const localPath = rootExpression(forms, platform, suffix);
  if (!localPath && !relativePath) return pack;
  const portable = JSON.parse(
    JSON.stringify(pack, (_key, value) => {
      if (typeof value !== 'string') return value;
      let text = maskTruncated(value.replace(ansi, ' '), forms, platform);
      if (relativePath)
        text = text.replace(relativePath, (match, tail) => {
          if (!tail) return '.';
          const relative = platform === 'win32' ? tail.replace(/\\+/g, '/') : tail;
          if (!/^file:/i.test(match)) return relative;
          try {
            return decodeURI(relative);
          } catch {
            return relative;
          }
        });
      if (!localPath) return text;
      text = text.replace(localPath, '<local-path>');
      // A diagnostic may itself quote JSON with escaped newlines.
      if (text.includes('\\')) {
        const embedded = embeddedText(text);
        if (matches(localPath, embedded)) return embedded.replace(localPath, '<local-path>');
      }
      return text;
    }),
  );
  if (typeof portable.bytes === 'number') {
    let size = Buffer.byteLength(JSON.stringify(portable));
    while (portable.bytes !== size) {
      portable.bytes = size;
      size = Buffer.byteLength(JSON.stringify(portable));
    }
  }
  return portable;
}
