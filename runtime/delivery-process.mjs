import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { redact, workerEnvironment } from './security.mjs';
import { gitBoundary } from './command.mjs';

/** Owned process execution, process-tree teardown and command output redaction for delivery. */
const sha256 = value => createHash('sha256').update(value).digest('hex');

const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

const parse = (text, label) => {
  try {
    return JSON.parse(text);
  } catch {
    throw fail('invalid_output', `Invalid JSON from ${label}`);
  }
};

const wait = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(fail('cancelled', 'Delivery cancelled'));
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(fail('cancelled', 'Delivery cancelled'));
    }
    signal?.addEventListener('abort', abort, { once: true });
  });

async function npmCommand() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.join(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
    ...(process.env.PATH ?? '').split(path.delimiter).map(item => path.join(item, 'node_modules/npm/bin/npm-cli.js')),
  ];
  for (const candidate of candidates.filter(Boolean)) {
    try {
      await access(candidate);
      return [process.execPath, [candidate]];
    } catch {
      /* next installation */
    }
  }
  throw fail('configuration', 'Cannot find npm-cli.js; install npm beside Node.js');
}

// Helpers receive no authenticated Git/gh environment. They operate on the
// spawned PID/group only, never executable names or the host application's tree.
async function processHelper(command, args, input) {
  return new Promise((resolve, reject) => {
    const helper = spawn(command, args, {
      env: workerEnvironment(),
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '',
      error;
    const timer = setTimeout(() => {
      error = fail('process_teardown', 'Owned process teardown helper timed out');
      helper.kill('SIGKILL');
    }, 20000);
    helper.stdout.setEncoding('utf8');
    helper.stderr.resume();
    helper.stdout.on('data', chunk => {
      if (output.length < 4 * 1024 * 1024) output += chunk;
      else {
        error ??= fail('process_teardown', 'Owned process enumeration exceeded limit');
        helper.kill('SIGKILL');
      }
    });
    helper.on('error', cause => {
      error ??= fail('process_teardown', 'Cannot start owned process teardown helper', { cause });
    });
    helper.on('close', code => {
      clearTimeout(timer);
      if (error) reject(error);
      else if (code !== 0) reject(fail('process_teardown', `Owned process teardown helper failed (${code})`));
      else resolve(output);
    });
    helper.stdin.on('error', () => {});
    helper.stdin.end(input);
  });
}

async function stopOwnedTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    // Keep handles to the observed descendants: taskkill returning, or the root
    // closing its pipes, alone does not prove children with ignored stdio exited.
    const script = `
      $ErrorActionPreference = 'Stop'
      $root = [int][Console]::In.ReadToEnd()
      $owned = [Collections.Generic.List[Diagnostics.Process]]::new()
      $seen = [Collections.Generic.HashSet[int]]::new()
      function Capture-Owned([int]$ownedId) {
        if (!$seen.Add($ownedId)) { return }
        if ($seen.Count -gt 1024) { throw 'Owned process tree exceeds limit' }
        $p = $null
        try { $p = [Diagnostics.Process]::GetProcessById($ownedId) } catch [ArgumentException] { }
        if ($null -ne $p) {
          $captured = $false
          try {
            $null = $p.Handle
            $owned.Add($p); $captured = $true
          } catch [InvalidOperationException] {
            # Exit between lookup and opening the handle is benign only when
            # this Process confirms exit. Access/other errors still propagate.
            if (!$p.HasExited) { throw }
          } finally { if (!$captured) { $p.Dispose() } }
        }
        foreach ($entry in @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $ownedId")) { Capture-Owned ([int]$entry.ProcessId) }
      }
      try {
        Capture-Owned $root
        # Only invoke the bulk kill for the captured root identity. Retain its
        # handle until teardown finishes, including if it exits during taskkill.
        $rootProcess = $owned | Where-Object { $_.Id -eq $root } | Select-Object -First 1
        if ($null -ne $rootProcess -and !$rootProcess.HasExited) {
          try { & "$env:SystemRoot\\System32\\taskkill.exe" /PID $root /T /F 2>$null | Out-Null } catch { }
        }
        foreach ($p in $owned) {
          try { if (!$p.HasExited) { $p.Kill() } }
          catch [InvalidOperationException] { if (!$p.HasExited) { throw } }
        }
        foreach ($p in $owned) { if (!$p.WaitForExit(5000)) { throw 'Owned process did not exit' } }
      } finally { foreach ($p in $owned) { $p.Dispose() } }
    `;
    const powershell = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32/WindowsPowerShell/v1.0/powershell.exe',
    );
    await processHelper(
      powershell,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      String(child.pid),
    );
    return;
  }
  const killGroup = signal => {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  killGroup('SIGTERM');
  await wait(250); // Bounded graceful shutdown, followed by mandatory escalation.
  killGroup('SIGKILL');
  const deadline = Date.now() + 5000;
  for (;;) {
    // Only the owned detached group is tested. Dead zombies hold no resources;
    // their final reap belongs to their OS parent, not to this Node process.
    const states = await processHelper('ps', ['-A', '-o', 'pgid=,stat=']);
    const running = states.split(/\r?\n/).some(line => {
      const [group, state] = line.trim().split(/\s+/);
      return Number(group) === child.pid && state && !/^[ZX]/.test(state);
    });
    if (!running) return;
    if (Date.now() >= deadline) throw fail('process_teardown', 'Owned process group did not exit');
    await wait(25);
  }
}

function commandRedactions(baseEnv, environment, secrets = {}) {
  // Separate namespaces retain both values when options.secrets and the stripped
  // environment use the same name. The map never becomes part of diagnostics.
  return Object.fromEntries([
    ...Object.entries(baseEnv)
      .filter(([name]) => !(name in environment))
      .map(([name, value]) => [`env:${name}`, value]),
    ...Object.entries(secrets ?? {}).map(([name, value]) => [`secret:${name}`, value]),
  ]);
}

function redactCommandOutput(value, secrets) {
  if (typeof value !== 'string') {
    if (Array.isArray(value)) return value.map(item => redactCommandOutput(item, secrets));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          redactCommandOutput(key, secrets),
          redactCommandOutput(item, secrets),
        ]),
      );
    return value;
  }
  // Sweep matches in the original text, retaining only one pending occurrence
  // per known value. Sequential replacement (even longest-first) can destroy
  // a crossing match and expose its tail. Include overlapping self-matches too.
  const pending = [...new Set(Object.values(secrets ?? {}))]
    .filter(secret => typeof secret === 'string' && secret.length > 5 && secret.length <= value.length)
    .map(secret => ({ secret, start: value.indexOf(secret) }))
    .filter(match => match.start >= 0);
  const parts = [];
  let cursor = 0,
    start = -1,
    end = 0;
  const flush = () => {
    if (start >= 0) {
      parts.push(value.slice(cursor, start), '[REDACTED]');
      cursor = end;
    }
  };
  while (pending.length) {
    let first = 0;
    for (let index = 1; index < pending.length; index++) if (pending[index].start < pending[first].start) first = index;
    const match = pending[first];
    if (start < 0 || match.start > end) {
      flush();
      start = match.start;
      end = match.start + match.secret.length;
    } else end = Math.max(end, match.start + match.secret.length);
    match.start = value.indexOf(match.secret, match.start + 1);
    if (match.start < 0) pending.splice(first, 1);
  }
  flush();
  // Generic credential rules run only after the known ranges have been hidden.
  // Memory is bounded by the supplied values and captured/redacted text, never
  // by a list of every occurrence or the uncaptured process output.
  return redact(parts.length ? parts.join('') + value.slice(cursor) : value);
}

function redactCommandError(value, secrets, seen = new WeakMap()) {
  if (typeof value === 'string') return redactCommandOutput(value, secrets);
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  // Keep mutable errors (including their type/identity), non-enumerable stack
  // and cause, and nested diagnostics. Frozen runner errors need a typed copy.
  const descriptors = Object.getOwnPropertyDescriptors(value);
  // V8's cached stack is still an accessor in Node 24. Materialize it before
  // changing message, then redact the original diagnostic instead of dropping it.
  if (value instanceof Error && descriptors.stack?.get)
    descriptors.stack = {
      value: value.stack,
      writable: descriptors.stack.configurable,
      enumerable: descriptors.stack.enumerable,
      configurable: descriptors.stack.configurable,
    };
  const immutable = Reflect.ownKeys(descriptors).some(
    key => 'value' in descriptors[key] && !descriptors[key].writable && !descriptors[key].configurable,
  );
  const clean = !immutable
    ? value
    : Array.isArray(value)
      ? []
      : value instanceof Error
        ? Object.setPrototypeOf(new Error(), Object.getPrototypeOf(value))
        : Object.create(Object.getPrototypeOf(value));
  seen.set(value, clean);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if ('value' in descriptor)
      Object.defineProperty(clean, key, { ...descriptor, value: redactCommandError(descriptor.value, secrets, seen) });
    else if (clean !== value) Object.defineProperty(clean, key, descriptor);
  }
  return clean;
}

function redactOutputBoundary(text, clean, secrets) {
  let hidden = 0;
  for (const secret of new Set(Object.values(secrets))) {
    if (typeof secret !== 'string' || secret.length <= 5) continue;
    // A closed/capped stream may end in any proper prefix of a known value.
    // Match its longest suffix in linear time, including repetitive/long keys.
    // The table and scan never exceed captured text, even if a key exceeds cap.
    const length = Math.min(secret.length - 1, text.length);
    if (!length || text.indexOf(secret[0], text.length - length) < 0) continue;
    const prefixes = new Uint32Array(length);
    for (let index = 1, matched = 0; index < length; index++) {
      while (matched && secret[index] !== secret[matched]) matched = prefixes[matched - 1];
      if (secret[index] === secret[matched]) matched++;
      prefixes[index] = matched;
    }
    let matched = 0;
    for (let index = text.length - length; index < text.length; index++) {
      while (matched && text[index] !== secret[matched]) matched = prefixes[matched - 1];
      if (text[index] === secret[matched]) matched++;
    }
    hidden = Math.max(hidden, matched);
  }
  if (!hidden) return clean;
  // Detect the boundary on raw text: a shorter known value may otherwise
  // replace the start of a longer unfinished value before we can recognize it.
  // A complete match can also overlap this cut. Keep only the common redacted
  // prefix so cutting the raw stream cannot expose part of that complete match.
  const prefix = redactCommandOutput(text.slice(0, -hidden), secrets);
  let end = 0;
  while (end < prefix.length && end < clean.length && prefix[end] === clean[end]) end++;
  // Short candidates must not expand a tiny capture budget. Finalize only
  // diagnostics: successful machine output remains byte-for-byte raw.
  return clean.slice(0, end) + (hidden < 10 ? '*'.repeat(hidden) : '[REDACTED]');
}

function commandFailure(command, code, result, extra = {}, secrets = {}) {
  const clean = redactCommandOutput({ ...result, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }, secrets);
  clean.stdout = redactOutputBoundary(result.stdout ?? '', clean.stdout, secrets);
  clean.stderr = redactOutputBoundary(result.stderr ?? '', clean.stderr, secrets);
  const diagnostics = ['stdout', 'stderr']
    .map(name =>
      clean[name]
        ? `${name}:\n${clean[name].length > 12000 ? `${clean[name].slice(0, 6000)}\n[full bounded output retained in result]\n${clean[name].slice(-6000)}` : clean[name]}`
        : '',
    )
    .filter(Boolean)
    .join('\n');
  return fail(
    code,
    `${command} ${code === 'command_failed' ? `failed (${result.code})` : code}${diagnostics ? `:\n${diagnostics}` : ''}`,
    { ...extra, exitCode: result.code, stdout: clean.stdout, stderr: clean.stderr, result: clean },
  );
}

export async function execute(
  command,
  args,
  { cwd, signal, timeoutMs = 120000, allowFailure = false, env, maxOutputBytes = 20 * 1024 * 1024, secrets = {} } = {},
) {
  if (signal?.aborted) throw fail('cancelled', 'Delivery cancelled');
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 0 ||
    timeoutMs > 2147483647 ||
    !Number.isInteger(maxOutputBytes) ||
    maxOutputBytes < 1
  )
    throw fail('configuration', 'Command deadline and output limit must be bounded integers');
  const baseEnv = env ?? process.env;
  let environment = workerEnvironment(baseEnv);
  const redactions = commandRedactions(baseEnv, environment, secrets);
  let executable = command,
    argv = args;
  // Coordinator Git processes retain credentials, so repository-authored hooks
  // must never run inside that boundary, including pre-push and reference hooks.
  if (/(?:^|[\\/])git(?:\.exe)?$/i.test(command)) ({ args: argv, env: environment } = gitBoundary(args, baseEnv));
  else if (/(?:^|[\\/])gh(?:\.exe)?$/i.test(command)) environment = gitBoundary(['ls-remote'], baseEnv).env;
  if (command === 'npm') {
    const [node, prefix] = await npmCommand();
    executable = node;
    argv = [...prefix, ...args];
  }
  if (signal?.aborted) throw fail('cancelled', 'Delivery cancelled');
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv, {
      cwd,
      env: environment,
      detached: process.platform !== 'win32',
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '',
      stderr = '',
      bytes = 0,
      terminalError,
      stopping,
      teardownError,
      outputTruncated = false;
    const stop = error => {
      if (terminalError) return;
      terminalError = error;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      stopping = stopOwnedTree(child).catch(cause => {
        teardownError = {
          code: cause.code ?? 'process_teardown',
          message: redactCommandOutput(cause.message, redactions),
        };
        child.kill('SIGKILL');
        child.stdout.destroy();
        child.stderr.destroy();
      });
    };
    const abort = () => stop(fail('cancelled', 'Delivery cancelled'));
    const timer = setTimeout(() => stop(fail('timeout', `${command} timed out`)), timeoutMs);
    const capture = (name, chunk) => {
      if (outputTruncated) return;
      const buffer = Buffer.from(chunk),
        available = Math.max(0, maxOutputBytes - bytes);
      // Decoder.write omits only an incomplete trailing code point; a literal
      // U+FFFD is valid output and must survive. Never fill the gap from a later
      // chunk/stream once this shared capture boundary has been reached.
      const text = buffer.length <= available ? chunk : new StringDecoder('utf8').write(buffer.subarray(0, available));
      bytes += Buffer.byteLength(text);
      if (name === 'stdout') stdout += text;
      else stderr += text;
      if (buffer.length > available) {
        outputTruncated = true;
        stop(fail('invalid_output', `${command} output exceeded limit`));
      }
    };
    child.stdout.on('data', chunk => capture('stdout', chunk));
    child.stderr.on('data', chunk => capture('stderr', chunk));
    child.on('error', error => {
      terminalError ??= error;
    });
    child.once('close', async code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      await stopping;
      const result = { stdout, stderr, code, ...(outputTruncated ? { outputTruncated: true } : {}) };
      if (terminalError)
        return reject(
          commandFailure(
            command,
            terminalError.code ?? 'command_failed',
            result,
            teardownError ? { teardownError } : {},
            redactions,
          ),
        );
      if (code !== 0 && !allowFailure) return reject(commandFailure(command, 'command_failed', result, {}, redactions));
      resolve(result);
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export { sha256, fail, parse, wait, commandRedactions, redactCommandOutput, redactCommandError, commandFailure };
