import { createHash } from 'node:crypto';
import path from 'node:path';

export const uiTools = [
  'agent-desktop',
  'browser-harness',
  'browser-use',
  'vibetest',
  'jev-ultrafast',
  'chrome-devtools-mcp',
];
export const modelTools = ['browser-use', 'vibetest', 'jev-ultrafast'];
export const hash = value => createHash('sha256').update(value).digest('hex');
export function fail(code, blocked = false) {
  return Object.assign(new Error(code), { code, blocked });
}
function object(value, keys) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(k => !keys.includes(k)))
    throw fail('invalid_ui_config');
}
function string(value, max = 2000, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max || value.includes('\0'))
    throw fail('invalid_ui_config');
  return value;
}
function boolean(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw fail('invalid_ui_config');
  return value;
}
function integer(value, min, max, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw fail('invalid_ui_config');
  return value;
}
export function httpURL(value) {
  string(value);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw fail('invalid_ui_url');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /[\r\n\\]/.test(value))
    throw fail('invalid_ui_url');
  return url.href;
}
export function normalizeUIConfig(value = undefined) {
  value ??= {};
  object(value, ['enabled', 'cases', 'autoInstall', 'maxSteps', 'timeoutMs', 'start', 'executablePath']);
  const config = {
    enabled: boolean(value.enabled, false),
    cases: [],
    autoInstall: boolean(value.autoInstall, true),
    maxSteps: integer(value.maxSteps, 1, 30, 12),
    timeoutMs: integer(value.timeoutMs, 1000, 600000, 180000),
  };
  if (!Array.isArray(value.cases ?? []) || (value.cases?.length ?? 0) > 20) throw fail('invalid_ui_config');
  const ids = new Set();
  for (const item of value.cases ?? []) {
    object(item, ['id', 'tool', 'url', 'goal', 'steps', 'assertions', 'app', 'windowId']);
    if (
      typeof item.id !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(item.id) ||
      ids.has(item.id) ||
      !uiTools.includes(item.tool)
    )
      throw fail('invalid_ui_config');
    ids.add(item.id);
    const desktop = item.tool === 'agent-desktop',
      c = { id: item.id, tool: item.tool };
    if (desktop) {
      if (item.url !== undefined || item.goal !== undefined) throw fail('invalid_ui_config');
      c.app = string(item.app, 256);
      if (item.windowId !== undefined) c.windowId = string(item.windowId, 128);
    } else {
      if (item.app !== undefined || item.windowId !== undefined) throw fail('invalid_ui_config');
      c.url = httpURL(item.url);
      if (modelTools.includes(item.tool) || item.goal !== undefined) c.goal = string(item.goal, 8000);
    }
    if (!Array.isArray(item.steps ?? []) || (item.steps?.length ?? 0) > config.maxSteps)
      throw fail('invalid_ui_config');
    c.steps = (item.steps ?? []).map(step => {
      object(step, desktop ? ['action', 'name', 'role', 'value'] : ['action', 'selector', 'name', 'value']);
      if (!(desktop ? ['set-value', 'click'] : ['fill', 'click']).includes(step.action))
        throw fail('invalid_ui_config');
      const s = {
        action: step.action,
        [desktop ? 'name' : 'selector']: string(step[desktop ? 'name' : 'selector'], 512),
      };
      for (const field of desktop ? ['role'] : ['name'])
        if (step[field] !== undefined) s[field] = string(step[field], 256);
      if (step.action !== 'click') s.value = string(step.value, 2000, true);
      else if (step.value !== undefined) throw fail('invalid_ui_config');
      return s;
    });
    if (!Array.isArray(item.assertions) || !item.assertions.length || item.assertions.length > 30)
      throw fail('invalid_ui_config');
    c.assertions = item.assertions.map(a => {
      object(a, desktop ? ['text'] : ['selector', 'text', 'value', 'exists']);
      if (desktop) return { text: string(a.text) };
      const result = { selector: string(a.selector, 512) };
      if (a.text !== undefined) result.text = string(a.text, 2000, true);
      if (a.value !== undefined) result.value = string(a.value, 2000, true);
      result.exists = boolean(a.exists, true);
      if (!result.exists && (a.text !== undefined || a.value !== undefined)) throw fail('invalid_ui_config');
      return result;
    });
    config.cases.push(c);
  }
  if (config.enabled && !config.cases.length) throw fail('invalid_ui_config');
  if (value.executablePath !== undefined) {
    config.executablePath = string(value.executablePath);
    if (!path.isAbsolute(config.executablePath)) throw fail('invalid_ui_config');
  }
  if (value.start !== undefined) {
    object(value.start, ['command', 'args']);
    const command = string(value.start.command, 2048);
    if (
      /^(?:cmd|powershell|pwsh|sh|bash|zsh|fish|wscript|cscript)(?:\.exe)?$/i.test(path.basename(command)) ||
      /[\r\n]/.test(command)
    )
      throw fail('invalid_ui_config');
    if (!Array.isArray(value.start.args) || value.start.args.length > 64) throw fail('invalid_ui_config');
    config.start = { command, args: value.start.args.map(a => string(a, 4096, true)) };
  }
  return config;
}
export const uiConfigHash = config => hash(JSON.stringify(normalizeUIConfig(config)));

// Observation is data read directly from a DOM/accessibility API, never an LLM verdict.
export function assessObservations(c, observations) {
  if (!Array.isArray(observations) || observations.length !== c.assertions.length) throw fail('malformed_output');
  return c.assertions.map((a, index) => {
    const o = observations[index];
    let passed;
    if (c.tool === 'agent-desktop') {
      if (
        !o ||
        !Array.isArray(o.texts) ||
        o.texts.length > 10000 ||
        !o.texts.every(t => typeof t === 'string' && t.length <= 10000)
      )
        throw fail('malformed_output');
      passed = o.texts.some(t => t === a.text);
    } else {
      if (
        !o ||
        typeof o.exists !== 'boolean' ||
        !Number.isInteger(o.count) ||
        o.count < 0 ||
        o.count > 100000 ||
        o.exists !== o.count > 0 ||
        !(o.text === null || typeof o.text === 'string') ||
        !(o.value === null || typeof o.value === 'string')
      )
        throw fail('malformed_output');
      passed = a.exists
        ? o.count === 1 && (a.text === undefined || o.text === a.text) && (a.value === undefined || o.value === a.value)
        : o.count === 0;
    }
    return { index, passed, kind: c.tool === 'agent-desktop' ? 'accessibility' : 'dom' };
  });
}
export function observationFunction(assertions, url) {
  // Only selectors are embedded as JSON data. The model cannot supply JS.
  return `() => { if(location.origin !== ${JSON.stringify(new URL(url).origin)} || document.readyState === 'loading') throw new Error('incomplete_observation'); return ${JSON.stringify(assertions.map(a => a.selector))}.map(selector => { const nodes = document.querySelectorAll(selector); const e = nodes[0]; return { exists: nodes.length > 0, count: nodes.length, text: e ? e.textContent.trim().slice(0,10000) : null, value: e && 'value' in e ? String(e.value).slice(0,10000) : null }; }); }`;
}
