/**
 * Compact, deduplicated, size-bounded diagnostic pack extracted from:
 * - `cargo build/check/test --message-format=json` (`compiler-message` + test failures)
 * - `node:test` TAP and spec output (plus `node --check` syntax errors)
 * - Kodo verification gates (behaviour, architecture, security, UI, review)
 *
 * Output items carry `{ file, line, column, code, level, message, failingTests[] }`.
 * No model calls, no network, secrets redacted before serialization.
 */
import { redact } from './security.mjs';

export const DEFAULT_MAX_DIAGNOSTICS = 25;
export const DEFAULT_MAX_DIAGNOSTIC_BYTES = 4096;
const MAX_MESSAGE_CHARS = 320;
const MAX_FAILING_TESTS = 50;

const byteLength = text => Buffer.byteLength(text, 'utf8');
const cleanPath = value => {
  if (typeof value !== 'string') return null;
  const trimmed = value
    .trim()
    .replace(/^file:\/\//, '')
    .replaceAll('\\', '/');
  return trimmed || null;
};
const safeInt = value => (Number.isSafeInteger(value) && value > 0 ? value : null);
const trimMessage = (value, max = MAX_MESSAGE_CHARS) => {
  const oneLine = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(oneLine);
  return chars.length <= max ? oneLine : chars.slice(0, max - 1).join('') + '…';
};
const normalizeLevel = value => {
  const raw = String(value ?? '').toLowerCase();
  if (['error', 'blocker', 'major', 'critical', 'high', 'failed', 'failure', 'fatal'].includes(raw)) return 'error';
  if (['warning', 'warn', 'minor', 'medium', 'low'].includes(raw)) return 'warning';
  if (['info', 'note', 'help'].includes(raw)) return 'info';
  return 'error';
};

// ---- Rust / Cargo JSON parser -----------------------------------------------

const RUST_SUMMARY_NOISE =
  /^(?:aborting due to \d+ previous errors?|could not compile |for more information about this error)/i;

function parseCargoJson(text) {
  const items = [];
  const failingTests = [];
  const lines = text.split(/\r?\n/);
  let inFailuresBlock = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      inFailuresBlock = false;
      continue;
    }
    if (line.startsWith('{') && line.endsWith('}')) {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        parsed = null;
      }
      if (parsed?.reason === 'compiler-message' && parsed.message && typeof parsed.message === 'object') {
        const msg = parsed.message;
        const level = normalizeLevel(msg.level);
        if (['note', 'help', 'failure-note'].includes(String(msg.level ?? '').toLowerCase())) continue;
        const spans = Array.isArray(msg.spans) ? msg.spans : [];
        const primary = spans.find(s => s?.is_primary === true) ?? spans[0] ?? null;
        const baseMsg = String(msg.message ?? '').trim();
        if (!baseMsg) continue;
        const label = typeof primary?.label === 'string' && primary.label.trim() ? primary.label.trim() : '';
        const combined = label && !baseMsg.includes(label) ? `${baseMsg} (${label})` : baseMsg;
        items.push({
          file: cleanPath(primary?.file_name),
          line: safeInt(primary?.line_start),
          column: safeInt(primary?.column_start),
          code: typeof msg.code?.code === 'string' && msg.code.code.trim() ? msg.code.code.trim() : null,
          level,
          message: trimMessage(combined),
          failingTests: [],
          _summaryNoise: spans.length === 0 && RUST_SUMMARY_NOISE.test(baseMsg),
        });
        continue;
      }
    }
    const cargoTestMatch = /^test\s+([^\s]+)\s+\.\.\.\s+FAILED$/.exec(line);
    if (cargoTestMatch) {
      failingTests.push(cargoTestMatch[1]);
      continue;
    }
    if (line === 'failures:') {
      inFailuresBlock = true;
      continue;
    }
    if (inFailuresBlock) {
      if (line.startsWith('test result:')) {
        inFailuresBlock = false;
      } else if (/^\s{2,}[A-Za-z0-9_:]/.test(raw) && !raw.includes(' ')) {
        // single indented identifier
        failingTests.push(line);
      } else if (/^\s{4}[A-Za-z0-9_:-]+$/.test(raw)) {
        failingTests.push(line);
      }
    }
  }
  const hasRealErrors = items.some(item => item.level === 'error' && !item._summaryNoise);
  const filtered = items
    .filter(item => !(hasRealErrors && item._summaryNoise))
    .map(({ _summaryNoise: _drop, ...rest }) => rest);
  return { items: filtered, failingTests };
}

// ---- node:test (spec & TAP) + Node syntax error parser ----------------------

function parseLocation(raw) {
  if (typeof raw !== 'string') return { file: null, line: null, column: null };
  const cleaned = raw.trim().replace(/^['"]|['"]$/g, '');
  const match = /^(?:file:\/\/\/?)?(.+?):(\d+)(?::(\d+))?$/.exec(cleaned);
  if (!match) return { file: cleanPath(cleaned), line: null, column: null };
  return {
    file: cleanPath(match[1]),
    line: safeInt(Number(match[2])),
    column: match[3] ? safeInt(Number(match[3])) : null,
  };
}

function extractErrorCode(line) {
  const bracketed = /\[(ERR_[A-Z0-9_]+)\]/.exec(line);
  if (bracketed) return bracketed[1];
  const typed = /^([A-Za-z]+Error):/.exec(line.trim());
  return typed ? typed[1] : null;
}

function parseNodeTestSpec(text) {
  const items = [];
  const failingTests = [];
  const lines = text.split(/\r?\n/);
  const sectionIndex = lines.findIndex(line => /^\s*failing tests:\s*$/i.test(line));
  if (sectionIndex !== -1) {
    let i = sectionIndex + 1;
    while (i < lines.length) {
      const locMatch = /^\s*test at (.+?):(\d+):(\d+)\s*$/.exec(lines[i]);
      if (!locMatch) {
        i++;
        continue;
      }
      const file = cleanPath(locMatch[1]);
      const line = safeInt(Number(locMatch[2]));
      const column = safeInt(Number(locMatch[3]));
      i++;
      let testName = null;
      if (i < lines.length) {
        const failLine = /^\s*[✖×x]\s+(.+?)(?:\s+\([\d.]+m?s\))?\s*$/.exec(lines[i]);
        if (failLine) {
          testName = failLine[1].trim();
          failingTests.push(testName);
          i++;
        }
      }
      const detailLines = [];
      while (i < lines.length && !/^\s*test at /.test(lines[i])) {
        const trimmed = lines[i].trim();
        if (trimmed && !trimmed.startsWith('ℹ')) detailLines.push(trimmed);
        i++;
      }
      const firstDetail = detailLines[0] ?? (testName ? `Test failed: ${testName}` : 'Test failed');
      const code = detailLines.map(extractErrorCode).find(Boolean) ?? 'test_failed';
      items.push({
        file,
        line,
        column,
        code,
        level: 'error',
        message: trimMessage(detailLines.slice(0, 2).join(' — ') || firstDetail),
        failingTests: testName ? [testName] : [],
      });
    }
  } else {
    for (const raw of lines) {
      const match = /^\s*[✖×]\s+(.+?)(?:\s+\([\d.]+m?s\))?\s*$/.exec(raw);
      if (match) failingTests.push(match[1].trim());
    }
  }
  return { items, failingTests };
}

function parseNodeTestTap(text) {
  const items = [];
  const failingTests = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*not ok \d+\s*(?:-\s*)?(.+?)\s*$/.exec(lines[i]);
    if (!match) continue;
    const testName = match[1].trim();
    if (!testName) continue;
    failingTests.push(testName);
    let file = null,
      line = null,
      column = null,
      code = null,
      errorMsg = null;
    if (lines[i + 1]?.trim() === '---') {
      let j = i + 2;
      while (j < lines.length && lines[j].trim() !== '...') {
        const row = lines[j].trim();
        const loc = /^location:\s*(.+)$/.exec(row);
        if (loc) ({ file, line, column } = parseLocation(loc[1]));
        const err = /^error:\s*(.+)$/.exec(row);
        if (err) errorMsg = err[1].trim().replace(/^['"]|['"]$/g, '');
        const codeMatch = /^code:\s*(.+)$/.exec(row);
        if (codeMatch) code = codeMatch[1].trim().replace(/^['"]|['"]$/g, '');
        j++;
      }
      i = j;
    }
    items.push({
      file,
      line,
      column,
      code: code || (errorMsg ? extractErrorCode(errorMsg) : null) || 'test_failed',
      level: 'error',
      message: trimMessage(errorMsg || `Test failed: ${testName}`),
      failingTests: [testName],
    });
  }
  return { items, failingTests };
}

function parseNodeSyntaxError(text) {
  const items = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const errMatch = /^(SyntaxError|ReferenceError|TypeError):\s*(.+)$/.exec(lines[i].trim());
    if (!errMatch) continue;
    let file = null,
      line = null;
    for (let back = i - 1; back >= Math.max(0, i - 5); back--) {
      const loc = /^([^\s].+\.[cm]?[jt]sx?):(\d+)$/.exec(lines[back].trim());
      if (loc) {
        file = cleanPath(loc[1]);
        line = safeInt(Number(loc[2]));
        break;
      }
    }
    if (file) {
      items.push({
        file,
        line,
        column: null,
        code: errMatch[1],
        level: 'error',
        message: trimMessage(`${errMatch[1]}: ${errMatch[2]}`),
        failingTests: [],
      });
    }
  }
  return items;
}

// ---- Kodo gate & review failure parser --------------------------------------

function normalizeFinding(f, fallbackCode) {
  if (!f || typeof f !== 'object') return null;
  const code =
    typeof f.ruleId === 'string' && f.ruleId.trim()
      ? f.ruleId.trim()
      : typeof f.code === 'string' && f.code.trim()
        ? f.code.trim()
        : fallbackCode;
  return {
    file: cleanPath(f.file),
    line: safeInt(f.line),
    column: safeInt(f.column),
    code,
    level: normalizeLevel(f.severity ?? f.level ?? 'error'),
    message: trimMessage(f.message || f.problem || f.reason || fallbackCode),
    failingTests: [],
  };
}

function parseBehaviorFailures(behavior) {
  if (!behavior || typeof behavior !== 'object' || behavior.passed !== false) return [];
  const list = Array.isArray(behavior.findings) ? behavior.findings : [];
  if (list.length) return list.map(f => normalizeFinding(f, behavior.code || 'behavior_gate')).filter(Boolean);
  return [
    {
      file: null,
      line: null,
      column: null,
      code: typeof behavior.code === 'string' ? behavior.code : 'behavior_gate',
      level: 'error',
      message: trimMessage(behavior.message || behavior.reason || 'Behaviour gate failed'),
      failingTests: [],
    },
  ];
}

function parseGateReceipts(gates) {
  const items = [];
  for (const receipt of Array.isArray(gates) ? gates : []) {
    if (!receipt || typeof receipt !== 'object' || ['passed', 'disabled'].includes(receipt.status)) continue;
    const found = [
      ...(Array.isArray(receipt.findings) ? receipt.findings : []),
      ...(Array.isArray(receipt.report?.findings) ? receipt.report.findings : []),
      ...(Array.isArray(receipt.tools)
        ? receipt.tools.flatMap(t => (Array.isArray(t?.findings) ? t.findings : []))
        : []),
    ];
    for (const f of found) {
      const normalized = normalizeFinding(f, receipt.gate || 'gate_failed');
      if (normalized) items.push(normalized);
    }
    for (const c of Array.isArray(receipt.cases) ? receipt.cases : []) {
      if (c && c.status && c.status !== 'passed') {
        items.push({
          file: null,
          line: null,
          column: null,
          code: `ui_case:${String(c.id ?? 'unknown')}`,
          level: 'error',
          message: trimMessage(`UI case ${c.id ?? 'unknown'} (${c.tool ?? 'ui'}) ${c.status}`),
          failingTests: [],
        });
      }
    }
  }
  return items;
}

function parseReviewFindings(review) {
  if (!review || typeof review !== 'object' || review.passed !== false || !Array.isArray(review.findings)) return [];
  return review.findings
    .filter(f => f && typeof f === 'object')
    .map(f => ({
      file: cleanPath(f.file),
      line: safeInt(f.line),
      column: null,
      code: 'review_finding',
      level: normalizeLevel(f.severity),
      message: trimMessage(f.problem || 'Review finding'),
      failingTests: [],
    }));
}

function parseGateFailures({ gates, behavior, review, error }) {
  const items = [...parseBehaviorFailures(behavior), ...parseGateReceipts(gates), ...parseReviewFindings(review)];
  if (error && typeof error === 'object' && !items.length) {
    const code = typeof error.code === 'string' && error.code.trim() ? error.code.trim() : 'check_failed';
    const message = trimMessage(error.message || code);
    if (message) {
      items.push({ file: null, line: null, column: null, code, level: 'error', message, failingTests: [] });
    }
  }
  return items;
}

// ---- Deduplication & size bounding ------------------------------------------

const levelRank = { error: 0, warning: 1, info: 2 };

function deduplicateItems(rawItems, secrets) {
  const byKey = new Map();
  const order = [];
  for (const raw of rawItems) {
    const item = {
      file: raw.file ? redact(raw.file, secrets) : null,
      line: safeInt(raw.line),
      column: safeInt(raw.column),
      code: raw.code ? redact(String(raw.code), secrets) : null,
      level: normalizeLevel(raw.level),
      message: trimMessage(redact(String(raw.message ?? ''), secrets)),
      failingTests: Array.isArray(raw.failingTests)
        ? [...new Set(raw.failingTests.map(name => redact(String(name), secrets).trim()).filter(Boolean))]
        : [],
    };
    const key = `${item.file ?? ''}|${item.line ?? ''}|${item.column ?? ''}|${item.code ?? ''}|${item.level}|${item.message}`;
    const existing = byKey.get(key);
    if (existing) {
      for (const name of item.failingTests) if (!existing.failingTests.includes(name)) existing.failingTests.push(name);
    } else {
      byKey.set(key, item);
      order.push(item);
    }
  }
  // Errors first, then warnings, then info; stable order within each level.
  return order.sort((a, b) => (levelRank[a.level] ?? 9) - (levelRank[b.level] ?? 9));
}

function packDiagnostics({ items, failingTests, maxItems, maxBytes }) {
  const totalFound = items.length;
  const keptTests = failingTests.slice(0, MAX_FAILING_TESTS);
  let kept = items.slice(0, maxItems);
  let truncated = totalFound > kept.length || failingTests.length > keptTests.length;

  const makeDoc = (list, tests, isTruncated) => {
    const doc = {
      schemaVersion: 1,
      kind: 'diagnostic-pack',
      items: list,
      failingTests: tests,
      totalFound,
      omitted: Math.max(0, totalFound - list.length),
      truncated: isTruncated,
      bytes: 0,
      maxBytes,
      maxItems,
    };
    // Measure with actual byte digit count converged.
    doc.bytes = byteLength(JSON.stringify(doc));
    doc.bytes = byteLength(JSON.stringify(doc));
    return doc;
  };

  let doc = makeDoc(kept, keptTests, truncated);
  while (doc.bytes > maxBytes && kept.length > 0) {
    kept = kept.slice(0, kept.length - 1);
    truncated = true;
    doc = makeDoc(kept, keptTests, true);
  }
  let tests = keptTests;
  while (doc.bytes > maxBytes && tests.length > 0) {
    tests = tests.slice(0, tests.length - 1);
    truncated = true;
    doc = makeDoc(kept, tests, true);
  }
  return doc;
}

/**
 * Build a compact, deduplicated, size-bounded diagnostic pack from command output
 * and/or Kodo gate/review receipts.
 *
 * @param {{
 *   stdout?: string,
 *   stderr?: string,
 *   checks?: any,
 *   behavior?: any,
 *   gates?: any[],
 *   review?: any,
 *   error?: any,
 *   secrets?: Record<string, any>,
 *   maxItems?: number,
 *   maxBytes?: number,
 * }} [input]
 */
export function buildDiagnosticPack(input = {}) {
  const {
    stdout = '',
    stderr = '',
    checks = null,
    behavior = null,
    gates = [],
    review = null,
    error = null,
    secrets = {},
    maxItems = DEFAULT_MAX_DIAGNOSTICS,
    maxBytes = DEFAULT_MAX_DIAGNOSTIC_BYTES,
  } = input;

  if (!Number.isSafeInteger(maxItems) || maxItems < 1)
    throw Object.assign(new Error('Diagnostic pack maxItems must be a positive integer'), {
      code: 'diagnostic_invalid',
    });
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 128)
    throw Object.assign(new Error('Diagnostic pack maxBytes must be >= 128'), { code: 'diagnostic_invalid' });

  const combinedText = [stdout, stderr].filter(part => typeof part === 'string' && part.length > 0).join('\n');

  const rawItems = [];
  const rawFailingTests = [];

  if (checks?.diagnostics?.items) {
    rawItems.push(...checks.diagnostics.items);
    if (Array.isArray(checks.diagnostics.failingTests)) rawFailingTests.push(...checks.diagnostics.failingTests);
  }
  if (error?.diagnostics?.items) {
    rawItems.push(...error.diagnostics.items);
    if (Array.isArray(error.diagnostics.failingTests)) rawFailingTests.push(...error.diagnostics.failingTests);
  }

  if (combinedText) {
    const cargo = parseCargoJson(combinedText);
    rawItems.push(...cargo.items);
    rawFailingTests.push(...cargo.failingTests);

    const spec = parseNodeTestSpec(combinedText);
    rawItems.push(...spec.items);
    rawFailingTests.push(...spec.failingTests);

    const tap = parseNodeTestTap(combinedText);
    rawItems.push(...tap.items);
    rawFailingTests.push(...tap.failingTests);

    if (!spec.items.length && !tap.items.length) {
      rawItems.push(...parseNodeSyntaxError(combinedText));
    }
  }

  const gateItems = parseGateFailures({
    gates,
    behavior,
    review,
    error: rawItems.length ? null : error,
  });
  rawItems.push(...gateItems);

  const items = deduplicateItems(rawItems, secrets);
  const failingTests = [
    ...new Set(
      [...rawFailingTests, ...items.flatMap(item => item.failingTests)]
        .map(name => redact(String(name), secrets).trim())
        .filter(Boolean),
    ),
  ];

  return packDiagnostics({ items, failingTests, maxItems, maxBytes });
}

/**
 * Render a diagnostic pack into a compact text summary for repair/retry briefs.
 * @param {ReturnType<typeof buildDiagnosticPack> | null | undefined} pack
 */
export function formatDiagnosticPack(pack) {
  if (!pack || typeof pack !== 'object') return '';
  const lines = ['Diagnostic pack:'];
  if (Array.isArray(pack.failingTests) && pack.failingTests.length) {
    lines.push(`Failing tests (${pack.failingTests.length}): ${pack.failingTests.join(', ')}`);
  }
  for (const item of pack.items ?? []) {
    const loc = item.file
      ? `${item.file}${item.line ? `:${item.line}${item.column ? `:${item.column}` : ''}` : ''}`
      : 'general';
    const code = item.code ? `[${item.code}] ` : '';
    lines.push(`- ${item.level} ${loc}: ${code}${item.message}`);
  }
  if (pack.truncated) {
    lines.push(`[truncated: omitted ${pack.omitted} diagnostics of ${pack.totalFound}; limit ${pack.maxBytes} bytes]`);
  }
  return lines.join('\n');
}
