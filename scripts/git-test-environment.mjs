import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Development runner only. Never substitute another installation or bypass a
// custom Git earlier in PATH. Any uncertainty leaves the environment untouched.
export function configureGitTestEnvironment() {
  if (process.platform !== 'win32') return;
  try {
    const names = ['git', 'git.com', 'git.exe', 'git.bat', 'git.cmd'];
    // Windows command resolution can select a CWD launcher before PATH.
    for (const name of names) {
      try { lstatSync(path.resolve(name)); return; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const keys = Object.keys(process.env).filter(key => key.toLowerCase() === 'path');
    if (keys.length !== 1 || !process.env[keys[0]]) return;
    const key = keys[0], original = process.env[key];
    let launcher;
    search: for (const entry of original.split(';')) {
      const directory = path.resolve(entry.replace(/^"(.*)"$/, '$1'));
      // Unknown launchers and links can be intentional. Do not search past them.
      for (const name of names) {
        const file = path.join(directory, name);
        let stat;
        try { stat = lstatSync(file); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (name !== 'git.exe' || !stat.isFile() || stat.isSymbolicLink()) return;
        launcher = file;
        break search;
      }
    }
    if (!launcher || path.basename(path.dirname(launcher)).toLowerCase() !== 'cmd') return;
    const root = path.dirname(path.dirname(launcher));
    const core = path.join(root, 'mingw64', 'bin', 'git.exe');
    const stat = lstatSync(core);
    if (!stat.isFile() || stat.isSymbolicLink()) return;
    const canonicalRoot = realpathSync.native(root);
    const same = (a, b) => a.toLowerCase() === b.toLowerCase();
    if (!same(realpathSync.native(launcher), path.join(canonicalRoot, 'cmd', 'git.exe'))
      || !same(realpathSync.native(core), path.join(canonicalRoot, 'mingw64', 'bin', 'git.exe'))) return;

    // Metadata needs no provider/network credentials or Git config overrides.
    // Preserve allowed names/casing and path values without modifying parent env.
    const allowed = /^(?:PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|SystemDrive|GIT_EXEC_PATH|LANG|LC_ALL)$/i;
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => allowed.test(name)));
    for (const argument of ['--version', '--exec-path']) {
      const outputs = [launcher, core].map(file => {
        const result = spawnSync(file, [argument], {
          shell: false, windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024, encoding: 'utf8', env,
        });
        if (result.error || result.status !== 0 || result.signal || result.stderr?.trim()
          || typeof result.stdout !== 'string') return null;
        const output = result.stdout;
        if (!output.trim() || /[\0]/.test(output)) return null;
        const line = output.replace(/\r?\n$/, '');
        if (/[\r\n]/.test(line)) return null;
        if (argument === '--version' ? !/^git version \S.*$/.test(line) : !path.isAbsolute(line)) return null;
        return output;
      });
      if (outputs[0] === null || outputs[1] === null || outputs[0] !== outputs[1]) return;
    }
    process.env[key] = path.dirname(core) + ';' + original;
  } catch {
    // Optimization failure must never turn a test run into a failure.
  }
}
