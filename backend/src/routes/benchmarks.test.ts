import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const fns = vi.hoisted(() => ({
  storeGet: vi.fn(),
  storeGetAll: vi.fn(),
  storeGetPage: vi.fn(),
  startBenchmark: vi.fn(),
  subscribe: vi.fn(),
  cancelRun: vi.fn(),
  providerGet: vi.fn(),
}));

vi.mock('../services/store', () => ({
  store: { get: fns.storeGet, getAll: fns.storeGetAll, getPage: fns.storeGetPage },
}));
vi.mock('../services/benchmarkEngine', () => ({
  startBenchmark: fns.startBenchmark,
  subscribe: fns.subscribe,
  cancelRun: fns.cancelRun,
}));
vi.mock('../services/providerStore', () => ({ providerStore: { get: fns.providerGet } }));

import benchmarksRouter from './benchmarks';

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use('/api/benchmarks', benchmarksRouter);
  return app;
}

const mockRun = {
  id: 'r1',
  status: 'completed' as const,
  providers: ['p1:gpt-4'],
  config: { prompt: 'hi', concurrency: 1, iterations: 1, maxTokens: 100 },
  results: {
    'p1:gpt-4': {
      provider: 'OpenAI',
      model: 'gpt-4',
      iterations: [
        {
          iteration: 0,
          responseTime: 100,
          firstTokenLatency: 50,
          tokensPerSecond: 20,
          inputTokens: 5,
          outputTokens: 10,
          reasoningTokens: 0,
          totalTokens: 15,
          estimatedCost: 0.001,
          success: true,
        },
      ],
      summary: {} as never,
    },
  },
  createdAt: '2026-05-15T00:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/benchmarks — start', () => {
  beforeEach(() => {
    fns.providerGet.mockReturnValue({ id: 'p1', name: 'OpenAI' });
    fns.startBenchmark.mockResolvedValue({ id: 'new-run', status: 'pending', createdAt: 't' });
  });

  it('201 on valid payload, passes provided concurrency through', async () => {
    const res = await request(makeApp())
      .post('/api/benchmarks')
      .send({
        providers: ['p1:gpt-4'],
        config: { prompt: 'hi', maxTokens: 100, concurrency: 100, iterations: 10 },
      });
    expect(res.status).toBe(201);
    const cfg = fns.startBenchmark.mock.calls[0][1];
    expect(cfg.concurrency).toBe(100);
  });

  it('clamps concurrency above route-level limit (schema=5000) — schema rejects > 5000', async () => {
    const res = await request(makeApp())
      .post('/api/benchmarks')
      .send({
        providers: ['p1:gpt-4'],
        config: { prompt: 'hi', maxTokens: 100, concurrency: 6000, iterations: 1 },
      });
    expect(res.status).toBe(400); // zod rejects before route's Math.min sees it
  });

  it('passes iterations through up to schema max (10_000_000)', async () => {
    await request(makeApp())
      .post('/api/benchmarks')
      .send({
        providers: ['p1:gpt-4'],
        config: { prompt: 'hi', maxTokens: 100, concurrency: 1, iterations: 100 },
      });
    expect(fns.startBenchmark.mock.calls[0][1].iterations).toBe(100);
  });

  it('clamps maxQps to [0, 1000]', async () => {
    await request(makeApp())
      .post('/api/benchmarks')
      .send({
        providers: ['p1:gpt-4'],
        config: { prompt: 'hi', maxTokens: 100, concurrency: 1, iterations: 1, maxQps: 999 },
      });
    expect(fns.startBenchmark.mock.calls[0][1].maxQps).toBe(999);
  });

  it('400 when providers empty', async () => {
    const res = await request(makeApp())
      .post('/api/benchmarks')
      .send({ providers: [], config: { prompt: 'hi', maxTokens: 100, concurrency: 1, iterations: 1 } });
    expect(res.status).toBe(400);
  });

  it('400 when prompt missing', async () => {
    const res = await request(makeApp())
      .post('/api/benchmarks')
      .send({ providers: ['p1:gpt-4'], config: { maxTokens: 100, concurrency: 1, iterations: 1 } });
    expect(res.status).toBe(400);
  });

  it('400 when provider id is unknown', async () => {
    fns.providerGet.mockReturnValueOnce(undefined);
    const res = await request(makeApp())
      .post('/api/benchmarks')
      .send({
        providers: ['absent'],
        config: { prompt: 'hi', maxTokens: 100, concurrency: 1, iterations: 1 },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('absent');
  });

  it('accepts legacy provider id "openai"', async () => {
    const res = await request(makeApp())
      .post('/api/benchmarks')
      .send({
        providers: ['openai'],
        config: { prompt: 'hi', maxTokens: 100, concurrency: 1, iterations: 1 },
      });
    expect(res.status).toBe(201);
  });

  it('500 when startBenchmark throws', async () => {
    fns.startBenchmark.mockRejectedValueOnce(new Error('boom'));
    const res = await request(makeApp())
      .post('/api/benchmarks')
      .send({
        providers: ['p1:gpt-4'],
        config: { prompt: 'hi', maxTokens: 100, concurrency: 1, iterations: 1 },
      });
    expect(res.status).toBe(500);
  });
});

describe('GET /api/benchmarks', () => {
  it('returns a bounded page of runs and exposes the total via header', async () => {
    fns.storeGetPage.mockReturnValueOnce({ items: [mockRun], total: 1 });
    const res = await request(makeApp()).get('/api/benchmarks');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.headers['x-total-count']).toBe('1');
  });
});

describe('GET /api/benchmarks/:id', () => {
  it('200 with run', async () => {
    fns.storeGet.mockReturnValueOnce(mockRun);
    const res = await request(makeApp()).get('/api/benchmarks/r1');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('r1');
  });

  it('404 when not found', async () => {
    fns.storeGet.mockReturnValueOnce(undefined);
    const res = await request(makeApp()).get('/api/benchmarks/missing');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/benchmarks/:id/cancel', () => {
  it('200 cancels a running benchmark', async () => {
    fns.storeGet.mockReturnValueOnce({ ...mockRun, status: 'running' });
    fns.cancelRun.mockReturnValueOnce(true);
    const res = await request(makeApp()).post('/api/benchmarks/r1/cancel');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('400 when not running', async () => {
    fns.storeGet.mockReturnValueOnce(mockRun); // completed
    const res = await request(makeApp()).post('/api/benchmarks/r1/cancel');
    expect(res.status).toBe(400);
  });

  it('404 when not found', async () => {
    fns.storeGet.mockReturnValueOnce(undefined);
    const res = await request(makeApp()).post('/api/benchmarks/absent/cancel');
    expect(res.status).toBe(404);
  });

  it('returns success=false when already cancelled', async () => {
    fns.storeGet.mockReturnValueOnce({ ...mockRun, status: 'running' });
    fns.cancelRun.mockReturnValueOnce(false);
    const res = await request(makeApp()).post('/api/benchmarks/r1/cancel');
    expect(res.body.success).toBe(false);
  });
});

describe('GET /api/benchmarks/:id/export', () => {
  it('returns JSON by default', async () => {
    fns.storeGet.mockReturnValueOnce(mockRun);
    const res = await request(makeApp()).get('/api/benchmarks/r1/export');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['content-disposition']).toContain('benchmark-r1.json');
    expect(res.body.id).toBe('r1');
  });

  it('returns CSV when format=csv with all iteration rows', async () => {
    fns.storeGet.mockReturnValueOnce(mockRun);
    const res = await request(makeApp()).get('/api/benchmarks/r1/export?format=csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('benchmark-r1.csv');
    expect(res.text).toContain('Provider,Model,Iteration');
    expect(res.text).toContain('OpenAI');
    expect(res.text).toContain('gpt-4');
  });

  it('CSV escapes commas in error messages', async () => {
    fns.storeGet.mockReturnValueOnce({
      ...mockRun,
      results: {
        x: {
          provider: 'P',
          model: 'M',
          iterations: [
            {
              iteration: 0,
              responseTime: 0,
              firstTokenLatency: 0,
              tokensPerSecond: 0,
              inputTokens: 0,
              outputTokens: 0,
              reasoningTokens: 0,
              totalTokens: 0,
              estimatedCost: 0,
              success: false,
              error: 'fail, with, commas',
              errorCategory: 'unknown',
            },
          ],
          summary: {} as never,
        },
      },
    });
    const res = await request(makeApp()).get('/api/benchmarks/r1/export?format=csv');
    expect(res.text).toContain('"fail, with, commas"');
  });

  it('404 when run missing', async () => {
    fns.storeGet.mockReturnValueOnce(undefined);
    const res = await request(makeApp()).get('/api/benchmarks/absent/export');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/benchmarks/:id/stream — SSE', () => {
  it('404 when run missing', async () => {
    fns.storeGet.mockReturnValueOnce(undefined);
    const res = await request(makeApp()).get('/api/benchmarks/missing/stream');
    expect(res.status).toBe(404);
  });

  it('emits init then done for completed run', async () => {
    fns.storeGet.mockReturnValueOnce(mockRun);
    const res = await request(makeApp()).get('/api/benchmarks/r1/stream');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.text).toContain('"type":"init"');
    expect(res.text).toContain('"type":"done"');
  });
});
