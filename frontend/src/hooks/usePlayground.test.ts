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

/** A fetch that only settles when its AbortSignal fires, mirroring a cancelled request. */
function abortableFetch() {
  return (_url: string, opts: { signal: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
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

describe('usePlayground.runPanel (non-streaming)', () => {
  it('200 success → populates panel A text + metrics', async () => {
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
      await result.current.runPanel('A', baseParams);
    });

    expect(apiFetchSpy).toHaveBeenCalledWith('/api/playground/run', expect.objectContaining({ method: 'POST' }));
    expect(result.current.panels.A.responseText).toBe('hello');
    expect(result.current.panels.A.metrics?.outputTokens).toBe(10);
    expect(result.current.panels.A.metrics?.firstTokenLatency).toBe(50);
    expect(result.current.panels.A.error).toBeNull();
  });

  it('non-2xx → sets error and leaves text empty', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ success: false, error: 'rate limit' }, 429));
    const { result } = renderHook(() => usePlayground());

    await act(async () => {
      await result.current.runPanel('A', baseParams);
    });

    expect(result.current.panels.A.error).toBe('rate limit');
    expect(result.current.panels.A.responseText).toBe('');
    expect(result.current.panels.A.metrics).toBeNull();
  });

  it('200 with success=false sets error and skips state population', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ success: false, error: 'bad' }, 200));
    const { result } = renderHook(() => usePlayground());

    await act(async () => {
      await result.current.runPanel('A', baseParams);
    });

    expect(result.current.panels.A.error).toBe('bad');
    expect(result.current.panels.A.metrics).toBeNull();
  });

  it('thrown error → sets error message', async () => {
    apiFetchSpy.mockRejectedValueOnce(new Error('network'));
    const { result } = renderHook(() => usePlayground());

    await act(async () => {
      await result.current.runPanel('A', baseParams);
    });

    expect(result.current.panels.A.error).toContain('network');
  });

  it('AbortError is silently ignored', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    apiFetchSpy.mockRejectedValueOnce(abortErr);
    const { result } = renderHook(() => usePlayground());

    await act(async () => {
      await result.current.runPanel('A', baseParams);
    });

    expect(result.current.panels.A.error).toBeNull();
  });

  it('captures cache fields only when present', async () => {
    apiFetchSpy.mockResolvedValueOnce(
      jsonResp({ success: true, text: 'x', cacheCreationTokens: 100, cacheReadTokens: 200 }),
    );
    const { result } = renderHook(() => usePlayground());

    await act(async () => {
      await result.current.runPanel('A', baseParams);
    });

    expect(result.current.panels.A.metrics?.cacheCreationTokens).toBe(100);
    expect(result.current.panels.A.metrics?.cacheReadTokens).toBe(200);
  });

  it('clears loading and streaming once the call settles', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ success: true, text: 'x' }));
    const { result } = renderHook(() => usePlayground());

    await act(async () => {
      await result.current.runPanel('A', baseParams);
    });

    expect(result.current.panels.A.loading).toBe(false);
    expect(result.current.panels.A.streaming).toBe(false);
    expect(result.current.anyLoading).toBe(false);
  });
});

describe('usePlayground.streamPanel (SSE)', () => {
  it('hits the streaming endpoint and aggregates chunk events', async () => {
    apiFetchSpy.mockResolvedValueOnce(
      sseResp([
        'data: {"type":"chunk","text":"hello"}\n\n',
        'data: {"type":"chunk","text":" world"}\n\n',
        'data: {"type":"done","text":"hello world","inputTokens":3,"outputTokens":2}\n\n',
      ]),
    );
    const { result } = renderHook(() => usePlayground());

    await act(async () => {
      await result.current.streamPanel('A', baseParams);
    });

    expect(apiFetchSpy).toHaveBeenCalledWith('/api/playground/stream', expect.objectContaining({ method: 'POST' }));
    expect(result.current.panels.A.responseText).toBe('hello world');
    expect(result.current.panels.A.metrics?.outputTokens).toBe(2);
  });

  // Regression: chunks used to be appended from a stale `panels` closure, so only
  // the last chunk survived whenever the stream ended without a `done` event.
  it('concatenates every chunk instead of keeping only the last one', async () => {
    apiFetchSpy.mockResolvedValueOnce(
      sseResp(['data: {"type":"chunk","text":"aa"}\n\n', 'data: {"type":"chunk","text":"a"}\n\n']),
    );
    const { result } = renderHook(() => usePlayground());

    await act(async () => {
      await result.current.streamPanel('A', baseParams);
    });

    expect(result.current.panels.A.responseText).toBe('aaa');
  });

  it('captures reasoning events separately from content chunks', async () => {
    apiFetchSpy.mockResolvedValueOnce(
      sseResp([
        'data: {"type":"reasoning","text":"thinking..."}\n\n',
        'data: {"type":"chunk","text":"answer"}\n\n',
        'data: {"type":"done","text":"answer","reasoningText":"thinking...","reasoningTokens":5}\n\n',
      ]),
    );
    const { result } = renderHook(() => usePlayground());

    await act(async () => {
      await result.current.streamPanel('A', baseParams);
    });

    expect(result.current.panels.A.responseText).toBe('answer');
    expect(result.current.panels.A.reasoningText).toBe('thinking...');
    expect(result.current.panels.A.metrics?.reasoningTokens).toBe(5);
  });

  it('stores firstTokenLatency and cache fields from the done event', async () => {
    apiFetchSpy.mockResolvedValueOnce(
      sseResp([
        'data: {"type":"chunk","text":"hi"}\n\n',
        'data: {"type":"done","text":"hi","firstTokenLatency":321,"outputTokens":4,"model":"gpt-4","cacheReadTokens":7}\n\n',
      ]),
    );
    const { result } = renderHook(() => usePlayground());

    await act(async () => {
      await result.current.streamPanel('A', baseParams);
    });

    expect(result.current.panels.A.metrics?.firstTokenLatency).toBe(321);
    expect(result.current.panels.A.metrics?.cacheReadTokens).toBe(7);
  });

  it('keeps partial text when the stream reports an error', async () => {
    apiFetchSpy.mockResolvedValueOnce(
      sseResp(['data: {"type":"chunk","text":"hi"}\n\n', 'data: {"type":"error","message":"upstream 500"}\n\n']),
    );
    const { result } = renderHook(() => usePlayground());

    await act(async () => {
      await result.current.streamPanel('A', baseParams);
    });

    expect(result.current.panels.A.error).toBe('upstream 500');
    expect(result.current.panels.A.responseText).toBe('hi');
  });

  it('JSON error response (validation failure) → sets error and exits', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ error: 'missing providerId' }, 400));
    const { result } = renderHook(() => usePlayground());

    await act(async () => {
      await result.current.streamPanel('A', baseParams);
    });

    expect(result.current.panels.A.error).toBe('missing providerId');
    expect(result.current.panels.A.loading).toBe(false);
  });

  it('non-2xx without a JSON body sets a generic HTTP error', async () => {
    apiFetchSpy.mockResolvedValueOnce(new Response('', { status: 500, headers: { 'Content-Type': 'text/plain' } }));
    const { result } = renderHook(() => usePlayground());

    await act(async () => {
      await result.current.streamPanel('A', baseParams);
    });

    expect(result.current.panels.A.error).toContain('500');
  });

  it('ignores malformed SSE lines and the [DONE] sentinel', async () => {
    apiFetchSpy.mockResolvedValueOnce(
      sseResp([
        'data: not-json\n\n',
        ': keep-alive comment\n\n',
        'data: {"type":"chunk","text":"recovered"}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const { result } = renderHook(() => usePlayground());

    await act(async () => {
      await result.current.streamPanel('A', baseParams);
    });

    expect(result.current.panels.A.responseText).toBe('recovered');
    expect(result.current.panels.A.error).toBeNull();
  });

  it('clears streaming + loading across the call', async () => {
    apiFetchSpy.mockResolvedValueOnce(sseResp(['data: {"type":"done","text":""}\n\n']));
    const { result } = renderHook(() => usePlayground());

    await act(async () => {
      await result.current.streamPanel('A', baseParams);
    });

    expect(result.current.panels.A.loading).toBe(false);
    expect(result.current.panels.A.streaming).toBe(false);
  });

  it('AbortError is silently ignored mid-stream', async () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    apiFetchSpy.mockRejectedValueOnce(err);
    const { result } = renderHook(() => usePlayground());

    await act(async () => {
      await result.current.streamPanel('A', baseParams);
    });

    expect(result.current.panels.A.error).toBeNull();
  });
});

describe('usePlayground.runAll (used by A/B compare)', () => {
  it('routes both panels to the streaming endpoint when useStreaming is on', async () => {
    // Each panel needs its own Response — a body stream can only be read once.
    apiFetchSpy.mockImplementation(() =>
      sseResp(['data: {"type":"done","text":"ok","outputTokens":1,"model":"m"}\n\n']),
    );
    const { result } = renderHook(() => usePlayground());

    await act(async () => {
      await result.current.runAll([
        { id: 'A', params: { ...baseParams, useStreaming: true } },
        { id: 'B', params: { ...baseParams, modelName: 'gpt-4o', useStreaming: true } },
      ]);
    });

    expect(apiFetchSpy).toHaveBeenCalledTimes(2);
    for (const call of apiFetchSpy.mock.calls) {
      expect(call[0]).toBe('/api/playground/stream');
    }
    expect(result.current.panels.A.responseText).toBe('ok');
    expect(result.current.panels.B.responseText).toBe('ok');
  });

  it('routes both panels to the non-streaming endpoint when useStreaming is off', async () => {
    apiFetchSpy.mockImplementation(() => jsonResp({ success: true, text: 'ok', outputTokens: 1, model: 'm' }));
    const { result } = renderHook(() => usePlayground());

    await act(async () => {
      await result.current.runAll([
        { id: 'A', params: { ...baseParams, useStreaming: false } },
        { id: 'B', params: { ...baseParams, modelName: 'gpt-4o', useStreaming: false } },
      ]);
    });

    expect(apiFetchSpy).toHaveBeenCalledTimes(2);
    for (const call of apiFetchSpy.mock.calls) {
      expect(call[0]).toBe('/api/playground/run');
    }
    expect(result.current.panels.A.responseText).toBe('ok');
    expect(result.current.panels.B.responseText).toBe('ok');
  });

  // Regression: parallel panels used to overwrite each other's text.
  it('keeps A and B text separate when streaming in parallel', async () => {
    apiFetchSpy
      .mockResolvedValueOnce(sseResp(['data: {"type":"chunk","text":"aaa"}\n\n']))
      .mockResolvedValueOnce(sseResp(['data: {"type":"chunk","text":"bbb"}\n\n']));
    const { result } = renderHook(() => usePlayground());

    await act(async () => {
      await result.current.runAll([
        { id: 'A', params: { ...baseParams, useStreaming: true } },
        { id: 'B', params: { ...baseParams, modelName: 'gpt-4o', useStreaming: true } },
      ]);
    });

    expect(result.current.panels.A.responseText).toBe('aaa');
    expect(result.current.panels.B.responseText).toBe('bbb');
  });

  it('wipes previous results before a new run', async () => {
    apiFetchSpy.mockImplementation(() => jsonResp({ success: true, text: 'fresh', outputTokens: 1, model: 'm' }));
    const { result } = renderHook(() => usePlayground());

    await act(async () => {
      await result.current.runPanel('A', baseParams);
    });
    expect(result.current.panels.A.responseText).toBe('fresh');

    await act(async () => {
      await result.current.runAll([{ id: 'A', params: { ...baseParams, useStreaming: false } }]);
    });

    expect(result.current.panels.A.responseText).toBe('fresh');
    expect(result.current.panels.B).toBeUndefined();
  });
});

describe('usePlayground.abortPanel / abortAll', () => {
  it('abortPanel cancels the in-flight request and settles the panel', async () => {
    apiFetchSpy.mockImplementationOnce(abortableFetch() as never);
    const { result } = renderHook(() => usePlayground());

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.runPanel('A', baseParams);
    });
    expect(result.current.panels.A.loading).toBe(true);

    await act(async () => {
      result.current.abortPanel('A');
      await pending;
    });

    expect(result.current.panels.A.loading).toBe(false);
    expect(result.current.panels.A.streaming).toBe(false);
    expect(result.current.panels.A.error).toBeNull();
  });

  it('abortAll clears loading + streaming on every panel', async () => {
    apiFetchSpy.mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() => usePlayground());

    await act(async () => {
      void result.current.runPanel('A', baseParams);
      void result.current.runPanel('B', baseParams);
    });
    expect(result.current.anyLoading).toBe(true);

    await act(async () => {
      result.current.abortAll();
    });

    expect(result.current.anyLoading).toBe(false);
    expect(result.current.panels.A.loading).toBe(false);
    expect(result.current.panels.B.streaming).toBe(false);
  });

  it('aborting before any request is a no-op', () => {
    const { result } = renderHook(() => usePlayground());
    expect(() =>
      act(() => {
        result.current.abortPanel('A');
        result.current.abortAll();
      }),
    ).not.toThrow();
    expect(result.current.panels).toEqual({});
    expect(result.current.anyLoading).toBe(false);
  });
});

describe('usePlayground.resetPanel / resetAll', () => {
  it('resetPanel clears a single panel', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ success: true, text: 'hello', outputTokens: 5, model: 'gpt-4' }));
    const { result } = renderHook(() => usePlayground());

    await act(async () => {
      await result.current.runPanel('A', baseParams);
    });
    expect(result.current.panels.A.responseText).toBe('hello');

    await act(async () => {
      result.current.resetPanel('A');
    });

    expect(result.current.panels.A.responseText).toBe('');
    expect(result.current.panels.A.metrics).toBeNull();
    expect(result.current.panels.A.error).toBeNull();
  });

  it('resetAll drops every panel', async () => {
    apiFetchSpy.mockImplementation(() => jsonResp({ success: true, text: 'hello', outputTokens: 5, model: 'gpt-4' }));
    const { result } = renderHook(() => usePlayground());

    await act(async () => {
      await result.current.runAll([
        { id: 'A', params: { ...baseParams, useStreaming: false } },
        { id: 'B', params: { ...baseParams, modelName: 'gpt-4o', useStreaming: false } },
      ]);
    });
    expect(Object.keys(result.current.panels)).toEqual(['A', 'B']);

    await act(async () => {
      result.current.resetAll();
    });

    expect(result.current.panels).toEqual({});
    expect(result.current.anyLoading).toBe(false);
  });
});

describe('usePlayground.restore', () => {
  it('populates panel A from a saved snapshot', async () => {
    const { result } = renderHook(() => usePlayground());

    await act(async () => {
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

    await waitFor(() => expect(result.current.panels.A.responseText).toBe('restored text'));
    expect(result.current.panels.A.reasoningText).toBe('restored reasoning');
    expect(result.current.panels.A.metrics?.outputTokens).toBe(2);
    expect(result.current.panels.A.loading).toBe(false);
  });

  it('falls back to empty defaults for missing fields', async () => {
    const { result } = renderHook(() => usePlayground());

    await act(async () => {
      result.current.restore({});
    });

    expect(result.current.panels.A.responseText).toBe('');
    expect(result.current.panels.A.reasoningText).toBe('');
    expect(result.current.panels.A.metrics).toBeNull();
    expect(result.current.panels.A.error).toBeNull();
  });
});
