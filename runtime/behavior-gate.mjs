/** Behaviour gate: deterministic, model-free checks of the final head that
 * outrank a reviewer's report.
 *
 * 1. QualityPolicy: the change is classified by its changed paths, and each
 *    type names the gates it needs. A needed gate that is disabled is a
 *    recorded gap, never a PASS.
 * 2. Test protection: tests that existed on the base may not be deleted,
 *    skipped, focused or stripped of their cases and assertions.
 * 3. Behavioural oracles: project-owned commands (contract tests, comparison
 *    with a reference tool) run by the coordinator. The files an oracle
 *    protects must be byte-identical to the base.
 *
 * The receipt is bound to the exact head, base and configuration.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ownsPath } from './contracts.mjs';
import { execute } from './command.mjs';
import { workerEnvironment } from './security.mjs';
import {
  panicWeakened,
  rustCrateDir,
  rustCrateRootProbe,
  rustMacroUse,
  rustRegistryCheck,
  rustTargetGroup,
  selectionNarrowed,
} from './behavior-rust.mjs';
import { languageOf, casesOf } from './behavior-scanners.mjs';

export { rustTestCases } from './behavior-rust.mjs';

export const BEHAVIOR_GATE_VERSION = 1;
const hash = value => createHash('sha256').update(value).digest('hex');

/** @returns {never} */
function invalid(message) {
  throw Object.assign(new Error(`Некорректная конфигурация Kodo: verification: ${message}`), {
    code: 'configuration',
  });
}

const relativeScope = scope =>
  typeof scope === 'string' &&
  Boolean(scope) &&
  !scope.includes('\\') &&
  !scope.startsWith('/') &&
  !scope.includes(':') &&
  !scope.split('/').includes('..');

/**
 * @typedef {object} VerificationConfig
 * @property {boolean} baseline Run the check commands on the base commit before any edit.
 * @property {boolean} testProtection Refuse removed and switched-off tests.
 * @property {string[]} testRemovalAllowed Test paths (globs) this run may delete or reduce: an explicit, narrow exception.
 * @property {boolean} strictGates A gate the policy needs but the project disabled fails the gate.
 * @property {boolean} testRegistry On a full gate of a Rust project, compare the libtest registry of the base and the head.
 * @property {{ id: string, command: string, args: string[], timeoutMs?: number, protect: string[],
 *   budgets?: OracleBudget[] }[]} oracles
 */

/**
 * A number the oracle reports in its result file (`KODO_ORACLE_RESULT`), with its bound:
 * the oracle passes only when it exits 0 and every budget is met.
 * @typedef {{ metric: string, max?: number, min?: number }} OracleBudget
 */
const metricName = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

/** Validates the budgets of one oracle and returns their normalized copy. */
function normalizeBudgets(id, budgets) {
  if (!Array.isArray(budgets) || !budgets.length || budgets.length > 8)
    invalid(`oracle ${id} budgets must be a list of 1 to 8`);
  return budgets.map(budget => {
    if (!budget || typeof budget !== 'object' || Array.isArray(budget))
      invalid(`oracle ${id} budget must be an object`);
    for (const key of Object.keys(budget))
      if (!['metric', 'max', 'min'].includes(key)) invalid(`unknown oracle ${id} budget key ${key}`);
    if (typeof budget.metric !== 'string' || !metricName.test(budget.metric))
      invalid(`oracle ${id} budget metric must be a metric name`);
    for (const key of ['max', 'min'])
      if (budget[key] !== undefined && (typeof budget[key] !== 'number' || !Number.isFinite(budget[key])))
        invalid(`oracle ${id} budget ${key} must be a number`);
    if (budget.max === undefined && budget.min === undefined) invalid(`oracle ${id} budget needs max or min`);
    if (budget.max !== undefined && budget.min !== undefined && budget.min > budget.max)
      invalid(`oracle ${id} budget min is above max`);
    return {
      metric: budget.metric,
      ...(budget.max === undefined ? {} : { max: budget.max }),
      ...(budget.min === undefined ? {} : { min: budget.min }),
    };
  });
}

/**
 * @param {unknown} [value]
 * @returns {VerificationConfig}
 */
export function normalizeVerificationConfig(value = undefined) {
  const input = /** @type {Record<string, any>} */ (value === undefined ? {} : value);
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('an object is expected');
  const known = ['baseline', 'testProtection', 'testRemovalAllowed', 'strictGates', 'testRegistry', 'oracles'];
  for (const key of Object.keys(input)) if (!known.includes(key)) invalid(`unknown key ${key}`);
  for (const key of ['baseline', 'testProtection', 'strictGates', 'testRegistry'])
    if (input[key] !== undefined && typeof input[key] !== 'boolean') invalid(`${key} must be boolean`);
  const allowed = input.testRemovalAllowed ?? [];
  if (!Array.isArray(allowed) || allowed.length > 64 || allowed.some(scope => !relativeScope(scope)))
    invalid('testRemovalAllowed must be a short list of repository-relative paths');
  const oracles = input.oracles ?? [];
  if (!Array.isArray(oracles) || oracles.length > 8) invalid('oracles must be a list of at most 8');
  const ids = new Set();
  const normalized = oracles.map(oracle => {
    if (!oracle || typeof oracle !== 'object' || Array.isArray(oracle)) invalid('an oracle must be an object');
    for (const key of Object.keys(oracle))
      if (!['id', 'command', 'args', 'timeoutMs', 'protect', 'budgets'].includes(key))
        invalid(`unknown oracle key ${key}`);
    if (typeof oracle.id !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(oracle.id) || ids.has(oracle.id))
      invalid('oracle id must be a unique slug');
    ids.add(oracle.id);
    if (typeof oracle.command !== 'string' || !oracle.command.trim()) invalid(`oracle ${oracle.id} has no command`);
    const args = oracle.args ?? [];
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) invalid(`oracle ${oracle.id} args`);
    const protect = oracle.protect ?? [];
    if (
      !Array.isArray(protect) ||
      !protect.length ||
      protect.length > 64 ||
      protect.some(
        scope =>
          typeof scope !== 'string' ||
          !scope ||
          scope.includes('\\') ||
          scope.startsWith('/') ||
          scope.includes(':') ||
          scope.split('/').includes('..'),
      )
    )
      invalid(`oracle ${oracle.id} must protect repository-relative paths`);
    if (
      oracle.timeoutMs !== undefined &&
      (!Number.isInteger(oracle.timeoutMs) || oracle.timeoutMs < 0 || oracle.timeoutMs > 2147483647)
    )
      invalid(`oracle ${oracle.id} timeoutMs`);
    return {
      id: oracle.id,
      command: oracle.command,
      args: [...args],
      ...(oracle.timeoutMs === undefined ? {} : { timeoutMs: oracle.timeoutMs }),
      protect: [...protect],
      ...(oracle.budgets === undefined ? {} : { budgets: normalizeBudgets(oracle.id, oracle.budgets) }),
    };
  });
  return {
    baseline: input.baseline ?? false,
    testProtection: input.testProtection ?? true,
    testRemovalAllowed: [...allowed],
    strictGates: input.strictGates ?? false,
    testRegistry: input.testRegistry ?? true,
    oracles: normalized,
  };
}

/** The hash of a verification block. A default `testRegistry` is left out, so the hash of an older block stays. */
export const verificationConfigHash = config => {
  const { testRegistry, ...rest } = normalizeVerificationConfig(config);
  return hash(
    JSON.stringify({ version: BEHAVIOR_GATE_VERSION, config: testRegistry ? rest : { ...rest, testRegistry } }),
  );
};

/** @type {[string, RegExp][]} */
const changeTypes = [
  [
    'ci',
    /(^|\/)\.github\/(?:workflows|actions)\/|(^|\/)\.github\/dependabot\.ya?ml$|(^|\/)\.gitlab-ci\.yml$|(^|\/)azure-pipelines\.yml$|(^|\/)Jenkinsfile$|(^|\/)\.circleci\/|(^|\/)Dockerfile[^/]*$|(^|\/)docker-compose[^/]*\.ya?ml$|\.tf$/i,
  ],
  [
    'release',
    /(^|\/)(?:CHANGELOG[^/]*|\.releaserc[^/]*|release[^/]*\.(?:json|ya?ml|[cm]?js))$|(^|\/)scripts\/release/i,
  ],
  ['schema', /(^|\/)(?:migrations?|schema|prisma|db)\/|\.sql$|(^|\/)schema\.[a-z]+$/i],
  [
    'security',
    // Whole words only: `AUTHORS.md` and `src/author.ts` are not authentication.
    /(^|\/)(?:auth|authn|authz|authentication|authorization|oauth\d?|login|security|crypto|cryptography|permissions?|secrets?|sessions?|acl)(?:\/|\.|-|_|$)|(^|\/)\.env[^/]*$/i,
  ],
  [
    'api',
    /(^|\/)(?:api|routes?|controllers?|handlers?|graphql|proto)\/|\.(?:proto|graphql)$|openapi[^/]*\.(?:ya?ml|json)$/i,
  ],
  [
    'tests',
    /(^|\/)(?:tests?|__tests__|spec)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.(?:go|py|rs)$|(^|\/)test_[^/]+\.py$/i,
  ],
  ['style', /\.(?:css|scss|sass|less|styl|pcss)$/i],
  // By extension only: a script under docs/ is code.
  [
    'content',
    /\.(?:md|mdx|rst|adoc)$|(^|\/)LICENSE[^/]*$|(^|\/)(?!CMakeLists\.txt$|requirements[^/]*\.txt$)[^/]+\.txt$/i,
  ],
  [
    'config',
    /(^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.(?:toml|lock)|go\.(?:mod|sum)|pyproject\.toml|requirements[^/]*\.txt|CMakeLists\.txt|Makefile|kodo\.config\.json|tsconfig[^/]*\.json|(?:jest|vitest|vite|webpack|rollup|babel|eslint|prettier|playwright)\.config\.[cm]?[jt]s|\.[a-z]+rc(?:\.[a-z]+)?)$/i,
  ],
];
const isTestFile = file => changeTypes.find(([type]) => type === 'tests')[1].test(file);
const highRisk = new Set(['ci', 'release', 'schema', 'security']);
const lowRisk = new Set(['style', 'content', 'tests']);
/** Gates each change type needs. `oracle` means at least one configured behavioural oracle. */
const neededGates = {
  style: ['ui'],
  security: ['security'],
  ci: ['security'],
  release: ['security'],
  config: ['security'],
  schema: ['oracle'],
  api: ['architecture'],
};

/**
 * Change types of a set of changed paths. A path with no specific type is `code`.
 * @param {string[]} paths
 * @returns {string[]} Sorted unique types.
 */
export function classifyChange(paths) {
  const types = new Set();
  for (const file of paths) {
    const matched = changeTypes.filter(([, pattern]) => pattern.test(file)).map(([type]) => type);
    for (const type of matched.length ? matched : ['code']) types.add(type);
  }
  return [...types].sort();
}

/**
 * What a change of these types requires and what the project cannot verify.
 * @param {{ types: string[], config: Record<string, any>, verification: VerificationConfig }} input
 */
export function qualityPolicy({ types, config, verification }) {
  const enabled = {
    ui: config.uiVerification?.enabled === true,
    security: config.security?.enabled === true,
    architecture: config.architecture?.enabled === true,
    oracle: verification.oracles.length > 0,
  };
  const required = [...new Set(types.flatMap(type => neededGates[type] ?? []))].sort();
  const risk = types.some(type => highRisk.has(type))
    ? 'high'
    : types.length && types.every(type => lowRisk.has(type))
      ? 'low'
      : 'medium';
  return {
    risk,
    types,
    // Local checks and the independent review are always required and enforced by the Engine.
    required: ['checks', 'review', ...required],
    // `disabled` is a gap, never a PASS.
    gaps: required.filter(gate => !enabled[gate]).map(gate => ({ gate, reason: 'disabled' })),
  };
}

/** Files larger than this are not inspected; the receipt says so. */
const MAX_INSPECTED_BYTES = 262144;
/** Rust files are read by a linear lexer: a larger limit, and on a full gate a larger file is `incomplete`. */
const MAX_RUST_BYTES = 2 * 1024 * 1024;
/** A file that names itself a test, whatever its language. */
const namedTest = /\.(?:test|spec)\.[^/]+$|_test\.[^/]+$|(^|\/)test_[^/]+$/i;

/**
 * The cases of one revision of a file, or the reason it was not inspected. Never throws.
 * @returns {Promise<any>}
 */
async function inspect(cwd, revision, file) {
  if (!languageOf(file)) return { reason: 'unsupported_language' };
  const rust = languageOf(file) === 'rs';
  let result;
  try {
    // The size first: a file over the limit is never read into memory.
    const size = await execute('git', ['cat-file', '-s', `${revision}:${file}`], { cwd, allowFailure: true });
    if (size.code !== 0) return { reason: 'unreadable' };
    if (Number(size.stdout.trim()) > (rust ? MAX_RUST_BYTES : MAX_INSPECTED_BYTES)) return { reason: 'too_large' };
    result = await execute('git', ['show', `${revision}:${file}`], { cwd, allowFailure: true, rawOutput: true });
  } catch {
    return { reason: 'unreadable' };
  }
  if (result.code !== 0) return { reason: 'unreadable' };
  // A Rust file next to `tests/<dir>/main.rs` is a module of that crate, not of `<dir>`.
  const probe = rust ? rustCrateRootProbe(file) : null;
  const nestedCrate =
    probe !== null &&
    (await execute('git', ['cat-file', '-e', `${revision}:${probe}`], { cwd, allowFailure: true })).code === 0;
  const parsed = casesOf(file, result.stdout, { nestedCrate });
  if (!parsed) return { reason: 'unsupported_language' };
  if (rust) {
    // Compared with the crate and the target: `tests::adds` of two crates, and `x` of `tests/a.rs`
    // and of `tests/b.rs`, are two tests each. `test` keeps the libtest name.
    const where = [rustCrateDir(file), rustTargetGroup(file, nestedCrate)].filter(Boolean).join(' ');
    for (const item of parsed.cases) {
      item.test = item.name;
      if (where) item.name = `${where}: ${item.name}`;
    }
  }
  return parsed;
}

/** Changed files between base and head as `{ status, from, to }`, renames followed. */
async function changes(cwd, baseSha, headSha) {
  const output = (await execute('git', ['diff', '--name-status', '-M', '-z', `${baseSha}...${headSha}`], { cwd }))
    .stdout;
  const fields = output.split('\0').filter(Boolean),
    rows = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++][0];
    const from = fields[index++];
    const to = status === 'R' || status === 'C' ? fields[index++] : from;
    rows.push({ status, from, to });
  }
  return rows;
}

const listNames = names =>
  `${names
    .slice(0, 5)
    .map(name => JSON.stringify(String(name).slice(0, 80)))
    .join(', ')}${names.length > 5 ? `, and ${names.length - 5} more` : ''}`;

/** How many cases carry each name, over the given files. */
function tally(entries, pick = _item => true) {
  const names = new Map();
  for (const entry of entries)
    for (const item of entry.cases) if (pick(item)) names.set(item.name, (names.get(item.name) ?? 0) + 1);
  return names;
}

/**
 * `test_skipped` findings: cases switched off, `.only` added, skip calls added inside existing tests.
 * @param {{ name: string, file: string, nested?: boolean, off: string }[]} [switchedOff] Receives
 *   every switched-off Rust case, with its libtest name and why (`cfg` or `ignore`).
 */
function skipFindings(base, head, switchedOff = []) {
  const found = [];
  // A case that ran on the base and runs in fewer places now, with a switched-off copy here. A new
  // case born skipped is not weakening, and neither is a skipped namesake of a case that still runs.
  const known = tally(base),
    activeBefore = tally(base, item => !item.skipped),
    activeAfter = tally(head, item => !item.skipped);
  for (const entry of head) {
    const names = [...new Set(entry.cases.filter(item => item.skipped).map(item => item.name))].filter(
      name => (activeAfter.get(name) ?? 0) < (activeBefore.get(name) ?? 0),
    );
    for (const item of entry.cases)
      if (item.skipped && item.test !== undefined && names.includes(item.name))
        switchedOff.push({ name: item.test, file: entry.file, nested: item.nested, off: item.off });
    if (names.length)
      found.push({ rule: 'test_skipped', file: entry.file, detail: `switched off: ${listNames(names)}` });
  }
  const sameFile = new Map(base.filter(entry => !entry.gone).map(entry => [entry.at, entry]));
  // `.only` on a case or a group stops the other tests of the file. A file of new tests only is left alone.
  for (const entry of head) {
    const before = sameFile.get(entry.file)?.onlys ?? 0;
    if (
      entry.onlys > before &&
      entry.cases.some(item => known.has(item.name)) &&
      !found.some(item => item.rule === 'test_skipped' && item.file === entry.file)
    )
      found.push({
        rule: 'test_skipped',
        file: entry.file,
        detail: `focused with .only ${before} -> ${entry.onlys}: the other tests of the file stop running`,
      });
  }
  // A skip call added to a file that gained no case was added to an existing test.
  for (const entry of head) {
    const before = sameFile.get(entry.file);
    if (!before || entry.bodySkips <= before.bodySkips || entry.dynamic > before.dynamic) continue;
    const names = new Set(before.cases.map(item => item.name));
    if (entry.cases.every(item => names.has(item.name)))
      found.push({
        rule: 'test_skipped',
        file: entry.file,
        detail: `skip calls inside existing tests ${before.bodySkips} -> ${entry.bodySkips}`,
      });
  }
  return found;
}

/**
 * Findings on the bodies of Rust tests, matched by file and name (two crates may hold the same name):
 * - `weak_or_empty_test`: a changed or new test that cannot fail. A body equal to the base, token
 *   for token, is old code and is left alone. No permission covers it: a test that is not needed is
 *   deleted instead.
 * - `test_weakened`: an existing test no longer has to panic, or no longer with its message.
 *   Adding a message to a bare `#[should_panic]` tightens it.
 */
function rustBodyFindings(base, head) {
  const weak = [],
    weakened = [],
    before = new Map();
  for (const entry of base)
    for (const item of entry.cases)
      if (item.body !== undefined) {
        const slot = `${entry.at}\u0000${item.name}`;
        if (!before.has(slot)) before.set(slot, []);
        before.get(slot).push(item);
      }
  for (const entry of head) {
    const fake = [],
      lost = [];
    for (const item of entry.cases) {
      if (item.body === undefined) continue;
      const old = before.get(`${entry.file}\u0000${item.name}`) ?? [];
      if (item.weak && !old.some(previous => previous.body === item.body)) fake.push(item);
      if (old.length && old.every(previous => panicWeakened(previous.panics, item.panics))) lost.push(item.name);
    }
    if (fake.length)
      weak.push({
        rule: 'weak_or_empty_test',
        file: entry.file,
        detail: `tests that cannot fail: ${fake
          .slice(0, 5)
          .map(item => `${JSON.stringify(item.name)} (${item.weak})`)
          .join(', ')}${fake.length > 5 ? `, and ${fake.length - 5} more` : ''}`,
      });
    if (lost.length)
      weakened.push({
        rule: 'test_weakened',
        file: entry.file,
        detail: `#[should_panic] removed or its expectation dropped or changed: ${listNames(lost)}`,
      });
  }
  return { weak, weakened };
}

/** How many files a search for macro calls reads at most; past it the macro counts as called. */
const MAX_CALL_FILES = 200;
const MAX_TEMPLATE_HOPS = 128;

/**
 * `weak_or_empty_test` for a `macro_rules!` template: a test it defines that is new or changed
 * and cannot fail, in a macro that is called (`name!(`, `name! {`, `name! [`) — in its package,
 * or anywhere in the repository for `#[macro_export]`. A call from inside another template counts
 * when that template is itself reached from a real call, transitively (`cases!()` expanding
 * `make_case!`), cycles cut. Calls are read as Rust tokens: a call in a comment or a string is
 * none. An unreached template defines no test.
 */
async function templateFindings(cwd, headSha, base, head) {
  const before = new Map();
  for (const entry of base)
    for (const template of entry.templates ?? [])
      for (const test of template.tests) {
        const slot = `${entry.at}\u0000${template.name}\u0000${test.name}`;
        if (!before.has(slot)) before.set(slot, new Set());
        before.get(slot).add(test.body);
      }
  /** How the files that may name a macro use macros, read once per file. */
  const uses = new Map(
    head.map(entry => [entry.file, { calls: entry.calls ?? new Set(), templates: entry.templates ?? [] }]),
  );
  const read = async file => {
    if (uses.has(file)) return uses.get(file);
    let use = { calls: new Set(), templates: [] };
    const size = await execute('git', ['cat-file', '-s', `${headSha}:${file}`], { cwd, allowFailure: true });
    if (size.code === 0 && Number(size.stdout.trim()) <= MAX_RUST_BYTES) {
      const text = await execute('git', ['show', `${headSha}:${file}`], { cwd, allowFailure: true, rawOutput: true });
      if (text.code === 0) use = rustMacroUse(text.stdout);
    }
    uses.set(file, use);
    return use;
  };
  /** The files in scope that may call `name`: the changed ones and a text search; their tokens decide. */
  const candidates = async (name, inScope, wide, crate) => {
    const pattern = `(^|[^A-Za-z0-9_])${name}[[:space:]]*![[:space:]]*[[({]`;
    const listed = await execute(
      'git',
      ['grep', '-l', '-E', pattern, headSha, '--', wide || !crate ? '*.rs' : `${crate}/*.rs`],
      { cwd, allowFailure: true },
    );
    const found = listed.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => line.slice(headSha.length + 1));
    return [...new Set([...head.map(entry => entry.file), ...found])].filter(inScope);
  };
  const reached = async (template, file, seen = new Set()) => {
    const slot = `${file}\u0000${template.name}`;
    if (seen.has(slot)) return false;
    // A work cap, not a verdict: past it the template is treated as reached and still checked.
    if (seen.size >= MAX_TEMPLATE_HOPS) return true;
    seen.add(slot);
    const crate = rustCrateDir(file),
      inScope = other => template.exported || rustCrateDir(other) === crate;
    const files = await candidates(template.name, inScope, template.exported, crate);
    if (files.length > MAX_CALL_FILES) return true;
    for (const other of files) {
      const use = await read(other);
      if (use.calls.has(template.name)) return true;
      for (const wrapper of use.templates)
        if (
          wrapper.name !== template.name &&
          wrapper.calls?.has(template.name) &&
          (await reached(wrapper, other, seen))
        )
          return true;
    }
    return false;
  };
  const called = (template, file) => reached(template, file);
  const found = [];
  for (const entry of head) {
    const fake = [];
    for (const template of entry.templates ?? []) {
      const weak = template.tests.filter(
        test => test.weak && !before.get(`${entry.file}\u0000${template.name}\u0000${test.name}`)?.has(test.body),
      );
      if (weak.length && (await called(template, entry.file)))
        fake.push(...weak.map(test => `${template.name}!: fn ${test.name} (${test.weak})`));
    }
    if (fake.length)
      found.push({
        rule: 'weak_or_empty_test',
        file: entry.file,
        detail: `macro templates define tests that cannot fail: ${listNames(fake)}`,
      });
  }
  return found;
}

/**
 * What the registry comparison may count on from this reading, each Rust case once, with its
 * libtest name and file:
 * - `reported`: a case gone from its file that the reading reported as a finding;
 * - `permitted`: a case gone from a file this run may reduce (and the target of a permitted file
 *   that is gone, with an empty name);
 * - `moved`: a case the reading saw move to another file of the same crate and target (`to`);
 * - `cfg`, `skips`: cases switched off by a provably false `cfg`, or by `#[ignore]`.
 */
function registryPools(base, gone, switchedOff, allowed) {
  const reported = [],
    permitted = [],
    moved = [];
  for (const [index, entry] of base.entries()) {
    const own = ownsPath(allowed, entry.file);
    for (const { item, to } of gone[index]) {
      if (item.test === undefined) continue;
      if (to) moved.push({ name: item.test, file: entry.file, to });
      else (own ? permitted : reported).push({ name: item.test, file: entry.file });
    }
    if (own && entry.gone && languageOf(entry.file) === 'rs') permitted.push({ name: '', file: entry.file });
  }
  return {
    reported,
    permitted,
    moved,
    cfg: switchedOff.filter(item => item.off === 'cfg'),
    skips: switchedOff.filter(item => item.off === 'ignore'),
  };
}

/**
 * Base cases missing from their own file on the head, each with the file it moved to (`to`) or
 * none. A case is first looked for in its own file, and only what is missing there can have
 * moved: with the same name in two files, the file that lost the case is the one reported, and
 * the one a permission must name. A Rust case that may not exist (`maybe`) is never missing.
 */
function missingCases(base, head) {
  const pools = new Map(head.map(entry => [entry.file, tally([entry])]));
  const take = (pool, name) => {
    const left = pool?.get(name) ?? 0;
    if (left > 0) pool.set(name, left - 1);
    return left > 0;
  };
  const missing = base.map(entry => entry.cases.filter(item => !take(pools.get(entry.at), item.name) && !item.maybe));
  // After every file has claimed its own cases it no longer matters much which file a moved case
  // went to: what is left is kept per name, so the cost does not grow with the number of files.
  const left = new Map();
  for (const [file, pool] of pools)
    for (const [name, number] of pool)
      for (let count = number; count > 0; count--) {
        if (!left.has(name)) left.set(name, []);
        left.get(name).push(file);
      }
  return missing.map(items => items.map(item => ({ item, to: left.get(item.name)?.pop() ?? null })));
}

/**
 * Tests that existed on the base and were removed or switched off.
 *
 * Cases are compared by name across all changed test files: a case that moved
 * to another file, or a file that was split or renamed, is still there; a case
 * whose name is gone is removed, whatever was added in its place. Comments and
 * string contents are not code, so a commented-out test is a removed one. A
 * case that ran on the base and no longer does is switched off: by its own
 * skip (`.skip`, `.only`, `.todo`, `xit`, an options object with `skip:`, a
 * decorator or attribute) or by one on its group, class or module
 * (`describe.skip`, `xdescribe`, a decorator on a class, `pytestmark`).
 * `.only` added to a file with existing tests stops the others.
 *
 * Rust files are read wherever they are: tests live in `#[cfg(test)]` modules
 * of `src/**.rs` too, and a Rust case is compared with its crate and target. A
 * changed or new Rust test that cannot fail (an empty body, `assert!(true)`, an
 * empty `return` before the first statement), also in a `macro_rules!`
 * template that is called, is `weak_or_empty_test`; a `#[should_panic]`
 * removed or loosened is `test_weakened`.
 *
 * What it cannot see is in the docs: a body emptied under the same name (except
 * Rust), an early `return`, a skip called inside the body, a renamed case
 * (reported as removed).
 * @param {{ cwd: string, baseSha: string, headSha: string, allowed?: string[] }} input
 *   `allowed`: test paths this run may delete or reduce.
 */
export async function testWeakening(input) {
  const { findings, allowed, warnings, unchecked } = await inspectTests(input);
  return { findings, allowed, warnings, unchecked };
}

/** A file whose cases are compared: a test file, or any Rust file (unit tests live in `src/`). */
const guarded = file => isTestFile(file) || languageOf(file) === 'rs';

/**
 * `testWeakening` with what the registry comparison needs: the pools of `registryPools`.
 * @param {{ cwd: string, baseSha: string, headSha: string, allowed?: string[] }} input
 */
async function inspectTests({ cwd, baseSha, headSha, allowed = [] }) {
  const base = [],
    head = [],
    unchecked = [],
    findings = [],
    permitted = [],
    warnings = [],
    switchedOff = [];
  const report = finding =>
    (finding.rule !== 'test_skipped' && ownsPath(allowed, finding.file) ? permitted : findings).push(finding);
  for (const { status, from, to } of await changes(cwd, baseSha, headSha)) {
    // A test renamed to a path no runner would pick up is gone.
    const gone = status === 'D' || !guarded(to);
    if (status !== 'A' && status !== 'C' && guarded(from)) {
      const before = await inspect(cwd, baseSha, from);
      if (!before.reason)
        base.push({ file: from, at: gone ? from : to, gone, renamedTo: status === 'D' ? null : to, ...before });
      else if (before.reason !== 'unsupported_language' || namedTest.test(from)) {
        unchecked.push({ file: from, reason: before.reason });
        // A removed test file is a removed test even when its cases could not be read.
        if (gone && languageOf(from) && isTestFile(from))
          report({ rule: 'test_deleted', file: from, detail: `removed and not inspected (${before.reason})` });
      }
    }
    if (status !== 'D' && guarded(to)) {
      const after = await inspect(cwd, headSha, to);
      if (!after.reason) head.push({ file: to, ...after });
      else if (after.reason !== 'unsupported_language' || namedTest.test(to))
        unchecked.push({ file: to, reason: after.reason });
    }
  }
  const gone = missingCases(base, head);
  for (const [index, entry] of base.entries()) {
    const removed = gone[index].filter(item => !item.to).map(({ item }) => item.name);
    if (removed.length)
      report(
        entry.gone
          ? {
              rule: 'test_deleted',
              file: entry.file,
              detail: `${entry.renamedTo ? `renamed to ${entry.renamedTo}, which no test runner picks up; ` : ''}${removed.length} test cases are gone: ${listNames(removed)}`,
            }
          : {
              rule: 'tests_removed',
              // The base path: it is what a permission names, and Git may pair a deleted file with a new one.
              file: entry.file,
              detail: `${entry.at === entry.file ? '' : `now ${entry.at}; `}test cases removed: ${listNames(removed)}`,
            },
      );
  }
  const dynamic = entries => entries.reduce((total, entry) => total + entry.dynamic, 0);
  if (dynamic(head) < dynamic(base)) {
    const entry = base.find(item => item.dynamic > 0);
    report({
      rule: 'tests_removed',
      file: entry.at,
      detail: `cases named by an expression: ${dynamic(base)} -> ${dynamic(head)} across changed tests`,
    });
  }
  skipFindings(base, head, switchedOff).forEach(report);
  const total = (entries, field) =>
    entries.reduce((sum, entry) => sum + (field ? entry[field] : entry.cases.length), 0);
  if (total(head, 'assertions') < total(base, 'assertions') && total(head) <= total(base))
    warnings.push({
      rule: 'assertions_removed',
      file: null,
      detail: `assertions ${total(base, 'assertions')} -> ${total(head, 'assertions')} across changed tests`,
    });
  const bodies = rustBodyFindings(base, head);
  findings.push(...bodies.weak, ...(await templateFindings(cwd, headSha, base, head)));
  bodies.weakened.forEach(report);
  return { findings, allowed: permitted, warnings, unchecked, pools: registryPools(base, gone, switchedOff, allowed) };
}

/**
 * Findings a repair session cannot fix: only a person can change the configuration, and an
 * incomplete registry (no Cargo, a base that does not build) is not the implementation's to fix.
 */
const unrepairable = new Set(['required_gate_disabled', 'test_registry_incomplete', 'test_inspection_incomplete']);

/** Rules that mean a required observation is missing: the gate is `incomplete`, never passed. */
const incompleteRules = new Set(['test_registry_incomplete', 'test_inspection_incomplete']);
const REGISTRY_REMEDY =
  'Install Cargo where the coordinator runs, or start a new run with "verification": { "testRegistry": false }';

/** A file at a revision, or null. */
async function fileAt(cwd, revision, file) {
  const result = await execute('git', ['show', `${revision}:${file}`], { cwd, allowFailure: true, rawOutput: true });
  return result.code === 0 ? result.stdout : null;
}

/** `test_selection_narrowed`: a plain `cargo test` of the project selects fewer packages now. */
async function selectionFinding({ cwd, baseSha, headSha, config }) {
  const lost = selectionNarrowed({
    base: await fileAt(cwd, baseSha, 'Cargo.toml'),
    head: await fileAt(cwd, headSha, 'Cargo.toml'),
    commands: Array.isArray(config.commands?.test) ? config.commands.test : [],
  });
  return lost
    ? {
        rule: 'test_selection_narrowed',
        file: 'Cargo.toml',
        detail: `cargo test without --workspace no longer selects: ${listNames(lost)}`,
      }
    : null;
}

/**
 * `test_inspection_incomplete` on a full gate: a changed Rust file too large or unreadable, once per file.
 * Its tests were not read, so nothing about them can pass.
 */
function inspectionIncomplete(unchecked) {
  const files = [
    ...new Set(
      unchecked
        .filter(item => (item.reason === 'too_large' || item.reason === 'unreadable') && languageOf(item.file) === 'rs')
        .map(item => item.file),
    ),
  ];
  return files.map(file => ({
    rule: 'test_inspection_incomplete',
    file,
    detail: `its tests were not read (larger than ${MAX_RUST_BYTES} bytes, or unreadable); split the file`,
  }));
}

/** The registry part of a full gate, when the base or the head has a root `Cargo.toml`. */
async function rustFullGate({ cwd, baseSha, headSha, signal, secrets, runner, registryHome, tests }) {
  const exists = async revision =>
    (await execute('git', ['cat-file', '-e', `${revision}:Cargo.toml`], { cwd, allowFailure: true })).code === 0;
  const headIsRust = await exists(headSha),
    baseIsRust = await exists(baseSha);
  if (!headIsRust && !baseIsRust) return { findings: [], allowed: [] };
  const compared = await rustRegistryCheck({
    cwd,
    baseSha,
    signal,
    secrets,
    runner,
    registryHome,
    baseIsRust,
    headIsRust,
    pools: tests.pools,
  });
  const findings = [];
  // Not compared is never a pass: the gate is incomplete.
  if (compared.registry.status !== 'compared')
    findings.push({
      rule: 'test_registry_incomplete',
      file: null,
      detail: `test registry not compared: ${compared.registry.reason}. ${REGISTRY_REMEDY}`,
    });
  findings.push(...(compared.findings ?? []));
  return { findings, allowed: compared.permitted ?? [], testRegistry: compared.registry };
}

/** Results of an oracle larger than this are not read. */
const MAX_RESULT_BYTES = 65536;

/**
 * The result file of an oracle with budgets: `{ "metrics": [{ "name": "…", "value": 12.5 }] }`.
 * @returns {{ metrics: { name: string, value: unknown }[], text: string } | { reason: string, text?: string }}
 */
function readOracleResult(file) {
  let text;
  try {
    if (statSync(file).size > MAX_RESULT_BYTES) return { reason: 'budget_result_invalid' };
    text = readFileSync(file, 'utf8');
  } catch {
    return { reason: 'budget_result_missing' };
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { reason: 'budget_result_invalid', text };
  }
  const metrics = value?.metrics;
  if (
    !Array.isArray(metrics) ||
    metrics.some(item => !item || typeof item !== 'object' || typeof item.name !== 'string')
  )
    return { reason: 'budget_result_invalid', text };
  return { metrics, text };
}

/**
 * One budget against the reported metrics: exactly one finite number of that name. None, two or
 * a value that is not a finite number is a failure, never a pass.
 * @param {OracleBudget} budget
 * @param {{ name: string, value: unknown }[]} metrics
 */
function measure(budget, metrics) {
  const found = metrics.filter(item => item.name === budget.metric);
  const value = found.length === 1 ? found[0].value : null;
  const status =
    found.length === 0
      ? 'missing'
      : found.length > 1
        ? 'ambiguous'
        : typeof value !== 'number' || !Number.isFinite(value)
          ? 'invalid'
          : budget.max !== undefined && value > budget.max
            ? 'over'
            : budget.min !== undefined && value < budget.min
              ? 'under'
              : 'met';
  return { ...budget, value: status === 'met' || status === 'over' || status === 'under' ? value : null, status };
}

/** The reason of an oracle whose budgets failed, the most fundamental first. */
const budgetReasons = [
  ['ambiguous', 'budget_metric_ambiguous'],
  ['missing', 'budget_metric_missing'],
  ['invalid', 'budget_result_invalid'],
  ['over', 'budget_exceeded'],
  ['under', 'budget_exceeded'],
];
const budgetText = budget =>
  ({
    missing: `${budget.metric}: not reported`,
    ambiguous: `${budget.metric}: reported more than once`,
    invalid: `${budget.metric}: not a finite number`,
    over: `${budget.metric} = ${budget.value}, above max ${budget.max}`,
    under: `${budget.metric} = ${budget.value}, below min ${budget.min}`,
  })[budget.status];

/**
 * Run one oracle; a crash or a timeout is a failure with its own evidence. An oracle with
 * budgets reports its numbers through one channel of its own: a JSON file at the path in
 * `KODO_ORACLE_RESULT`, outside the checked tree. Its console output is evidence, never a metric.
 */
async function runOracle(oracle, { cwd, signal, secrets, runner, persist }) {
  let exitCode = null,
    reason,
    output,
    result = null;
  const resultDir = oracle.budgets ? mkdtempSync(path.join(os.tmpdir(), 'kodo-oracle-')) : null,
    resultFile = resultDir ? path.join(resultDir, 'result.json') : null;
  try {
    try {
      const ran = await runner(oracle.command, oracle.args, {
        cwd,
        signal,
        env: { ...workerEnvironment(), ...(resultFile ? { KODO_ORACLE_RESULT: resultFile } : {}) },
        secrets,
        timeoutMs: oracle.timeoutMs,
        allowFailure: true,
      });
      exitCode = ran.code;
      output = (ran.stdout + ran.stderr).slice(-24000);
    } catch (error) {
      if (signal?.aborted || error.code === 'cancelled') throw error;
      // An oracle that did not finish proves nothing: it is a failure, not a pass.
      reason = ['timeout', 'ENOENT', 'EACCES', 'EPERM'].includes(error.code) ? error.code : 'execution_failed';
      output = `not completed: ${reason}`;
    }
    if (resultFile && exitCode === 0) result = readOracleResult(resultFile);
  } finally {
    if (resultDir) rmSync(resultDir, { recursive: true, force: true });
  }
  const evidence = persist
    ? await persist('oracle', {
        id: oracle.id,
        command: oracle.command,
        args: oracle.args,
        exitCode,
        output,
        ...(result?.text === undefined ? {} : { result: result.text.slice(0, 16000) }),
      })
    : null;
  // Budgets are read only from an oracle that exited 0.
  let budgets = null,
    missed = [];
  if (result && 'metrics' in result) {
    budgets = oracle.budgets.map(budget => measure(budget, result.metrics));
    missed = budgets.filter(budget => budget.status !== 'met');
    if (missed.length) reason = budgetReasons.find(([status]) => missed.some(budget => budget.status === status))?.[1];
  } else if (result) reason = result.reason;
  return {
    receipt: {
      id: oracle.id,
      status: exitCode !== 0 || reason ? 'failed' : 'passed',
      ...(reason ? { reason } : {}),
      exitCode,
      ...(budgets ? { budgets } : {}),
      ...(evidence ? { outputPath: evidence.path, outputHash: evidence.sha256 } : {}),
    },
    detail: missed.length
      ? `${oracle.id}: ${missed.map(budgetText).join('; ')}`
      : reason
        ? `${oracle.id}: ${reason}`
        : `${oracle.id} exit ${exitCode}: ${output.slice(-2000)}`,
  };
}

/**
 * Run the behaviour gate on a clean checkout of `headSha`.
 *
 * `registry`: this is a full gate (an epic or milestone gate, the final check of `kodo run`), not a
 * task-fast check. On a Rust project (`Cargo.toml` at the root of the head) a full gate always
 * compares the test registry of the base and the head, whatever files changed, unless the project
 * set `testRegistry: false`. A registry that could not be compared makes the gate `incomplete`.
 * @param {{ cwd: string, headSha: string, baseSha: string, config: Record<string, any>, signal?: AbortSignal,
 *   secrets?: Record<string, string>, runner?: typeof execute, isClean?: () => Promise<boolean>,
 *   persist?: (kind: string, value: any) => Promise<{ sha256: string, path: string }>,
 *   registry?: boolean, registryHome?: string }} input
 */
export async function runBehaviorGate({
  cwd,
  headSha,
  baseSha,
  config,
  signal,
  secrets = {},
  runner = execute,
  isClean,
  persist,
  registry = false,
  registryHome,
}) {
  const verification = normalizeVerificationConfig(config.verification);
  const rows = await changes(cwd, baseSha, headSha);
  const paths = [...new Set(rows.flatMap(row => [row.from, row.to]))].sort();
  const policy = qualityPolicy({ types: classifyChange(paths), config, verification });
  const findings = [],
    allowed = [],
    warnings = [],
    unchecked = [];
  if (verification.strictGates)
    for (const gap of policy.gaps)
      findings.push({
        rule: 'required_gate_disabled',
        file: null,
        detail: `${gap.gate} gate is required for this change`,
      });
  let testRegistry;
  if (verification.testProtection) {
    const tests = await inspectTests({ cwd, baseSha, headSha, allowed: verification.testRemovalAllowed });
    findings.push(...tests.findings);
    // Removals this run was explicitly allowed; the receipt still shows them.
    allowed.push(...tests.allowed);
    warnings.push(...tests.warnings);
    unchecked.push(...tests.unchecked);
    // A plain `cargo test` that selects fewer packages runs fewer tests.
    if (paths.includes('Cargo.toml')) {
      const narrowed = await selectionFinding({ cwd, baseSha, headSha, config });
      if (narrowed) (ownsPath(verification.testRemovalAllowed, 'Cargo.toml') ? allowed : findings).push(narrowed);
    }
    // A full gate reads every changed Rust file, whatever the registry setting.
    if (registry) findings.push(...inspectionIncomplete(tests.unchecked));
    // A full gate of a Rust project (on the base or the head) compares the test registry, whatever changed.
    if (registry && verification.testRegistry) {
      const rust = await rustFullGate({ cwd, baseSha, headSha, signal, secrets, runner, registryHome, tests });
      testRegistry = rust.testRegistry;
      findings.push(...rust.findings);
      allowed.push(...rust.allowed);
    }
  }
  const oracles = [];
  for (const oracle of verification.oracles) {
    // An implementation may not edit the oracle that judges it.
    const touched = paths.filter(file => ownsPath(oracle.protect, file));
    for (const file of touched)
      findings.push({ rule: 'oracle_modified', file, detail: `protected by oracle ${oracle.id}` });
    if (touched.length) {
      oracles.push({ id: oracle.id, status: 'not_run', reason: 'oracle_modified', exitCode: null });
      continue;
    }
    const { receipt, detail } = await runOracle(oracle, { cwd, signal, secrets, runner, persist });
    oracles.push(receipt);
    if (receipt.status !== 'passed') findings.push({ rule: 'oracle_failed', file: null, detail });
    // An oracle observes; one that changes the checked tree invalidates everything after it.
    if (isClean && !(await isClean())) {
      findings.push({ rule: 'oracle_dirty_worktree', file: null, detail: `${oracle.id} changed the checked worktree` });
      break;
    }
  }
  return {
    schemaVersion: BEHAVIOR_GATE_VERSION,
    headSha,
    baseSha,
    configHash: verificationConfigHash(config.verification),
    // `incomplete`: nothing was found wrong, but a required observation is missing. Never a pass.
    status: findings.some(finding => !incompleteRules.has(finding.rule))
      ? 'failed'
      : findings.length
        ? 'incomplete'
        : 'passed',
    passed: findings.length === 0,
    // Nothing a repair session could change: the run stops for a person instead of spending sessions.
    // One finding only a person can fix means no repair can make the gate pass.
    repairable: !findings.some(finding => unrepairable.has(finding.rule)),
    policy,
    findings,
    allowed,
    warnings,
    unchecked,
    oracles,
    ...(testRegistry ? { testRegistry } : {}),
  };
}

/**
 * A receipt counts only for the exact head, base and verification configuration it was made for.
 * @param {any} receipt
 * @param {{ headSha?: string, baseSha?: string, config?: Record<string, any> }} [current]
 */
export function isCurrentBehaviorReceipt(receipt, { headSha, baseSha, config } = {}) {
  return (
    receipt?.schemaVersion === BEHAVIOR_GATE_VERSION &&
    typeof headSha === 'string' &&
    receipt.headSha === headSha &&
    receipt.baseSha === baseSha &&
    receipt.configHash === verificationConfigHash(config?.verification) &&
    receipt.passed === true &&
    receipt.status === 'passed' &&
    Array.isArray(receipt.findings) &&
    receipt.findings.length === 0
  );
}

/**
 * Compare final check results with the baseline taken on the base commit.
 * A failure that already existed is labelled, never ignored.
 * @param {{ results: { kind: string, command: any, exitCode: number | null }[] } | null | undefined} baseline
 * @param {{ kind: string, command: any, exitCode: number | null }[]} results
 */
export function compareWithBaseline(baseline, results) {
  if (!baseline || !Array.isArray(baseline.results)) return null;
  const key = row => JSON.stringify([row.kind, row.command]);
  const before = new Map(baseline.results.map(row => [key(row), row]));
  return results.map(row => {
    const base = before.get(key(row));
    const failed = row.exitCode !== 0,
      failedBefore = base ? base.exitCode !== 0 : null;
    // A baseline command that did not finish says nothing about the base.
    const classification =
      !base || base.exitCode === null
        ? 'no_baseline'
        : failed
          ? failedBefore
            ? 'pre_existing'
            : 'regression'
          : failedBefore
            ? 'fixed'
            : 'unchanged';
    return {
      kind: row.kind,
      command: row.command,
      baseline: base ? base.exitCode : null,
      final: row.exitCode,
      classification,
    };
  });
}
