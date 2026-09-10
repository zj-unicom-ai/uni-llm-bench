import { describe, it, expect } from 'vitest';
import {
  executeWithRetry,
  calculatePercentile,
  calculateSummary,
} from './benchmarkEngine';
import type { LLMProvider, IterationResult } from '../types';

// ─────────────────────────────────────────────────────────────────────────
// P0 guard: a failing provider must NEVER be silently "simulated".
// This suite locks in the behaviour that was the project's core defect —
// providers catching errors and returning fabricated latency/cost numbers.
// ─────────────────────────────────────────────────────────────────────────
describe('executeWithRetry — no silent fallback (P0)', () => {
  it('rejects when the provider always throws (would have returned fake data before)', async () => {
    const failingProvider: LLMProvider = {
      name: 'mock',
      execute: async () => {
        throw Object.assign(new Error('401 Unauthorized'), { status: 401 });
      },
    };
    await expect(
      executeWithRetry(failingProvider, 'p', undefined, 100, 'key', false, undefined, 2),
    ).rejects.toThrow(/401/);
  });

  it('does not retry on 4xx and surfaces the error exactly once', async () => {
    let calls = 0;
    const provider: LLMProvider = {
      name: 'mock',
      execute: async () => {
        calls++;
        throw Object.assign(new Error('400 bad request'), { status: 400 });
      },
    };
    await expect(
      executeWithRetry(provider, 'p', undefined, 100, 'k', false, undefined, 2),
    ).rejects.toThrow(/400/);
    expect(calls).toBe(1); // 4xx is not retryable — do not burn retries on it
  });

  it('retries once on 429, then succeeds, reporting retries = 1', async () => {
    let calls = 0;
    const provider: LLMProvider = {
      name: 'mock',
      execute: async () => {
        calls++;
        if (calls === 1) throw Object.assign(new Error('rate limited'), { status: 429 });
        return {
          text: 'ok',
          inputTokens: 1,
          outputTokens: 1,
          reasoningTokens: 0,
          totalTokens: 2,
          responseTime: 100,
          firstTokenLatency: 50,
          estimatedCost: 0,
          model: 'mock',
        };
      },
    };
    const outcome = await executeWithRetry(provider, 'p', undefined, 100, 'k', false, undefined, 2);
    expect(outcome.retries).toBe(1);
    // e2eTime must include the backoff sleep, not just the final attempt
    expect(outcome.e2eTime).toBeGreaterThanOrEqual(100);
  });
});

describe('calculatePercentile — linear interpolation', () => {
  it('interpolates between ranks (numpy/Prometheus-style)', () => {
    const v = [1, 2, 3, 4];
    expect(calculatePercentile(v, 50)).toBeCloseTo(2.5, 5);
    expect(calculatePercentile(v, 25)).toBeCloseTo(1.75, 5);
  });
  it('handles a single value', () => {
    expect(calculatePercentile([42], 99)).toBe(42);
  });
  it('returns 0 for an empty array', () => {
    expect(calculatePercentile([], 95)).toBe(0);
  });
});

describe('calculateSummary — reflects failures without fabrication', () => {
  function iter(o: Partial<IterationResult>): IterationResult {
    return {
      iteration: 0,
      responseTime: 200,
      firstTokenLatency: null,
      tokensPerSecond: 50,
      inputTokens: 10,
      outputTokens: 20,
      reasoningTokens: 0,
      totalTokens: 30,
      estimatedCost: 0,
      success: true,
      ...o,
    } as IterationResult;
  }

  it('lowers successRate and counts errors when iterations fail', () => {
    const results = [
      iter({ success: true }),
      iter({ success: true }),
      iter({ success: false, responseTime: 150, error: 'boom', errorCategory: 'unknown' }),
    ];
    const summary = calculateSummary(results);
    expect(summary.successRate).toBeCloseTo(2 / 3, 5);
    expect(summary.errorCount).toBe(1);
  });

  it('keeps TTFT null (never fabricates) when no iteration was streaming', () => {
    const results = [iter({ success: true }), iter({ success: true })];
    const summary = calculateSummary(results);
    expect(summary.avgFirstTokenLatency).toBeNull();
    expect(summary.p50FirstTokenLatency).toBeNull();
    expect(summary.p99FirstTokenLatency).toBeNull();
  });
});
