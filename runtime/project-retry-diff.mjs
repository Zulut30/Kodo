import { execute } from './command.mjs';
import { ownsPath } from './contracts.mjs';
import { redact } from './security.mjs';

const limit = 64 * 1024;
const boundary = '\ndiff --git ';

// Git pathspec and Kodo glob syntax differ (e.g. braces). Restrict Git to literal
// directory roots of patterns, then check each NUL-delimited filename with ownsPath.
function pathspecs(scopes) {
  const paths = scopes.map(scope => {
    const parts = scope.replace(/^\.\//, '').split('/');
    const glob = parts.findIndex(part => /[^\w.-]/.test(part));
    return (glob < 0 ? parts : parts.slice(0, glob)).join('/');
  });
  return paths.includes('') ? [] : [...new Set(paths)];
}

// With --no-renames Git emits numstat and patch sections in identical order.
// Consume whole file patches only. A huge line/file never accumulates in memory.
export async function retryDiff(run, scopes, head, secrets, command = execute) {
  let stats = '',
    files,
    index = 0,
    tail = '',
    patch = '',
    bytes = 0,
    rejected = false;
  const omittedFiles = [];
  let diff = '',
    remaining = limit;

  function append(text) {
    if (!files[index]?.owned || files[index].binary || rejected) return;
    bytes += Buffer.byteLength(text);
    if (bytes > remaining || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\ufffd]/.test(text)) {
      rejected = true;
      patch = '';
    } else patch += text;
  }
  function finish() {
    const file = files[index++];
    if (file?.owned) {
      const safe = redact(patch, secrets);
      if (file.binary || rejected || !safe || Buffer.byteLength(safe) > remaining) omittedFiles.push(file.name);
      else {
        diff += safe;
        remaining -= Buffer.byteLength(safe);
      }
    }
    patch = '';
    bytes = 0;
    rejected = false;
  }
  function consumeStdout(chunk) {
    if (!files) {
      const searchFrom = Math.max(0, stats.length - 1);
      stats += chunk;
      const end = stats.indexOf('\0\0', searchFrom);
      if (end < 0) return;
      files = stats
        .slice(0, end)
        .split('\0')
        .map(row => {
          const secondTab = row.indexOf('\t', row.indexOf('\t') + 1);
          const name = row.slice(secondTab + 1);
          return {
            name,
            owned: ownsPath(scopes, name),
            binary: row.startsWith('-\t') || /[\x00-\x1f\x7f-\x9f]/.test(name),
          };
        });
      chunk = stats.slice(end + 2);
      stats = '';
    }
    const text = tail + chunk;
    let start = 0,
      next;
    while ((next = text.indexOf(boundary, start)) >= 0) {
      append(text.slice(start, next + 1));
      finish();
      start = next + 1;
    }
    // Keep only a possible incomplete delimiter, never split a surrogate pair.
    const lastLine = text.lastIndexOf('\n');
    const split = lastLine >= start && boundary.startsWith(text.slice(lastLine)) ? lastLine : text.length;
    append(text.slice(start, split));
    tail = text.slice(split);
  }

  await command(
    'git',
    [
      '--literal-pathspecs',
      'diff',
      '--no-color',
      '--no-renames',
      '--no-ext-diff',
      '--no-textconv',
      '--numstat',
      '-z',
      '--patch',
      run.baseSha,
      head,
      '--',
      ...pathspecs(scopes),
    ],
    { cwd: run.project, secrets, consumeStdout },
  );
  if (files) {
    append(tail);
    while (index < files.length) finish();
  }
  return { diff, omittedFiles, truncated: omittedFiles.length > 0 };
}
