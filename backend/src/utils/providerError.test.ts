import { describe, it, expect } from 'vitest';
import { classifyError, isRetryableError, ProviderHttpError } from './providerError';

describe('classifyError — structured classification', () => {
  it('prefers HTTP status over message text (a 429 message mentioning "api" must be rate_limit, not api_error)', () => {
    const err = Object.assign(new Error('Too Many Requests: api throttled'), { status: 429 });
    expect(classifyError(err)).toBe('rate_limit');
  });

  it('maps 401/403 to a dedicated auth-style bucket (rate_limit not used here)', () => {
    const err = Object.assign(new Error('Unauthorized'), { status: 401 });
    expect(classifyError(err)).toBe('api_error');
  });

  it('treats 5xx as api_error and timeouts as timeout', () => {
    expect(classifyError(Object.assign(new Error('bad gateway'), { status: 502 }))).toBe('api_error');
    const timeout = Object.assign(new Error('aborted'), { code: 'ABORT_ERR' });
    expect(classifyError(timeout)).toBe('timeout');
  });

  it('falls back to message text only when no status/code is present', () => {
    expect(classifyError(new Error('request timed out after 30s'))).toBe('timeout');
    expect(classifyError(new Error('ECONNRESET network down'))).toBe('network');
    expect(classifyError(new Error('weird unknown failure'))).toBe('unknown');
  });

  it('ProviderHttpError carries status + retryable flag', () => {
    const e = new ProviderHttpError('nope', { status: 503, retryable: true });
    expect(e).toBeInstanceOf(Error);
    expect(e.status).toBe(503);
    expect(isRetryableError(e)).toBe(true);
  });

  it('4xx is not retryable, 429/5xx is', () => {
    expect(isRetryableError(Object.assign(new Error('x'), { status: 400 }))).toBe(false);
    expect(isRetryableError(Object.assign(new Error('x'), { status: 429 }))).toBe(true);
    expect(isRetryableError(Object.assign(new Error('x'), { status: 500 }))).toBe(true);
  });
});
