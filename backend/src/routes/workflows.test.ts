import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const fns = vi.hoisted(() => ({
  wfCreate: vi.fn(),
  wfGet: vi.fn(),
  wfGetAll: vi.fn(),
  wfUpdate: vi.fn(),
  wfDelete: vi.fn(),
  executeWorkflow: vi.fn(),
  subscribeWorkflow: vi.fn(),
  cancelWorkflow: vi.fn(),
  backfillTokenStats: vi.fn((wf) => wf),
  tplGetAll: vi.fn(() => [
    {
      id: 'builtin:Quick test',
      name: 'Quick test',
      builtin: true,
      description: '',
      tasks: [],
      options: { stopOnFailure: true, cooldownBetweenTasks: 0 },
    },
  ]),
  storeGet: vi.fn(),
  providerGet: vi.fn(),
}));

vi.mock('../services/workflowStore', () => ({
  workflowStore: {
    create: fns.wfCreate,
    get: fns.wfGet,
    getAll: fns.wfGetAll,
    update: fns.wfUpdate,
    delete: fns.wfDelete,
  },
}));

vi.mock('../services/workflowEngine', () => ({
  executeWorkflow: fns.executeWorkflow,
  subscribeWorkflow: fns.subscribeWorkflow,
  cancelWorkflow: fns.cancelWorkflow,
  backfillTokenStats: fns.backfillTokenStats,
}));

vi.mock('../services/workflowTemplateStore', () => ({ workflowTemplateStore: { getAll: fns.tplGetAll } }));
vi.mock('../services/store', () => ({ store: { get: fns.storeGet } }));
vi.mock('../services/providerStore', () => ({ providerStore: { get: fns.providerGet } }));

import workflowsRouter from './workflows';

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use('/api/workflows', workflowsRouter);
  return app;
}

const baseWorkflow = {
  id: 'wf1',
  name: 'My Workflow',
  description: '',
  status: 'completed' as const,
  providers: ['p1:gpt-4'],
  apiKeys: { 'p1:gpt-4': 'sk-secret' },
  tasks: [{ id: 't1', name: 'Task 1', order: 0, config: {} }],
  options: { stopOnFailure: true, cooldownBetweenTasks: 3000 },
  taskResults: [{ taskId: 't1', taskName: 'Task 1', benchmarkRunId: 'r1', status: 'completed' as const }],
  createdAt: '2026-05-15T00:00:00Z',
  updatedAt: '2026-05-15T00:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  fns.executeWorkflow.mockResolvedValue(undefined);
  fns.backfillTokenStats.mockImplementation((wf) => wf);
});

describe('POST /api/workflows — create', () => {
  beforeEach(() => {
    fns.providerGet.mockReturnValue({
      id: 'p1',
      name: 'OpenAI',
      models: [{ id: 'm1', name: 'gpt-4', displayName: 'GPT-4' }],
    });
    fns.wfCreate.mockImplementation((wf) => wf);
  });

  it('201 on valid payload, starts execution async', async () => {
    const res = await request(makeApp())
      .post('/api/workflows')
      .send({
        name: 'Test',
        providers: ['p1:gpt-4'],
        apiKeys: { 'p1:gpt-4': 'k' },
        tasks: [
          {
            name: 'Quick',
            config: {
              prompt: 'hi',
              maxTokens: 100,
              concurrency: 1,
              iterations: 1,
            },
          },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.taskCount).toBe(1);
    expect(res.body.id).toMatch(/^wf_/);
    expect(fns.executeWorkflow).toHaveBeenCalled();
  });

  it('400 when name missing', async () => {
    const res = await request(makeApp())
      .post('/api/workflows')
      .send({
        providers: ['p1:gpt-4'],
        tasks: [{ name: 'x', config: { prompt: 'p', maxTokens: 1, concurrency: 1, iterations: 1 } }],
      });
    expect(res.status).toBe(400);
  });

  it('400 when providers array empty', async () => {
    const res = await request(makeApp())
      .post('/api/workflows')
      .send({
        name: 'x',
        providers: [],
        tasks: [{ name: 'x', config: { prompt: 'p', maxTokens: 1, concurrency: 1, iterations: 1 } }],
      });
    expect(res.status).toBe(400);
  });

  it('400 when tasks array empty', async () => {
    const res = await request(makeApp())
      .post('/api/workflows')
      .send({ name: 'x', providers: ['p1:gpt-4'], tasks: [] });
    expect(res.status).toBe(400);
  });

  it('400 when provider id is unknown and not legacy/composite', async () => {
    fns.providerGet.mockReturnValueOnce(undefined);
    const res = await request(makeApp())
      .post('/api/workflows')
      .send({
        name: 'x',
        providers: ['absent'],
        tasks: [{ name: 'x', config: { prompt: 'p', maxTokens: 1, concurrency: 1, iterations: 1 } }],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('absent');
  });

  it('accepts legacy provider id without lookup', async () => {
    const res = await request(makeApp())
      .post('/api/workflows')
      .send({
        name: 'Legacy',
        providers: ['openai'], // legacy
        tasks: [{ name: 'x', config: { prompt: 'p', maxTokens: 1, concurrency: 1, iterations: 1 } }],
      });
    expect(res.status).toBe(201);
  });

  it('builds providerLabels from composite key', async () => {
    await request(makeApp())
      .post('/api/workflows')
      .send({
        name: 'X',
        providers: ['p1:gpt-4'],
        tasks: [{ name: 'x', config: { prompt: 'p', maxTokens: 1, concurrency: 1, iterations: 1 } }],
      });
    const created = fns.wfCreate.mock.calls[0][0];
    expect(created.providerLabels['p1:gpt-4']).toBe('OpenAI/GPT-4');
  });

  it('clamps maxTokens to 32000 max', async () => {
    await request(makeApp())
      .post('/api/workflows')
      .send({
        name: 'X',
        providers: ['p1:gpt-4'],
        tasks: [{ name: 'x', config: { prompt: 'p', maxTokens: 999999, concurrency: 1, iterations: 1 } }],
      });
    expect(fns.wfCreate.mock.calls[0][0].tasks[0].config.maxTokens).toBe(32000);
  });

  it('default options.stopOnFailure=true when not provided', async () => {
    await request(makeApp())
      .post('/api/workflows')
      .send({
        name: 'X',
        providers: ['p1:gpt-4'],
        tasks: [{ name: 'x', config: { prompt: 'p', maxTokens: 1, concurrency: 1, iterations: 1 } }],
      });
    expect(fns.wfCreate.mock.calls[0][0].options.stopOnFailure).toBe(true);
  });

  it('marks workflow as failed asynchronously if executeWorkflow throws', async () => {
    fns.executeWorkflow.mockRejectedValueOnce(new Error('boom'));
    fns.wfGet.mockReturnValueOnce({ ...baseWorkflow, status: 'running' });
    await request(makeApp())
      .post('/api/workflows')
      .send({
        name: 'X',
        providers: ['p1:gpt-4'],
        tasks: [{ name: 'x', config: { prompt: 'p', maxTokens: 1, concurrency: 1, iterations: 1 } }],
      });
    // The error handler is async; wait a tick
    await new Promise((r) => setTimeout(r, 10));
    expect(fns.wfUpdate).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ status: 'failed' }));
  });
});

describe('GET /api/workflows', () => {
  it('returns all workflows without apiKeys', async () => {
    fns.wfGetAll.mockReturnValueOnce([baseWorkflow]);
    const res = await request(makeApp()).get('/api/workflows');
    expect(res.status).toBe(200);
    expect(res.body[0].apiKeys).toBeUndefined();
    expect(res.body[0].id).toBe('wf1');
  });
});

describe('GET /api/workflows/active', () => {
  it('returns the running workflow', async () => {
    fns.wfGetAll.mockReturnValueOnce([baseWorkflow, { ...baseWorkflow, id: 'wf2', status: 'running' }]);
    const res = await request(makeApp()).get('/api/workflows/active');
    expect(res.body.id).toBe('wf2');
    expect(res.body.apiKeys).toBeUndefined();
  });

  it('returns null when no running workflow', async () => {
    fns.wfGetAll.mockReturnValueOnce([baseWorkflow]); // status='completed'
    const res = await request(makeApp()).get('/api/workflows/active');
    expect(res.body).toBeNull();
  });
});

describe('GET /api/workflows/templates', () => {
  it('returns the templates list', async () => {
    const res = await request(makeApp()).get('/api/workflows/templates');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // Built-in templates are returned with a `builtin:` id prefix and `builtin: true`
    const builtin = res.body.find((t: { id: string }) => t.id === 'builtin:Quick test');
    expect(builtin).toBeDefined();
    expect(builtin.name).toBe('Quick test');
    expect(builtin.builtin).toBe(true);
  });
});

describe('GET /api/workflows/:id', () => {
  it('200 with safe workflow (no apiKeys)', async () => {
    fns.wfGet.mockReturnValueOnce(baseWorkflow);
    const res = await request(makeApp()).get('/api/workflows/wf1');
    expect(res.status).toBe(200);
    expect(res.body.apiKeys).toBeUndefined();
    expect(fns.backfillTokenStats).toHaveBeenCalled();
  });

  it('404 when not found', async () => {
    fns.wfGet.mockReturnValueOnce(undefined);
    const res = await request(makeApp()).get('/api/workflows/missing');
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/workflows/:id', () => {
  it('200 with updated name', async () => {
    fns.wfGet.mockReturnValueOnce(baseWorkflow);
    fns.wfUpdate.mockReturnValueOnce({ ...baseWorkflow, name: 'Renamed' });
    const res = await request(makeApp()).patch('/api/workflows/wf1').send({ name: 'Renamed' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Renamed');
    expect(res.body.apiKeys).toBeUndefined();
  });

  it('400 when no valid fields provided', async () => {
    fns.wfGet.mockReturnValueOnce(baseWorkflow);
    const res = await request(makeApp()).patch('/api/workflows/wf1').send({});
    expect(res.status).toBe(400);
  });

  it('404 when workflow not found', async () => {
    fns.wfGet.mockReturnValueOnce(undefined);
    const res = await request(makeApp()).patch('/api/workflows/absent').send({ name: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/workflows/:id/cancel', () => {
  it('cancels a running workflow', async () => {
    fns.wfGet.mockReturnValueOnce({ ...baseWorkflow, status: 'running' });
    fns.cancelWorkflow.mockReturnValueOnce(true);
    const res = await request(makeApp()).post('/api/workflows/wf1/cancel');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('400 when workflow is not running', async () => {
    fns.wfGet.mockReturnValueOnce({ ...baseWorkflow, status: 'completed' });
    const res = await request(makeApp()).post('/api/workflows/wf1/cancel');
    expect(res.status).toBe(400);
  });

  it('404 when workflow not found', async () => {
    fns.wfGet.mockReturnValueOnce(undefined);
    const res = await request(makeApp()).post('/api/workflows/absent/cancel');
    expect(res.status).toBe(404);
  });

  it('returns success=false when already cancelled', async () => {
    fns.wfGet.mockReturnValueOnce({ ...baseWorkflow, status: 'running' });
    fns.cancelWorkflow.mockReturnValueOnce(false);
    const res = await request(makeApp()).post('/api/workflows/wf1/cancel');
    expect(res.body.success).toBe(false);
  });
});

describe('GET /api/workflows/:id/export', () => {
  it('returns JSON by default with workflow + benchmarkRuns', async () => {
    fns.wfGet.mockReturnValueOnce(baseWorkflow);
    fns.storeGet.mockReturnValueOnce({ id: 'r1', results: {} });
    const res = await request(makeApp()).get('/api/workflows/wf1/export');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body.workflow.id).toBe('wf1');
    expect(res.body.benchmarkRuns).toBeDefined();
    expect(res.body.workflow.apiKeys).toBeUndefined();
  });

  it('returns CSV when format=csv', async () => {
    fns.wfGet.mockReturnValueOnce(baseWorkflow);
    fns.storeGet.mockReturnValueOnce({
      results: {
        openai: {
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
              totalTokens: 15,
              estimatedCost: 0.001,
              success: true,
            },
          ],
        },
      },
    });
    const res = await request(makeApp()).get('/api/workflows/wf1/export?format=csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('TaskName,TaskOrder');
    expect(res.text).toContain('OpenAI');
    expect(res.text).toContain('gpt-4');
  });

  it('404 when workflow not found', async () => {
    fns.wfGet.mockReturnValueOnce(undefined);
    const res = await request(makeApp()).get('/api/workflows/absent/export');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/workflows/:id/duplicate', () => {
  it('201 with new workflow id', async () => {
    fns.wfGet.mockReturnValueOnce(baseWorkflow);
    fns.wfCreate.mockImplementation((wf) => wf);
    const res = await request(makeApp()).post('/api/workflows/wf1/duplicate');
    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(/^wf_/);
    expect(res.body.id).not.toBe('wf1');
    expect(res.body.name).toContain('(copy)');
  });

  it('404 when source not found', async () => {
    fns.wfGet.mockReturnValueOnce(undefined);
    const res = await request(makeApp()).post('/api/workflows/absent/duplicate');
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/workflows/:id', () => {
  it('200 on success', async () => {
    fns.wfGet.mockReturnValueOnce({ ...baseWorkflow, status: 'completed' });
    fns.wfDelete.mockReturnValueOnce(true);
    const res = await request(makeApp()).delete('/api/workflows/wf1');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('400 when workflow is running', async () => {
    fns.wfGet.mockReturnValueOnce({ ...baseWorkflow, status: 'running' });
    const res = await request(makeApp()).delete('/api/workflows/wf1');
    expect(res.status).toBe(400);
    expect(fns.wfDelete).not.toHaveBeenCalled();
  });

  it('404 when not found', async () => {
    fns.wfGet.mockReturnValueOnce(undefined);
    const res = await request(makeApp()).delete('/api/workflows/absent');
    expect(res.status).toBe(404);
  });
});
