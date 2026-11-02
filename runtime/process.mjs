import { spawn, spawnSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parse as parseToml } from 'smol-toml';
import { workerEnvironment } from './security.mjs';

export function redact(value, secrets = {}) {
  let result = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of Object.values(secrets)) {
    if (typeof secret === 'string' && secret.length >= 8) result = result.split(secret).join('[REDACTED]');
  }
  return result
    .replace(/([?&](?:token|key|api_key)=)[^&\s"']+/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~-]+/gi, '$1[REDACTED]')
    .replace(/AIza[A-Za-z0-9_-]{20,}/g, '[REDACTED]')
    .replace(/(?:apikey_|get-x-api-|reddit-api-)[A-Za-z0-9_-]{16,}/g, '[REDACTED]');
}

export function subscriptionEnvironment(base = process.env) {
  // An explicitly supplied worker environment is complete. Merging the parent
  // here would reintroduce coordinator credentials already removed by Engine.
  const environment = workerEnvironment(base);
  for (const name of Object.keys(environment)) {
    if (/^(?:OPENAI_|ANTHROPIC_|CLAUDE_CODE_USE_)/i.test(name) || name === 'CLAUDECODE') delete environment[name];
  }
  return environment;
}

async function isFile(filename) {
  try { await access(filename); return true; } catch { return false; }
}

export async function resolveClient(client, environment = process.env) {
  const home = environment.USERPROFILE || os.homedir();
  const appdata = environment.APPDATA || path.join(home, 'AppData', 'Roaming');
  if (client === 'codex') {
    const launchers = [
      environment.KODO_CODEX_CLIJS,
      path.join(appdata, 'npm/node_modules/@openai/codex/bin/codex.js'),
      '/usr/local/lib/node_modules/@openai/codex/bin/codex.js',
      '/usr/lib/node_modules/@openai/codex/bin/codex.js'
    ].filter(Boolean);
    for (const launcher of launchers) if (await isFile(launcher)) return { command: process.execPath, args: [launcher] };
  }
  const commandName = client === 'claude-code' ? 'claude' : client;
  if (process.platform === 'win32') {
    const result = spawnSync('where.exe', [commandName + '.exe'], { encoding: 'utf8', windowsHide: true, env: environment });
    const native = result.stdout?.split(/\r?\n/).find(line => line.trim());
    if (native) return { command: native.trim(), args: [] };
    if (client === 'claude-code') {
      const nativeClaude = path.join(home, '.local/bin/claude.exe');
      if (await isFile(nativeClaude)) return { command: nativeClaude, args: [] };
    }
    throw new Error(`Не найден исполняемый файл клиента ${client}`);
  }
  const result = spawnSync('which', [commandName], { encoding: 'utf8', env: environment });
  const executable = result.stdout?.trim();
  if (executable) return { command: executable, args: [] };
  throw new Error(`Не найден исполняемый файл клиента ${client}`);
}

export async function runProcess({ command, args = [], cwd, input = '', env = process.env, signal, timeoutMs = 1800000, onLine, maxOutputBytes = 16 * 1024 * 1024 }) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', pending = '', finished = false, terminalError;
    const terminate = error => {
      if (finished) return;
      terminalError = error;
      // Windows process groups require taskkill to stop the CLI's native child too.
      if (process.platform === 'win32' && child.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else child.kill('SIGTERM');
    };
    const timer = setTimeout(() => terminate(Object.assign(new Error('Истекло время выполнения клиента'), { code: 'KODO_TIMEOUT' })), timeoutMs);
    timer.unref();
    const aborted = () => terminate(signal.reason instanceof Error ? signal.reason : Object.assign(new Error('Запуск отменён'), { name: 'AbortError' }));
    signal?.addEventListener('abort', aborted, { once: true });
    const finish = callback => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      callback();
    };
    child.on('error', error => finish(() => reject(error)));
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      pending += chunk;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxOutputBytes) return terminate(Object.assign(new Error('Превышен предел вывода клиента'), { code: 'KODO_OUTPUT_LIMIT' }));
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline).replace(/\r$/, '');
        pending = pending.slice(newline + 1);
        try { onLine?.(line); } catch (error) { terminate(error); }
      }
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxOutputBytes) terminate(Object.assign(new Error('Превышен предел вывода клиента'), { code: 'KODO_OUTPUT_LIMIT' }));
    });
    child.on('close', (exitCode, exitSignal) => finish(() => {
      if (pending) { try { onLine?.(pending.replace(/\r$/, '')); } catch (error) { terminalError ??= error; } }
      if (terminalError) reject(terminalError);
      else resolve({ stdout, stderr, exitCode, signal: exitSignal, pid: child.pid });
    }));
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') terminate(error); });
    child.stdin.end(input);
  });
}

export async function readCodexModelCache(environment = process.env) {
  const home = environment.CODEX_HOME || path.join(environment.USERPROFILE || os.homedir(), '.codex');
  try { return JSON.parse(await readFile(path.join(home, 'models_cache.json'), 'utf8')).models ?? []; }
  catch { return []; }
}

export async function codexIsolationOverrides(cwd, environment = process.env) {
  const home = environment.CODEX_HOME || path.join(environment.USERPROFILE || os.homedir(), '.codex');
  const filenames = new Set([path.join(home, 'config.toml')]);
  let current = path.resolve(cwd);
  for (;;) {
    filenames.add(path.join(current, '.codex', 'config.toml'));
    if (await isFile(path.join(current, '.git'))) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const serverNames = new Set(), pluginNames = new Set();
  for (const filename of filenames) {
    let text;
    try { text = await readFile(filename, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw new Error('Не удалось прочитать конфигурацию Codex для изоляции рабочих инструментов'); }
    let config;
    try { config = parseToml(text.replace(/^\uFEFF/, '')); }
    catch { throw new Error('Некорректная конфигурация Codex; запуск инструментов не начат'); }
    for (const name of Object.keys(config.mcp_servers || {})) serverNames.add(name);
    for (const name of Object.keys(config.plugins || {})) pluginNames.add(name);
  }
  const args = ['-c', 'notify=[]', '-c', 'plugins._default.enabled=false'];
  for (const name of [...serverNames].sort()) args.push('-c', `mcp_servers.${JSON.stringify(name)}.enabled=false`);
  for (const name of [...pluginNames].filter(name => name !== '_default').sort()) args.push('-c', `plugins.${JSON.stringify(name)}.enabled=false`);
  return args;
}
