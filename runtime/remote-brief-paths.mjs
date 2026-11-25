import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Include quoted JSON inside the worker prompt, shell assignments and stack locations.
// A slash within a relative path or a host URL cannot start a private root.
const start = String.raw`(?:^|(?<=[\s"'(=,;[{<\x60])|(?<=:)(?![\\/]{2})|(?<=\\[nrt]))`;
const end = String.raw`(?![\p{L}\p{M}\p{N}._~%+-])`;
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function rootForms(roots, platform) {
  const windows = platform === 'win32';
  const paths = windows ? path.win32 : path.posix;
  const forms = new Set();
  for (const root of roots.filter(Boolean)) {
    const absolute = paths.resolve(root);
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

function rootExpression(roots, platform, suffix = '') {
  const separator = platform === 'win32' ? String.raw`[\\/]+` : '/';
  const forms = rootForms(roots, platform).map(form =>
    form
      .split(platform === 'win32' ? /[\\/]+/ : '/')
      .map(escape)
      .join(separator),
  );
  if (!forms.length) return null;
  return new RegExp(start + '(?:' + forms.join('|') + ')' + end + suffix, platform === 'win32' ? 'giu' : 'gu');
}

export function assertRemoteBriefPaths(brief, roots, platform = process.platform) {
  const pattern = rootExpression(roots, platform);
  if (pattern?.test(JSON.stringify(brief)))
    throw Object.assign(new Error('Project brief_path_leak'), { code: 'project_brief_path_leak' });
}

export function portableDiagnostics(pack, worktrees, platform = process.platform) {
  // Rewrite only paths rooted in a known checkout. Other private locations are
  // still subject to the final brief guard. Keep the locally persisted evidence intact.
  const suffix = String.raw`(?:[\\/]+([^\s"'()<>,;]*))?`;
  const pattern = rootExpression(worktrees, platform, suffix);
  if (!pattern) return pack;
  const portable = JSON.parse(
    JSON.stringify(pack, (_key, value) => {
      if (typeof value !== 'string') return value;
      return value.replace(pattern, (match, tail) => {
        if (!tail) return '.';
        const relative = platform === 'win32' ? tail.replace(/\\+/g, '/') : tail;
        if (!/^file:/i.test(match)) return relative;
        try {
          return decodeURI(relative);
        } catch {
          return relative;
        }
      });
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
