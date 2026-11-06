import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUsage, sessionMetrics, aggregateMetrics } from '../runtime/metrics.mjs';

test('Codex totals include cached input once and expose absent cache fields as unknown', () => {
  const result = normalizeUsage('codex', {
    input_tokens: 100,
    cached_input_tokens: 80,
    output_tokens: 20,
    total_tokens: 999,
  });
  assert.equal(result.inputTokens, 100);
  assert.equal(result.cachedInputTokens, 80);
  assert.equal(result.outputTokens, 20);
  assert.equal(result.totalTokens, 120);
  assert.equal(result.cacheReadTokens, null);
  assert.equal(result.cacheWriteTokens, null);
  assert.match(result.semantics, /includes.*cached/);
  assert.equal(normalizeUsage('codex', { input_tokens: 0, output_tokens: 0 }).totalTokens, 0);
});

test('Claude totals add separate cache reads and writes only when all components are known', () => {
  const result = normalizeUsage('claude-code', {
    input_tokens: 10,
    cache_read_input_tokens: 80,
    cache_creation_input_tokens: 5,
    output_tokens: 20,
  });
  assert.equal(result.inputTokens, 10);
  assert.equal(result.cachedInputTokens, null);
  assert.equal(result.cacheReadTokens, 80);
  assert.equal(result.cacheWriteTokens, 5);
  assert.equal(result.totalTokens, 115);
  assert.match(result.semantics, /separate/);
  assert.equal(normalizeUsage('claude-code', { input_tokens: 10, output_tokens: 20 }).totalTokens, null);
  assert.equal(
    normalizeUsage('claude-code', {
      input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: 0,
    }).totalTokens,
    0,
  );
});

test('Missing malformed negative fractional and nonfinite native usage stays nullable', () => {
  for (const usage of [
    undefined,
    null,
    [],
    'unknown',
    { input_tokens: '10', output_tokens: -1 },
    { input_tokens: NaN, output_tokens: Infinity },
    { input_tokens: 1.5, output_tokens: true },
  ]) {
    const result = normalizeUsage('codex', usage);
    for (const key of [
      'inputTokens',
      'cachedInputTokens',
      'outputTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
      'totalTokens',
    ])
      assert.equal(result[key], null);
  }
  assert.equal(
    normalizeUsage('codex', { input_tokens: 10, cached_input_tokens: 11, output_tokens: 1 }).cachedInputTokens,
    null,
  );
  assert.equal(normalizeUsage('codex', { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 }).totalTokens, null);
  assert.equal(normalizeUsage('other', { input_tokens: 10, output_tokens: 1 }).totalTokens, null);
});

test('Codex tool steps count completed tools once and exclude starts updates and prose', () => {
  const complete = {
    type: 'item.completed',
    item: { id: 'command-1', type: 'command_execution', aggregated_output: 'fixture-private-payload' },
  };
  const events = [
    { type: 'item.started', item: complete.item },
    { type: 'item.updated', item: complete.item },
    complete,
    complete,
    { type: 'item.completed', item: { id: 'mcp-1', type: 'mcp_tool_call' } },
    { type: 'item.completed', item: { id: 'search-1', type: 'web_search' } },
    { type: 'item.completed', item: { id: 'patch-1', type: 'file_change' } },
    { type: 'item.completed', item: { id: 'text-1', type: 'agent_message' } },
    { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 3 } },
  ];
  const result = sessionMetrics('codex', events, { durationMs: 12.5 });
  assert.equal(result.toolSteps, 4);
  assert.equal(result.durationMs, 12.5);
  assert.equal(result.nativeRequestCount, null);
  assert.equal(result.usage.totalTokens, 13);
  assert.equal(JSON.stringify(result).includes('fixture-private-payload'), false);
});

test('Claude counts completed assistant tool uses once by ID across full and stream events', () => {
  const tool = { type: 'tool_use', id: 'tool-1', name: 'Read', input: { private: 'fixture-private-payload' } };
  const events = [
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: tool } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { partial_json: '{}' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
    { type: 'assistant', message: { id: 'message-1', content: [tool, { type: 'text', text: 'working' }] } },
    { type: 'assistant', message: { id: 'message-1', content: [tool] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-2', name: 'Bash' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1' }] } },
    {
      type: 'stream_event',
      event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'unfinished' } },
    },
  ];
  const result = sessionMetrics('claude-code', events, { durationMs: 0 });
  assert.equal(result.toolSteps, 2);
  assert.equal(result.durationMs, 0);
  assert.equal(result.usage.totalTokens, null);
  assert.equal(JSON.stringify(result).includes('fixture-private-payload'), false);
});

test('Metrics prefer terminal usage and accept failed terminal receipts without inventing request counts', () => {
  const events = [
    { type: 'assistant', message: { usage: { input_tokens: 999, output_tokens: 999 } } },
    {
      type: 'result',
      is_error: true,
      usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 4 },
    },
  ];
  assert.equal(sessionMetrics('claude-code', events).usage.totalTokens, 14);
  assert.equal(sessionMetrics('claude-code', events, { usage: null }).usage.totalTokens, null);
  assert.equal(sessionMetrics('codex', []).toolSteps, 0);
  assert.equal(sessionMetrics('codex', undefined).toolSteps, null);
  assert.equal(sessionMetrics('unknown', []).toolSteps, null);
  for (const durationMs of [undefined, -1, NaN, Infinity, '1'])
    assert.equal(sessionMetrics('codex', [], { durationMs }).durationMs, null);
});

test('Aggregation sums known session measurements and reports mixed cache semantics explicitly', () => {
  const codex = sessionMetrics('codex', [], {
    durationMs: 20,
    usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 20 },
  });
  const claude = sessionMetrics('claude-code', [], {
    durationMs: 30,
    usage: { input_tokens: 10, cache_read_input_tokens: 80, cache_creation_input_tokens: 5, output_tokens: 20 },
  });
  const result = aggregateMetrics([{ metrics: codex }, { metrics: claude }]);
  assert.equal(result.sessions, 2);
  assert.equal(result.durationMs, 50);
  assert.equal(result.toolSteps, 0);
  assert.equal(result.usage.totalTokens, 235);
  assert.equal(result.usage.cachedInputTokens, null);
  assert.equal(result.usage.semantics, 'mixed');
  assert.equal(result.nativeRequestCount, null);
  assert.equal(result.completeness.usage.totalTokens.complete, true);
});

test('Aggregation preserves partial and absent evidence instead of fabricating zeros', () => {
  const known = sessionMetrics('codex', [], { durationMs: 10, usage: { input_tokens: 4, output_tokens: 2 } });
  const result = aggregateMetrics([known, {}]);
  assert.equal(result.sessions, 2);
  assert.equal(result.durationMs, null);
  assert.equal(result.toolSteps, null);
  assert.equal(result.usage.totalTokens, null);
  assert.deepEqual(result.completeness.usage.totalTokens, { known: 1, total: 2, complete: false });
  const empty = aggregateMetrics([]);
  assert.equal(empty.sessions, 0);
  assert.equal(empty.durationMs, null);
  assert.equal(empty.toolSteps, null);
  assert.equal(empty.usage.totalTokens, null);
});

test('Local prompt and context bytes aggregate independently while legacy and malformed measurements stay unknown', () => {
  const nativeOnly = sessionMetrics('codex', [], { usage: { input_tokens: 4, output_tokens: 2 } });
  for (const key of ['promptBytes', 'contextOriginalBytes', 'contextSentBytes'])
    assert.equal(nativeOnly[key], null, 'native token usage does not establish local payload bytes');
  const measured = {
    promptBytes: 52,
    contextOriginalBytes: 80,
    contextSentBytes: 20,
    usage: normalizeUsage('codex', { input_tokens: 4, output_tokens: 2 }),
  };
  const result = aggregateMetrics([
    measured,
    { ...measured, promptBytes: 18, contextOriginalBytes: 5, contextSentBytes: 12 },
  ]);
  assert.equal(result.promptBytes, 70);
  assert.equal(result.contextOriginalBytes, 85);
  assert.equal(result.contextSentBytes, 32, 'tiny contexts may grow; no fictional savings');
  assert.equal(result.usage.totalTokens, 12);
  for (const missing of [{}, { promptBytes: -1 }, { promptBytes: '52' }, { promptBytes: 1.5 }]) {
    const partial = aggregateMetrics([measured, missing]);
    assert.equal(partial.promptBytes, null);
    assert.deepEqual(partial.completeness.promptBytes, { known: 1, total: 2, complete: false });
    assert.equal(partial.contextSentBytes, null);
  }
  assert.equal(aggregateMetrics([]).promptBytes, null);
});
