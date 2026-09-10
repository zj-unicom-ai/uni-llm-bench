import { describe, it, expect, vi } from 'vitest';
import {
  TokenBucket,
  calculatePercentile,
  classifyError,
  generateRandomPrefix,
  executeWithRetry,
  calculateSummary,
  buildErrorBreakdown,
  cancelRun,
  isCancelled,
  subscribe,
} from './benchmarkEngine';
import type { LLMProvider, IterationResult } from '../types';

/**
 * Comprehensive benchmarkEngine internals tests.
 * Covers: TokenBucket QPS limiter, percentile math, error classification,
 * retry policy (rate_limit + network only), summary aggregation, prefix generation,
 * cancellation + pub/sub.
 */

describe('TokenBucket — QPS limiter', () => {
  it('tryAcquire returns 0 on first call (pre-charged token)', () => {
    const bucket = new TokenBucket(10);
    expect(bucket.tryAcquire()).toBe(0);
  });

  it('tryAcquire returns wait time (positive) when bucket is empty', () => {
    const bucket = new TokenBucket(10); // 100ms interval
    bucket.tryAcquire(); // drain
    const wait = bucket.tryAcquire();
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(100);
  });

  it('refills tokens over time', async () => {
    const bucket = new TokenBucket(20); // 50ms interval
    bucket.tryAcquire(); // drain
    await new Promise((r) => setTimeout(r, 70)); // wait > interval
    expect(bucket.tryAcquire()).toBe(0); // refilled
  });

  it('caps tokens at 1 (no burst > 1)', async () => {
    const bucket = new TokenBucket(100); // 10ms interval
    bucket.tryAcquire();
    await new Promise((r) => setTimeout(r, 200)); // many intervals elapsed
    expect(bucket.tryAcquire()).toBe(0); // first refill succeeds
    expect(bucket.tryAcquire()).toBeGreaterThan(0); // immediately drained again, no burst
  });

  it('handles maxQps=1 (1 req/s)', () => {
    const bucket = new TokenBucket(1); // 1000ms interval
    expect(bucket.tryAcquire()).toBe(0);
    const wait = bucket.tryAcquire();
    expect(wait).toBeGreaterThan(900); // close to 1000ms
  });
});

describe('calculatePercentile — boundaries', () => {
  it('p50 of [1,2,3,4,5] = 3', () => {
    expect(calculatePercentile([1, 2, 3, 4, 5], 50)).toBe(3);
  });

  it('p100 returns the maximum value', () => {
    expect(calculatePercentile([1, 2, 3], 100)).toBe(3);
  });

  it('p0 returns the minimum value (clamped to index 0)', () => {
    expect(calculatePercentile([1, 2, 3], 0)).toBe(1);
  });

  it('single value: p50 = that value', () => {
    expect(calculatePercentile([42], 50)).toBe(42);
  });

  it('two values: p50 interpolates to the midpoint', () => {
    // Linear interpolation (the numpy / Prometheus default). The previous
    // nearest-rank method returned the lower value, which understated every
    // percentile on the small sample sizes typical of a benchmark run.
    expect(calculatePercentile([10, 20], 50)).toBe(15);
  });

  it('p95 of 20 items interpolates between the 19th and 20th sorted', () => {
    const values = Array.from({ length: 20 }, (_, i) => i + 1);
    // rank = 0.95 * (20 - 1) = 18.05 → 19 + 0.05 * (20 - 19)
    expect(calculatePercentile(values, 95)).toBeCloseTo(19.05, 5);
  });

  it('handles unsorted input (sorts internally)', () => {
    expect(calculatePercentile([5, 1, 3, 4, 2], 50)).toBe(3);
  });

  it('does not mutate input array', () => {
    const input = [3, 1, 2];
    calculatePercentile(input, 50);
    expect(input).toEqual([3, 1, 2]);
  });
});

describe('classifyError', () => {
  it('classifies timeout variants', () => {
    expect(classifyError(new Error('Request timeout'))).toBe('timeout');
    expect(classifyError(new Error('Aborted after 30s'))).toBe('timeout');
    expect(classifyError(new Error('Connection timed out'))).toBe('timeout');
  });

  it('classifies rate limit variants', () => {
    expect(classifyError(new Error('Rate limit exceeded'))).toBe('rate_limit');
    expect(classifyError(new Error('HTTP 429'))).toBe('rate_limit');
    expect(classifyError(new Error('Too many requests'))).toBe('rate_limit');
  });

  it('classifies network errors', () => {
    expect(classifyError(new Error('fetch failed'))).toBe('network');
    expect(classifyError(new Error('Network unreachable'))).toBe('network');
    expect(classifyError(new Error('ECONNREFUSED'))).toBe('network');
    expect(classifyError(new Error('DNS resolution failed'))).toBe('network');
  });

  it('classifies api errors (401/403/500 status references)', () => {
    expect(classifyError(new Error('API error 401'))).toBe('api_error');
    expect(classifyError(new Error('HTTP 500'))).toBe('api_error');
    expect(classifyError(new Error('Forbidden 403'))).toBe('api_error');
  });

  it('returns "unknown" for unrecognized messages', () => {
    expect(classifyError(new Error('something weird'))).toBe('unknown');
  });

  it('handles non-Error inputs (string, null, undefined)', () => {
    expect(classifyError('timeout')).toBe('timeout');
    expect(classifyError(null)).toBe('unknown');
    expect(classifyError(undefined)).toBe('unknown');
  });

  it('case-insensitive matching', () => {
    expect(classifyError(new Error('TIMEOUT'))).toBe('timeout');
    expect(classifyError(new Error('RATE LIMIT'))).toBe('rate_limit');
  });
});

describe('generateRandomPrefix', () => {
  it('generates at least 128 chars for very short prompts', () => {
    const prefix = generateRandomPrefix(10);
    expect(prefix.length).toBeGreaterThanOrEqual(128);
  });

  it('caps at ~4096 chars + spaces for very long prompts', () => {
    const prefix = generateRandomPrefix(1_000_000);
    // 4096 + ~spaces (max ~1024 spaces); upper bound ~5120
    expect(prefix.length).toBeLessThanOrEqual(5500);
    expect(prefix.length).toBeGreaterThanOrEqual(4096);
  });

  it('scales with prompt length (~5%) inside the band', () => {
    const small = generateRandomPrefix(2000); // 5% = 100 → clamped up to 128
    const mid = generateRandomPrefix(20_000); // 5% = 1000 → in-band
    expect(mid.length).toBeGreaterThan(small.length);
  });

  it('contains only base62 chars and spaces', () => {
    const prefix = generateRandomPrefix(5000);
    expect(prefix).toMatch(/^[a-zA-Z0-9 ]+$/);
  });

  it('produces different output each call (random)', () => {
    expect(generateRandomPrefix(1000)).not.toBe(generateRandomPrefix(1000));
  });
});

describe('executeWithRetry — retry policy', () => {
  function makeProvider(responses: Array<unknown | Error>): LLMProvider {
    let i = 0;
    return {
      name: 'mock',
      execute: vi.fn(async () => {
        const r = responses[i++];
        if (r instanceof Error) throw r;
        return r as never;
      }),
    } as LLMProvider;
  }

  it('returns success immediately with retries=0 when first attempt succeeds', async () => {
    const provider = makeProvider([{ text: 'ok' }]);
    const r = await executeWithRetry(provider, 'p', undefined, 100, 'k', false, undefined, 2);
    expect(r.retries).toBe(0);
    expect((r.response as { text: string }).text).toBe('ok');
  });

  it('retries on rate_limit errors with exponential backoff', async () => {
    const provider = makeProvider([new Error('429 rate limit'), new Error('429 rate limit'), { text: 'finally' }]);
    const r = await executeWithRetry(provider, 'p', undefined, 100, 'k', false, undefined, 2);
    expect(r.retries).toBe(2);
    expect((r.response as { text: string }).text).toBe('finally');
  }, 20_000);

  it('retries on network errors', async () => {
    const provider = makeProvider([new Error('fetch failed'), { text: 'recovered' }]);
    const r = await executeWithRetry(provider, 'p', undefined, 100, 'k', false, undefined, 2);
    expect(r.retries).toBe(1);
  }, 20_000);

  it('does NOT retry on timeout errors (only rate_limit + network)', async () => {
    const provider = makeProvider([new Error('Request timeout')]);
    await expect(executeWithRetry(provider, 'p', undefined, 100, 'k', false, undefined, 2)).rejects.toThrow(/timeout/);
    expect(provider.execute).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on api_error', async () => {
    const provider = makeProvider([new Error('API error 401')]);
    await expect(executeWithRetry(provider, 'p', undefined, 100, 'k', false, undefined, 2)).rejects.toThrow(/401/);
    expect(provider.execute).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxRetries on persistent rate_limit', async () => {
    const provider = makeProvider([
      new Error('rate limit'),
      new Error('rate limit'),
      new Error('rate limit'),
      new Error('rate limit'),
    ]);
    await expect(executeWithRetry(provider, 'p', undefined, 100, 'k', false, undefined, 2)).rejects.toThrow();
    expect(provider.execute).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  }, 20_000);

  it('does NOT retry on unknown errors', async () => {
    const provider = makeProvider([new Error('totally bizarre failure')]);
    await expect(executeWithRetry(provider, 'p', undefined, 100, 'k', false, undefined, 2)).rejects.toThrow();
    expect(provider.execute).toHaveBeenCalledTimes(1);
  });
});

describe('calculateSummary', () => {
  function iter(overrides: Partial<IterationResult> = {}): IterationResult {
    return {
      iteration: 0,
      success: true,
      responseTime: 100,
      firstTokenLatency: 50,
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      tokensPerSecond: 200,
      estimatedCost: 0.001,
      ...overrides,
    } as IterationResult;
  }

  it('returns zero-summary when no iterations succeeded', () => {
    const result = calculateSummary([iter({ success: false, error: 'fail' })]);
    expect(result.avgResponseTime).toBe(0);
    expect(result.successRate).toBe(0);
    expect(result.errorCount).toBe(1);
  });

  it('returns zero-summary on empty input', () => {
    const result = calculateSummary([]);
    expect(result.avgResponseTime).toBe(0);
    expect(result.successRate).toBe(0);
  });

  it('aggregates successful iterations correctly', () => {
    const result = calculateSummary([
      iter({ responseTime: 100 }),
      iter({ responseTime: 200 }),
      iter({ responseTime: 300 }),
    ]);
    expect(result.avgResponseTime).toBe(200);
    expect(result.p50ResponseTime).toBe(200);
    // p95 interpolates between 200 and 300 at rank 1.9 → 290
    expect(result.p95ResponseTime).toBe(290);
    expect(result.successRate).toBe(1.0);
    expect(result.sampleSize).toBe(3);
    expect(result.ttftSampleCount).toBe(3);
  });

  it('computes successRate based on success/total', () => {
    const result = calculateSummary([
      iter({ success: true }),
      iter({ success: true }),
      iter({ success: false, error: 'x' }),
      iter({ success: false, error: 'x' }),
    ]);
    expect(result.successRate).toBe(0.5);
  });

  it('uses totalTestDurationMs for system throughput when provided', () => {
    const iters = [iter({ outputTokens: 100, responseTime: 1000 }), iter({ outputTokens: 200, responseTime: 1000 })];
    // total output = 300 tokens. duration = 1000ms → 300 tokens/s
    const result = calculateSummary(iters, 1000);
    expect(result.systemThroughput).toBe(300);
  });

  it('falls back to batchMaxTime when totalTestDurationMs missing', () => {
    const iters = [iter({ outputTokens: 100, responseTime: 1000 }), iter({ outputTokens: 200, responseTime: 2000 })];
    // Max time = 2000ms. total output = 300 → 150 tokens/s
    const result = calculateSummary(iters);
    expect(result.systemThroughput).toBe(150);
  });
});

describe('buildErrorBreakdown', () => {
  it('counts errors by errorCategory field', () => {
    const breakdown = buildErrorBreakdown([
      { iteration: 0, success: false, errorCategory: 'rate_limit', responseTime: 0 } as never,
      { iteration: 1, success: false, errorCategory: 'network', responseTime: 0 } as never,
      { iteration: 2, success: false, errorCategory: 'rate_limit', responseTime: 0 } as never,
      { iteration: 3, success: true, responseTime: 100 } as never,
    ]);
    expect(breakdown.rate_limit).toBe(2);
    expect(breakdown.network).toBe(1);
    expect(breakdown.timeout).toBe(0);
  });

  it('returns all-zero for all-success input', () => {
    const breakdown = buildErrorBreakdown([{ iteration: 0, success: true, responseTime: 100 } as never]);
    expect(breakdown.timeout).toBe(0);
    expect(breakdown.rate_limit).toBe(0);
    expect(breakdown.network).toBe(0);
    expect(breakdown.api_error).toBe(0);
    expect(breakdown.unknown).toBe(0);
  });

  it('skips failed iterations missing errorCategory (defensive)', () => {
    // errorCategory must be present on the iteration; otherwise it's excluded
    const breakdown = buildErrorBreakdown([{ iteration: 0, success: false, responseTime: 0 } as never]);
    expect(breakdown.unknown).toBe(0);
    expect(Object.values(breakdown).every((v) => v === 0)).toBe(true);
  });

  it('counts all five categories independently', () => {
    const breakdown = buildErrorBreakdown([
      { iteration: 0, success: false, errorCategory: 'timeout', responseTime: 0 },
      { iteration: 1, success: false, errorCategory: 'rate_limit', responseTime: 0 },
      { iteration: 2, success: false, errorCategory: 'api_error', responseTime: 0 },
      { iteration: 3, success: false, errorCategory: 'network', responseTime: 0 },
      { iteration: 4, success: false, errorCategory: 'unknown', responseTime: 0 },
    ] as never);
    expect(breakdown.timeout).toBe(1);
    expect(breakdown.rate_limit).toBe(1);
    expect(breakdown.api_error).toBe(1);
    expect(breakdown.network).toBe(1);
    expect(breakdown.unknown).toBe(1);
  });
});

describe('cancellation + subscription', () => {
  it('isCancelled returns false initially', () => {
    expect(isCancelled('not-cancelled')).toBe(false);
  });

  it('cancelRun marks the run cancelled', () => {
    cancelRun('test-cancel-1');
    expect(isCancelled('test-cancel-1')).toBe(true);
  });

  it('cancelRun is idempotent (returns false the second time)', () => {
    cancelRun('test-cancel-2');
    expect(cancelRun('test-cancel-2')).toBe(false);
  });

  it('subscribe returns unsubscribe fn that detaches the listener', () => {
    let receivedCount = 0;
    const unsub = subscribe('test-sub', () => {
      receivedCount++;
    });
    cancelRun('test-sub'); // emits an 'error' event to listeners
    expect(receivedCount).toBe(1);
    unsub();
    cancelRun('test-sub'); // already cancelled → noop
    expect(receivedCount).toBe(1);
  });

  it('subscribe to a different run does not receive events from another run', () => {
    let aCount = 0;
    let bCount = 0;
    subscribe('run-a', () => aCount++);
    subscribe('run-b', () => bCount++);
    cancelRun('run-a');
    expect(aCount).toBe(1);
    expect(bCount).toBe(0);
  });
});
