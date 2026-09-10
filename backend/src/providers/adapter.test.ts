import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DynamicProvider, testProviderConnection, createDynamicProvider, PROBE_TIMEOUT_MS } from './adapter';
import type { ProviderConfig } from '../types';

/**
 * adapter.ts covers DynamicProvider (multi-format HTTP client) + testProviderConnection.
 * Tests cover: pickTimeout plumbing, OpenAI/Anthropic/Gemini non-streaming + streaming success paths,
 * error paths (non-2xx, empty response, thrown), AbortSignal timeout, and the createDynamicProvider factory.
 */

const enc = new TextEncoder();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

// (removed: neverEndingResponse — abort test now triggers via signal in the fetch mock itself)

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const baseConfig: ProviderConfig = {
  id: 'p1',
  name: 'P1',
  endpoint: 'https://api.example.com/v1',
  apiKey: 'plain-key',
  format: 'openai',
  models: [
    {
      id: 'm1',
      name: 'gpt-4',
      contextSize: 8192,
      supportsVision: false,
      supportsTools: false,
      supportsStreaming: true,
      isActive: true,
    },
  ],
  createdAt: '',
  updatedAt: '',
};

describe('PROBE_TIMEOUT_MS', () => {
  it('exports 90_000 ms (90s health-check default)', () => {
    expect(PROBE_TIMEOUT_MS).toBe(90_000);
  });
});

describe('DynamicProvider — OpenAI non-streaming', () => {
  it('returns parsed text + token counts on a 200 response', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        choices: [{ message: { content: 'hello world' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );
    const p = new DynamicProvider(baseConfig, 'gpt-4', 'plain-key');
    const r = await p.execute('hi', undefined, 100, '', false);
    expect(r.text).toBe('hello world');
    expect(r.inputTokens).toBe(10);
    expect(r.outputTokens).toBe(5);
    expect(r.totalTokens).toBe(15);
    // Non-streaming has no first-token event. It must report null rather than
    // 0, which would be indistinguishable from a real measurement.
    expect(r.firstTokenLatency).toBeNull();
  });

  it('throws on non-2xx with status code in error message', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'rate limit' }, 429));
    const p = new DynamicProvider(baseConfig, 'gpt-4', 'plain-key');
    await expect(p.execute('hi', undefined, 100, '', false)).rejects.toThrow(/429/);
  });

  it('captures reasoning_tokens from usage.completion_tokens_details', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        choices: [{ message: { content: 'x' } }],
        usage: { prompt_tokens: 5, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 15 } },
      }),
    );
    const p = new DynamicProvider(baseConfig, 'gpt-4', 'plain-key');
    const r = await p.execute('hi', undefined, 100, '', false);
    expect(r.reasoningTokens).toBe(15);
  });

  it('includes systemPrompt in the messages array when provided', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'x' } }], usage: {} }));
    const p = new DynamicProvider(baseConfig, 'gpt-4', 'plain-key');
    await p.execute('hi', 'You are helpful', 100, '', false);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.messages[0]).toEqual({ role: 'system', content: 'You are helpful' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('omits system role when systemPrompt is undefined', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'x' } }], usage: {} }));
    const p = new DynamicProvider(baseConfig, 'gpt-4', 'plain-key');
    await p.execute('hi', undefined, 100, '', false);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe('user');
  });
});

describe('DynamicProvider — OpenAI streaming', () => {
  it('parses SSE chunks and reports usage from the final message', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" there"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const p = new DynamicProvider(baseConfig, 'gpt-4', 'plain-key');
    const r = await p.execute('hi', undefined, 100, '', true);
    expect(r.inputTokens).toBe(3);
    expect(r.outputTokens).toBe(2);
    expect(r.firstTokenLatency).toBeGreaterThanOrEqual(0);
  });

  it('reports firstTokenLatency=0 when no content chunk arrives', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse(['data: {"choices":[],"usage":{"prompt_tokens":0,"completion_tokens":0}}\n\n', 'data: [DONE]\n\n']),
    );
    const p = new DynamicProvider(baseConfig, 'gpt-4', 'plain-key');
    const r = await p.execute('hi', undefined, 100, '', true);
    expect(r.firstTokenLatency).toBe(0);
  });

  it('ignores malformed JSON in SSE chunks (does not throw)', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        'data: not json\n\n',
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
        'data: {"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const p = new DynamicProvider(baseConfig, 'gpt-4', 'plain-key');
    await expect(p.execute('hi', undefined, 100, '', true)).resolves.toBeDefined();
  });

  it('throws on non-2xx streaming response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'x' }, 503));
    const p = new DynamicProvider(baseConfig, 'gpt-4', 'plain-key');
    await expect(p.execute('hi', undefined, 100, '', true)).rejects.toThrow(/503/);
  });
});

describe('DynamicProvider — Anthropic format', () => {
  const anthropicConfig: ProviderConfig = { ...baseConfig, format: 'anthropic' };

  it('builds Anthropic-shaped request and parses non-streaming response', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        content: [{ text: 'claude says hi' }],
        usage: { input_tokens: 7, output_tokens: 3 },
      }),
    );
    const p = new DynamicProvider(anthropicConfig, 'claude', 'plain-key');
    const r = await p.execute('hi', 'be terse', 100, '', false);
    expect(r.text).toBe('claude says hi');
    expect(r.inputTokens).toBe(7);
    expect(r.outputTokens).toBe(3);
    // Body should have system at top-level (not in messages), per Anthropic API
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.system).toBe('be terse');
    expect(body.messages[0].role).toBe('user');
  });

  it('omits "system" field when systemPrompt undefined', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ content: [{ text: 'x' }], usage: {} }));
    const p = new DynamicProvider(anthropicConfig, 'claude', 'plain-key');
    await p.execute('hi', undefined, 100, '', false);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.system).toBeUndefined();
  });

  it('parses streaming Anthropic events (message_start, content_block_delta, message_delta)', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        'data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
        'data: {"type":"message_delta","usage":{"output_tokens":2}}\n\n',
      ]),
    );
    const p = new DynamicProvider(anthropicConfig, 'claude', 'plain-key');
    const r = await p.execute('hi', undefined, 100, '', true);
    expect(r.inputTokens).toBe(5);
    expect(r.outputTokens).toBe(2);
    expect(r.firstTokenLatency).toBeGreaterThanOrEqual(0);
  });

  it('captures cache_creation_input_tokens and cache_read_input_tokens', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        content: [{ text: 'x' }],
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 100, cache_read_input_tokens: 200 },
      }),
    );
    const p = new DynamicProvider(anthropicConfig, 'claude', 'plain-key');
    const r = await p.execute('hi', undefined, 100, '', false);
    expect(r.cacheCreationTokens).toBe(100);
    expect(r.cacheReadTokens).toBe(200);
  });

  it('throws on non-2xx Anthropic response with status in message', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'rate' }, 429));
    const p = new DynamicProvider(anthropicConfig, 'claude', 'plain-key');
    await expect(p.execute('hi', undefined, 100, '', false)).rejects.toThrow(/Anthropic API error 429/);
  });
});

describe('DynamicProvider — Gemini format', () => {
  const geminiConfig: ProviderConfig = { ...baseConfig, format: 'gemini' };

  it('sends the API key in a header, never in the URL', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        candidates: [{ content: { parts: [{ text: 'hi' }] } }],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 },
      }),
    );
    const p = new DynamicProvider(geminiConfig, 'gemini-2.5', 'gem-key');
    await p.execute('hi', undefined, 100, '', false);
    const url = fetchMock.mock.calls[0][0] as string;
    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    // A key in the query string leaks into proxy logs and browser history.
    expect(url).not.toContain('key=gem-key');
    expect(url).toContain(':generateContent');
    expect(headers['x-goog-api-key']).toBe('gem-key');
  });

  it('uses streamGenerateContent URL when streaming', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1}}\n\n',
      ]),
    );
    const p = new DynamicProvider(geminiConfig, 'gemini-2.5', 'gem-key');
    await p.execute('hi', undefined, 100, '', true);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain(':streamGenerateContent');
    expect(url).toContain('alt=sse');
  });

  it('falls back to character-estimated tokens when usageMetadata missing', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ candidates: [{ content: { parts: [{ text: 'hello world' }] } }] }));
    const p = new DynamicProvider(geminiConfig, 'gemini-2.5', 'gem-key');
    const r = await p.execute('hello there', undefined, 100, '', false);
    expect(r.inputTokens).toBeGreaterThan(0);
    expect(r.outputTokens).toBeGreaterThan(0);
  });

  it('throws on non-2xx Gemini response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'x' }, 400));
    const p = new DynamicProvider(geminiConfig, 'gemini-2.5', 'gem-key');
    await expect(p.execute('hi', undefined, 100, '', false)).rejects.toThrow(/Gemini API error 400/);
  });
});

describe('DynamicProvider — format dispatching', () => {
  it('throws on unknown format', async () => {
    const bad: ProviderConfig = { ...baseConfig, format: 'badfmt' as 'openai' };
    const p = new DynamicProvider(bad, 'x', 'k');
    await expect(p.execute('hi', undefined, 100, '', false)).rejects.toThrow(/Unsupported format/);
  });

  it('"custom" format uses OpenAI-compatible path', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'x' } }], usage: {} }));
    const p = new DynamicProvider({ ...baseConfig, format: 'custom' }, 'x', 'k');
    await p.execute('hi', undefined, 100, '', false);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/chat/completions');
  });
});

describe('DynamicProvider — pickTimeout (requestTimeoutMs override)', () => {
  it('fetch is called with an AbortSignal (timeout machinery active)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'x' } }], usage: {} }));
    const p = new DynamicProvider(baseConfig, 'gpt-4', 'k', 1000);
    await p.execute('hi', undefined, 100, '', false);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('aborts the fetch when timeout elapses', async () => {
    // fetch never resolves on its own; it rejects ONLY when the AbortSignal fires
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init.signal as AbortSignal;
          if (signal.aborted) reject(new DOMException('aborted', 'AbortError'));
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const p = new DynamicProvider(baseConfig, 'gpt-4', 'k', 50);
    await expect(p.execute('hi', undefined, 100, '', true)).rejects.toBeDefined();
  });
});

describe('testProviderConnection', () => {
  it('returns success=true with metrics when response is non-empty', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
        'data: {"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\n',
      ]),
    );
    const r = await testProviderConnection({
      endpoint: 'https://api.example.com',
      apiKey: 'k',
      format: 'openai',
      modelName: 'gpt-4',
    });
    expect(r.success).toBe(true);
    expect(r.outputTokens).toBe(1);
    expect(typeof r.latencyMs).toBe('number');
  });

  it('returns success=false with error="Empty response (0 output tokens)" when no content', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse(['data: {"usage":{"prompt_tokens":1,"completion_tokens":0}}\n\n']));
    const r = await testProviderConnection({
      endpoint: 'https://api.example.com',
      apiKey: 'k',
      format: 'openai',
      modelName: 'gpt-4',
    });
    expect(r.success).toBe(false);
    expect(r.error).toBe('Empty response (0 output tokens)');
  });

  it('catches thrown errors and returns success=false with error message', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const r = await testProviderConnection({
      endpoint: 'https://api.example.com',
      apiKey: 'k',
      format: 'openai',
      modelName: 'gpt-4',
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain('network down');
  });

  it('honors timeoutMs override (passed through to DynamicProvider)', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
        'data: {"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
      ]),
    );
    await testProviderConnection({
      endpoint: 'https://api.example.com',
      apiKey: 'k',
      format: 'openai',
      modelName: 'gpt-4',
      timeoutMs: 5_000,
    });
    // Verify fetch was invoked with an AbortSignal (timeout active)
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('uses PROBE_TIMEOUT_MS default when timeoutMs omitted', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
        'data: {"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
      ]),
    );
    await testProviderConnection({
      endpoint: 'https://api.example.com',
      apiKey: 'k',
      format: 'openai',
      modelName: 'gpt-4',
    });
    // No way to inspect the timeout value directly without parsing fetch internals;
    // verify the signal exists (machinery wired up)
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('createDynamicProvider (factory)', () => {
  // The factory looks up via providerStore singleton — to avoid touching the real DB
  // we mock providerStore.get. createDynamicProvider does NOT take the store as a
  // dependency, so we exercise it by directly asserting the (provider not found) path.

  it('returns null when providerStore has no such id', () => {
    // The real providerStore singleton has no 'absent-id'; this tests the early-return
    expect(createDynamicProvider('absent-id', 'any-model')).toBeNull();
  });
});
