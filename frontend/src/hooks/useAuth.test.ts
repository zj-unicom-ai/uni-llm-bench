import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useAuth } from './useAuth';
import * as apiMod from '../services/api';

const apiFetchSpy = vi.spyOn(apiMod, 'apiFetch');
const setTokenSpy = vi.spyOn(apiMod, 'setToken');

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
});

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('useAuth.login', () => {
  it('sets token and returns success on 200', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ token: 'abc', passwordChangeRequired: false }));
    const { result } = renderHook(() => useAuth());

    let res!: Awaited<ReturnType<typeof result.current.login>>;
    await act(async () => {
      res = await result.current.login('admin', 'pw');
    });

    expect(res.success).toBe(true);
    expect(setTokenSpy).toHaveBeenCalledWith('abc');
    expect(result.current.error).toBeNull();
  });

  it('propagates passwordChangeRequired from response', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ token: 't', passwordChangeRequired: true }));
    const { result } = renderHook(() => useAuth());
    let res!: Awaited<ReturnType<typeof result.current.login>>;
    await act(async () => {
      res = await result.current.login('admin', 'pw');
    });
    expect(res.passwordChangeRequired).toBe(true);
  });

  it('returns success=false and sets error on non-2xx', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ error: 'bad creds' }, 401));
    const { result } = renderHook(() => useAuth());
    let res!: Awaited<ReturnType<typeof result.current.login>>;
    await act(async () => {
      res = await result.current.login('a', 'b');
    });
    expect(res.success).toBe(false);
    expect(result.current.error).toBe('bad creds');
  });

  it('catches thrown errors as login failure', async () => {
    apiFetchSpy.mockRejectedValueOnce(new Error('network down'));
    const { result } = renderHook(() => useAuth());
    let res!: Awaited<ReturnType<typeof result.current.login>>;
    await act(async () => {
      res = await result.current.login('a', 'b');
    });
    expect(res.success).toBe(false);
    expect(result.current.error).toContain('network down');
  });

  it('loading flips true→false across the call', async () => {
    let resolveFetch!: (r: Response) => void;
    const fetchPromise = new Promise<Response>((r) => {
      resolveFetch = r;
    });
    apiFetchSpy.mockReturnValueOnce(fetchPromise);

    const { result } = renderHook(() => useAuth());
    let loginPromise!: Promise<unknown>;
    act(() => {
      loginPromise = result.current.login('a', 'b');
    });

    await waitFor(() => expect(result.current.loading).toBe(true));
    resolveFetch(jsonResp({ token: 't' }));
    await act(async () => {
      await loginPromise;
    });
    expect(result.current.loading).toBe(false);
  });
});

describe('useAuth.changePassword', () => {
  it('returns true on success', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ ok: true }));
    const { result } = renderHook(() => useAuth());
    let ok!: boolean;
    await act(async () => {
      ok = await result.current.changePassword('old', 'new');
    });
    expect(ok).toBe(true);
  });

  it('sets error and returns false on non-2xx', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ error: 'too short' }, 400));
    const { result } = renderHook(() => useAuth());
    let ok!: boolean;
    await act(async () => {
      ok = await result.current.changePassword('old', 'x');
    });
    expect(ok).toBe(false);
    expect(result.current.error).toBe('too short');
  });

  it('returns false and sets generic error on throw', async () => {
    apiFetchSpy.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useAuth());
    let ok!: boolean;
    await act(async () => {
      ok = await result.current.changePassword('old', 'new');
    });
    expect(ok).toBe(false);
    expect(result.current.error).toBe('Failed to change password');
  });
});

describe('useAuth.clearError', () => {
  it('clears the error', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ error: 'x' }, 401));
    const { result } = renderHook(() => useAuth());
    await act(async () => {
      await result.current.login('a', 'b');
    });
    expect(result.current.error).toBe('x');
    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
  });
});
