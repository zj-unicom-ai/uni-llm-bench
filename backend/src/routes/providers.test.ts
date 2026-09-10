import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const fns = vi.hoisted(() => ({
  getAll: vi.fn(),
  get: vi.fn(),
  getDecryptedApiKey: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  toResponse: vi.fn(),
  testProviderConnection: vi.fn(),
}));

vi.mock('../services/providerStore', () => ({
  providerStore: {
    getAll: fns.getAll,
    get: fns.get,
    getDecryptedApiKey: fns.getDecryptedApiKey,
    create: fns.create,
    update: fns.update,
    delete: fns.delete,
    toResponse: fns.toResponse,
  },
}));

vi.mock('../providers/adapter', () => ({ testProviderConnection: fns.testProviderConnection }));

import providersRouter from './providers';

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use('/api/providers', providersRouter);
  return app;
}

const baseModel = {
  id: 'm1',
  name: 'gpt-4',
  displayName: 'GPT-4',
  contextSize: 8192,
  supportsVision: false,
  supportsTools: false,
  supportsStreaming: true,
  isActive: true,
};

const mockProvider = {
  id: 'p1',
  name: 'OpenAI',
  endpoint: 'https://api.example.com/v1',
  apiKey: 'enc-key',
  format: 'openai' as const,
  models: [baseModel],
  createdAt: '2026-05-15T00:00:00Z',
  updatedAt: '2026-05-15T00:00:00Z',
};
const maskedResp = { ...mockProvider, apiKeyMasked: 'sk-****' };
delete (maskedResp as Record<string, unknown>).apiKey;

beforeEach(() => {
  vi.clearAllMocks();
  fns.toResponse.mockImplementation((p) => ({ ...p, apiKeyMasked: 'sk-****' }));
});

describe('GET /api/providers', () => {
  it('returns list with toResponse-mapped entries', async () => {
    fns.getAll.mockReturnValueOnce([mockProvider]);
    const res = await request(makeApp()).get('/api/providers');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].apiKeyMasked).toBe('sk-****');
  });

  it('returns empty array when no providers', async () => {
    fns.getAll.mockReturnValueOnce([]);
    const res = await request(makeApp()).get('/api/providers');
    expect(res.body).toEqual([]);
  });
});

describe('GET /api/providers/:id', () => {
  it('returns 200 with provider', async () => {
    fns.get.mockReturnValueOnce(mockProvider);
    const res = await request(makeApp()).get('/api/providers/p1');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('p1');
  });

  it('returns 404 for unknown id', async () => {
    fns.get.mockReturnValueOnce(undefined);
    const res = await request(makeApp()).get('/api/providers/missing');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Provider not found');
  });
});

describe('POST /api/providers — create', () => {
  it('201 on valid payload, strips trailing slashes from endpoint', async () => {
    fns.create.mockReturnValueOnce(mockProvider);
    const res = await request(makeApp())
      .post('/api/providers')
      .send({
        name: 'OpenAI',
        endpoint: 'https://api.example.com/v1/////',
        apiKey: 'sk-test',
        format: 'openai',
        models: [{ name: 'gpt-4', contextSize: 8192, supportsVision: false, supportsTools: false }],
      });
    expect(res.status).toBe(201);
    expect(fns.create).toHaveBeenCalledOnce();
    const input = fns.create.mock.calls[0][0];
    expect(input.name).toBe('OpenAI');
    expect(input.endpoint).toBe('https://api.example.com/v1'); // trailing slashes stripped
    expect(input.apiKey).toBe('sk-test');
  });

  it('400 when name missing (validation)', async () => {
    const res = await request(makeApp())
      .post('/api/providers')
      .send({
        endpoint: 'https://x',
        apiKey: 'k',
        format: 'openai',
        models: [{ name: 'gpt-4', contextSize: 8192, supportsVision: false, supportsTools: false }],
      });
    expect(res.status).toBe(400);
  });

  it('400 when models array is empty', async () => {
    const res = await request(makeApp())
      .post('/api/providers')
      .send({ name: 'X', endpoint: 'https://x', apiKey: 'k', format: 'openai', models: [] });
    expect(res.status).toBe(400);
  });

  it('400 when format is invalid', async () => {
    const res = await request(makeApp())
      .post('/api/providers')
      .send({
        name: 'X',
        endpoint: 'https://x',
        apiKey: 'k',
        format: 'not-a-format',
        models: [{ name: 'm', contextSize: 8192, supportsVision: false, supportsTools: false }],
      });
    expect(res.status).toBe(400);
  });

  it('assigns default supportsStreaming=true and isActive=true', async () => {
    fns.create.mockReturnValueOnce(mockProvider);
    await request(makeApp())
      .post('/api/providers')
      .send({
        name: 'X',
        endpoint: 'https://x',
        apiKey: 'k',
        format: 'openai',
        models: [{ name: 'm', contextSize: 8192, supportsVision: false, supportsTools: false }],
      });
    const input = fns.create.mock.calls[0][0];
    expect(input.models[0].supportsStreaming).toBe(true);
    expect(input.models[0].isActive).toBe(true);
  });

  it('preserves explicit isActive=false', async () => {
    fns.create.mockReturnValueOnce(mockProvider);
    await request(makeApp())
      .post('/api/providers')
      .send({
        name: 'X',
        endpoint: 'https://x',
        apiKey: 'k',
        format: 'openai',
        models: [{ name: 'm', contextSize: 8192, supportsVision: false, supportsTools: false, isActive: false }],
      });
    expect(fns.create.mock.calls[0][0].models[0].isActive).toBe(false);
  });
});

describe('PUT /api/providers/:id — update', () => {
  it('200 on success and only updates provided fields', async () => {
    fns.get.mockReturnValue(mockProvider);
    fns.update.mockReturnValueOnce({ ...mockProvider, name: 'renamed' });
    const res = await request(makeApp()).put('/api/providers/p1').send({ name: 'renamed' });
    expect(res.status).toBe(200);
    const input = fns.update.mock.calls[0][1];
    expect(input.name).toBe('renamed');
    expect(input.endpoint).toBeUndefined();
  });

  it('404 when provider missing', async () => {
    fns.get.mockReturnValueOnce(undefined);
    const res = await request(makeApp()).put('/api/providers/absent').send({ name: 'x' });
    expect(res.status).toBe(404);
  });

  it('500 when store.update returns undefined unexpectedly', async () => {
    fns.get.mockReturnValue(mockProvider);
    fns.update.mockReturnValueOnce(undefined);
    const res = await request(makeApp()).put('/api/providers/p1').send({ name: 'x' });
    expect(res.status).toBe(500);
  });
});

describe('DELETE /api/providers/:id', () => {
  it('200 on success', async () => {
    fns.delete.mockReturnValueOnce(true);
    const res = await request(makeApp()).delete('/api/providers/p1');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('404 when provider does not exist', async () => {
    fns.delete.mockReturnValueOnce(false);
    const res = await request(makeApp()).delete('/api/providers/absent');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/providers/test-connection — unsaved', () => {
  it('200 with the test result', async () => {
    fns.testProviderConnection.mockResolvedValueOnce({
      success: true,
      latencyMs: 100,
      ttftMs: 50,
      outputTokens: 10,
      responseText: 'ok',
    });
    const res = await request(makeApp())
      .post('/api/providers/test-connection')
      .send({ endpoint: 'https://x  ', apiKey: ' k ', format: 'openai', modelName: 'gpt-4' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // Trimming applied
    const args = fns.testProviderConnection.mock.calls[0][0];
    expect(args.endpoint).toBe('https://x');
    expect(args.apiKey).toBe('k');
  });

  it('400 when modelName invalid (validation)', async () => {
    const res = await request(makeApp())
      .post('/api/providers/test-connection')
      .send({ endpoint: 'https://x', apiKey: 'k', format: 'openai' }); // missing modelName
    expect(res.status).toBe(400);
  });

  it('502 when testProviderConnection throws', async () => {
    fns.testProviderConnection.mockRejectedValueOnce(new Error('network'));
    const res = await request(makeApp())
      .post('/api/providers/test-connection')
      .send({ endpoint: 'https://x', apiKey: 'k', format: 'openai', modelName: 'gpt-4' });
    expect(res.status).toBe(502);
    expect(res.body.details).toContain('network');
  });
});

describe('POST /api/providers/:id/test — saved', () => {
  it('200 with test result for saved provider', async () => {
    fns.get.mockReturnValueOnce(mockProvider);
    fns.getDecryptedApiKey.mockReturnValueOnce('sk-decrypted');
    fns.testProviderConnection.mockResolvedValueOnce({
      success: true,
      latencyMs: 200,
      ttftMs: 50,
      outputTokens: 10,
      responseText: 'pong',
    });
    const res = await request(makeApp()).post('/api/providers/p1/test').send({ modelName: 'gpt-4' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('uses first active model when modelName not provided', async () => {
    fns.get.mockReturnValueOnce({
      ...mockProvider,
      models: [
        { ...baseModel, name: 'inactive-one', isActive: false },
        { ...baseModel, id: 'm-active', name: 'active-one', isActive: true },
      ],
    });
    fns.getDecryptedApiKey.mockReturnValueOnce('sk-decrypted');
    fns.testProviderConnection.mockResolvedValueOnce({
      success: true,
      latencyMs: 50,
      ttftMs: 10,
      outputTokens: 1,
      responseText: '',
    });
    await request(makeApp()).post('/api/providers/p1/test').send({});
    expect(fns.testProviderConnection.mock.calls[0][0].modelName).toBe('active-one');
  });

  it('404 when provider not found', async () => {
    fns.get.mockReturnValueOnce(undefined);
    const res = await request(makeApp()).post('/api/providers/absent/test').send({});
    expect(res.status).toBe(404);
  });

  it('400 when no active models and no modelName provided', async () => {
    fns.get.mockReturnValueOnce({ ...mockProvider, models: [{ ...baseModel, isActive: false }] });
    const res = await request(makeApp()).post('/api/providers/p1/test').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No model specified/);
  });

  it('500 when api key cannot be decrypted', async () => {
    fns.get.mockReturnValueOnce(mockProvider);
    fns.getDecryptedApiKey.mockReturnValueOnce(undefined);
    const res = await request(makeApp()).post('/api/providers/p1/test').send({ modelName: 'gpt-4' });
    expect(res.status).toBe(500);
  });

  it('502 when testProviderConnection throws', async () => {
    fns.get.mockReturnValueOnce(mockProvider);
    fns.getDecryptedApiKey.mockReturnValueOnce('k');
    fns.testProviderConnection.mockRejectedValueOnce(new Error('connection refused'));
    const res = await request(makeApp()).post('/api/providers/p1/test').send({ modelName: 'gpt-4' });
    expect(res.status).toBe(502);
  });
});
