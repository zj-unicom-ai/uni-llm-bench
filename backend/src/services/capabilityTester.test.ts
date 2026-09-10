import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { testCapabilities } from './capabilityTester';

/**
 * capabilityTester does HTTP calls via global fetch for 5 capability probes
 * (vision, function_calling, json_mode, streaming, non_streaming). Each has three
 * branches: success, API error (non-2xx), thrown error. Tests cover all 15.
 */

const okJson = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const errJson = (status: number, body: unknown = { error: 'fail' }) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Build a streaming Response whose body emits the given SSE-style chunks one at a time. */
function streamingResponse(chunks: string[]): Response {
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function setFetchSequence(...responses: Array<Response | Error>) {
  for (const r of responses) {
    if (r instanceof Error) fetchMock.mockRejectedValueOnce(r);
    else fetchMock.mockResolvedValueOnce(r);
  }
}

function findByType(results: Awaited<ReturnType<typeof testCapabilities>>, type: string) {
  const r = results.find((t) => t.type === type);
  if (!r) throw new Error(`No result for type ${type}`);
  return r;
}

describe('testCapabilities — return shape', () => {
  it('returns exactly 5 results in order vision/function_calling/json_mode/streaming/non_streaming', async () => {
    // All probes return non-2xx → fast failure for each
    setFetchSequence(errJson(500), errJson(500), errJson(500), errJson(500), errJson(500));
    const results = await testCapabilities('zai', 'sk-test');
    expect(results).toHaveLength(5);
    expect(results.map((r) => r.type)).toEqual([
      'vision',
      'function_calling',
      'json_mode',
      'streaming',
      'non_streaming',
    ]);
  });

  it('every result has type/name/description/passed', async () => {
    setFetchSequence(errJson(500), errJson(500), errJson(500), errJson(500), errJson(500));
    const results = await testCapabilities('zai', 'sk-test');
    for (const r of results) {
      expect(typeof r.type).toBe('string');
      expect(typeof r.name).toBe('string');
      expect(typeof r.description).toBe('string');
      expect(typeof r.passed).toBe('boolean');
    }
  });
});

describe('vision capability', () => {
  it('passes when the response mentions "red"', async () => {
    setFetchSequence(
      okJson({ choices: [{ message: { content: 'This image is RED.' } }] }),
      errJson(500),
      errJson(500),
      errJson(500),
      errJson(500),
    );
    const v = findByType(await testCapabilities('zai', 'sk-test'), 'vision');
    expect(v.passed).toBe(true);
    expect(v.details).toContain('correctly identified');
  });

  it('passes when the response mentions "红" (Chinese)', async () => {
    setFetchSequence(
      okJson({ choices: [{ message: { content: '图片是红色的' } }] }),
      errJson(500),
      errJson(500),
      errJson(500),
      errJson(500),
    );
    expect(findByType(await testCapabilities('zai', 'sk-test'), 'vision').passed).toBe(true);
  });

  it('fails when neither "red" nor "红" appears', async () => {
    setFetchSequence(
      okJson({ choices: [{ message: { content: 'I see a blue square' } }] }),
      errJson(500),
      errJson(500),
      errJson(500),
      errJson(500),
    );
    const v = findByType(await testCapabilities('zai', 'sk-test'), 'vision');
    expect(v.passed).toBe(false);
    expect(v.details).toContain('Model response');
  });

  it('reports API error on non-2xx', async () => {
    setFetchSequence(errJson(401), errJson(500), errJson(500), errJson(500), errJson(500));
    const v = findByType(await testCapabilities('zai', 'sk-test'), 'vision');
    expect(v.passed).toBe(false);
    expect(v.details).toBe('API error: 401');
  });

  it('reports error message on thrown fetch', async () => {
    setFetchSequence(new Error('network down'), errJson(500), errJson(500), errJson(500), errJson(500));
    const v = findByType(await testCapabilities('zai', 'sk-test'), 'vision');
    expect(v.passed).toBe(false);
    expect(v.details).toContain('network down');
  });
});

describe('function_calling capability', () => {
  it('passes when response includes tool_calls', async () => {
    setFetchSequence(
      errJson(500),
      okJson({ choices: [{ message: { tool_calls: [{ function: { name: 'get_weather' } }] } }] }),
      errJson(500),
      errJson(500),
      errJson(500),
    );
    const f = findByType(await testCapabilities('zai', 'sk-test'), 'function_calling');
    expect(f.passed).toBe(true);
    expect(f.details).toContain('get_weather');
  });

  it('fails when tool_calls is missing or empty', async () => {
    setFetchSequence(
      errJson(500),
      okJson({ choices: [{ message: { content: 'I would call get_weather' } }] }),
      errJson(500),
      errJson(500),
      errJson(500),
    );
    expect(findByType(await testCapabilities('zai', 'sk-test'), 'function_calling').passed).toBe(false);
  });

  it('fails when tool_calls array is empty', async () => {
    setFetchSequence(
      errJson(500),
      okJson({ choices: [{ message: { tool_calls: [] } }] }),
      errJson(500),
      errJson(500),
      errJson(500),
    );
    expect(findByType(await testCapabilities('zai', 'sk-test'), 'function_calling').passed).toBe(false);
  });

  it('reports API error', async () => {
    setFetchSequence(errJson(500), errJson(429), errJson(500), errJson(500), errJson(500));
    expect(findByType(await testCapabilities('zai', 'sk-test'), 'function_calling').details).toBe('API error: 429');
  });

  it('reports thrown error', async () => {
    setFetchSequence(errJson(500), new Error('timeout'), errJson(500), errJson(500), errJson(500));
    expect(findByType(await testCapabilities('zai', 'sk-test'), 'function_calling').details).toContain('timeout');
  });
});

describe('json_mode capability', () => {
  it('passes when response content is valid JSON object', async () => {
    setFetchSequence(
      errJson(500),
      errJson(500),
      okJson({ choices: [{ message: { content: '{"name":"test","value":123}' } }] }),
      errJson(500),
      errJson(500),
    );
    const j = findByType(await testCapabilities('zai', 'sk-test'), 'json_mode');
    expect(j.passed).toBe(true);
    expect(j.details).toContain('Valid JSON');
  });

  it('fails when content is not valid JSON', async () => {
    setFetchSequence(
      errJson(500),
      errJson(500),
      okJson({ choices: [{ message: { content: 'hello not json' } }] }),
      errJson(500),
      errJson(500),
    );
    const j = findByType(await testCapabilities('zai', 'sk-test'), 'json_mode');
    expect(j.passed).toBe(false);
    expect(j.details).toContain('Invalid JSON');
  });

  it('fails when content is a JSON primitive (not an object)', async () => {
    setFetchSequence(
      errJson(500),
      errJson(500),
      okJson({ choices: [{ message: { content: '42' } }] }),
      errJson(500),
      errJson(500),
    );
    expect(findByType(await testCapabilities('zai', 'sk-test'), 'json_mode').passed).toBe(false);
  });

  it('passes when content is a JSON array (still typeof object)', async () => {
    setFetchSequence(
      errJson(500),
      errJson(500),
      okJson({ choices: [{ message: { content: '[1,2,3]' } }] }),
      errJson(500),
      errJson(500),
    );
    expect(findByType(await testCapabilities('zai', 'sk-test'), 'json_mode').passed).toBe(true);
  });

  it('reports API error', async () => {
    setFetchSequence(errJson(500), errJson(500), errJson(503), errJson(500), errJson(500));
    expect(findByType(await testCapabilities('zai', 'sk-test'), 'json_mode').details).toBe('API error: 503');
  });
});

describe('streaming capability', () => {
  it('passes when at least 2 SSE chunks arrive', async () => {
    setFetchSequence(
      errJson(500),
      errJson(500),
      errJson(500),
      streamingResponse([
        'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
      errJson(500),
    );
    const s = findByType(await testCapabilities('zai', 'sk-test'), 'streaming');
    expect(s.passed).toBe(true);
    expect(typeof s.latencyMs).toBe('number');
  });

  it('fails when only 1 chunk arrives', async () => {
    setFetchSequence(
      errJson(500),
      errJson(500),
      errJson(500),
      streamingResponse(['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n']),
      errJson(500),
    );
    expect(findByType(await testCapabilities('zai', 'sk-test'), 'streaming').passed).toBe(false);
  });

  it('fails when no SSE chunks at all', async () => {
    setFetchSequence(errJson(500), errJson(500), errJson(500), streamingResponse(['no sse here']), errJson(500));
    const s = findByType(await testCapabilities('zai', 'sk-test'), 'streaming');
    expect(s.passed).toBe(false);
    expect(s.details).toContain('Only received 0');
  });

  it('cancels reader after 3 chunks (does not hang)', async () => {
    // 5 chunks would be too many but the code should bail after 3
    setFetchSequence(
      errJson(500),
      errJson(500),
      errJson(500),
      streamingResponse(['data: a\n\n', 'data: b\n\n', 'data: c\n\n', 'data: d\n\n', 'data: e\n\n']),
      errJson(500),
    );
    const s = findByType(await testCapabilities('zai', 'sk-test'), 'streaming');
    expect(s.passed).toBe(true);
  });

  it('reports API error on non-2xx streaming response', async () => {
    setFetchSequence(errJson(500), errJson(500), errJson(500), errJson(429), errJson(500));
    expect(findByType(await testCapabilities('zai', 'sk-test'), 'streaming').details).toBe('API error: 429');
  });
});

describe('non_streaming capability', () => {
  it('passes when response content is non-empty', async () => {
    setFetchSequence(
      errJson(500),
      errJson(500),
      errJson(500),
      errJson(500),
      okJson({ choices: [{ message: { content: 'hi there' } }] }),
    );
    const n = findByType(await testCapabilities('zai', 'sk-test'), 'non_streaming');
    expect(n.passed).toBe(true);
    expect(typeof n.latencyMs).toBe('number');
  });

  it('fails when response content is empty string', async () => {
    setFetchSequence(
      errJson(500),
      errJson(500),
      errJson(500),
      errJson(500),
      okJson({ choices: [{ message: { content: '' } }] }),
    );
    expect(findByType(await testCapabilities('zai', 'sk-test'), 'non_streaming').passed).toBe(false);
  });

  it('fails when choices missing entirely', async () => {
    setFetchSequence(errJson(500), errJson(500), errJson(500), errJson(500), okJson({}));
    expect(findByType(await testCapabilities('zai', 'sk-test'), 'non_streaming').passed).toBe(false);
  });

  it('reports API error', async () => {
    setFetchSequence(errJson(500), errJson(500), errJson(500), errJson(500), errJson(402));
    expect(findByType(await testCapabilities('zai', 'sk-test'), 'non_streaming').details).toBe('API error: 402');
  });
});

describe('provider/baseUrl plumbing', () => {
  it('uses model "z-ai/glm-4.7" when provider="zai"', async () => {
    setFetchSequence(
      okJson({ choices: [{ message: { content: 'red' } }] }),
      errJson(500),
      errJson(500),
      errJson(500),
      errJson(500),
    );
    await testCapabilities('zai', 'sk-test', 'https://api.example.com');
    const firstCallBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(firstCallBody.model).toBe('z-ai/glm-4.7');
  });

  it('uses model "default" when provider is anything else', async () => {
    setFetchSequence(
      okJson({ choices: [{ message: { content: 'red' } }] }),
      errJson(500),
      errJson(500),
      errJson(500),
      errJson(500),
    );
    await testCapabilities('openai', 'sk-test', 'https://api.example.com');
    const firstCallBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(firstCallBody.model).toBe('default');
  });

  it('passes baseUrl into the fetch URL', async () => {
    setFetchSequence(errJson(500), errJson(500), errJson(500), errJson(500), errJson(500));
    await testCapabilities('zai', 'sk-test', 'https://my-custom-url.com/v1');
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe('https://my-custom-url.com/v1/chat/completions');
  });

  it('passes the Authorization header with the api key', async () => {
    setFetchSequence(errJson(500), errJson(500), errJson(500), errJson(500), errJson(500));
    await testCapabilities('zai', 'sk-my-secret-key');
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-my-secret-key');
  });
});
