import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePlaygroundHistory } from './usePlaygroundHistory';
import * as apiMod from '../services/api';

const apiFetchSpy = vi.spyOn(apiMod, 'apiFetch');

beforeEach(() => {
  vi.clearAllMocks();
  import.meta.env.VITE_DEMO_MODE = 'false';
});

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const baseItem = {
  id: 'h1',
  providerId: 'p1',
  providerName: 'OpenAI',
  modelName: 'gpt-4',
  promptSnippet: 'hi',
  createdAt: '2026-05-15T00:00:00Z',
  responseTime: 100,
};

describe('usePlaygroundHistory.fetchHistory', () => {
  it('populates items on success', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp([baseItem]));
    const { result } = renderHook(() => usePlaygroundHistory());
    await act(async () => {
      await result.current.fetchHistory();
    });
    expect(result.current.items).toHaveLength(1);
  });

  it('silently no-ops on error', async () => {
    apiFetchSpy.mockRejectedValueOnce(new Error('x'));
    const { result } = renderHook(() => usePlaygroundHistory());
    await expect(
      act(async () => {
        await result.current.fetchHistory();
      }),
    ).resolves.toBeUndefined();
    expect(result.current.items).toEqual([]);
  });

  it('toggles loading false after the call', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp([]));
    const { result } = renderHook(() => usePlaygroundHistory());
    await act(async () => {
      await result.current.fetchHistory();
    });
    expect(result.current.loading).toBe(false);
  });

  it('does not crash when response is non-ok', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({}, 500));
    const { result } = renderHook(() => usePlaygroundHistory());
    await act(async () => {
      await result.current.fetchHistory();
    });
    expect(result.current.items).toEqual([]);
  });
});

describe('usePlaygroundHistory.getDetail', () => {
  it('returns the detail on success', async () => {
    apiFetchSpy.mockResolvedValueOnce(
      jsonResp({ ...baseItem, prompt: 'full prompt', maxTokens: 100, useStreaming: true, enableThinking: false }),
    );
    const { result } = renderHook(() => usePlaygroundHistory());
    let detail!: Awaited<ReturnType<typeof result.current.getDetail>>;
    await act(async () => {
      detail = await result.current.getDetail('h1');
    });
    expect(detail?.prompt).toBe('full prompt');
  });

  it('returns null on non-2xx', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({}, 404));
    const { result } = renderHook(() => usePlaygroundHistory());
    let detail!: Awaited<ReturnType<typeof result.current.getDetail>>;
    await act(async () => {
      detail = await result.current.getDetail('missing');
    });
    expect(detail).toBeNull();
  });

  it('returns null on thrown error', async () => {
    apiFetchSpy.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => usePlaygroundHistory());
    let detail!: Awaited<ReturnType<typeof result.current.getDetail>>;
    await act(async () => {
      detail = await result.current.getDetail('h1');
    });
    expect(detail).toBeNull();
  });
});

describe('usePlaygroundHistory.deleteEntry', () => {
  it('removes the item from local state on 200', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp([baseItem]));
    const { result } = renderHook(() => usePlaygroundHistory());
    await act(async () => {
      await result.current.fetchHistory();
    });

    apiFetchSpy.mockResolvedValueOnce(jsonResp({ success: true }));
    let ok!: boolean;
    await act(async () => {
      ok = await result.current.deleteEntry('h1');
    });
    expect(ok).toBe(true);
    expect(result.current.items).toEqual([]);
  });

  // Bug #2 regression: phantom delete — non-2xx must NOT remove from local state
  it('regression #2: 404 response does NOT remove the item locally (no phantom delete)', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp([baseItem]));
    const { result } = renderHook(() => usePlaygroundHistory());
    await act(async () => {
      await result.current.fetchHistory();
    });

    apiFetchSpy.mockResolvedValueOnce(jsonResp({ error: 'not found' }, 404));
    let ok!: boolean;
    await act(async () => {
      ok = await result.current.deleteEntry('h1');
    });
    expect(ok).toBe(false);
    expect(result.current.items).toHaveLength(1);
  });

  it('regression #2: 500 also returns false and keeps item', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp([baseItem]));
    const { result } = renderHook(() => usePlaygroundHistory());
    await act(async () => {
      await result.current.fetchHistory();
    });

    apiFetchSpy.mockResolvedValueOnce(jsonResp({}, 500));
    let ok!: boolean;
    await act(async () => {
      ok = await result.current.deleteEntry('h1');
    });
    expect(ok).toBe(false);
    expect(result.current.items).toHaveLength(1);
  });

  it('returns false on throw', async () => {
    apiFetchSpy.mockRejectedValueOnce(new Error('x'));
    const { result } = renderHook(() => usePlaygroundHistory());
    let ok!: boolean;
    await act(async () => {
      ok = await result.current.deleteEntry('h1');
    });
    expect(ok).toBe(false);
  });
});

describe('usePlaygroundHistory.clearAll', () => {
  it('clears local state on 200', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp([baseItem]));
    const { result } = renderHook(() => usePlaygroundHistory());
    await act(async () => {
      await result.current.fetchHistory();
    });

    apiFetchSpy.mockResolvedValueOnce(jsonResp({ success: true }));
    let ok!: boolean;
    await act(async () => {
      ok = await result.current.clearAll();
    });
    expect(ok).toBe(true);
    expect(result.current.items).toEqual([]);
  });

  it('regression #2: 500 does NOT clear local state', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp([baseItem]));
    const { result } = renderHook(() => usePlaygroundHistory());
    await act(async () => {
      await result.current.fetchHistory();
    });

    apiFetchSpy.mockResolvedValueOnce(jsonResp({}, 500));
    let ok!: boolean;
    await act(async () => {
      ok = await result.current.clearAll();
    });
    expect(ok).toBe(false);
    expect(result.current.items).toHaveLength(1);
  });

  it('issues DELETE /api/playground/history', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({}));
    const { result } = renderHook(() => usePlaygroundHistory());
    await act(async () => {
      await result.current.clearAll();
    });
    expect(apiFetchSpy).toHaveBeenCalledWith('/api/playground/history', { method: 'DELETE' });
  });
});
