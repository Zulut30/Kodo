/** ContextManifest: a bounded, hash-addressed record of what one native session
 * was given. It holds sizes, flags and evidence references only, never prompt
 * text, so it cannot carry a secret or an instruction from a retrieved
 * document. Mandatory parts (the task contract with its acceptance, and the
 * coordinator guidance) are never shortened: a session that does not fit its
 * explicit limit is refused instead.
 */
import path from 'node:path';

export const CONTEXT_MANIFEST_VERSION = 1;
const evidenceName = /^([a-z][a-z0-9-]*)-([0-9a-f]{64})\.json$/;
const sha = value => typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
const size = value => Number.isSafeInteger(value) && value >= 0;

/** @returns {never} */
function fail(code, message) {
  throw Object.assign(new Error(`Context manifest: ${message}`), { code });
}

/**
 * A portable reference: evidence kind, file name and hash; the private state
 * path stays out. A reference without a valid hash is recorded as unverifiable
 * rather than refused: the manifest observes a session, it does not gate inputs
 * that `assertEvidence` already checked.
 */
function reference(value) {
  const sha256 = typeof value?.sha256 === 'string' && /^[0-9a-f]{64}$/.test(value.sha256) ? value.sha256 : null;
  const file = path.basename(String(value?.path ?? '')).slice(0, 160);
  const match = evidenceName.exec(file);
  // The kind is trusted only when the file name carries the same hash.
  const kind = sha256 && match && match[2] === sha256 ? match[1] : 'evidence';
  return {
    kind,
    file,
    sha256,
    bytes: size(value?.bytes) ? value.bytes : null,
    headSha: sha(value?.headSha) ? value.headSha : null,
  };
}

/**
 * @typedef {object} ManifestSection
 * @property {string} name
 * @property {number} bytes Bytes sent to the session.
 * @property {boolean} mandatory Never shortened.
 * @property {number} [originalBytes] Size before bounded packing.
 * @property {boolean} [truncated]
 * @property {{ field: string, items?: number, bytes?: number }[]} [omitted] What packing left out, by field.
 */

/**
 * Build and validate the manifest of one session.
 * @param {{ runId: string, stage: string, node?: string | null, headSha?: string | null, limitBytes?: number | null,
 *   sections: ManifestSection[], references?: { path: string, sha256: string, bytes: number, headSha?: string | null }[] }} input
 */
export function buildContextManifest({
  runId,
  stage,
  node = null,
  headSha = null,
  limitBytes = null,
  sections,
  references = [],
}) {
  if (typeof runId !== 'string' || !runId || typeof stage !== 'string' || !stage)
    fail('context_manifest_invalid', 'run and stage are required');
  if (headSha !== null && !sha(headSha)) fail('context_manifest_invalid', 'head is not a commit id');
  if (limitBytes !== null && !(size(limitBytes) && limitBytes > 0))
    fail('context_manifest_invalid', 'limit is invalid');
  if (!Array.isArray(sections) || !sections.length) fail('context_manifest_invalid', 'sections are required');
  const names = new Set();
  const rows = sections.map(section => {
    if (typeof section?.name !== 'string' || !/^[a-z][a-z-]{0,31}$/.test(section.name) || names.has(section.name))
      fail('context_manifest_invalid', 'section names must be unique identifiers');
    names.add(section.name);
    if (!size(section.bytes)) fail('context_manifest_invalid', `section ${section.name} has no size`);
    const truncated = section.truncated === true;
    const omitted = (section.omitted ?? []).map(item => ({
      field: String(item.field).slice(0, 120),
      ...(size(item.items) ? { items: item.items } : {}),
      ...(size(item.bytes) ? { bytes: item.bytes } : {}),
    }));
    if (section.mandatory === true && (truncated || omitted.length))
      fail('context_manifest_invalid', `mandatory section ${section.name} was shortened`);
    // A shortened section must say what it lost: no silent truncation.
    if (truncated && !omitted.length) fail('context_manifest_invalid', `section ${section.name} hides what it omitted`);
    return {
      name: section.name,
      bytes: section.bytes,
      mandatory: section.mandatory === true,
      ...(size(section.originalBytes) ? { originalBytes: section.originalBytes } : {}),
      ...(truncated ? { truncated, omitted } : {}),
    };
  });
  const refs = references.map(reference);
  const contract = refs.find(item => item.kind === 'node-contract') ?? null;
  // A session that carries a task context must carry the immutable contract it was built from.
  const taskContext = rows.find(row => row.name === 'task-context');
  if (taskContext && !(taskContext.mandatory && taskContext.bytes > 0 && contract))
    fail('context_manifest_invalid', 'a task context requires its mandatory node contract');
  const totalBytes = rows.reduce((sum, row) => sum + row.bytes, 0);
  if (limitBytes !== null && totalBytes > limitBytes) {
    const mandatory = rows.filter(row => row.mandatory).reduce((sum, row) => sum + row.bytes, 0);
    throw Object.assign(
      new Error(
        `Context manifest: session context is ${totalBytes} bytes, limit ${limitBytes} (mandatory ${mandatory}); nothing is shortened silently`,
      ),
      { code: 'context_budget', totalBytes, limitBytes, mandatoryBytes: mandatory },
    );
  }
  return {
    schemaVersion: CONTEXT_MANIFEST_VERSION,
    kind: 'context-manifest',
    runId,
    stage,
    node,
    headSha,
    limitBytes,
    totalBytes,
    mandatory: { contract },
    sections: rows,
    references: refs,
  };
}

/**
 * Is a stored manifest still a description of current inputs?
 * `invalidated`: a referenced evidence file is gone or has another hash.
 * `stale`: the evidence is intact but the head moved since.
 * @param {any} manifest
 * @param {{ headSha?: string | null, hashes?: Record<string, string | null> }} current
 *   `hashes` maps evidence file names to their present SHA-256, or null when missing.
 * @returns {{ status: 'fresh' | 'stale' | 'invalidated' | 'unknown', reasons: string[] }}
 */
export function manifestFreshness(manifest, { headSha, hashes } = {}) {
  if (manifest?.kind !== 'context-manifest' || manifest.schemaVersion !== CONTEXT_MANIFEST_VERSION)
    return { status: 'unknown', reasons: ['unsupported_manifest'] };
  const reasons = [];
  if (hashes)
    for (const item of manifest.references.filter(item => item.sha256 !== null)) {
      const present = Object.hasOwn(hashes, item.file) ? hashes[item.file] : null;
      if (present !== item.sha256) reasons.push(`${present === null ? 'missing' : 'changed'}:${item.file}`);
    }
  if (reasons.length) return { status: 'invalidated', reasons };
  if (!hashes || headSha === undefined) return { status: 'unknown', reasons: ['not_observed'] };
  if (manifest.headSha !== headSha) return { status: 'stale', reasons: ['head_moved'] };
  return { status: 'fresh', reasons: [] };
}
