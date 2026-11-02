import os from 'node:os';
import path from 'node:path';
import { mkdir, readFile, chmod } from 'node:fs/promises';

export const secretNames = ['GEMINI_API_KEY', 'TYPESAFE_API_KEY', 'SCRAPEDO_TOKEN', 'REDDIT_API_KEY', 'GETX_API_KEY'];
export function stateHome() { return path.resolve(process.env.KODO_HOME || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'state'), 'Kodo')); }
export async function loadSecrets() {
  const home = stateHome();
  await mkdir(home, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(home, 0o700);
  let stored = {};
  try { stored = JSON.parse((await readFile(path.join(home, 'secrets.json'), 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Не удалось прочитать пользовательское хранилище ключей Kodo'); }
  return Object.fromEntries(secretNames.map(name => [name, process.env[`KODO_${name}`] || process.env[name] || stored[name] || '']));
}
export function redact(value, secrets = {}) {
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of Object.values(secrets)) if (typeof secret === 'string' && secret.length > 5) text = text.split(secret).join('[REDACTED]');
  text = text.replace(/AIza[\w-]{25,}/g, '[REDACTED]').replace(/(?:apikey_|get-x-api-|reddit-api-|sk-(?:proj-)?)[A-Za-z0-9_-]{16,}/g, '[REDACTED]');
  text = text.replace(/(Bearer\s+)[^\s"'<>]+/gi, '$1[REDACTED]').replace(/([?&](?:token|key|api_key)=)[^&\s"']+/gi, '$1[REDACTED]');
  return typeof value === 'string' ? text : JSON.parse(text);
}
export function workerEnvironment(base = process.env) {
  return Object.fromEntries(Object.entries(base).filter(([name]) => !/(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|DATABASE_URL|SCRAPEDO|REDDIT_API|GETX|TYPESAFE|GEMINI|OPENROUTER|BASE_URL|USE_BEDROCK|USE_VERTEX|USE_FOUNDRY)/i.test(name) && !/^(?:KODO_|GH_|GITHUB_)/i.test(name) && (!/^CODEX_/i.test(name) || name === 'CODEX_HOME')));
}
export function secretFile(name) { return /(?:^|\/)(?:\.env(?:\..*)?|auth\.json|secrets?(?:\..*)?|credentials?(?:\..*)?|[^/]*\.(?:pem|key|pfx))$/i.test(name); }
