import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QualityRun, QualitySample, QualitySampleResult } from '../types';

/**
 * Contract tests for the quality engine.
 *
 * The single most important guarantee in this module: a provider failure is
 * recorded as `error`, never as a failing answer, and a rate with no judgeable
 * sample behind it is `null` rather than `0`. A tool that reports "0% accuracy"
 * for a run where every request 401'd is worse than useless — it is actively
 * misleading. These tests exist to make that impossible to regress.
 */

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  updates: [] as Array<{ id: string; updates: Record<string, unknown> }>,
}));

vi.mock('./probeClient', () => ({
  resolveProbeTarget: (key: string) =>
    key.startsWith('unknown')
      ? null
      : {
          providerKey: key,
          configId: key.split(':')[0],
          providerName: 'Test Provider',
          modelName: key.split(':')[1] ?? 'model-x',
          endpoint: 'http://example.invalid/v1',
          apiKey: 'not-a-real-key',
          format: 'openai',
        },
}));

vi.mock('../providers/adapter', () => ({
  createDynamicProvider: vi.fn(() => ({ execute: mocks.execute })),
}));

vi.mock('./qualityRunStore', () => ({
  qualityRunStore: {
    create: (run: unknown) => run,
    update: (id: string, updates: Record<string, unknown>) => {
      mocks.updates.push({ id, updates });
      return undefined;
    },
    get: () => undefined,
  },
}));

import { cancelQualityRun, executeQualityRun, subscribeQualityRun, summarize } from './qualityEngine';

const TARGET = 'cfg:model-x';

function makeSample(n: number, category = 'cat-a'): QualitySample {
  return { id: `s${n}`, input: `question ${n}`, expected: 'ok', grader: 'exact', category };
}

function makeRun(overrides: Partial<QualityRun> = {}): QualityRun {
  const samples = [makeSample(1), makeSample(2), makeSample(3)];
  return {
    id: 'qr_test',
    name: 'Test run',
    status: 'pending',
    datasetId: 'ds_test',
    datasetName: 'Test dataset',
    datasetSnapshot: samples,
    targets: [TARGET],
    targetLabels: { [TARGET]: 'Test Provider / model-x' },
    params: { temperature: 0, maxTokens: 64, concurrency: 3, repeats: 1 },
    results: {},
    progress: { completed: 0, total: samples.length },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function llmResponse(text: string, outputTokens = 4, reasoningTokens = 0) {
  return {
    text,
    inputTokens: 12,
    outputTokens,
    reasoningTokens,
    totalTokens: 12 + outputTokens,
    responseTime: 40,
    firstTokenLatency: null,
    estimatedCost: 0.0005,
    model: 'model-x',
  };
}

/** The summary object from the final persisted update. */
function finalResults(): Record<string, { samples: QualitySampleResult[] } & Record<string, unknown>> {
  const last = mocks.updates[mocks.updates.length - 1];
  return last.updates.results as never;
}

beforeEach(() => {
  mocks.execute.mockReset();
  mocks.updates.length = 0;
  // Reset the engine's module-level cancellation set between tests.
  cancelQualityRun('qr_test');
});

describe('quality engine — provider failures', () => {
  it('records a provider failure as error and reports no pass rate at all', async () => {
    mocks.execute.mockRejectedValue(new Error('unauthorized: invalid api key'));

    await executeQualityRun(makeRun());

    const summary = finalResults()[TARGET];
    expect(summary.errorCount).toBe(3);
    expect(summary.passCount).toBe(0);
    expect(summary.failCount).toBe(0);

    // The whole point: no fabricated score.
    expect(summary.passRate).toBeNull();
    expect(summary.avgScore).toBeNull();

    for (const sample of summary.samples) {
      expect(sample.status).toBe('error');
      expect(sample.score).toBeNull();
      expect(sample.detailKey).toBe('quality.grade.providerFailed');
      expect(sample.output).toBe('');
    }

    expect((summary.errorBreakdown as Record<string, number>).api_error).toBe(3);
    expect(mocks.updates[mocks.updates.length - 1].updates.status).toBe('completed');
  });

  it('classifies failures by cause instead of lumping them together', async () => {
    mocks.execute
      .mockRejectedValueOnce(new Error('request timed out after 30000ms'))
      .mockRejectedValueOnce(new Error('fetch failed: ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('something inexplicable'));

    await executeQualityRun(makeRun());

    const breakdown = finalResults()[TARGET].errorBreakdown as Record<string, number>;
    expect(breakdown.timeout).toBe(1);
    expect(breakdown.network).toBe(1);
    expect(breakdown.unknown).toBe(1);
    expect(finalResults()[TARGET].passRate).toBeNull();
  });

  it('marks every sample as error when the target cannot be resolved', async () => {
    await executeQualityRun(makeRun({ targets: ['unknown:model'], targetLabels: { 'unknown:model': 'Nope' } }));

    const summary = finalResults()['unknown:model'];
    expect(summary.errorCount).toBe(3);
    expect(summary.passRate).toBeNull();
    expect(summary.samples.every((s) => s.detailKey === 'quality.grade.targetUnresolved')).toBe(true);
    // A target we could not even construct a provider for never calls the API.
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});

describe('quality engine — empty responses', () => {
  /**
   * Regression cover for a real finding: running the bundled HellaSwag suite
   * against a reasoning model produced three responses with status 200, an empty
   * `content`, and an output-token count exactly equal to maxTokens. The first
   * implementation graded those as `fail`, which reported 68.8% for a model that
   * had actually answered 11 of the 13 questions it was able to answer.
   */
  it('records an empty response as error, never as a wrong answer', async () => {
    mocks.execute.mockResolvedValue(llmResponse(''));

    await executeQualityRun(makeRun());

    const summary = finalResults()[TARGET];
    expect(summary.errorCount).toBe(3);
    expect(summary.failCount).toBe(0);
    expect(summary.passRate).toBeNull();

    for (const sample of summary.samples) {
      expect(sample.status).toBe('error');
      expect(sample.score).toBeNull();
      expect(sample.detailKey).toBe('quality.grade.emptyResponse');
      expect(sample.errorCategory).toBe('empty_response');
    }
  });

  it('names output-budget exhaustion when the response filled maxTokens', async () => {
    // makeRun sets maxTokens to 64.
    mocks.execute.mockResolvedValue(llmResponse('', 64, 64));

    await executeQualityRun(makeRun());

    const sample = finalResults()[TARGET].samples[0];
    expect(sample.detailKey).toBe('quality.grade.truncatedResponse');
    expect(sample.params).toMatchObject({ outputTokens: 64, maxTokens: 64, reasoningTokens: 64 });
    expect(sample.detail).toContain('without emitting an answer');
    expect(sample.detail).toContain('64 reasoning tokens');
    expect(sample.error).toContain('output budget of 64 tokens exhausted');
  });

  it('gives empty responses their own error bucket', async () => {
    mocks.execute
      .mockResolvedValueOnce(llmResponse('ok'))
      .mockResolvedValueOnce(llmResponse(''))
      .mockResolvedValueOnce(llmResponse('wrong'));

    await executeQualityRun(makeRun());

    const summary = finalResults()[TARGET];
    expect((summary.errorBreakdown as Record<string, number>).empty_response).toBe(1);
    expect(summary.passCount).toBe(1);
    expect(summary.failCount).toBe(1);
    // 1 of 2 judgeable, with the empty response kept out of the denominator.
    expect(summary.passRate).toBe(0.5);
  });

  it('treats whitespace-only content as empty rather than as an answer', async () => {
    mocks.execute.mockResolvedValue(llmResponse('  \n\t '));

    await executeQualityRun(makeRun());

    expect(finalResults()[TARGET].samples.every((s) => s.status === 'error')).toBe(true);
  });

  it('carries reasoning tokens through so the report can explain the truncation', async () => {
    mocks.execute.mockResolvedValue(llmResponse('ok', 900, 899));

    await executeQualityRun(makeRun());

    const sample = finalResults()[TARGET].samples[0];
    expect(sample.status).toBe('pass');
    expect(sample.reasoningTokens).toBe(899);
    expect(sample.outputTokens).toBe(900);
  });
});

describe('quality engine — scoring', () => {
  it('reports a genuine 0% when the model answered everything wrong', async () => {
    mocks.execute.mockResolvedValue(llmResponse('definitely not ok'));

    await executeQualityRun(makeRun());

    const summary = finalResults()[TARGET];
    expect(summary.failCount).toBe(3);
    expect(summary.errorCount).toBe(0);
    // A real wrong answer is 0, not null. Only "no verdict" is null.
    expect(summary.passRate).toBe(0);
    expect(summary.avgScore).toBe(0);
  });

  it('reports 100% when every answer is right', async () => {
    mocks.execute.mockResolvedValue(llmResponse('OK')); // exact grader is case-insensitive

    await executeQualityRun(makeRun());

    const summary = finalResults()[TARGET];
    expect(summary.passRate).toBe(1);
    expect(summary.passCount).toBe(3);
  });

  it('keeps errored samples out of the pass-rate denominator', async () => {
    mocks.execute
      .mockResolvedValueOnce(llmResponse('ok'))
      .mockResolvedValueOnce(llmResponse('wrong'))
      .mockRejectedValueOnce(new Error('rate limit exceeded — too many requests'));

    await executeQualityRun(makeRun());

    const summary = finalResults()[TARGET];
    expect(summary.passCount).toBe(1);
    expect(summary.failCount).toBe(1);
    expect(summary.errorCount).toBe(1);
    // 1 pass out of 2 judgeable samples, not out of 3.
    expect(summary.passRate).toBe(0.5);
    expect(summary.sampleCount).toBe(3);
  });

  it('keeps dataset order in the report even though the pool finishes out of order', async () => {
    mocks.execute.mockImplementation(async (prompt: string) => {
      // Make the first sample the slowest so completion order inverts.
      await new Promise((resolve) => setTimeout(resolve, prompt.includes('1') ? 15 : 1));
      return llmResponse('ok');
    });

    await executeQualityRun(makeRun({ params: { temperature: 0, maxTokens: 64, concurrency: 3, repeats: 1 } }));

    const indices = finalResults()[TARGET].samples.map((s) => s.index);
    expect(indices).toEqual([0, 1, 2]);
  });

  it('breaks the report down by category', async () => {
    const run = makeRun({
      datasetSnapshot: [makeSample(1, 'math'), makeSample(2, 'math'), makeSample(3, 'zh')],
    });
    mocks.execute.mockResolvedValue(llmResponse('ok'));

    await executeQualityRun(run);

    const byCategory = finalResults()[TARGET].byCategory as Array<{ category: string; passRate: number }>;
    expect(byCategory.map((c) => c.category)).toEqual(['math', 'zh']);
    expect(byCategory[0].passRate).toBe(1);
  });
});

describe('quality engine — measurement conditions', () => {
  it('pins temperature and forces non-streaming so runs stay comparable', async () => {
    mocks.execute.mockResolvedValue(llmResponse('ok'));

    await executeQualityRun(makeRun());

    const [prompt, systemPrompt, maxTokens, apiKey, streaming, images, generation] = mocks.execute.mock.calls[0];
    expect(prompt).toBe('question 1');
    expect(systemPrompt).toBeUndefined();
    expect(maxTokens).toBe(64);
    expect(apiKey).toBe('');
    expect(streaming).toBe(false);
    expect(images).toBeUndefined();
    expect(generation).toEqual({ temperature: 0 });
  });

  it('passes topP and seed through when the caller sets them', async () => {
    mocks.execute.mockResolvedValue(llmResponse('ok'));

    await executeQualityRun(makeRun({ params: { temperature: 0.7, topP: 0.9, seed: 42, maxTokens: 64, concurrency: 1, repeats: 1 } }));

    expect(mocks.execute.mock.calls[0][6]).toEqual({ temperature: 0.7, topP: 0.9, seed: 42 });
  });

  it('never exceeds the requested concurrency', async () => {
    let inFlight = 0;
    let peak = 0;
    mocks.execute.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return llmResponse('ok');
    });

    const run = makeRun({
      datasetSnapshot: Array.from({ length: 9 }, (_, i) => makeSample(i + 1)),
      params: { temperature: 0, maxTokens: 64, concurrency: 2, repeats: 1 },
    });
    await executeQualityRun(run);

    expect(peak).toBeLessThanOrEqual(2);
    expect(mocks.execute).toHaveBeenCalledTimes(9);
  });
});

describe('quality engine — progress events', () => {
  it('emits init, one progress event per sample, and a terminal event', async () => {
    mocks.execute.mockResolvedValue(llmResponse('ok'));
    const events: Array<{ type: string; data: unknown }> = [];
    const unsubscribe = subscribeQualityRun('qr_test', (event) => events.push(event));

    await executeQualityRun(makeRun());
    unsubscribe();

    const types = events.map((e) => e.type);
    expect(types[0]).toBe('quality:init');
    expect(types.filter((t) => t === 'quality:progress')).toHaveLength(3);
    expect(types.filter((t) => t === 'quality:target')).toHaveLength(1);
    expect(types[types.length - 1]).toBe('quality:complete');

    const progress = events.filter((e) => e.type === 'quality:progress').map((e) => (e.data as { completed: number }).completed);
    expect(progress).toEqual([1, 2, 3]);
  });
});

describe('summarize', () => {
  const sampleResult = (overrides: Partial<QualitySampleResult>): QualitySampleResult => ({
    sampleId: 's',
    index: 0,
    category: 'cat',
    grader: 'exact',
    status: 'pass',
    score: 1,
    detailKey: 'quality.grade.exact.match',
    detail: '',
    input: 'q',
    output: 'a',
    inputTokens: 1,
    outputTokens: 1,
    reasoningTokens: 0,
    responseTime: 100,
    estimatedCost: 0,
    ...overrides,
  });

  it('reports null rather than zero rates when there is nothing to judge', () => {
    expect(summarize('t', 'label', 'm', []).passRate).toBeNull();
    expect(summarize('t', 'label', 'm', []).avgScore).toBeNull();
  });

  it('excludes errored samples from the latency average', () => {
    const summary = summarize('t', 'label', 'm', [
      sampleResult({ responseTime: 100 }),
      sampleResult({ responseTime: 200 }),
      // Errored samples carry responseTime 0 — averaging them in would make the
      // model look faster than it is.
      sampleResult({ status: 'error', score: null, responseTime: 0 }),
    ]);
    expect(summary.avgResponseTime).toBe(150);
  });

  it('surfaces the share of samples whose token counts were inferred', () => {
    const summary = summarize('t', 'label', 'm', [
      sampleResult({ usageEstimated: true }),
      sampleResult({ usageEstimated: false }),
      sampleResult({ usageEstimated: false }),
      sampleResult({ usageEstimated: false }),
    ]);
    expect(summary.usageEstimatedRatio).toBe(0.25);
  });

  it('counts errors in the rate denominator only when a verdict exists', () => {
    const summary = summarize('t', 'label', 'm', [
      sampleResult({ status: 'pass' }),
      sampleResult({ status: 'error', score: null }),
    ]);
    expect(summary.passRate).toBe(1);
    expect(summary.errorCount).toBe(1);
  });
});
