import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { execute, resolveCommand } from './command.mjs';
import { fail, observationFunction, modelTools } from './ui-schema.mjs';

// Complete environment, not an overlay: don't inherit cloud/profile/provider settings.
export function uiEnvironment(home, base = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(base)) if (/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|LANG|LC_ALL|DISPLAY|WAYLAND_DISPLAY|XDG_RUNTIME_DIR)$/i.test(key)) env[key] = value;
  return { ...env, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TEMP: home, TMP: home, TMPDIR: home,
    XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8',
    PYTHON_DOTENV_DISABLED: '1', ANONYMIZED_TELEMETRY: 'false', BROWSER_USE_LOGGING_LEVEL: 'critical', BROWSER_USE_DISABLE_UPDATE_CHECK: 'true',
    NO_UPDATE_CHECKS: '1', DO_NOT_TRACK: '1', BH_RECORD: '0', BH_TAB_MARKER: '0', BH_OPEN_LIVE_URL: '0', BH_DOMAIN_SKILLS: '0' };
}
export function browserEnvironment(home, base = process.env, platform = process.platform) {
  const env = uiEnvironment(home, base);
  // Windows Chrome resolves system known folders before honoring its explicit
  // user-data-dir. Fabricated account folders break that resolution. Omit the
  // account overrides rather than inherit personal folder values or API keys.
  if (platform === 'win32') for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) delete env[name];
  return env;
}
export function ownedProcess(command, args, { cwd, env, signal } = {}) {
  const resolved = resolveCommand(command, args);
  const child = spawn(resolved.command, resolved.args, { cwd, env, shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: 'ignore' });
  let failure, stopping;
  child.on('error', () => { failure = fail('process_unavailable', true); });
  const stop = () => stopping ??= (async () => {
    if (!child.pid) return;
    let cleanupFailed = false;
    if (process.platform === 'win32') {
      // Kill only this owned process and its descendants, never by executable name.
      const result = await execute(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { env: uiEnvironment(os.tmpdir()), timeoutMs: 10000, allowFailure: true }).catch(() => null);
      // Restricted worker tokens can deny taskkill. Always terminate our direct
      // child too, and report incomplete tree cleanup instead of claiming success.
      if (child.exitCode === null) child.kill();
      if (!result || (result.code !== 0 && child.exitCode === null)) cleanupFailed = true;
    } else {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      await delay(100);
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }
    if (child.exitCode === null && child.signalCode === null) await Promise.race([new Promise(resolve => child.once('close', resolve)), delay(2000)]);
    signal?.removeEventListener('abort', abort);
    if (cleanupFailed || (child.exitCode === null && child.signalCode === null)) throw fail('cleanup_failed');
  })();
  const abort = () => { void stop().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  return { child, stop, check() { if (failure) throw failure; if (signal?.aborted) throw fail('cancelled'); if (child.exitCode !== null) throw fail('process_exited'); } };
}
export async function waitUntil(check, { signal, timeoutMs = 15000 } = {}) {
  const end = Date.now() + timeoutMs;
  do { if (signal?.aborted) throw fail('cancelled'); const found = await check(); if (found) return found; await delay(100, undefined, { signal }); } while (Date.now() < end);
  throw fail('timeout');
}
export async function startProjectServer(start, { cwd, env, url, signal, timeoutMs }) {
  const ping = async () => { try { const response = await fetch(url, { signal: AbortSignal.timeout(500), redirect: 'manual' }); await response.body?.cancel(); return response.status; } catch { return null; } };
  if (await ping() !== null) throw fail('server_already_running', true);
  const process = ownedProcess(start.command, start.args, { cwd, env, signal });
  try { await waitUntil(async () => { process.check(); const status = await ping(); return status !== null && status < 400; }, { signal, timeoutMs: Math.min(timeoutMs, 30000) }); return process; }
  catch (e) { await process.stop(); throw e; }
}
function chromeExecutable(config) {
  // Binary discovery only. Never inspect user profiles, DevTools ports or running browsers.
  const candidates = config.executablePath ? [config.executablePath] : process.platform === 'win32'
    ? [path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'), path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe')]
    : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'] : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const executable = candidates.find(existsSync);
  if (!executable) throw fail('browser_missing', true);
  return executable;
}
export async function launchOwnedBrowser({ config, signal }) {
  const executablePath = chromeExecutable(config);
  // Short unique OS-temp paths also avoid Windows IPC/path limits.
  // External Chrome must see the physical directory, including MSIX redirected
  // Windows temp roots; a logical path can otherwise name a different profile.
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kui-')));
  const profile = path.join(directory, 'profile'); await mkdir(profile, { mode: 0o700 });
  const process = ownedProcess(executablePath, [`--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync', '--disable-extensions', '--disable-component-update', 'about:blank'], { cwd: directory, env: browserEnvironment(directory), signal });
  const close = async () => { try { await process.stop(); } finally { await rm(directory, { recursive: true, force: true, maxRetries: 3 }).catch(() => {}); } };
  try {
    const cdpUrl = await waitUntil(async () => {
      process.check();
      let data; try { data = await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8'); } catch { return null; }
      const [port, endpoint] = data.trim().split(/\r?\n/);
      if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535 || !endpoint?.startsWith('/devtools/browser/')) throw fail('malformed_browser_endpoint');
      return `http://127.0.0.1:${port}`;
    }, { signal, timeoutMs: Math.min(config.timeoutMs, 20000) });
    return { cdpUrl, executablePath, close };
  } catch (e) { await close(); throw e; }
}
function parseJSON(output) {
  if (typeof output !== 'string' || Buffer.byteLength(output) > 2 * 1024 * 1024) throw fail('malformed_output');
  try { return JSON.parse(output); } catch { throw fail('malformed_output'); }
}

export async function runDesktopCase({ case: c, config, tool, evidenceDir, signal, runner = execute }) {
  const env = { ...uiEnvironment(evidenceDir), ...tool.env, AGENT_DESKTOP_HOME: path.join(evidenceDir, 'desktop') };
  const call = async (args, action = false) => {
    const output = await runner(tool.command, [...tool.args, ...args], { cwd: evidenceDir, env, signal, timeoutMs: Math.min(config.timeoutMs, 20000), allowFailure: true, rawOutput: true });
    const r = parseJSON(output?.stdout);
    if (r.version !== '2.5' || typeof r.ok !== 'boolean' || r.command !== args[0]) throw fail('malformed_output');
    if (r.ok && output.code === 0 && r.data && typeof r.data === 'object') return r.data;
    if (action && r.ok === false && r.error?.disposition?.delivery && r.error.disposition.delivery !== 'not_delivered') return { uncertain: true };
    throw fail(['AMBIGUOUS_TARGET', 'PERM_DENIED', 'PLATFORM_NOT_SUPPORTED', 'WINDOW_NOT_FOUND', 'APP_NOT_FOUND'].includes(r.error?.code) ? 'desktop_unavailable' : 'desktop_error', true);
  };
  // Documentation is embedded in this exact native binary. No trace-enabled session.
  await call(['skills', 'get', 'desktop']);
  let windowId = c.windowId;
  if (!windowId) {
    const windows = await call(['list-windows', '--app', c.app]);
    if (!Array.isArray(windows) || windows.length !== 1 || typeof windows[0]?.id !== 'string' || !windows[0].id) throw fail('ambiguous_target', true);
    windowId = windows[0].id;
  }
  const scope = ['--app', c.app, '--window-id', windowId];
  const snapshot = async () => {
    const s = await call(['snapshot', ...scope]);
    if (s.complete !== true || !s.tree || s.window?.id !== windowId) throw fail('incomplete_observation');
    return s;
  };
  const find = async step => {
    const found = await call(['find', ...scope, '--name', step.name, '--exact', '--limit', '2', ...(step.role ? ['--role', step.role] : [])]);
    if (!Array.isArray(found.matches) || found.matches.length !== 1 || found.truncated === true || !/^@[a-zA-Z0-9_-]+:e\d+$/.test(found.matches[0]?.ref_id || '')) throw fail('ambiguous_target', true);
    return found.matches[0].ref_id;
  };
  let uncertain = false;
  for (const [index, step] of c.steps.entries()) {
    const ref = await find(step);
    const result = await call([step.action, ref, ...(step.action === 'set-value' ? [step.value] : [])], true);
    const fresh = await snapshot();
    if (step.action === 'set-value') {
      const newRef = await find(step);
      const read = await call(['get', newRef, '--property', 'value']);
      if (read.value !== step.value) throw fail('action_readback_failed');
    }
    // Fresh independent assertions may verify the final uncertain action. Never
    // repeat it or execute later mutations while delivery remains uncertain.
    if (result.uncertain) { uncertain = index < c.steps.length - 1; break; }
    if (!fresh.complete) throw fail('incomplete_observation');
  }
  const final = await snapshot(), texts = [];
  function visit(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 100 || texts.length > 10000) throw fail('malformed_output');
    for (const key of ['name', 'value', 'text', 'title']) if (typeof node[key] === 'string') texts.push(node[key].slice(0, 10000));
    for (const child of node.children ?? []) visit(child, depth + 1);
  }
  visit(final.tree);
  return { schemaVersion: 1, status: uncertain ? 'failed' : 'completed', ...(uncertain ? { reason: 'uncertain_delivery' } : {}), observations: c.assertions.map(() => ({ texts })), steps: c.steps.length };
}

export async function runChromeCase({ case: c, config, tool, evidenceDir, signal, browser, connect }) {
  let client, transport;
  try {
    if (connect) ({ client, transport } = await connect());
    else {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
      transport = new StdioClientTransport({ command: tool.command, args: [...tool.args, `--browserUrl=${browser.cdpUrl}`, '--no-usage-statistics', '--no-performance-crux'], env: { ...uiEnvironment(evidenceDir), ...tool.env, NO_UPDATE_CHECKS: '1' }, cwd: evidenceDir, stderr: 'ignore' });
      client = new Client({ name: 'kodo-ui-verification', version: '1.0.0' });
      await client.connect(transport, { signal, timeout: Math.min(config.timeoutMs, 20000) });
    }
    const abort = () => { void transport.close(); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const tools = await client.listTools({}, { signal, timeout: 15000 });
      const definitions = new Map(tools.tools.map(t => [t.name, t]));
      let pageId;
      const call = async (name, args = {}) => {
        const definition = definitions.get(name);
        if (!definition) throw fail('unsupported_tool_api', true);
        if (pageId !== undefined && definition.inputSchema?.properties?.pageId) args = { pageId, ...args };
        const r = await client.callTool({ name, arguments: args }, undefined, { signal, timeout: Math.min(config.timeoutMs, 20000) });
        if (r.isError || !Array.isArray(r.content) || r.content.some(x => x.type !== 'text')) throw fail('mcp_error');
        const text = r.content.map(x => x.text).join('\n');
        if (text.length > 2 * 1024 * 1024) throw fail('malformed_output');
        return text;
      };
      const pages = await call('list_pages');
      const found = [...pages.matchAll(/^\s*(\d+):\s+about:blank(?:\s|$)/gm)];
      if (found.length !== 1) throw fail('ambiguous_target');
      pageId = Number(found[0][1]);
      await call('select_page', { pageId, bringToFront: false });
      await call('navigate_page', { type: 'url', url: c.url, timeout: Math.min(config.timeoutMs, 20000) });
      const evaluate = async (fn, args) => {
        const text = await call('evaluate_script', { function: fn, ...(args ? { args } : {}) });
        const matches = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)];
        if (matches.length !== 1) throw fail('malformed_output');
        return parseJSON(matches[0][1]);
      };
      for (const step of c.steps) {
        const snapshot = await call('take_snapshot');
        // Test candidate UIDs against the configured CSS selector in the same live document.
        // No model-derived code, no selector guessing by label.
        const uids = [...new Set([...snapshot.matchAll(/\buid=([\w-]+)/g)].map(m => m[1]))];
        if (!uids.length || uids.length > 500) throw fail('incomplete_observation');
        const selected = await evaluate(`(...elements) => { const nodes = document.querySelectorAll(${JSON.stringify(step.selector)}); if(nodes.length !== 1) return -1; return elements.findIndex(e => e === nodes[0]); }`, uids);
        if (!Number.isInteger(selected) || selected < 0 || selected >= uids.length) throw fail('ambiguous_target', true);
        await call(step.action, { uid: uids[selected], ...(step.action === 'fill' ? { value: step.value } : {}) });
      }
      const observations = await evaluate(observationFunction(c.assertions, c.url));
      return { schemaVersion: 1, status: 'completed', observations, steps: c.steps.length };
    } finally { signal?.removeEventListener('abort', abort); }
  } finally { await client?.close().catch(() => {}); await transport?.close().catch(() => {}); }
}

export async function runInstalledCase({ case: c, config, tool, evidenceDir, secrets = {}, signal, runner = execute }) {
  if (c.tool === 'agent-desktop') return runDesktopCase({ case: c, config, tool, evidenceDir, signal, runner });
  const browsers = [];
  try {
    for (let i = 0; i < (c.tool === 'vibetest' ? 3 : 1); i++) browsers.push(await launchOwnedBrowser({ config, signal }));
    if (c.tool === 'chrome-devtools-mcp') return await runChromeCase({ case: c, config, tool, evidenceDir, signal, browser: browsers[0] });
    const bridge = fileURLToPath(new URL('./ui-bridge.py', import.meta.url));
    const request = { schemaVersion: 1, case: c, maxSteps: config.maxSteps, timeoutMs: config.timeoutMs, evidenceDir, cdpUrl: browsers[0].cdpUrl, cdpUrls: browsers.map(b => b.cdpUrl), executablePath: browsers[0].executablePath };
    const env = { ...uiEnvironment(evidenceDir), ...tool.env };
    if (modelTools.includes(c.tool)) env.GEMINI_API_KEY = secrets.GEMINI_API_KEY;
    if (c.tool === 'jev-ultrafast') env.TYPESAFE_API_KEY = secrets.TYPESAFE_API_KEY;
    try {
      const output = await runner(tool.command, [...tool.args, bridge], { cwd: evidenceDir, input: JSON.stringify(request), env, signal, timeoutMs: config.timeoutMs, allowFailure: true, rawOutput: true });
      if (output?.code !== 0) throw fail('bridge_error');
      return parseJSON(output.stdout);
    } finally {
      // Daemons may outlive a killed bridge. Stop only this case's named daemon, credential-free.
      if (['browser-harness', 'jev-ultrafast'].includes(c.tool)) {
        const output = await runner(tool.command, [...tool.args, bridge, '--cleanup'], { cwd: evidenceDir, input: JSON.stringify(request), env: { ...uiEnvironment(evidenceDir), ...tool.env }, timeoutMs: 15000, allowFailure: true, rawOutput: true });
        if (output?.code !== 0 || parseJSON(output.stdout).status !== 'cleaned') throw fail('cleanup_failed');
      }
    }
  } finally {
    const closed = await Promise.allSettled(browsers.reverse().map(browser => browser.close()));
    if (closed.some(c => c.status === 'rejected')) throw fail('cleanup_failed');
  }
}
