import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const apiFetchSpy = vi.hoisted(() => vi.fn());
vi.mock('../services/api', () => ({
  apiFetch: apiFetchSpy,
  getToken: () => null,
  setToken: () => {},
  clearToken: () => {},
  isAuthenticated: () => false,
  sseUrl: vi.fn(async (u: string) => u),
  downloadUrl: vi.fn(async (u: string) => u),
}));

import { usePlayground } from './usePlayground';

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const enc = new TextEncoder();
function sseResp(chunks: string[]): Response {
  const stream = new ReadableStream({
    start(c) {
      for (const x of chunks) c.enqueue(enc.encode(x));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

beforeEach(() => {
  vi.clearAllMocks();
});

const baseParams = {
  providerId: 'p1',
  modelName: 'gpt-4',
  prompt: 'hi',
  maxTokens: 100,
};

describe('usePlayground.runPrompt (non-streaming)', () => {
  it('200 success → populates text + metrics', async () => {
    apiFetchSpy.mockResolvedValueOnce(
      jsonResp({
        success: true,
        text: 'hello',
        inputTokens: 5,
        outputTokens: 10,
        totalTokens: 15,
        responseTime: 200,
        firstTokenLatency: 50,
        tokensPerSecond: 50,
        model: 'gpt-4',
      }),
    );
    const { result } = renderHook(() => usePlayground());
    await act(async () => {
      await result.current.runPrompt(baseParams);
    });
    expect(result.current.responseText).toBe('hello');
    expect(result.current.metrics?.outputTokens).toBe(10);
    expect(result.current.error).toBeNull();
  });

  it('non-2xx → sets error', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ success: false, error: 'rate limit' }, 429));
    const { result } = renderHook(() => usePlayground());
    await act(async () => {
      await result.current.runPrompt(baseParams);
    });
    expect(result.current.error).toBe('rate limit');
    expect(result.current.responseText).toBe('');
  });

  it('200 with success=false sets error and skips state population', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ success: false, error: 'bad' }, 200));
    const { result } = renderHook(() => usePlayground());
    await act(async () => {
      await result.current.runPrompt(baseParams);
    });
    expect(result.current.error).toBe('bad');
    expect(result.current.metrics).toBeNull();
  });

  it('thrown error → setError unless AbortError', async () => {
    apiFetchSpy.mockRejectedValueOnce(new Error('network'));
    const { result } = renderHook(() => usePlayground());
    await act(async () => {
      await result.current.runPrompt(baseParams);
    });
    expect(result.current.error).toContain('network');
  });

  it('AbortError is silently ignored', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    apiFetchSpy.mockRejectedValueOnce(abortErr);
    const { result } = renderHook(() => usePlayground());
    await act(async () => {
      await result.current.runPrompt(baseParams);
    });
    expect(result.current.error).toBeNull();
  });

  it('captures cache fields when present', async () => {
    apiFetchSpy.mockResolvedValueOnce(
      jsonResp({
        success: true,
        text: 'x',
        cacheCreationTokens: 100,
        cacheReadTokens: 200,
      }),
    );
    const { result } = renderHook(() => usePlayground());
    await act(async () => {
      await result.current.runPrompt(baseParams);
    });
    expect(result.current.metrics?.cacheCreationTokens).toBe(100);
    expect(result.current.metrics?.cacheReadTokens).toBe(200);
  });

  it('toggles loading false after the call', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ success: true, text: 'x' }));
    const { result } = renderHook(() => usePlayground());
    await act(async () => {
      await result.current.runPrompt(baseParams);
    });
    expect(result.current.loading).toBe(false);
  });
});

describe('usePlayground.streamPrompt (SSE)', () => {
  it('aggregates chunk events into responseText', async () => {
    apiFetchSpy.mockResolvedValueOnce(
      sseResp([
        'data: {"type":"chunk","text":"hello"}\n\n',
        'data: {"type":"chunk","text":" world"}\n\n',
        'data: {"type":"done","text":"hello world","inputTokens":3,"outputTokens":2}\n\n',
      ]),
    );
    const { result } = renderHook(() => usePlayground());
    await act(async () => {
      await result.current.streamPrompt(baseParams);
    });
    expect(result.current.responseText).toBe('hello world');
    expect(result.current.metrics?.outputTokens).toBe(2);
  });

  it('captures reasoning events separately from chunks', async () => {
    apiFetchSpy.mockResolvedValueOnce(
      sseResp([
        'data: {"type":"reasoning","text":"thinking..."}\n\n',
        'data: {"type":"chunk","text":"answer"}\n\n',
        'data: {"type":"done","text":"answer","reasoningText":"thinking...","reasoningTokens":5}\n\n',
      ]),
    );
    const { result } = renderHook(() => usePlayground());
    await act(async () => {
      await result.current.streamPrompt(baseParams);
    });
    expect(result.current.responseText).toBe('answer');
    expect(result.current.reasoningText).toBe('thinking...');
    expect(result.current.metrics?.reasoningTokens).toBe(5);
  });

  it('handles error event in stream', async () => {
    apiFetchSpy.mockResolvedValueOnce(
      sseResp(['data: {"type":"chunk","text":"hi"}\n\n', 'data: {"type":"error","message":"upstream 500"}\n\n']),
    );
    const { result } = renderHook(() => usePlayground());
    await act(async () => {
      await result.current.streamPrompt(baseParams);
    });
    expect(result.current.error).toBe('upstream 500');
    // Partial text from chunks before the error is preserved
    expect(result.current.responseText).toBe('hi');
  });

  it('JSON error response (validation failure) → sets error and exits', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ error: 'missing providerId' }, 400));
    const { result } = renderHook(() => usePlayground());
    await act(async () => {
      await result.current.streamPrompt(baseParams);
    });
    expect(result.current.error).toBe('missing providerId');
  });

  it('non-2xx without JSON body sets generic HTTP error', async () => {
    apiFetchSpy.mockResolvedValueOnce(new Response('', { status: 500, headers: { 'Content-Type': 'text/plain' } }));
    const { result } = renderHook(() => usePlayground());
    await act(async () => {
      await result.current.streamPrompt(baseParams);
    });
    expect(result.current.error).toContain('500');
  });

  it('ignores malformed SSE JSON chunks', async () => {
    apiFetchSpy.mockResolvedValueOnce(
      sseResp([
        'data: not-json\n\n',
        'data: {"type":"chunk","text":"recovered"}\n\n',
        'data: {"type":"done","text":"recovered"}\n\n',
      ]),
    );
    const { result } = renderHook(() => usePlayground());
    await act(async () => {
      await result.current.streamPrompt(baseParams);
    });
    expect(result.current.responseText).toBe('recovered');
  });

  it('toggles streaming + loading correctly across the call', async () => {
    apiFetchSpy.mockResolvedValueOnce(sseResp(['data: {"type":"done","text":""}\n\n']));
    const { result } = renderHook(() => usePlayground());
    await act(async () => {
      await result.current.streamPrompt(baseParams);
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.streaming).toBe(false);
  });

  it('AbortError is silently ignored mid-stream', async () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    apiFetchSpy.mockRejectedValueOnce(err);
    const { result } = renderHook(() => usePlayground());
    await act(async () => {
      await result.current.streamPrompt(baseParams);
    });
    expect(result.current.error).toBeNull();
  });
});

describe('usePlayground.abort', () => {
  it('clears loading + streaming state', async () => {
    const { result } = renderHook(() => usePlayground());
    act(() => result.current.abort());
    expect(result.current.loading).toBe(false);
    expect(result.current.streaming).toBe(false);
  });

  it('aborting before any request is a no-op', () => {
    const { result } = renderHook(() => usePlayground());
    expect(() => result.current.abort()).not.toThrow();
  });
});

describe('usePlayground.reset', () => {
  it('clears text, metrics, error', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ success: true, text: 'hello', outputTokens: 5, model: 'gpt-4' }));
    const { result } = renderHook(() => usePlayground());
    await act(async () => {
      await result.current.runPrompt(baseParams);
    });
    expect(result.current.responseText).toBe('hello');

    act(() => result.current.reset());
    expect(result.current.responseText).toBe('');
    expect(result.current.metrics).toBeNull();
    expect(result.current.error).toBeNull();
  });
});

describe('usePlayground.restore', () => {
  it('populates state from saved snapshot', async () => {
    const { result } = renderHook(() => usePlayground());
    act(() => {
      result.current.restore({
        responseText: 'restored text',
        reasoningText: 'restored reasoning',
        metrics: {
          inputTokens: 1,
          outputTokens: 2,
          reasoningTokens: 0,
          totalTokens: 3,
          responseTime: 100,
          firstTokenLatency: 50,
          tokensPerSecond: 20,
          model: 'gpt-4',
        },
      });
    });
    await waitFor(() => expect(result.current.responseText).toBe('restored text'));
    expect(result.current.reasoningText).toBe('restored reasoning');
    expect(result.current.metrics?.outputTokens).toBe(2);
  });

  it('handles undefined fields with empty defaults', () => {
    const { result } = renderHook(() => usePlayground());
    act(() => {
      result.current.restore({});
    });
    expect(result.current.responseText).toBe('');
    expect(result.current.reasoningText).toBe('');
    expect(result.current.metrics).toBeNull();
  });
});
