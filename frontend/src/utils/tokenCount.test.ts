import { describe, it, expect } from 'vitest';
import { countTokens } from './tokenCount';

describe('countTokens', () => {
  it('returns 0 for empty string', () => {
    expect(countTokens('')).toBe(0);
  });

  it('returns token count for simple text', () => {
    const count = countTokens('Hello world');
    expect(count).toBeGreaterThan(0);
    expect(count).toBe(2); // "Hello" + " world"
  });

  it('returns token count for longer text', () => {
    const count = countTokens('The quick brown fox jumps over the lazy dog');
    expect(count).toBeGreaterThan(5);
  });
});
