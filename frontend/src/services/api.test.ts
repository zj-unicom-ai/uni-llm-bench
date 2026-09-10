import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getToken, setToken, clearToken, isAuthenticated, apiFetch, sseUrl, downloadUrl } from './api';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock sessionStorage
const store: Record<string, string> = {};
vi.stubGlobal('sessionStorage', {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, value: string) => {
    store[key] = value;
  },
  removeItem: (key: string) => {
    delete store[key];
  },
});

// Mock CustomEvent and window.dispatchEvent
vi.stubGlobal(
  'CustomEvent',
  class MockCustomEvent {
    type: string;
    constructor(type: string) {
      this.type = type;
    }
  },
);
const mockDispatchEvent = vi.fn();
vi.stubGlobal('window', {
  ...globalThis.window,
  dispatchEvent: mockDispatchEvent,
});

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(store)) delete store[key];
});

describe('Token management', () => {
  it('getToken returns null when no token is stored', () => {
    expect(getToken()).toBeNull();
  });

  it('setToken stores and getToken retrieves it', () => {
    setToken('test-jwt-token');
    expect(getToken()).toBe('test-jwt-token');
  });

  it('clearToken removes the stored token', () => {
    setToken('test-jwt-token');
    clearToken();
    expect(getToken()).toBeNull();
  });

  it('isAuthenticated returns false when no token', () => {
    expect(isAuthenticated()).toBe(false);
  });

  it('isAuthenticated returns true when token exists', () => {
    setToken('some-token');
    expect(isAuthenticated()).toBe(true);
  });
});

describe('apiFetch', () => {
  it('injects Authorization header when token exists', async () => {
    setToken('my-jwt');
    mockFetch.mockResolvedValueOnce({ status: 200, ok: true });

    await apiFetch('/api/test');

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/test');
    const headers = options.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer my-jwt');
  });

  it('does not inject Authorization header when no token', async () => {
    mockFetch.mockResolvedValueOnce({ status: 200, ok: true });

    await apiFetch('/api/test');

    const [, options] = mockFetch.mock.calls[0];
    const headers = options.headers as Headers;
    expect(headers.get('Authorization')).toBeNull();
  });

  it('clears token and dispatches auth-expired on 401', async () => {
    setToken('expired-jwt');
    mockFetch.mockResolvedValueOnce({ status: 401, ok: false });

    await apiFetch('/api/protected');

    expect(getToken()).toBeNull();
    expect(mockDispatchEvent).toHaveBeenCalledTimes(1);
  });

  it('does not clear token on non-401 errors', async () => {
    setToken('valid-jwt');
    mockFetch.mockResolvedValueOnce({ status: 500, ok: false });

    await apiFetch('/api/failing');

    expect(getToken()).toBe('valid-jwt');
    expect(mockDispatchEvent).not.toHaveBeenCalled();
  });

  it('passes through request init options', async () => {
    mockFetch.mockResolvedValueOnce({ status: 200, ok: true });

    await apiFetch('/api/data', {
      method: 'POST',
      body: JSON.stringify({ key: 'value' }),
    });

    const [, options] = mockFetch.mock.calls[0];
    expect(options.method).toBe('POST');
    expect(options.body).toBe('{"key":"value"}');
  });
});

describe('sseUrl', () => {
  it('appends token as query parameter', async () => {
    setToken('jwt-for-sse');
    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: () => Promise.resolve({ token: 'ott-abc' }),
    });

    const url = await sseUrl('/api/workflows/123/stream');
    expect(url).toBe('/api/workflows/123/stream?token=ott-abc');
  });

  it('uses & separator when URL already has query params', async () => {
    setToken('jwt-for-sse');
    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: () => Promise.resolve({ token: 'ott-xyz' }),
    });

    const url = await sseUrl('/api/stream?format=json');
    expect(url).toBe('/api/stream?format=json&token=ott-xyz');
  });

  it('returns bare URL when OTT fetch fails', async () => {
    setToken('jwt');
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const url = await sseUrl('/api/stream');
    expect(url).toBe('/api/stream');
  });

  it('returns bare URL when OTT response is not ok', async () => {
    setToken('jwt');
    mockFetch.mockResolvedValueOnce({ status: 401, ok: false });

    const url = await sseUrl('/api/stream');
    expect(url).toBe('/api/stream');
  });
});

describe('downloadUrl', () => {
  it('appends token as query parameter', async () => {
    setToken('jwt');
    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: () => Promise.resolve({ token: 'ott-dl' }),
    });

    const url = await downloadUrl('/api/export/csv');
    expect(url).toBe('/api/export/csv?token=ott-dl');
  });
});
