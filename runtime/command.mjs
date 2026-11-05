import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { redact, workerEnvironment } from './security.mjs';

export function gitBoundary(args, env) {
  // Put the guard after caller-supplied global options so a -c override cannot
  // restore hooks. This changes only this Git invocation, never user config.
  const valuedOptions = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--config-env']);
  let commandIndex = 0;
  while (commandIndex < args.length && args[commandIndex].startsWith('-')) {
    const option = args[commandIndex++];
    if (valuedOptions.has(option)) commandIndex++;
    if (option === '--') break;
  }
  const network = ['fetch', 'push', 'pull', 'clone', 'ls-remote'].includes(args[commandIndex]);
  const environment = workerEnvironment(env);
  // Only authenticated transport may receive GitHub credentials. Other API
  // keys stay absent even while a credential helper handles fetch or push.
  if (network) for (const [name, value] of Object.entries(env)) {
    if (/^(?:GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|GH_HOST|GH_CONFIG_DIR)$/i.test(name)) environment[name] = value;
  }
  const config = ['-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, '-c', 'core.fsmonitor=false'];
  if (process.platform === 'win32') config.push('-c', 'core.longpaths=true');
  if (!network) config.push('-c', 'credential.helper=');
  let invocation = args.slice(commandIndex);
  if (invocation[0] === 'diff') {
    const separator = invocation.indexOf('--');
    const optionEnd = separator === -1 ? invocation.length : separator;
    const options = invocation.slice(1, optionEnd).filter(arg => !['--ext-diff', '--textconv'].includes(arg));
    invocation = ['diff', '--no-ext-diff', '--no-textconv', ...options, ...invocation.slice(optionEnd)];
  }
  return { args: [...args.slice(0, commandIndex), ...config, ...invocation], env: environment };
}

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
function stoppedOutput(text, secrets) {
  // Find matches in the original stream so overlapping credentials cannot leave
  // a fragment behind after an earlier replacement. Merge repeated matches to
  // keep the range list bounded even for highly repetitive child output.
  const ranges = [];
  for (const secret of new Set(Object.values(secrets).filter(value => typeof value === 'string' && value.length))) {
    let previous;
    for (let start = text.indexOf(secret); start !== -1; start = text.indexOf(secret, start + 1)) {
      const end = start + secret.length;
      if (previous && start <= previous[1]) previous[1] = end;
      else { previous = [start, end]; ranges.push(previous); }
    }
    // A stop/capture ceiling may split a known secret across the last chunk.
    for (let size = Math.min(secret.length - 1, text.length); size > 0; size--) {
      if (text.endsWith(secret.slice(0, size))) { ranges.push([text.length - size, text.length]); break; }
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const parts = []; let cursor = 0;
  for (let index = 0; index < ranges.length; index++) {
    const [start, initialEnd] = ranges[index]; let end = initialEnd;
    while (index + 1 < ranges.length && ranges[index + 1][0] <= end) end = Math.max(end, ranges[++index][1]);
    parts.push(text.slice(cursor, start), '[REDACTED]'); cursor = end;
  }
  parts.push(text.slice(cursor));
  return redact(parts.join(''), secrets);
}

export async function execute(command, args = [], { cwd, env = process.env, signal, input, timeoutMs = 1800000, allowFailure = false, secrets = {}, rawOutput = false } = {}) {
  if (/(?:^|[\\/])git(?:\.exe)?$/i.test(command)) ({ args, env } = gitBoundary(args, env));
  const resolved = resolveCommand(command, args);
  return new Promise((resolve, reject) => {
    const child = spawn(resolved.command, resolved.args, { cwd, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    const started = Date.now();
    let stdout = '', stderr = '', stopCause, outputTruncated = false;
    const stop = (code, reason = code) => {
      if (stopCause) return;
      stopCause = Object.assign(new Error('Команда остановлена: ' + reason), { code });
      stopCause.result = { reason };
      if (process.platform === 'win32' && child.pid) { const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.on('error', () => child.kill()); } else child.kill('SIGTERM');
    };
    const timeout = setTimeout(() => stop('timeout'), timeoutMs); timeout.unref();
    const aborted = () => stop('cancelled');
    signal?.addEventListener('abort', aborted, { once: true }); if (signal?.aborted) aborted();
    child.stdout.on('data', data => {
      const remaining = 16 * 1024 * 1024 - stdout.length;
      stdout += data.slice(0, remaining);
      if (data.length > remaining) { outputTruncated = true; stop('invalid_output', 'output_limit'); }
    });
    child.stderr.on('data', data => {
      const remaining = 4 * 1024 * 1024 - stderr.length;
      stderr += data.slice(0, remaining);
      if (data.length > remaining) { outputTruncated = true; stop('invalid_output', 'output_limit'); }
    });
    child.on('error', error => { clearTimeout(timeout); signal?.removeEventListener('abort', aborted); if (!stopCause) reject(error); });
    child.on('close', code => {
      clearTimeout(timeout); signal?.removeEventListener('abort', aborted);
      if (stopCause) {
        const safeOut = stoppedOutput(stdout, secrets), safeErr = stoppedOutput(stderr, secrets);
        stopCause.result = { stdout: safeOut.slice(-24000), stderr: safeErr.slice(-24000), code: Number.isInteger(code) ? code : null, durationMs: Date.now() - started, outputTruncated: outputTruncated || safeOut.length > 24000 || safeErr.length > 24000, reason: stopCause.result.reason };
        reject(stopCause); return;
      }
      const clean = { stdout: redact(stdout, secrets), stderr: redact(stderr, secrets), code };
      const result = rawOutput ? { stdout, stderr, code } : clean;
      if (code && !allowFailure) reject(Object.assign(new Error(`${command} завершился с кодом ${code}: ${[clean.stderr, clean.stdout].filter(Boolean).join('\n').slice(-24000)}`), { code: 'command_failed', result: clean }));
      else resolve(result);
    });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
