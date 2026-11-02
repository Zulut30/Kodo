import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { redact } from './security.mjs';

export function resolveCommand(command, args) {
  if (process.platform === 'win32' && ['npm', 'npx'].includes(command)) {
    const filename = `${command}-cli.js`;
    const candidates = [path.join(path.dirname(process.execPath), 'node_modules/npm/bin', filename), process.env.npm_execpath && path.join(path.dirname(process.env.npm_execpath), filename), path.join(process.env.APPDATA || '', 'npm/node_modules/npm/bin', filename)];
    const found = candidates.find(item => item && existsSync(item));
    if (!found) throw new Error(`Не найден Node launcher для ${command}`);
    return { command: process.execPath, args: [found, ...args] };
  }
  return { command, args };
}
export async function execute(command, args = [], { cwd, env = process.env, signal, input, timeoutMs = 1800000, allowFailure = false, secrets = {} } = {}) {
  const resolved = resolveCommand(command, args);
  return new Promise((resolve, reject) => {
    const child = spawn(resolved.command, resolved.args, { cwd, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', stopped = false;
    const stop = () => { stopped = true; if (process.platform === 'win32' && child.pid) { const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.on('error', () => child.kill()); } else child.kill('SIGTERM'); };
    const timeout = setTimeout(stop, timeoutMs); timeout.unref();
    signal?.addEventListener('abort', stop, { once: true }); if (signal?.aborted) stop();
    child.stdout.on('data', data => { stdout += data; if (stdout.length > 16 * 1024 * 1024) stop(); });
    child.stderr.on('data', data => { stderr += data; if (stderr.length > 4 * 1024 * 1024) stop(); });
    child.on('error', error => { clearTimeout(timeout); signal?.removeEventListener('abort', stop); reject(error); });
    child.on('close', code => {
      clearTimeout(timeout); signal?.removeEventListener('abort', stop);
      const result = { stdout: redact(stdout, secrets), stderr: redact(stderr, secrets), code };
      if (stopped) reject(Object.assign(new Error('Команда отменена или превысила лимит времени'), { code: signal?.aborted ? 'cancelled' : 'timeout' }));
      else if (code && !allowFailure) reject(Object.assign(new Error(`${command} завершился с кодом ${code}: ${result.stderr || result.stdout}`), { code: 'command_failed', result }));
      else resolve(result);
    });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
