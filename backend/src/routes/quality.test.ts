import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { QualityDataset, QualityRun } from '../types';

/**
 * Route-level tests for the quality API.
 *
 * The stores and the engine are mocked so these tests describe the HTTP
 * contract — validation, status codes, guard rails — without a database or a
 * network. `validate()` and `importDataset()` stay real, because the Zod schemas
 * and the import report are exactly what is worth pinning down here.
 */

const fns = vi.hoisted(() => ({
  list: vi.fn(),
  getDataset: vi.fn(),
  createDataset: vi.fn(),
  updateDataset: vi.fn(),
  deleteDataset: vi.fn(),
  listRuns: vi.fn(),
  getRun: vi.fn(),
  deleteRun: vi.fn(),
  createQualityRun: vi.fn(),
  executeQualityRun: vi.fn(),
  subscribeQualityRun: vi.fn(),
  cancelQualityRun: vi.fn(),
  providerGet: vi.fn(),
}));

vi.mock('../services/qualityDatasetStore', () => ({
  qualityDatasetStore: {
    list: fns.list,
    get: fns.getDataset,
    create: fns.createDataset,
    update: fns.updateDataset,
    delete: fns.deleteDataset,
  },
}));

vi.mock('../services/qualityRunStore', () => ({
  qualityRunStore: {
    list: fns.listRuns,
    get: fns.getRun,
    delete: fns.deleteRun,
  },
}));

vi.mock('../services/qualityEngine', () => ({
  createQualityRun: fns.createQualityRun,
  executeQualityRun: fns.executeQualityRun,
  subscribeQualityRun: fns.subscribeQualityRun,
  cancelQualityRun: fns.cancelQualityRun,
}));

vi.mock('../services/providerStore', () => ({
  providerStore: { get: fns.providerGet },
}));

import qualityRouter from './quality';

const app = express();
app.use(express.json());
app.use('/api/quality', qualityRouter);

const provider = {
  id: 'cfg',
  name: 'Test Provider',
  endpoint: 'http://example.invalid/v1',
  apiKey: 'encrypted',
  format: 'openai' as const,
  models: [
    {
      id: 'm1',
      name: 'gpt-4o',
      displayName: 'GPT-4o',
      contextSize: 128000,
      supportsVision: true,
      supportsTools: true,
      supportsStreaming: true,
      isActive: true,
    },
  ],
  createdAt: '',
  updatedAt: '',
};

function makeDataset(overrides: Partial<QualityDataset> = {}): QualityDataset {
  return {
    id: 'ds_user',
    name: 'My dataset',
    description: '',
    source: 'manual',
    samples: [{ id: 's1', input: 'q', expected: 'a', grader: 'exact' }],
    sampleCount: 1,
    tags: [],
    builtin: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  for (const fn of Object.values(fns)) fn.mockReset();
  fns.providerGet.mockReturnValue(provider);
  fns.executeQualityRun.mockResolvedValue(undefined);
});

describe('GET /api/quality/graders', () => {
  it('serves the grader catalog with its config fields', async () => {
    const res = await request(app).get('/api/quality/graders').expect(200);
    expect(res.body).toHaveLength(7);
    const jsonSchema = res.body.find((g: { type: string }) => g.type === 'json_schema');
    expect(jsonSchema.requiresExpected).toBe(false);
    expect(jsonSchema.configFields).toContain('schema');
  });
});

describe('datasets', () => {
  it('lists datasets', async () => {
    fns.list.mockReturnValue([{ id: 'ds_user', name: 'My dataset', sampleCount: 1 }]);
    const res = await request(app).get('/api/quality/datasets').expect(200);
    expect(res.body).toHaveLength(1);
  });

  it('404s on an unknown dataset', async () => {
    fns.getDataset.mockReturnValue(undefined);
    await request(app).get('/api/quality/datasets/nope').expect(404);
  });

  it('protects built-in datasets from modification and deletion', async () => {
    fns.getDataset.mockReturnValue(makeDataset({ builtin: true }));

    const put = await request(app).put('/api/quality/datasets/ds_user').send({ name: 'x' }).expect(403);
    expect(put.body.message).toContain('cannot be modified');

    const del = await request(app).delete('/api/quality/datasets/ds_user').expect(403);
    expect(del.body.message).toContain('cannot be deleted');

    expect(fns.updateDataset).not.toHaveBeenCalled();
    expect(fns.deleteDataset).not.toHaveBeenCalled();
  });

  it('deletes a user dataset', async () => {
    fns.getDataset.mockReturnValue(makeDataset());
    fns.deleteDataset.mockReturnValue(true);
    await request(app).delete('/api/quality/datasets/ds_user').expect(200);
    expect(fns.deleteDataset).toHaveBeenCalledWith('ds_user');
  });

  it('rejects a create with no samples', async () => {
    const res = await request(app).post('/api/quality/datasets').send({ name: 'Empty', samples: [] }).expect(400);
    expect(res.body.error).toBeTruthy();
  });

  it('creates a dataset', async () => {
    fns.createDataset.mockReturnValue(makeDataset());
    const res = await request(app)
      .post('/api/quality/datasets')
      .send({ name: 'My dataset', samples: [{ input: 'q', expected: 'a', grader: 'exact' }] })
      .expect(201);
    expect(res.body.id).toBe('ds_user');
  });
});

describe('POST /api/quality/datasets/import', () => {
  const payload = {
    name: 'Imported',
    text: '{"input":"2+2?","expected":"4","grader":"numeric_tolerance","graderConfig":{"tolerance":0}}\n{"input":"bad"}',
  };

  it('returns a dry-run report when persist is false', async () => {
    const res = await request(app)
      .post('/api/quality/datasets/import')
      .send({ ...payload, persist: false })
      .expect(200);

    expect(res.body.dataset).toBeNull();
    expect(res.body.preview.accepted).toBe(1);
    expect(res.body.preview.rejected).toBe(1);
    // The bad row is reported with its line number and reason.
    expect(res.body.preview.issues[0]).toMatchObject({ row: 2, level: 'error' });
    expect(fns.createDataset).not.toHaveBeenCalled();
  });

  it('persists the accepted rows', async () => {
    fns.createDataset.mockReturnValue(makeDataset({ id: 'ds_imported', source: 'import' }));
    const res = await request(app)
      .post('/api/quality/datasets/import')
      .send(payload)
      .expect(201);

    expect(res.body.dataset.id).toBe('ds_imported');
    const args = fns.createDataset.mock.calls[0][0];
    expect(args.samples).toHaveLength(1);
    expect(args.source).toBe('import');
  });

  it('refuses to persist when nothing survived validation', async () => {
    const res = await request(app)
      .post('/api/quality/datasets/import')
      .send({ name: 'Broken', text: '{"input":"a"}\n{"nope":1}' })
      .expect(400);
    expect(res.body.message).toContain('No valid samples');
    expect(res.body.preview.rejected).toBe(2);
  });

  it('returns 400 for an unreadable file', async () => {
    const res = await request(app)
      .post('/api/quality/datasets/import')
      .send({ name: 'Broken', text: 'foo,bar\n1,2' })
      .expect(400);
    expect(res.body.message).toContain('input');
  });
});

describe('POST /api/quality/estimate', () => {
  it('404s when the dataset is unknown', async () => {
    fns.getDataset.mockReturnValue(undefined);
    await request(app).post('/api/quality/estimate').send({ datasetId: 'nope', targets: ['cfg:gpt-4o'] }).expect(404);
  });

  it('returns per-target cost estimates with its assumptions spelled out', async () => {
    fns.getDataset.mockReturnValue(makeDataset());
    const res = await request(app)
      .post('/api/quality/estimate')
      .send({ datasetId: 'ds_user', targets: ['cfg:gpt-4o'], params: { maxTokens: 512 } })
      .expect(200);

    expect(res.body.totalRequests).toBe(1);
    expect(res.body.perTarget[0]).toMatchObject({ target: 'cfg:gpt-4o', resolvable: true });
    expect(res.body.perTarget[0].typicalCost).toBeGreaterThan(0);
    expect(res.body.perTarget[0].upperBoundCost).toBeGreaterThanOrEqual(res.body.perTarget[0].typicalCost);
    expect(res.body.assumptions.length).toBeGreaterThan(0);
  });

  it('marks an unresolvable target instead of inventing a price', async () => {
    fns.getDataset.mockReturnValue(makeDataset());
    fns.providerGet.mockReturnValue(undefined);
    const res = await request(app)
      .post('/api/quality/estimate')
      .send({ datasetId: 'ds_user', targets: ['ghost:model'] })
      .expect(200);
    expect(res.body.perTarget[0]).toMatchObject({ resolvable: false, typicalCost: null, upperBoundCost: null });
  });
});

describe('POST /api/quality/runs', () => {
  const run: QualityRun = {
    id: 'qr_1',
    name: 'Run',
    status: 'pending',
    datasetId: 'ds_user',
    datasetName: 'My dataset',
    datasetSnapshot: [{ id: 's1', input: 'q', expected: 'a', grader: 'exact' }],
    targets: ['cfg:gpt-4o'],
    targetLabels: { 'cfg:gpt-4o': 'Test Provider / GPT-4o' },
    params: { temperature: 0, maxTokens: 1024, concurrency: 4, repeats: 1 },
    results: {},
    progress: { completed: 0, total: 1 },
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  it('404s on an unknown dataset', async () => {
    fns.getDataset.mockReturnValue(undefined);
    await request(app).post('/api/quality/runs').send({ name: 'R', datasetId: 'nope', targets: ['cfg:gpt-4o'] }).expect(404);
  });

  it('rejects a target it cannot resolve before any tokens are spent', async () => {
    fns.getDataset.mockReturnValue(makeDataset());
    const res = await request(app)
      .post('/api/quality/runs')
      .send({ name: 'R', datasetId: 'ds_user', targets: ['cfg:not-a-model'] })
      .expect(400);
    expect(res.body.message).toContain('Unknown provider or model');
    expect(fns.createQualityRun).not.toHaveBeenCalled();
  });

  it('snapshots the dataset and starts the run', async () => {
    fns.getDataset.mockReturnValue(makeDataset());
    fns.createQualityRun.mockReturnValue(run);

    const res = await request(app)
      .post('/api/quality/runs')
      .send({ name: 'Run', datasetId: 'ds_user', targets: ['cfg:gpt-4o'], params: { temperature: 0, concurrency: 2 } })
      .expect(201);

    expect(res.body).toMatchObject({ id: 'qr_1', total: 1 });

    const args = fns.createQualityRun.mock.calls[0][0];
    expect(args.datasetSnapshot).toHaveLength(1);
    expect(args.targetLabels['cfg:gpt-4o']).toBe('Test Provider / GPT-4o');
    expect(fns.executeQualityRun).toHaveBeenCalledWith(run);
  });

  it('requires at least one target', async () => {
    await request(app).post('/api/quality/runs').send({ name: 'R', datasetId: 'ds_user', targets: [] }).expect(400);
  });
});

describe('run lifecycle guards', () => {
  const running: QualityRun = {
    id: 'qr_1',
    name: 'Run',
    status: 'running',
    datasetId: 'ds',
    datasetName: 'D',
    datasetSnapshot: [],
    targets: [],
    targetLabels: {},
    params: { temperature: 0, maxTokens: 1024, concurrency: 4, repeats: 1 },
    results: {},
    progress: { completed: 0, total: 0 },
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  it('refuses to delete a running run', async () => {
    fns.getRun.mockReturnValue(running);
    const res = await request(app).delete('/api/quality/runs/qr_1').expect(400);
    expect(res.body.message).toContain('Cannot delete a running run');
  });

  it('refuses to cancel a run that is not running', async () => {
    fns.getRun.mockReturnValue({ ...running, status: 'completed' });
    const res = await request(app).post('/api/quality/runs/qr_1/cancel').expect(400);
    expect(res.body.message).toContain('not running');
  });

  it('cancels a running run', async () => {
    fns.getRun.mockReturnValue(running);
    fns.cancelQualityRun.mockReturnValue(true);
    const res = await request(app).post('/api/quality/runs/qr_1/cancel').expect(200);
    expect(res.body.success).toBe(true);
  });
});

describe('GET /api/quality/runs/:id/export', () => {
  const completed: QualityRun = {
    id: 'qr_1',
    name: 'Run',
    status: 'completed',
    datasetId: 'ds',
    datasetName: 'D',
    datasetSnapshot: [{ id: 's1', input: 'q', expected: 'a', grader: 'exact' }],
    targets: ['cfg:gpt-4o'],
    targetLabels: { 'cfg:gpt-4o': 'Test Provider / GPT-4o' },
    params: { temperature: 0, maxTokens: 1024, concurrency: 4, repeats: 1 },
    results: {
      'cfg:gpt-4o': {
        target: 'cfg:gpt-4o',
        targetLabel: 'Test Provider / GPT-4o',
        model: 'gpt-4o',
        sampleCount: 1,
        passCount: 0,
        failCount: 0,
        errorCount: 1,
        passRate: null,
        avgScore: null,
        byCategory: [],
        avgResponseTime: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCost: 0,
        errorBreakdown: { timeout: 0, rate_limit: 0, api_error: 1, network: 0, empty_response: 0, unknown: 0 },
        usageEstimatedRatio: 0,
        samples: [
          {
            sampleId: 's1',
            index: 0,
            category: 'cat',
            grader: 'exact',
            status: 'error',
            score: null,
            detailKey: 'quality.grade.providerFailed',
            detail: 'provider call failed: 401',
            input: 'q',
            expected: 'a',
            output: '',
            inputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            responseTime: 0,
            estimatedCost: 0,
            error: 'unauthorized',
            errorCategory: 'api_error',
          },
        ],
      },
    },
    progress: { completed: 1, total: 1 },
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  it('exports a CSV whose rows preserve the error verdict', async () => {
    fns.getRun.mockReturnValue(completed);
    const res = await request(app).get('/api/quality/runs/qr_1/export?format=csv').expect(200);
    expect(res.headers['content-type']).toContain('text/csv');

    const lines = res.text.split('\n');
    expect(lines[0]).toContain('Status');
    expect(lines[1]).toContain('error');
    // Score must be empty for an error, not 0 — the CSV has to stay honest too.
    expect(lines[1].split(',')[7]).toBe('');
    expect(lines[1]).toContain('api_error');
  });

  it('embeds the measurement conditions in the JSON export', async () => {
    fns.getRun.mockReturnValue(completed);
    const res = await request(app).get('/api/quality/runs/qr_1/export').expect(200);
    expect(res.body.run.meta.params.temperature).toBe(0);
    expect(res.body.run.meta.graders).toEqual(['exact']);
    expect(res.body.run.meta.note).toContain('rule-based');
  });
});
