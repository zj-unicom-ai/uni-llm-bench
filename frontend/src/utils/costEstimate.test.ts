import { describe, it, expect } from 'vitest';
import { estimateInputTokens, estimateModelCost, hasPricing, formatCost } from './costEstimate';

const M = 1_000_000;

describe('hasPricing', () => {
  it('is false when no price is configured', () => {
    expect(hasPricing({})).toBe(false);
    expect(hasPricing(undefined)).toBe(false);
    expect(hasPricing(null)).toBe(false);
  });

  it('is true when input or output price is configured', () => {
    expect(hasPricing({ inputPrice: 1 })).toBe(true);
    expect(hasPricing({ outputPrice: 2 })).toBe(true);
  });
});

describe('estimateModelCost', () => {
  it('bills input and output at their configured rates', () => {
    const cost = estimateModelCost({ inputPrice: 1, outputPrice: 2 }, [
      { inputTokens: M, outputTokens: M, requests: 1 },
    ]);
    expect(cost).toBeCloseTo(3, 6); // $1 in + $2 out
  });

  it('scales with the number of requests', () => {
    const cost = estimateModelCost({ inputPrice: 1, outputPrice: 2 }, [
      { inputTokens: M, outputTokens: M, requests: 10 },
    ]);
    expect(cost).toBeCloseTo(30, 6);
  });

  it('bills the cached input portion at the cache read price', () => {
    const cost = estimateModelCost({ inputPrice: 1, cacheReadPrice: 0.1 }, [
      { inputTokens: M, outputTokens: 0, requests: 1, cacheHitRate: 0.5 },
    ]);
    // 0.5M fresh @ $1 + 0.5M cached @ $0.1
    expect(cost).toBeCloseTo(0.5 + 0.05, 6);
  });

  it('falls back to the input price when no cache read price is set', () => {
    const cost = estimateModelCost({ inputPrice: 1 }, [
      { inputTokens: M, outputTokens: 0, requests: 1, cacheHitRate: 0.5 },
    ]);
    expect(cost).toBeCloseTo(1, 6);
  });

  it('clamps an out-of-range cache hit rate', () => {
    const cost = estimateModelCost({ inputPrice: 1, cacheReadPrice: 0 }, [
      { inputTokens: M, outputTokens: 0, requests: 1, cacheHitRate: 5 },
    ]);
    expect(cost).toBeCloseTo(0, 6);
  });

  it('treats missing prices as free rather than NaN', () => {
    const cost = estimateModelCost({}, [{ inputTokens: M, outputTokens: M, requests: 10 }]);
    expect(cost).toBe(0);
  });

  it('sums across multiple tasks', () => {
    const cost = estimateModelCost({ inputPrice: 1, outputPrice: 1 }, [
      { inputTokens: M, outputTokens: 0, requests: 1 },
      { inputTokens: 0, outputTokens: M, requests: 2 },
    ]);
    expect(cost).toBeCloseTo(3, 6);
  });
});

describe('estimateInputTokens', () => {
  it('counts prompt and system prompt together', () => {
    const promptOnly = estimateInputTokens('Hello world');
    const withSystem = estimateInputTokens('Hello world', 'You are helpful');
    expect(promptOnly).toBeGreaterThan(0);
    expect(withSystem).toBeGreaterThan(promptOnly);
  });

  it('handles empty input', () => {
    expect(estimateInputTokens()).toBe(0);
    expect(estimateInputTokens('', '')).toBe(0);
  });
});

describe('formatCost', () => {
  it('formats large and small totals with appropriate precision', () => {
    expect(formatCost(3)).toBe('$3.00');
    expect(formatCost(0.5)).toBe('$0.5000');
    expect(formatCost(0.000001)).toBe('$0.000001');
  });

  it('formats zero and invalid values as $0', () => {
    expect(formatCost(0)).toBe('$0');
    expect(formatCost(Number.NaN)).toBe('$0');
  });
});
