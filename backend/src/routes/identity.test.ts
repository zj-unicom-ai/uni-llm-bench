import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const fns = vi.hoisted(() => ({
  resolveProbeTarget: vi.fn(),
  runAllProbes: vi.fn(),
  toFingerprint: vi.fn(),
  buildRunRecord: vi.fn(),
  listBaselines: vi.fn(),
  getBaseline: vi.fn(),
  saveBaseline: vi.fn(),
  deleteBaseline: vi.fn(),
  saveRun: vi.fn(),
  listRuns: vi.fn(),
  getRun: vi.fn(),
  deleteRun: vi.fn(),
}));

vi.mock('../services/probeClient', () => ({ resolveProbeTarget: fns.resolveProbeTarget }));

vi.mock('../services/identityEngine', () => ({
  runAllProbes: fns.runAllProbes,
  toFingerprint: fns.toFingerprint,
  buildRunRecord: fns.buildRunRecord,
}));

vi.mock('../services/identityStore', () => ({
  identityStore: {
    listBaselines: fns.listBaselines,
    getBaseline: fns.getBaseline,
    saveBaseline: fns.saveBaseline,
    deleteBaseline: fns.deleteBaseline,
    saveRun: fns.saveRun,
    listRuns: fns.listRuns,
    getRun: fns.getRun,
    deleteRun: fns.deleteRun,
  },
}));

import identityRouter from './identity';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/identity', identityRouter);
  return app;
}

const app = makeApp();

const target = {
  providerKey: 'p1:gpt-4',
  configId: 'p1',
  providerName: 'OpenAI',
  modelName: 'gpt-4',
  endpoint: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  format: 'openai' as const,
};

const baseline = {
  id: 'b1',
  providerKey: 'p1:gpt-4',
  providerName: 'OpenAI',
  modelName: 'gpt-4',
  fingerprint: { 'tokenizer.en': 20 },
  capturedAt: '2026-09-01T00:00:00.000Z',
};

const runRecord = {
  id: 'r1',
  target: 'p1:gpt-4',
  targetLabel: 'OpenAI / gpt-4',
  baselineId: 'b1',
  baselineLabel: 'OpenAI / gpt-4',
  probes: [],
  verdict: 'consistent' as const,
  score: 100,
  hardGates: [],
  summary: { pass: 0, warn: 0, fail: 0, error: 0, skipped: 0 },
  createdAt: '2026-09-09T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/identity/probes', () => {
  it('returns the probe catalog used by the onboarding guide', async () => {
    const res = await request(app).get('/api/identity/probes');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0]).toHaveProperty('tier');
    expect(res.body[0]).toHaveProperty('cost');
    expect(res.body[0]).toHaveProperty('requiresBaseline');
  });
});

describe('POST /api/identity/baselines', () => {
  it('captures a fingerprint and returns 201', async () => {
    fns.resolveProbeTarget.mockReturnValue(target);
    fns.runAllProbes.mockResolvedValue([{ id: 'tokenizer.en', observed: 20 }]);
    fns.toFingerprint.mockReturnValue({ 'tokenizer.en': 20 });
    fns.saveBaseline.mockImplementation((b: unknown) => b);

    const res = await request(app).post('/api/identity/baselines').send({ providerKey: 'p1:gpt-4' });

    expect(res.status).toBe(201);
    expect(fns.saveBaseline).toHaveBeenCalledTimes(1);
    expect(res.body.baseline.providerKey).toBe('p1:gpt-4');
  });

  it('returns 404 for an unknown provider', async () => {
    fns.resolveProbeTarget.mockReturnValue(null);

    const res = await request(app).post('/api/identity/baselines').send({ providerKey: 'nope:model' });

    expect(res.status).toBe(404);
    expect(fns.saveBaseline).not.toHaveBeenCalled();
  });

  it('returns 500 and stores nothing when probing throws', async () => {
    fns.resolveProbeTarget.mockReturnValue(target);
    fns.runAllProbes.mockRejectedValue(new Error('boom'));

    const res = await request(app).post('/api/identity/baselines').send({ providerKey: 'p1:gpt-4' });

    expect(res.status).toBe(500);
    expect(res.body.message).toBe('boom');
    expect(fns.saveBaseline).not.toHaveBeenCalled();
  });

  it('rejects a missing provider key', async () => {
    const res = await request(app).post('/api/identity/baselines').send({});
    expect(res.status).toBe(400);
  });
});

describe('POST /api/identity/verify', () => {
  it('runs the comparison and returns 201', async () => {
    fns.resolveProbeTarget.mockReturnValue(target);
    fns.getBaseline.mockReturnValue(baseline);
    fns.buildRunRecord.mockResolvedValue(runRecord);
    fns.saveRun.mockImplementation((r: unknown) => r);

    const res = await request(app).post('/api/identity/verify').send({ target: 'p1:gpt-4', baselineId: 'b1' });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('completed');
    expect(fns.saveRun).toHaveBeenCalledTimes(1);
  });

  it('returns 404 when the target is unknown', async () => {
    fns.resolveProbeTarget.mockReturnValue(null);

    const res = await request(app).post('/api/identity/verify').send({ target: 'nope:model' });

    expect(res.status).toBe(404);
    expect(fns.saveRun).not.toHaveBeenCalled();
  });

  it('returns 404 when the referenced baseline does not exist', async () => {
    fns.resolveProbeTarget.mockReturnValue(target);
    fns.getBaseline.mockReturnValue(undefined);

    const res = await request(app).post('/api/identity/verify').send({ target: 'p1:gpt-4', baselineId: 'gone' });

    expect(res.status).toBe(404);
    expect(fns.saveRun).not.toHaveBeenCalled();
  });

  it('returns 500 and persists nothing when the run fails', async () => {
    fns.resolveProbeTarget.mockReturnValue(target);
    fns.getBaseline.mockReturnValue(baseline);
    fns.buildRunRecord.mockRejectedValue(new Error('probe explosion'));

    const res = await request(app).post('/api/identity/verify').send({ target: 'p1:gpt-4', baselineId: 'b1' });

    expect(res.status).toBe(500);
    expect(res.body.message).toBe('probe explosion');
    expect(fns.saveRun).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/identity/baselines/:id', () => {
  it('deletes an existing baseline', async () => {
    fns.deleteBaseline.mockReturnValue(true);
    const res = await request(app).delete('/api/identity/baselines/b1');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('returns 404 when the baseline is already gone', async () => {
    fns.deleteBaseline.mockReturnValue(false);
    const res = await request(app).delete('/api/identity/baselines/b1');
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/identity/runs/:id', () => {
  it('deletes an existing run', async () => {
    fns.deleteRun.mockReturnValue(true);
    const res = await request(app).delete('/api/identity/runs/r1');
    expect(res.status).toBe(200);
  });

  it('returns 404 when the run is missing', async () => {
    fns.deleteRun.mockReturnValue(false);
    const res = await request(app).delete('/api/identity/runs/r1');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/identity/runs/:id', () => {
  it('returns 404 for an unknown run', async () => {
    fns.getRun.mockReturnValue(undefined);
    const res = await request(app).get('/api/identity/runs/missing');
    expect(res.status).toBe(404);
  });

  it('returns the run when it exists', async () => {
    fns.getRun.mockReturnValue({ ...runRecord, status: 'completed' });
    const res = await request(app).get('/api/identity/runs/r1');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('r1');
  });
});
