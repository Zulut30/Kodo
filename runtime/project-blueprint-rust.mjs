// Rust checks of the project factory blueprint (`project-blueprint.mjs`): the
// contract crate and workspace declarations, wave zero contract policy, the
// committed toolchain and the package names of committed Cargo manifests.

import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import {
  isBroadContractScope,
  isExplicitContractScope,
  normalizeScopePath,
  scopeMatchesPath,
} from './cargo-workspace.mjs';
import { inside } from './toolchains.mjs';
import { BLUEPRINT_LIMITS, FOUNDATION_ID, compare, finding, isPlain } from './project-blueprint-shared.mjs';
import { taskAncestors } from './project-blueprint-lint.mjs';
import { readBoundedFile } from './project-blueprint-io.mjs';

const RUST_CONTRACT_CRATE_MIN = 3;
const CONTRACT_CRATE_NAME = /(?:^|[-_])contracts$/i;
function normalizeRelScope(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replaceAll('\\', '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/+$/, '');
}
function crateFromWritePath(raw) {
  const cleaned = normalizeRelScope(raw);
  if (!cleaned) return null;
  const cratesMatch = /^((?:[^/*?[{]+\/)*crates\/([A-Za-z0-9][A-Za-z0-9_-]*))(?:\/|$)/.exec(cleaned);
  if (cratesMatch) return { name: cratesMatch[2], root: cratesMatch[1] };
  const cargoMatch = /^([^/*?[{]+(?:\/[^/*?[{]+)*)\/Cargo\.toml$/.exec(cleaned);
  if (cargoMatch) {
    const root = cargoMatch[1];
    return { name: root.split('/').at(-1), root };
  }
  return null;
}
function isRustBlueprint(spec, projectMarkdown, architecturePolicy) {
  if (architecturePolicy?.schemaVersion === 2 && architecturePolicy?.language === 'rust') return true;
  if (typeof projectMarkdown === 'string' && /\b(?:rust|cargo)\b/i.test(projectMarkdown)) return true;
  if (
    spec.tasks.some(task =>
      (task.writePaths ?? []).some(scope => /(?:^|\/)Cargo\.toml$|\.rs$/i.test(String(scope).replaceAll('\\', '/'))),
    )
  )
    return true;
  const meta = [spec.title, spec.businessContext, ...(spec.constraints ?? [])].filter(Boolean).join('\n');
  return /\b(?:rust|cargo)\b/i.test(meta);
}
function linesOutsideCodeFences(text) {
  if (typeof text !== 'string' || !text) return [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let fence = null;
  for (const line of lines) {
    const opener = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (
        opener &&
        opener[1][0] === fence[0] &&
        opener[1].length >= fence.length &&
        !/\S/.test(line.slice(opener[0].length))
      )
        fence = null;
      continue;
    }
    if (opener) {
      fence = opener[1];
      continue;
    }
    out.push(line);
  }
  return out;
}
const strictDeclRe = (key, valueClass) =>
  new RegExp(
    `^ {0,3}(?:[-*]\\s+)?${key}\\s*:\\s*(?:\`(${valueClass})\`|"(${valueClass})"|'(${valueClass})'|(${valueClass}))\\s*$`,
  );
const CONTRACT_DECL_RE = strictDeclRe('contractCrate', '[A-Za-z0-9][A-Za-z0-9_./-]*');
const WORKSPACE_DECL_RE = strictDeclRe('workspaceRoot', '\\.|[A-Za-z0-9][A-Za-z0-9_./-]*');
const ROOT_PACKAGE_DECL_RE = strictDeclRe('rootPackage', '\\.|[A-Za-z0-9][A-Za-z0-9_./-]*');
function cleanDeclaredPath(raw) {
  const cleaned = raw
    .trim()
    .replaceAll('\\', '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/+$/, '');
  if (!cleaned || /^(?:none|no|false)$/i.test(cleaned)) return null;
  if (cleaned !== '.' && cleaned.split('/').some(part => !part || part === '.' || part === '..')) return null;
  return cleaned;
}
function collectStrictDeclarations(sources, pattern) {
  const tokens = new Set();
  for (const source of sources) {
    for (const line of linesOutsideCodeFences(source)) {
      const match = pattern.exec(line);
      if (!match) continue;
      const raw = match[1] ?? match[2] ?? match[3] ?? match[4];
      const cleaned = cleanDeclaredPath(raw);
      if (cleaned) tokens.add(cleaned);
    }
  }
  return tokens;
}
function declaredContractTokens(spec, projectMarkdown) {
  return collectStrictDeclarations([projectMarkdown, ...(spec.constraints ?? [])], CONTRACT_DECL_RE);
}
function declaredRootPackages(spec, projectMarkdown) {
  const roots = new Set();
  for (const token of collectStrictDeclarations([projectMarkdown, ...(spec.constraints ?? [])], ROOT_PACKAGE_DECL_RE)) {
    roots.add(token === '.' || token === 'Cargo.toml' ? '' : token.replace(/\/Cargo\.toml$/, ''));
  }
  return roots;
}
function declaredWorkspaceRoots(spec, projectMarkdown, architecturePolicy, allCrates) {
  const roots = new Set();
  if (architecturePolicy?.schemaVersion === 2 && architecturePolicy?.language === 'rust') roots.add('');
  for (const token of collectStrictDeclarations([projectMarkdown, ...(spec.constraints ?? [])], WORKSPACE_DECL_RE)) {
    roots.add(token === '.' || token === 'Cargo.toml' ? '' : token.replace(/\/Cargo\.toml$/, ''));
  }
  for (const task of spec.tasks) {
    for (const raw of task.writePaths ?? []) {
      const cleaned = normalizeRelScope(raw);
      if (cleaned === 'Cargo.toml') roots.add('');
      else if (cleaned.endsWith('/Cargo.toml')) {
        const dir = cleaned.slice(0, -'/Cargo.toml'.length);
        if ([...allCrates.keys()].some(crateRoot => crateRoot !== dir && crateRoot.startsWith(`${dir}/`)))
          roots.add(dir);
      }
    }
  }
  return roots;
}
function taskCreatesCompilableContractCrate(task, contractRoot) {
  let coversManifest = false;
  let coversSource = false;
  const manifestPath = contractRoot ? `${contractRoot}/Cargo.toml` : 'Cargo.toml';
  const libPath = contractRoot ? `${contractRoot}/src/lib.rs` : 'src/lib.rs';
  const srcPrefix = contractRoot ? `${contractRoot}/src/` : 'src/';
  for (const rawScope of task.writePaths ?? []) {
    if (!isExplicitContractScope(rawScope, contractRoot)) continue;
    const scope = normalizeScopePath(rawScope);
    if (scopeMatchesPath(scope, manifestPath)) coversManifest = true;
    if (scopeMatchesPath(scope, libPath) || (scope.startsWith(srcPrefix) && /\.rs$/i.test(scope))) coversSource = true;
  }
  return coversManifest && coversSource;
}
function broadContractScopeFindings(spec, contractRoots) {
  if (!contractRoots.size) return [];
  const offending = new Set();
  for (const task of spec.tasks) {
    for (const scope of task.writePaths ?? []) {
      for (const contractRoot of contractRoots) {
        if (isBroadContractScope(scope, contractRoot)) offending.add(task.id);
      }
    }
  }
  if (!offending.size) return [];
  return [
    finding(
      'contract_scope_too_broad',
      'Путь записи задачи накрывает защищённый контрактный крейт слишком широкой маской; ' +
        'укажите конкретный каталог модуля или явно назовите каталог контрактного крейта в задаче контракта',
      [...offending].sort(compare),
    ),
  ];
}
function ownerWorkspaceOf(crateRoot, sortedWorkspaceRoots) {
  return sortedWorkspaceRoots.find(wsRoot =>
    wsRoot === '' ? true : crateRoot === wsRoot || crateRoot.startsWith(`${wsRoot}/`),
  );
}
function normalizePackageNames(raw) {
  const map = new Map();
  const entries = raw instanceof Map ? [...raw.entries()] : isPlain(raw) ? Object.entries(raw) : [];
  for (const [dir, name] of entries) {
    if (typeof dir !== 'string' || typeof name !== 'string' || !name.trim()) continue;
    const cleaned = dir === '' || dir === '.' ? '' : normalizeRelScope(dir);
    map.set(cleaned, name.trim());
  }
  return map;
}
function selectContractRootsForWorkspace({
  wsRoot,
  wsCrates,
  workspaceRoots,
  explicitTokens,
  architecturePolicy,
  actualNames,
}) {
  const roots = new Set();
  const isRustV2Policy =
    wsRoot === '' && architecturePolicy?.schemaVersion === 2 && architecturePolicy?.language === 'rust';
  if (isRustV2Policy) {
    const policyNames = new Set(
      Array.isArray(architecturePolicy.contractCrates)
        ? architecturePolicy.contractCrates.filter(n => typeof n === 'string' && n.trim()).map(n => n.trim())
        : [],
    );
    for (const [root, name] of wsCrates.entries()) {
      if (policyNames.has(name)) roots.add(root);
    }
    for (const token of explicitTokens) {
      const dir = token === '.' ? '' : token;
      const pkgName = actualNames?.get(dir);
      if (pkgName && policyNames.has(pkgName) && ownerWorkspaceOf(dir, workspaceRoots) === wsRoot) roots.add(dir);
    }
    return roots;
  }
  for (const [root, name] of wsCrates.entries()) {
    if (explicitTokens.has(root) || explicitTokens.has(name) || CONTRACT_CRATE_NAME.test(name)) roots.add(root);
  }
  for (const token of explicitTokens) {
    if (token.includes('/') && ownerWorkspaceOf(token, workspaceRoots) === wsRoot) roots.add(token);
  }
  return roots;
}
function taskCoversManifest(task, wsRoot) {
  const manifestPath = wsRoot ? `${wsRoot}/Cargo.toml` : 'Cargo.toml';
  return (task.writePaths ?? []).some(rawScope => {
    const scope = normalizeScopePath(rawScope);
    return Boolean(scope) && (scope === manifestPath || isExplicitContractScope(scope, wsRoot, manifestPath));
  });
}
function hasRootPackageMember(spec, wsRoot, explicitRootPackages = new Set(), explicitTokens = new Set()) {
  if (explicitRootPackages.has(wsRoot)) return true;
  if (explicitTokens.has(wsRoot === '' ? '.' : wsRoot)) return true;
  const srcDir = wsRoot ? `${wsRoot}/src` : 'src';
  const libPath = `${srcDir}/lib.rs`;
  const mainPath = `${srcDir}/main.rs`;
  let hasManifest = false;
  let hasRustSrc = false;
  for (const task of spec.tasks) {
    if (taskCoversManifest(task, wsRoot)) hasManifest = true;
    for (const rawScope of task.writePaths ?? []) {
      const scope = normalizeScopePath(rawScope);
      if (!scope) continue;
      if (scope === libPath || scope === mainPath || (scope.startsWith(`${srcDir}/`) && /\.rs$/i.test(scope))) {
        hasRustSrc = true;
      }
    }
  }
  return hasManifest && hasRustSrc;
}
function waveZeroPolicyFindings({ waveZeroTasks, ancestors, architecturePolicy, requiredWorkspaces }) {
  if (architecturePolicy?.schemaVersion === 2 && architecturePolicy?.language === 'rust') return [];
  const policyTasks = waveZeroTasks.filter(task =>
    (task.writePaths ?? []).some(scope => isExplicitContractScope(scope, '', 'architecture.policy.json')),
  );
  if (!policyTasks.length) {
    return [
      finding(
        'architecture_policy_required',
        'Для Rust workspace с ≥ 3 крейтами Волна 0 (foundation) должна содержать задачу, ' +
          'создающую architecture.policy.json (в её writePaths), иначе гейты при architecture.enabled будут заблокированы',
      ),
    ];
  }
  const policyIds = new Set(policyTasks.map(task => task.id));
  const unordered = new Set(
    waveZeroTasks
      .filter(
        task =>
          !policyIds.has(task.id) &&
          !policyTasks.some(
            pt =>
              ancestors.get(task.id)?.has(pt.id) || (pt.epicId === task.epicId && ancestors.get(pt.id)?.has(task.id)),
          ),
      )
      .map(task => task.id),
  );
  // At the first epic gate carrying architecture.policy.json, the workspace manifest and
  // compilable contract crate must already exist (same task, same epic, or an ancestor task).
  for (const pt of policyTasks) {
    const ptAncestors = ancestors.get(pt.id) ?? new Set();
    const available = waveZeroTasks.filter(
      task => task.id === pt.id || task.epicId === pt.epicId || ptAncestors.has(task.id),
    );
    for (const { wsRoot, wsContracts } of requiredWorkspaces) {
      const hasManifest = available.some(task => taskCoversManifest(task, wsRoot));
      const hasContract = available.some(task =>
        [...wsContracts].some(contractRoot => taskCreatesCompilableContractCrate(task, contractRoot)),
      );
      if (!hasManifest || !hasContract) unordered.add(pt.id);
    }
  }
  if (!unordered.size) return [];
  return [
    finding(
      'architecture_policy_order',
      'Остальные задачи Волны 0 (foundation) должны зависеть от задачи, создающей architecture.policy.json, ' +
        'или совпадать с ней, а к гейту эпика с политикой уже должны существовать Cargo.toml и контрактный крейт',
      [...unordered].sort(compare),
    ),
  ];
}
/** Multi-crate Rust workspaces (>= 3 crates sharing a workspace root) must create a compilable
 * contract crate (`Cargo.toml` + `src/**`) and `architecture.policy.json` in Wave 0. */
export function rustContractCrateFindings(
  spec,
  projectMarkdown = '',
  architecturePolicy = null,
  ancestors = null,
  packageNames = null,
) {
  if (!isRustBlueprint(spec, projectMarkdown, architecturePolicy)) return [];
  const actualNames = normalizePackageNames(packageNames);
  const allCrates = new Map();
  for (const task of spec.tasks) {
    for (const scope of task.writePaths ?? []) {
      const crate = crateFromWritePath(scope);
      if (crate) allCrates.set(crate.root, actualNames.get(crate.root) ?? crate.name);
    }
  }
  const explicitTokens = declaredContractTokens(spec, projectMarkdown);
  const explicitRootPackages = declaredRootPackages(spec, projectMarkdown);
  const workspaceRoots = [...declaredWorkspaceRoots(spec, projectMarkdown, architecturePolicy, allCrates)].sort(
    (a, b) => b.length - a.length || compare(a, b),
  );
  const byWorkspace = new Map(workspaceRoots.map(wsRoot => [wsRoot, new Map()]));
  for (const [crateRoot, crateName] of allCrates.entries()) {
    const ownerWs = ownerWorkspaceOf(crateRoot, workspaceRoots);
    if (ownerWs !== undefined && crateRoot !== ownerWs) byWorkspace.get(ownerWs).set(crateRoot, crateName);
  }
  for (const [wsRoot, wsCrates] of byWorkspace.entries()) {
    if (
      !wsCrates.has(wsRoot) &&
      (actualNames.has(wsRoot) || hasRootPackageMember(spec, wsRoot, explicitRootPackages, explicitTokens))
    ) {
      wsCrates.set(wsRoot, actualNames.get(wsRoot) ?? (wsRoot ? wsRoot.split('/').at(-1) : spec.id || 'root'));
    }
  }

  const allContractRoots = new Set();
  if (workspaceRoots.length) {
    for (const [wsRoot, wsCrates] of byWorkspace.entries()) {
      for (const root of selectContractRootsForWorkspace({
        wsRoot,
        wsCrates,
        workspaceRoots,
        explicitTokens,
        architecturePolicy,
        actualNames,
      }))
        allContractRoots.add(root);
    }
  } else {
    for (const [root, name] of allCrates.entries()) {
      if (explicitTokens.has(root) || explicitTokens.has(name) || CONTRACT_CRATE_NAME.test(name))
        allContractRoots.add(root);
    }
    for (const token of explicitTokens) {
      if (token.includes('/')) allContractRoots.add(token);
    }
  }
  const findings = [...broadContractScopeFindings(spec, allContractRoots)];
  if (!workspaceRoots.length) return findings;

  const waveZeroEpics = new Set(
    spec.epics.filter(epic => epic.id === FOUNDATION_ID || epic.milestoneId === FOUNDATION_ID).map(epic => epic.id),
  );
  const waveZeroTasks = spec.tasks.filter(task => waveZeroEpics.has(task.epicId));
  if (!waveZeroTasks.length) return findings;

  const requiredWorkspaces = [];
  let missingContract = false;
  for (const [wsRoot, wsCrates] of byWorkspace.entries()) {
    if (wsCrates.size < RUST_CONTRACT_CRATE_MIN) continue;
    const wsContracts = selectContractRootsForWorkspace({
      wsRoot,
      wsCrates,
      workspaceRoots,
      explicitTokens,
      architecturePolicy,
      actualNames,
    });
    requiredWorkspaces.push({ wsRoot, wsContracts });
    const satisfied = waveZeroTasks.some(task =>
      [...wsContracts].some(contractRoot => taskCreatesCompilableContractCrate(task, contractRoot)),
    );
    if (!satisfied) missingContract = true;
  }
  if (missingContract) {
    findings.push(
      finding(
        'contract_crate_required',
        'Для Rust workspace с ≥ 3 крейтами Волна 0 (foundation) должна содержать задачу, ' +
          'создающую компилируемый контрактный крейт (Cargo.toml и src/** в crates/<name>-contracts ' +
          'или явно объявленном контрактном крейте), защищённый через contractCrates в architecture.policy.json',
      ),
    );
  }
  if (requiredWorkspaces.length) {
    const resolvedAncestors = ancestors ?? taskAncestors(spec.tasks);
    findings.push(
      ...waveZeroPolicyFindings({
        waveZeroTasks,
        ancestors: resolvedAncestors,
        architecturePolicy,
        requiredWorkspaces,
      }),
    );
  }
  return findings;
}
function isRustWriteScope(rawScope) {
  const scope = normalizeRelScope(rawScope);
  if (!scope) return false;
  return /(?:^|[/{,])(?:Cargo\.toml|[^/{},]+\.rs)(?:[},]|$)/i.test(scope);
}
function isRustToolchainBlueprint(spec, architecturePolicy, { hasCommittedCargoManifest = false } = {}) {
  if (architecturePolicy?.schemaVersion === 2 && architecturePolicy?.language === 'rust') return true;
  if (hasCommittedCargoManifest) return true;
  return spec.tasks.some(task => (task.writePaths ?? []).some(isRustWriteScope));
}
/** Wave 0 for Rust blueprints must include `rust-toolchain.toml` (exact `channel = "1.x.y"`
 * with `clippy` and `rustfmt` components) in its writePaths unless a valid committed file already exists. */
export function rustToolchainFindings(
  spec,
  _projectMarkdown = '',
  architecturePolicy = null,
  { hasRustToolchain = false, hasCommittedCargoManifest = false } = {},
) {
  if (hasRustToolchain) return [];
  const waveZeroEpics = new Set(
    spec.epics.filter(epic => epic.id === FOUNDATION_ID || epic.milestoneId === FOUNDATION_ID).map(epic => epic.id),
  );
  const waveZeroTasks = spec.tasks.filter(task => waveZeroEpics.has(task.epicId));
  if (!waveZeroTasks.length) return [];
  if (!isRustToolchainBlueprint(spec, architecturePolicy, { hasCommittedCargoManifest })) return [];
  const coversToolchain = waveZeroTasks.some(task =>
    (task.writePaths ?? []).some(rawScope => {
      const scope = normalizeScopePath(rawScope);
      return (
        Boolean(scope) &&
        (scope === 'rust-toolchain.toml' ||
          scope.endsWith('/rust-toolchain.toml') ||
          isExplicitContractScope(scope, '', 'rust-toolchain.toml'))
      );
    }),
  );
  if (coversToolchain) return [];
  return [
    finding(
      'rust_toolchain_required',
      'Для Rust-проекта Волна 0 (foundation) должна содержать задачу с rust-toolchain.toml ' +
        '(точная версия channel = "1.x.y", компоненты clippy и rustfmt) в writePaths',
    ),
  ];
}
export async function readOptionalCargoPackageNames(root, specValue, projectMarkdown) {
  const dirs = new Set(['']);
  if (isPlain(specValue) && Array.isArray(specValue.tasks)) {
    for (const task of specValue.tasks) {
      if (!isPlain(task) || !Array.isArray(task.writePaths)) continue;
      for (const scope of task.writePaths) {
        if (typeof scope !== 'string') continue;
        const crate = crateFromWritePath(scope);
        if (crate) dirs.add(crate.root);
      }
    }
    for (const token of declaredContractTokens(specValue, projectMarkdown)) {
      if (token.includes('/')) dirs.add(token);
    }
  }
  const names = new Map();
  for (const dir of dirs) {
    if (dir && dir.split('/').some(part => !part || part === '.' || part === '..' || /[*?[{]/.test(part))) continue;
    const target = dir ? path.join(root, ...dir.split('/'), 'Cargo.toml') : path.join(root, 'Cargo.toml');
    if (!inside(root, target)) continue;
    try {
      const file = await readBoundedFile(target, BLUEPRINT_LIMITS.project);
      const doc = parseToml(file.text);
      const pkg = /** @type {Record<string, any> | null} */ (isPlain(doc?.package) ? doc.package : null);
      const pkgName = typeof pkg?.name === 'string' ? pkg.name.trim() : '';
      if (pkgName) names.set(dir, pkgName);
    } catch {
      /* Missing or unreadable manifest: fall back to directory name. */
    }
  }
  return names;
}
