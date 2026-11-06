const tokenFields = [
  'inputTokens',
  'cachedInputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'totalTokens',
];
const count = value => (Number.isSafeInteger(value) && value >= 0 ? value : null);
const duration = value => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function sum(values) {
  if (!values.length || values.some(value => value === null)) return null;
  return count(values.reduce((total, value) => total + value, 0));
}

export function normalizeUsage(client, usage) {
  const result = {
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: null,
    semantics: 'unknown',
    source: null,
  };
  if (!['codex', 'claude-code'].includes(client) || !object(usage)) return result;
  result.source = `${client}.usage`;
  result.inputTokens = count(usage.input_tokens);
  result.outputTokens = count(usage.output_tokens);
  if (client === 'codex') {
    result.semantics = 'input-includes-cached';
    result.cachedInputTokens = count(usage.cached_input_tokens);
    if (result.inputTokens !== null && result.cachedInputTokens > result.inputTokens) result.cachedInputTokens = null;
    result.totalTokens = sum([result.inputTokens, result.outputTokens]);
  } else {
    result.semantics = 'cache-read-and-write-separate-from-input';
    result.cacheReadTokens = count(usage.cache_read_input_tokens);
    result.cacheWriteTokens = count(usage.cache_creation_input_tokens);
    result.totalTokens = sum([
      result.inputTokens,
      result.cacheReadTokens,
      result.cacheWriteTokens,
      result.outputTokens,
    ]);
  }
  return result;
}

function toolSteps(client, events) {
  if (!Array.isArray(events) || !['codex', 'claude-code'].includes(client)) return null;
  const seen = new Set(),
    blocks = new Map();
  let steps = 0;
  const complete = id => {
    if (typeof id !== 'string' || !id) {
      steps++;
      return;
    }
    if (!seen.has(id)) {
      seen.add(id);
      steps++;
    }
  };
  for (const event of events) {
    if (!object(event)) continue;
    if (client === 'codex') {
      if (
        event.type === 'item.completed' &&
        ['command_execution', 'mcp_tool_call', 'web_search', 'file_change', 'collab_tool_call'].includes(
          event.item?.type,
        )
      )
        complete(event.item.id);
    } else {
      // Full assistant messages contain complete tool-use blocks. Partial stream
      // starts only count after content_block_stop; IDs deduplicate both forms.
      if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
        for (const block of event.message.content)
          if (block?.type === 'tool_use' && typeof block.id === 'string' && block.id) complete(block.id);
      }
      const stream = event.type === 'stream_event' ? event.event : null;
      if (stream?.type === 'message_start') blocks.clear();
      if (stream?.type === 'content_block_start' && stream.content_block?.type === 'tool_use')
        blocks.set(stream.index, stream.content_block.id);
      if (stream?.type === 'content_block_stop' && blocks.has(stream.index)) {
        const id = blocks.get(stream.index);
        blocks.delete(stream.index);
        if (typeof id === 'string' && id) complete(id);
      }
    }
  }
  return steps;
}

export function sessionMetrics(client, events, { durationMs, usage } = {}) {
  if (usage === undefined && Array.isArray(events)) {
    for (const event of events) {
      if (
        (client === 'codex' && event?.type === 'turn.completed') ||
        (client === 'claude-code' && event?.type === 'result')
      )
        usage = event.usage;
    }
  }
  return {
    durationMs: duration(durationMs),
    toolSteps: toolSteps(client, events),
    promptBytes: null,
    contextOriginalBytes: null,
    contextSentBytes: null,
    nativeRequestCount: null,
    usage: normalizeUsage(client, usage),
  };
}

export function aggregateMetrics(receipts = []) {
  if (!Array.isArray(receipts)) throw new TypeError('Metrics receipts must be an array');
  const metrics = Array.from(receipts, receipt => receipt?.metrics ?? receipt);
  const completeness = {};
  function aggregate(values, target, key, numeric = count) {
    const normalized = values.map(numeric);
    const known = normalized.filter(value => value !== null).length;
    target[key] = { known, total: metrics.length, complete: metrics.length > 0 && known === metrics.length };
    if (!target[key].complete) return null;
    const total = normalized.reduce((value, item) => value + item, 0);
    return numeric(total);
  }
  const durationMs = aggregate(
    metrics.map(value => value?.durationMs),
    completeness,
    'durationMs',
    duration,
  );
  const steps = aggregate(
    metrics.map(value => value?.toolSteps),
    completeness,
    'toolSteps',
  );
  // Local UTF-8 payload measurements are independent of native token/cache
  // usage. Missing historical measurements must remain unknown, never zero.
  const byteMetrics = Object.fromEntries(
    ['promptBytes', 'contextOriginalBytes', 'contextSentBytes'].map(key => [
      key,
      aggregate(
        metrics.map(value => value?.[key]),
        completeness,
        key,
      ),
    ]),
  );
  // Neither native stream exposes the actual backend HTTP request count.
  completeness.nativeRequestCount = { known: 0, total: metrics.length, complete: false };
  completeness.usage = {};
  const usage = Object.fromEntries(
    tokenFields.map(key => [
      key,
      aggregate(
        metrics.map(value => value?.usage?.[key]),
        completeness.usage,
        key,
      ),
    ]),
  );
  const semantics = new Set(metrics.map(value => value?.usage?.semantics ?? 'unknown'));
  usage.semantics = semantics.size > 1 ? 'mixed' : (semantics.values().next().value ?? 'unknown');
  usage.source = metrics.length ? 'aggregate' : null;
  return {
    sessions: metrics.length,
    durationMs,
    toolSteps: steps,
    ...byteMetrics,
    nativeRequestCount: null,
    usage,
    completeness,
  };
}
