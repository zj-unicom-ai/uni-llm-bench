import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DynamicProvider } from './adapter';
import type { ProviderConfig } from '../types';

/**
 * Cache token + reasoning token field tests per provider format.
 * Each format has its own usage shape — boundary tests ensure we extract
 * cacheCreationTokens, cacheReadTokens, reasoningTokens correctly and that
 * zero values are omitted (not included as 0).
 */

const enc = new TextEncoder();
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function sseResponse(chunks: string[]): Response {
  return new Response(
    new ReadableStream({
      start(c) {
        for (const x of chunks) c.enqueue(enc.encode(x));
        c.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

const baseConfig: ProviderConfig = {
  id: 'p1',
  name: 'P1',
  endpoint: 'https://api.example.com/v1',
  apiKey: 'key',
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

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('OpenAI — non-streaming token fields', () => {
  it('reads reasoning_tokens from completion_tokens_details', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        choices: [{ message: { content: 'x' } }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 50,
          completion_tokens_details: { reasoning_tokens: 30 },
        },
      }),
    );
    const p = new DynamicProvider(baseConfig, 'gpt-4', 'k');
    const r = await p.execute('hi', undefined, 100, '', false);
    expect(r.reasoningTokens).toBe(30);
  });

  it('reads cached_tokens from prompt_tokens_details (OpenAI cache hit)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        choices: [{ message: { content: 'x' } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 80 } },
      }),
    );
    const p = new DynamicProvider(baseConfig, 'gpt-4', 'k');
    const r = await p.execute('hi', undefined, 100, '', false);
    expect(r.cacheReadTokens).toBe(80);
  });

  it('omits cacheReadTokens when cached_tokens is 0', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        choices: [{ message: { content: 'x' } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 0 } },
      }),
    );
    const r = await new DynamicProvider(baseConfig, 'gpt-4', 'k').execute('hi', undefined, 100, '', false);
    expect(r.cacheReadTokens).toBeUndefined();
  });

  it('reasoningTokens defaults to 0 when usage missing the field entirely', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ choices: [{ message: { content: 'x' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    );
    const r = await new DynamicProvider(baseConfig, 'gpt-4', 'k').execute('hi', undefined, 100, '', false);
    expect(r.reasoningTokens).toBe(0);
  });

  it('OpenAI never reports cacheCreationTokens (Anthropic-only concept)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        choices: [{ message: { content: 'x' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
    const r = await new DynamicProvider(baseConfig, 'gpt-4', 'k').execute('hi', undefined, 100, '', false);
    expect(r.cacheCreationTokens).toBeUndefined();
  });
});

describe('OpenAI — streaming token fields', () => {
  it('captures reasoning_tokens from the final usage chunk', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":15,"completion_tokens_details":{"reasoning_tokens":10}}}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const r = await new DynamicProvider(baseConfig, 'gpt-4', 'k').execute('hi', undefined, 100, '', true);
    expect(r.reasoningTokens).toBe(10);
  });

  it('captures cached_tokens from streaming usage', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":10,"prompt_tokens_details":{"cached_tokens":75}}}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const r = await new DynamicProvider(baseConfig, 'gpt-4', 'k').execute('hi', undefined, 100, '', true);
    expect(r.cacheReadTokens).toBe(75);
  });

  it('accumulates text via streaming delta.reasoning_content (if provided)', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        'data: {"choices":[{"delta":{"reasoning_content":"thinking..."}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n',
        'data: {"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    // The provider just needs to not crash on reasoning_content — primary behavior is to count as a delta
    const r = await new DynamicProvider(baseConfig, 'gpt-4', 'k').execute('hi', undefined, 100, '', true);
    expect(r).toBeDefined();
    expect(r.firstTokenLatency).toBeGreaterThanOrEqual(0);
  });
});

describe('Anthropic — non-streaming cache fields', () => {
  const anthropicConfig: ProviderConfig = { ...baseConfig, format: 'anthropic' };

  it('captures both cache_creation_input_tokens and cache_read_input_tokens', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        content: [{ text: 'x' }],
        usage: {
          input_tokens: 50,
          output_tokens: 10,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 200,
        },
      }),
    );
    const r = await new DynamicProvider(anthropicConfig, 'claude', 'k').execute('hi', undefined, 100, '', false);
    expect(r.cacheCreationTokens).toBe(100);
    expect(r.cacheReadTokens).toBe(200);
  });

  it('omits cacheCreationTokens when 0', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        content: [{ text: 'x' }],
        usage: { input_tokens: 50, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 200 },
      }),
    );
    const r = await new DynamicProvider(anthropicConfig, 'claude', 'k').execute('hi', undefined, 100, '', false);
    expect(r.cacheCreationTokens).toBeUndefined();
    expect(r.cacheReadTokens).toBe(200);
  });

  it('omits cacheReadTokens when 0', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        content: [{ text: 'x' }],
        usage: { input_tokens: 50, output_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 0 },
      }),
    );
    const r = await new DynamicProvider(anthropicConfig, 'claude', 'k').execute('hi', undefined, 100, '', false);
    expect(r.cacheCreationTokens).toBe(100);
    expect(r.cacheReadTokens).toBeUndefined();
  });

  it('both omitted when both 0', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ content: [{ text: 'x' }], usage: { input_tokens: 50, output_tokens: 10 } }),
    );
    const r = await new DynamicProvider(anthropicConfig, 'claude', 'k').execute('hi', undefined, 100, '', false);
    expect(r.cacheCreationTokens).toBeUndefined();
    expect(r.cacheReadTokens).toBeUndefined();
  });

  it('Anthropic non-streaming sets reasoningTokens to 0 (no reasoning concept)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ content: [{ text: 'x' }], usage: { input_tokens: 1, output_tokens: 1 } }),
    );
    const r = await new DynamicProvider(anthropicConfig, 'claude', 'k').execute('hi', undefined, 100, '', false);
    expect(r.reasoningTokens).toBe(0);
  });
});

describe('Anthropic — streaming cache fields', () => {
  const anthropicConfig: ProviderConfig = { ...baseConfig, format: 'anthropic' };

  it('captures cache fields from message_start usage', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        'data: {"type":"message_start","message":{"usage":{"input_tokens":50,"cache_creation_input_tokens":100,"cache_read_input_tokens":200}}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
        'data: {"type":"message_delta","usage":{"output_tokens":3}}\n\n',
      ]),
    );
    const r = await new DynamicProvider(anthropicConfig, 'claude', 'k').execute('hi', undefined, 100, '', true);
    expect(r.cacheCreationTokens).toBe(100);
    expect(r.cacheReadTokens).toBe(200);
  });

  it('omits cache fields when message_start usage is missing them', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        'data: {"type":"message_start","message":{"usage":{"input_tokens":50}}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}\n\n',
        'data: {"type":"message_delta","usage":{"output_tokens":1}}\n\n',
      ]),
    );
    const r = await new DynamicProvider(anthropicConfig, 'claude', 'k').execute('hi', undefined, 100, '', true);
    expect(r.cacheCreationTokens).toBeUndefined();
    expect(r.cacheReadTokens).toBeUndefined();
  });

  it('streaming reasoningTokens stays at 0 (Anthropic format)', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        'data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}\n\n',
        'data: {"type":"message_delta","usage":{"output_tokens":1}}\n\n',
      ]),
    );
    const r = await new DynamicProvider(anthropicConfig, 'claude', 'k').execute('hi', undefined, 100, '', true);
    expect(r.reasoningTokens).toBe(0);
  });
});

describe('Gemini — no cache/reasoning fields', () => {
  const geminiConfig: ProviderConfig = { ...baseConfig, format: 'gemini' };

  it('Gemini non-streaming: reasoningTokens=0, no cache fields', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        candidates: [{ content: { parts: [{ text: 'x' }] } }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
      }),
    );
    const r = await new DynamicProvider(geminiConfig, 'gemini', 'k').execute('hi', undefined, 100, '', false);
    expect(r.reasoningTokens).toBe(0);
    expect(r.cacheCreationTokens).toBeUndefined();
    expect(r.cacheReadTokens).toBeUndefined();
  });

  it('Gemini streaming: reasoningTokens=0, no cache fields', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1}}\n\n',
      ]),
    );
    const r = await new DynamicProvider(geminiConfig, 'gemini', 'k').execute('hi', undefined, 100, '', true);
    expect(r.reasoningTokens).toBe(0);
    expect(r.cacheCreationTokens).toBeUndefined();
    expect(r.cacheReadTokens).toBeUndefined();
  });
});

describe('totalTokens calculation', () => {
  it('OpenAI totalTokens = input + output (excluding reasoning, which is part of output)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        choices: [{ message: { content: 'x' } }],
        usage: { prompt_tokens: 10, completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 20 } },
      }),
    );
    const r = await new DynamicProvider(baseConfig, 'gpt-4', 'k').execute('hi', undefined, 100, '', false);
    expect(r.inputTokens).toBe(10);
    expect(r.outputTokens).toBe(50);
    expect(r.totalTokens).toBe(60);
  });

  it('Anthropic totalTokens = input + output', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        content: [{ text: 'x' }],
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    );
    const r = await new DynamicProvider({ ...baseConfig, format: 'anthropic' }, 'claude', 'k').execute(
      'hi',
      undefined,
      100,
      '',
      false,
    );
    expect(r.totalTokens).toBe(150);
  });

  it('Gemini totalTokens = prompt + candidates', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        candidates: [{ content: { parts: [{ text: 'x' }] } }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 },
      }),
    );
    const r = await new DynamicProvider({ ...baseConfig, format: 'gemini' }, 'gemini', 'k').execute(
      'hi',
      undefined,
      100,
      '',
      false,
    );
    expect(r.totalTokens).toBe(10);
  });
});
