import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useProviders } from './useProviders';
import * as apiMod from '../services/api';

const apiFetchSpy = vi.spyOn(apiMod, 'apiFetch');

beforeEach(() => {
  vi.clearAllMocks();
  // Set VITE_DEMO_MODE=false so maskProviderConfig doesn't rewrite values
  import.meta.env.VITE_DEMO_MODE = 'false';
});

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const baseProvider = {
  id: 'p1',
  name: 'OpenAI',
  endpoint: 'https://api.openai.com',
  apiKeyMasked: 'sk-****',
  format: 'openai' as const,
  models: [],
  createdAt: '',
  updatedAt: '',
};

describe('useProviders.fetchProviders', () => {
  it('populates providers state on success', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp([baseProvider]));
    const { result } = renderHook(() => useProviders());
    await act(async () => {
      await result.current.fetchProviders();
    });
    expect(result.current.providers).toHaveLength(1);
    expect(result.current.providers[0].id).toBe('p1');
    expect(result.current.error).toBeNull();
  });

  it('returns empty array and sets error on non-2xx', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ error: 'forbidden' }, 403));
    const { result } = renderHook(() => useProviders());
    let returned!: ReturnType<typeof result.current.fetchProviders> extends Promise<infer T> ? T : never;
    await act(async () => {
      returned = await result.current.fetchProviders();
    });
    expect(returned).toEqual([]);
    expect(result.current.error).toBe('Failed to fetch providers');
  });

  it('catches thrown error', async () => {
    apiFetchSpy.mockRejectedValueOnce(new Error('network'));
    const { result } = renderHook(() => useProviders());
    await act(async () => {
      await result.current.fetchProviders();
    });
    expect(result.current.error).toContain('network');
  });
});

describe('useProviders.createProvider', () => {
  it('prepends new provider on success', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp(baseProvider, 201));
    const { result } = renderHook(() => useProviders());
    let created!: Awaited<ReturnType<typeof result.current.createProvider>>;
    await act(async () => {
      created = await result.current.createProvider({
        name: 'OpenAI',
        endpoint: 'https://x',
        apiKey: 'k',
        format: 'openai',
        models: [],
      });
    });
    expect(created?.id).toBe('p1');
    expect(result.current.providers).toHaveLength(1);
  });

  it('returns null and sets error on non-2xx', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ error: 'duplicate name' }, 409));
    const { result } = renderHook(() => useProviders());
    let created!: Awaited<ReturnType<typeof result.current.createProvider>>;
    await act(async () => {
      created = await result.current.createProvider({
        name: 'x',
        endpoint: 'https://x',
        apiKey: 'k',
        format: 'openai',
        models: [],
      });
    });
    expect(created).toBeNull();
    expect(result.current.error).toBe('duplicate name');
  });
});

describe('useProviders.updateProvider', () => {
  it('replaces matching provider in state', async () => {
    // Seed state
    apiFetchSpy.mockResolvedValueOnce(jsonResp([baseProvider]));
    const { result } = renderHook(() => useProviders());
    await act(async () => {
      await result.current.fetchProviders();
    });

    apiFetchSpy.mockResolvedValueOnce(jsonResp({ ...baseProvider, name: 'Renamed' }));
    await act(async () => {
      await result.current.updateProvider('p1', { name: 'Renamed' });
    });
    expect(result.current.providers[0].name).toBe('Renamed');
  });

  it('returns null on non-2xx', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ error: 'not found' }, 404));
    const { result } = renderHook(() => useProviders());
    let updated!: Awaited<ReturnType<typeof result.current.updateProvider>>;
    await act(async () => {
      updated = await result.current.updateProvider('absent', {});
    });
    expect(updated).toBeNull();
  });
});

describe('useProviders.deleteProvider', () => {
  it('removes the provider from state on success', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp([baseProvider]));
    const { result } = renderHook(() => useProviders());
    await act(async () => {
      await result.current.fetchProviders();
    });

    apiFetchSpy.mockResolvedValueOnce(jsonResp({ success: true }));
    let ok!: boolean;
    await act(async () => {
      ok = await result.current.deleteProvider('p1');
    });
    expect(ok).toBe(true);
    expect(result.current.providers).toHaveLength(0);
  });

  it('returns false on non-2xx', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ error: 'x' }, 404));
    const { result } = renderHook(() => useProviders());
    let ok!: boolean;
    await act(async () => {
      ok = await result.current.deleteProvider('p1');
    });
    expect(ok).toBe(false);
  });
});

describe('useProviders.testConnection', () => {
  it('returns the test result', async () => {
    apiFetchSpy.mockResolvedValueOnce(
      jsonResp({ success: true, latencyMs: 200, ttftMs: 50, outputTokens: 10, responseText: 'ok' }),
    );
    const { result } = renderHook(() => useProviders());
    let r!: Awaited<ReturnType<typeof result.current.testConnection>>;
    await act(async () => {
      r = await result.current.testConnection('p1', 'gpt-4');
    });
    expect(r?.success).toBe(true);
    expect(r?.latencyMs).toBe(200);
  });

  it('returns failure object on throw', async () => {
    apiFetchSpy.mockRejectedValueOnce(new Error('timeout'));
    const { result } = renderHook(() => useProviders());
    let r!: Awaited<ReturnType<typeof result.current.testConnection>>;
    await act(async () => {
      r = await result.current.testConnection('p1');
    });
    expect(r?.success).toBe(false);
    expect(r?.error).toContain('timeout');
  });
});

describe('useProviders.testRawConnection', () => {
  it('passes the config to /test-connection', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ success: true, latencyMs: 100 }));
    const { result } = renderHook(() => useProviders());
    await act(async () => {
      await result.current.testRawConnection({
        endpoint: 'https://x',
        apiKey: 'k',
        format: 'openai',
        modelName: 'gpt-4',
      });
    });
    const init = apiFetchSpy.mock.calls[0][1]!;
    const body = JSON.parse(init.body as string);
    expect(body.endpoint).toBe('https://x');
    expect(body.modelName).toBe('gpt-4');
  });
});
