import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * End-to-end HTTP tests for the playground router. Mocks providerStore + DynamicProvider
 * + playgroundHistoryStore so the route layer logic is exercised without real API calls
 * or DB writes. Covers validation, success, failure, and history endpoints.
 */

const fns = vi.hoisted(() => ({
  providerGet: vi.fn(),
  providerGetKey: vi.fn(),
  execute: vi.fn(),
  historyCreate: vi.fn(),
  historyGet: vi.fn(),
  historyList: vi.fn(),
  historyDelete: vi.fn(),
  historyDeleteAll: vi.fn(),
}));

vi.mock('../services/providerStore', () => ({
  providerStore: { get: fns.providerGet, getDecryptedApiKey: fns.providerGetKey },
}));

vi.mock('../providers/adapter', () => {
  class MockDynamicProvider {
    execute = fns.execute;
  }
  // Generation-param mappers: tests send no genParams, so return the baseline.
  return {
    DynamicProvider: MockDynamicProvider,
    PROBE_TIMEOUT_MS: 90_000,
    openAIGenerationFields: () => ({}),
    anthropicGenerationFields: () => ({}),
    geminiGenerationFields: (_gp: unknown, maxTokens: number) => ({ maxOutputTokens: maxTokens }),
  };
});

vi.mock('../services/playgroundHistoryStore', () => ({
  playgroundHistoryStore: {
    create: fns.historyCreate,
    get: fns.historyGet,
    getList: fns.historyList,
    delete: fns.historyDelete,
    deleteAll: fns.historyDeleteAll,
  },
}));

import playgroundRouter from './playground';

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use('/api/playground', playgroundRouter);
  return app;
}

const mockProvider = {
  id: 'p1',
  name: 'OpenAI',
  endpoint: 'https://api.example.com/v1',
  apiKey: 'enc',
  format: 'openai' as const,
  models: [
    {
      id: 'm1',
      name: 'gpt-4',
      displayName: 'GPT-4',
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

beforeEach(() => {
  vi.clearAllMocks();
  fns.providerGet.mockReturnValue(mockProvider);
  fns.providerGetKey.mockReturnValue('sk-test');
  fns.historyCreate.mockImplementation((data) => ({ id: 'hist-1', createdAt: new Date().toISOString(), ...data }));
  fns.historyList.mockReturnValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/playground/run — validation', () => {
  it('400 when providerId missing', async () => {
    const res = await request(makeApp()).post('/api/playground/run').send({ modelName: 'gpt-4', prompt: 'hi' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/);
  });

  it('400 when modelName missing', async () => {
    const res = await request(makeApp()).post('/api/playground/run').send({ providerId: 'p1', prompt: 'hi' });
    expect(res.status).toBe(400);
  });

  it('400 when prompt missing', async () => {
    const res = await request(makeApp()).post('/api/playground/run').send({ providerId: 'p1', modelName: 'gpt-4' });
    expect(res.status).toBe(400);
  });

  it('400 when image exceeds 10MB', async () => {
    const bigData = 'A'.repeat(15 * 1024 * 1024); // ~11MB decoded
    const res = await request(makeApp())
      .post('/api/playground/run')
      .send({
        providerId: 'p1',
        modelName: 'gpt-4',
        prompt: 'hi',
        images: [{ type: 'base64', mediaType: 'image/png', data: bigData }],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/exceeds 10MB/);
  });

  it('400 when more than 10 images', async () => {
    const images = Array.from({ length: 11 }, () => ({ type: 'url' as const, url: 'http://x.png' }));
    const res = await request(makeApp())
      .post('/api/playground/run')
      .send({ providerId: 'p1', modelName: 'gpt-4', prompt: 'hi', images });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Maximum 10/);
  });

  it('400 when providerId unknown (resolveProvider error path)', async () => {
    fns.providerGet.mockReturnValueOnce(undefined);
    const res = await request(makeApp())
      .post('/api/playground/run')
      .send({ providerId: 'absent', modelName: 'gpt-4', prompt: 'hi' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Provider not found');
  });

  it('400 when model is inactive', async () => {
    fns.providerGet.mockReturnValueOnce({
      ...mockProvider,
      models: [{ ...mockProvider.models[0], isActive: false }],
    });
    const res = await request(makeApp())
      .post('/api/playground/run')
      .send({ providerId: 'p1', modelName: 'gpt-4', prompt: 'hi' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/inactive/);
  });

  it('400 when api key cannot be decrypted', async () => {
    fns.providerGetKey.mockReturnValueOnce(undefined);
    const res = await request(makeApp())
      .post('/api/playground/run')
      .send({ providerId: 'p1', modelName: 'gpt-4', prompt: 'hi' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/decrypt/);
  });
});

describe('POST /api/playground/run — happy path', () => {
  it('200 with response body + tokensPerSecond computed', async () => {
    fns.execute.mockResolvedValueOnce({
      text: 'hello back',
      inputTokens: 5,
      outputTokens: 10,
      totalTokens: 15,
      responseTime: 500, // 500ms
      firstTokenLatency: 100,
      estimatedCost: 0.001,
      reasoningTokens: 0,
      model: 'gpt-4',
    });

    const res = await request(makeApp())
      .post('/api/playground/run')
      .send({ providerId: 'p1', modelName: 'gpt-4', prompt: 'hi' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.text).toBe('hello back');
    expect(res.body.tokensPerSecond).toBe(20); // 10/500*1000 = 20
    expect(res.body.provider).toBe('OpenAI');
  });

  it('persists to history on success', async () => {
    fns.execute.mockResolvedValueOnce({
      text: 'x',
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      responseTime: 100,
      firstTokenLatency: 50,
      estimatedCost: 0,
      reasoningTokens: 0,
      model: 'gpt-4',
    });
    await request(makeApp()).post('/api/playground/run').send({ providerId: 'p1', modelName: 'gpt-4', prompt: 'hi' });
    expect(fns.historyCreate).toHaveBeenCalledOnce();
    const arg = fns.historyCreate.mock.calls[0][0];
    expect(arg.providerId).toBe('p1');
    expect(arg.useStreaming).toBe(false);
    expect(arg.responseText).toBe('x');
  });

  it('honors enableThinking flag', async () => {
    fns.execute.mockResolvedValueOnce({
      text: 'x',
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      responseTime: 100,
      firstTokenLatency: 50,
      estimatedCost: 0,
      reasoningTokens: 50,
      model: 'gpt-4',
    });
    await request(makeApp())
      .post('/api/playground/run')
      .send({ providerId: 'p1', modelName: 'gpt-4', prompt: 'hi', enableThinking: true });
    expect(fns.historyCreate.mock.calls[0][0].enableThinking).toBe(true);
  });

  it('tokensPerSecond is 0 when responseTime is 0', async () => {
    fns.execute.mockResolvedValueOnce({
      text: 'x',
      inputTokens: 1,
      outputTokens: 10,
      totalTokens: 11,
      responseTime: 0,
      firstTokenLatency: 0,
      estimatedCost: 0,
      reasoningTokens: 0,
      model: 'gpt-4',
    });
    const res = await request(makeApp())
      .post('/api/playground/run')
      .send({ providerId: 'p1', modelName: 'gpt-4', prompt: 'hi' });
    expect(res.body.tokensPerSecond).toBe(0);
  });

  it('tokensPerSecond is 0 when outputTokens is 0', async () => {
    fns.execute.mockResolvedValueOnce({
      text: '',
      inputTokens: 1,
      outputTokens: 0,
      totalTokens: 1,
      responseTime: 1000,
      firstTokenLatency: 0,
      estimatedCost: 0,
      reasoningTokens: 0,
      model: 'gpt-4',
    });
    const res = await request(makeApp())
      .post('/api/playground/run')
      .send({ providerId: 'p1', modelName: 'gpt-4', prompt: 'hi' });
    expect(res.body.tokensPerSecond).toBe(0);
  });

  it('uses default maxTokens=4096 when not provided', async () => {
    fns.execute.mockResolvedValueOnce({
      text: 'x',
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      responseTime: 100,
      firstTokenLatency: 50,
      estimatedCost: 0,
      reasoningTokens: 0,
      model: 'gpt-4',
    });
    await request(makeApp()).post('/api/playground/run').send({ providerId: 'p1', modelName: 'gpt-4', prompt: 'hi' });
    // execute is called with (prompt, systemPrompt, maxTokens, ...)
    expect(fns.execute.mock.calls[0][2]).toBe(4096);
  });
});

describe('POST /api/playground/run — error path', () => {
  it('502 when provider.execute throws', async () => {
    fns.execute.mockRejectedValueOnce(new Error('API rate limit'));
    const res = await request(makeApp())
      .post('/api/playground/run')
      .send({ providerId: 'p1', modelName: 'gpt-4', prompt: 'hi' });
    expect(res.status).toBe(502);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('rate limit');
    expect(res.body.provider).toBe('OpenAI');
  });

  it('persists error to history on failure', async () => {
    fns.execute.mockRejectedValueOnce(new Error('boom'));
    await request(makeApp()).post('/api/playground/run').send({ providerId: 'p1', modelName: 'gpt-4', prompt: 'hi' });
    expect(fns.historyCreate).toHaveBeenCalled();
    const arg = fns.historyCreate.mock.calls[0][0];
    expect(arg.error).toBe('boom');
    expect(arg.responseText).toBeUndefined();
  });

  it('falls back to "Request failed" when error has no message', async () => {
    fns.execute.mockRejectedValueOnce({}); // not an Error
    const res = await request(makeApp())
      .post('/api/playground/run')
      .send({ providerId: 'p1', modelName: 'gpt-4', prompt: 'hi' });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('Request failed');
  });
});

describe('History endpoints', () => {
  it('GET /history returns the list', async () => {
    fns.historyList.mockReturnValueOnce([
      { id: 'h1', providerName: 'OpenAI', modelName: 'gpt-4', promptSnippet: 'hi', createdAt: 't' },
    ]);
    const res = await request(makeApp()).get('/api/playground/history');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe('h1');
  });

  it('GET /history/:id returns the entry', async () => {
    fns.historyGet.mockReturnValueOnce({ id: 'h1', prompt: 'hi' });
    const res = await request(makeApp()).get('/api/playground/history/h1');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('h1');
  });

  it('GET /history/:id returns 404 when not found', async () => {
    fns.historyGet.mockReturnValueOnce(undefined);
    const res = await request(makeApp()).get('/api/playground/history/missing');
    expect(res.status).toBe(404);
  });

  it('DELETE /history/:id returns success', async () => {
    fns.historyDelete.mockReturnValueOnce(true);
    const res = await request(makeApp()).delete('/api/playground/history/h1');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(fns.historyDelete).toHaveBeenCalledWith('h1');
  });

  it('DELETE /history clears all', async () => {
    const res = await request(makeApp()).delete('/api/playground/history');
    expect(res.status).toBe(200);
    expect(fns.historyDeleteAll).toHaveBeenCalledOnce();
  });
});

describe('POST /api/playground/stream — validation', () => {
  it('400 when providerId missing', async () => {
    const res = await request(makeApp()).post('/api/playground/stream').send({ modelName: 'gpt-4', prompt: 'hi' });
    expect(res.status).toBe(400);
  });

  it('400 when prompt missing', async () => {
    const res = await request(makeApp()).post('/api/playground/stream').send({ providerId: 'p1', modelName: 'gpt-4' });
    expect(res.status).toBe(400);
  });

  it('400 when provider unknown', async () => {
    fns.providerGet.mockReturnValueOnce(undefined);
    const res = await request(makeApp())
      .post('/api/playground/stream')
      .send({ providerId: 'absent', modelName: 'gpt-4', prompt: 'hi' });
    expect(res.status).toBe(400);
  });
});

// ---- SSE response content ----
//
// /stream uses internal `streamOpenAI` / `streamAnthropic` / `streamGemini` which call
// fetchWithTimeout (global fetch). We stub fetch to return a controlled SSE Response,
// then read the response body as raw text and parse the SSE frames.

const encSSE = new TextEncoder();
function upstreamSSE(chunks: string[]): Response {
  const stream = new ReadableStream({
    start(c) {
      for (const x of chunks) c.enqueue(encSSE.encode(x));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

/** Parse "data: {...}\n\n" frames into JSON objects (skips [DONE] sentinel). */
function parseSSE(body: string): Array<Record<string, unknown>> {
  const frames: Array<Record<string, unknown>> = [];
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data: ')) continue;
    const payload = t.slice(6);
    if (payload === '[DONE]') continue;
    try {
      frames.push(JSON.parse(payload));
    } catch {
      /* skip */
    }
  }
  return frames;
}

let upstreamFetch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  upstreamFetch = vi.fn();
  vi.stubGlobal('fetch', upstreamFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/playground/stream — SSE response content (OpenAI)', () => {
  it('emits chunk events for each content delta, then [DONE]', async () => {
    upstreamFetch.mockResolvedValueOnce(
      upstreamSSE([
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" there"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n',
        'data: [DONE]\n\n',
      ]),
    );

    const res = await request(makeApp())
      .post('/api/playground/stream')
      .send({ providerId: 'p1', modelName: 'gpt-4', prompt: 'hi' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.text).toContain('data: [DONE]');
    const frames = parseSSE(res.text);
    const chunks = frames.filter((f) => f.type === 'chunk').map((f) => f.text);
    expect(chunks.join('')).toBe('hi there');
    const done = frames.find((f) => f.type === 'done');
    expect(done).toBeDefined();
    expect(done!.text).toBe('hi there');
    expect(done!.inputTokens).toBe(3);
    expect(done!.outputTokens).toBe(2);
  });

  it('emits reasoning event when delta.reasoning_content is present', async () => {
    upstreamFetch.mockResolvedValueOnce(
      upstreamSSE([
        'data: {"choices":[{"delta":{"reasoning_content":"thinking..."}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"completion_tokens_details":{"reasoning_tokens":5}}}\n\n',
      ]),
    );

    const res = await request(makeApp())
      .post('/api/playground/stream')
      .send({ providerId: 'p1', modelName: 'gpt-4', prompt: 'hi' });

    const frames = parseSSE(res.text);
    expect(frames.some((f) => f.type === 'reasoning' && f.text === 'thinking...')).toBe(true);
    expect(frames.some((f) => f.type === 'chunk' && f.text === 'answer')).toBe(true);
    const done = frames.find((f) => f.type === 'done');
    expect(done!.reasoningTokens).toBe(5);
    expect(done!.reasoningText).toBe('thinking...');
  });

  it('emits "error" event when upstream returns non-2xx', async () => {
    upstreamFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'rate limit' }), { status: 429 }));

    const res = await request(makeApp())
      .post('/api/playground/stream')
      .send({ providerId: 'p1', modelName: 'gpt-4', prompt: 'hi' });

    expect(res.status).toBe(200); // SSE always opens at 200, error is in the frames
    const frames = parseSSE(res.text);
    const err = frames.find((f) => f.type === 'error');
    expect(err).toBeDefined();
    expect(err!.message as string).toContain('429');
    expect(res.text).toContain('[DONE]');
  });

  it('emits cacheReadTokens in done metrics when upstream reports cached_tokens', async () => {
    upstreamFetch.mockResolvedValueOnce(
      upstreamSSE([
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":1,"prompt_tokens_details":{"cached_tokens":80}}}\n\n',
      ]),
    );

    const res = await request(makeApp())
      .post('/api/playground/stream')
      .send({ providerId: 'p1', modelName: 'gpt-4', prompt: 'hi' });

    const frames = parseSSE(res.text);
    const done = frames.find((f) => f.type === 'done');
    expect(done!.cacheReadTokens).toBe(80);
  });

  it('persists streaming result to history on success', async () => {
    upstreamFetch.mockResolvedValueOnce(
      upstreamSSE([
        'data: {"choices":[{"delta":{"content":"streamed"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
      ]),
    );

    await request(makeApp())
      .post('/api/playground/stream')
      .send({ providerId: 'p1', modelName: 'gpt-4', prompt: 'hi' });

    expect(fns.historyCreate).toHaveBeenCalledOnce();
    const arg = fns.historyCreate.mock.calls[0][0];
    expect(arg.useStreaming).toBe(true);
    expect(arg.responseText).toBe('streamed');
  });

  it('sends reasoning_effort=high in upstream body when enableThinking=true', async () => {
    upstreamFetch.mockResolvedValueOnce(
      upstreamSSE([
        'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
      ]),
    );

    await request(makeApp())
      .post('/api/playground/stream')
      .send({ providerId: 'p1', modelName: 'gpt-4', prompt: 'hi', enableThinking: true });

    const upstreamBody = JSON.parse((upstreamFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(upstreamBody.reasoning_effort).toBe('high');
  });

  it('forwards Authorization header to upstream', async () => {
    upstreamFetch.mockResolvedValueOnce(
      upstreamSSE([
        'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
      ]),
    );

    await request(makeApp())
      .post('/api/playground/stream')
      .send({ providerId: 'p1', modelName: 'gpt-4', prompt: 'hi' });

    const headers = (upstreamFetch.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-test');
  });

  it('ignores malformed SSE JSON chunks (does not crash)', async () => {
    upstreamFetch.mockResolvedValueOnce(
      upstreamSSE([
        'data: not-valid-json\n\n',
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
        'data: {"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
      ]),
    );

    const res = await request(makeApp())
      .post('/api/playground/stream')
      .send({ providerId: 'p1', modelName: 'gpt-4', prompt: 'hi' });

    expect(res.status).toBe(200);
    const frames = parseSSE(res.text);
    expect(frames.some((f) => f.type === 'chunk')).toBe(true);
  });
});

describe('POST /api/playground/stream — SSE response content (Anthropic)', () => {
  const anthropicProvider = {
    ...mockProvider,
    format: 'anthropic' as const,
    endpoint: 'https://api.anthropic.com',
  };

  it('emits chunks from Anthropic SSE events and captures usage from message_delta', async () => {
    upstreamFetch.mockResolvedValueOnce(
      upstreamSSE([
        'data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" there"}}\n\n',
        'data: {"type":"message_delta","usage":{"output_tokens":2}}\n\n',
      ]),
    );
    fns.providerGet.mockReturnValueOnce(anthropicProvider);

    const res = await request(makeApp())
      .post('/api/playground/stream')
      .send({ providerId: 'p1', modelName: 'gpt-4', prompt: 'hi' });

    const frames = parseSSE(res.text);
    expect(
      frames
        .filter((f) => f.type === 'chunk')
        .map((f) => f.text)
        .join(''),
    ).toBe('hi there');
    const done = frames.find((f) => f.type === 'done');
    expect(done!.inputTokens).toBe(5);
    expect(done!.outputTokens).toBe(2);
  });

  it('captures cache fields from Anthropic message_start', async () => {
    upstreamFetch.mockResolvedValueOnce(
      upstreamSSE([
        'data: {"type":"message_start","message":{"usage":{"input_tokens":50,"cache_creation_input_tokens":100,"cache_read_input_tokens":200}}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}\n\n',
        'data: {"type":"message_delta","usage":{"output_tokens":1}}\n\n',
      ]),
    );
    fns.providerGet.mockReturnValueOnce(anthropicProvider);

    const res = await request(makeApp())
      .post('/api/playground/stream')
      .send({ providerId: 'p1', modelName: 'gpt-4', prompt: 'hi' });

    const frames = parseSSE(res.text);
    const done = frames.find((f) => f.type === 'done')!;
    expect(done.cacheCreationTokens).toBe(100);
    expect(done.cacheReadTokens).toBe(200);
  });
});

describe('POST /api/playground/stream — SSE response content (Gemini)', () => {
  const geminiProvider = {
    ...mockProvider,
    format: 'gemini' as const,
    endpoint: 'https://generativelanguage.googleapis.com',
  };

  it('emits chunks from Gemini SSE format', async () => {
    upstreamFetch.mockResolvedValueOnce(
      upstreamSSE([
        'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1}}\n\n',
      ]),
    );
    fns.providerGet.mockReturnValueOnce(geminiProvider);

    const res = await request(makeApp())
      .post('/api/playground/stream')
      .send({ providerId: 'p1', modelName: 'gpt-4', prompt: 'hi' });

    expect(res.status).toBe(200);
    const frames = parseSSE(res.text);
    expect(frames.some((f) => f.type === 'chunk' && f.text === 'hi')).toBe(true);
  });
});
