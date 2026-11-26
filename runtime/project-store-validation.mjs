import { isDeepStrictEqual } from 'node:util';
import { redact } from './security.mjs';

export const fail = code => {
  throw Object.assign(new Error('Project ' + code), { code: 'project_' + code });
};
export const requireValue = (condition, code = 'record_invalid') => {
  if (!condition) fail(code);
};
export function createValidationCache(store, contracts, options) {
  // Bound the retained bytes of encoded keys and detached normalized values.
  const validationCache = new Map(),
    validationLimit = 8 * 1024 * 1024;
  let validationBytes = 0,
    validationSecrets = structuredClone(store.secrets || {});
  function refresh() {
    if (isDeepStrictEqual(validationSecrets, store.secrets || {})) return;
    validationCache.clear();
    validationBytes = 0;
    validationSecrets = structuredClone(store.secrets || {});
    options.knownValues = Object.values(validationSecrets).filter(
      value => typeof value === 'string' && value.length > 0,
    );
  }

  function safe(value) {
    refresh();
    contracts.assertDirectorSafe(value, options);
    requireValue(isDeepStrictEqual(value, redact(value, store.secrets || {})), 'secret_redaction_required');
  }

  function normalize(kind, value) {
    safe(value);
    const normalized = contracts.normalizeDirectorRecord(kind, value, options);
    safe(normalized);
    return normalized;
  }

  function validated(kind, text, parse = () => JSON.parse(text)) {
    refresh();
    const key = kind + '\0' + text,
      cached = validationCache.get(key);
    if (cached) {
      validationCache.delete(key);
      validationCache.set(key, cached);
      return structuredClone(cached.value);
    }
    const value = normalize(kind, parse());
    const size = Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value));
    if (size <= validationLimit) {
      while (validationCache.size && (validationCache.size >= 2048 || validationBytes + size > validationLimit)) {
        const oldest = validationCache.keys().next().value;
        validationBytes -= validationCache.get(oldest).size;
        validationCache.delete(oldest);
      }
      validationCache.set(key, { value: structuredClone(value), size });
      validationBytes += size;
    }
    return value;
  }

  return { refresh, safe, normalize, validated };
}
