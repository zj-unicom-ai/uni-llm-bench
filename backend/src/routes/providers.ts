import { Router, Request, Response } from 'express';
import { providerStore } from '../services/providerStore';
import { testProviderConnection } from '../providers/adapter';
import { ProviderConfigInput } from '../types';
import { randomUUID } from 'node:crypto';
import { validate } from '../validation/middleware';
import { ProviderConfigInputSchema, ProviderConfigUpdateSchema, TestConnectionSchema } from '../validation/schemas';

const router = Router();

// GET /api/providers - List all providers (masked keys)
router.get('/', (_req: Request, res: Response) => {
  const providers = providerStore.getAll();
  res.json(providers.map((p) => providerStore.toResponse(p)));
});

// POST /api/providers - Create provider
router.post('/', validate(ProviderConfigInputSchema), (req: Request, res: Response) => {
  const { name, endpoint, apiKey, format, models } = req.body as ProviderConfigInput;

  const input: ProviderConfigInput = {
    name: name.trim(),
    endpoint: endpoint.trim().replace(/\/+$/, ''),
    apiKey: apiKey.trim(),
    format,
    models: models.map((m) => ({
      id: m.id || randomUUID(),
      name: m.name.trim(),
      displayName: m.displayName?.trim() || undefined,
      contextSize: m.contextSize || 4096,
      supportsVision: m.supportsVision || false,
      supportsTools: m.supportsTools || false,
      supportsStreaming: m.supportsStreaming ?? true,
      isActive: m.isActive ?? true,
      inputPrice: typeof m.inputPrice === 'number' ? m.inputPrice : undefined,
      outputPrice: typeof m.outputPrice === 'number' ? m.outputPrice : undefined,
      cacheReadPrice: typeof m.cacheReadPrice === 'number' ? m.cacheReadPrice : undefined,
      cacheWritePrice: typeof m.cacheWritePrice === 'number' ? m.cacheWritePrice : undefined,
    })),
  };

  try {
    const provider = providerStore.create(input);
    res.status(201).json(providerStore.toResponse(provider));
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to create provider';
    return res.status(400).json({ error: msg });
  }
});

// POST /api/providers/test-connection - Test with raw config (before saving)
router.post('/test-connection', validate(TestConnectionSchema), async (req: Request, res: Response) => {
  try {
    const { endpoint, apiKey, format, modelName } = req.body;

    const result = await testProviderConnection({
      endpoint: endpoint.trim().replace(/\/+$/, ''),
      apiKey: apiKey.trim(),
      format,
      modelName: modelName.trim(),
    });

    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Connection test failed';
    res.status(502).json({ error: 'Connection test failed', details: message });
  }
});

// GET /api/providers/:id - Get single provider
router.get('/:id', (req: Request, res: Response) => {
  const provider = providerStore.get(req.params.id);
  if (!provider) {
    return res.status(404).json({ error: 'Provider not found' });
  }
  res.json(providerStore.toResponse(provider));
});

// PUT /api/providers/:id - Update provider
router.put('/:id', validate(ProviderConfigUpdateSchema), (req: Request, res: Response) => {
  const existing = providerStore.get(req.params.id);
  if (!existing) {
    return res.status(404).json({ error: 'Provider not found' });
  }

  const { name, endpoint, apiKey, format, models } = req.body;

  const input: Partial<ProviderConfigInput> = {};
  if (name?.trim()) input.name = name.trim();
  if (endpoint?.trim()) input.endpoint = endpoint.trim().replace(/\/+$/, '');
  if (apiKey?.trim()) input.apiKey = apiKey.trim();
  if (format) input.format = format;
  if (models && Array.isArray(models) && models.length > 0) {
    input.models = models.map((m: Record<string, unknown>) => ({
      id: (m.id as string) || randomUUID(),
      name: ((m.name as string) || '').trim(),
      displayName: (m.displayName as string)?.trim() || undefined,
      contextSize: (m.contextSize as number) || 4096,
      supportsVision: (m.supportsVision as boolean) ?? false,
      supportsTools: (m.supportsTools as boolean) ?? false,
      supportsStreaming: (m.supportsStreaming as boolean) ?? true,
      isActive: (m.isActive as boolean) ?? true,
      inputPrice: typeof m.inputPrice === 'number' ? m.inputPrice : undefined,
      outputPrice: typeof m.outputPrice === 'number' ? m.outputPrice : undefined,
      cacheReadPrice: typeof m.cacheReadPrice === 'number' ? m.cacheReadPrice : undefined,
      cacheWritePrice: typeof m.cacheWritePrice === 'number' ? m.cacheWritePrice : undefined,
    }));
  }

  let updated;
  try {
    updated = providerStore.update(req.params.id, input);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to update provider';
    return res.status(400).json({ error: msg });
  }
  if (!updated) {
    return res.status(500).json({ error: 'Failed to update provider' });
  }

  res.json(providerStore.toResponse(updated));
});

// DELETE /api/providers/:id - Delete provider
router.delete('/:id', (req: Request, res: Response) => {
  const result = providerStore.delete(req.params.id);
  if (!result) {
    return res.status(404).json({ error: 'Provider not found' });
  }
  res.json({ success: true });
});

// POST /api/providers/:id/test - Test saved provider connection
router.post('/:id/test', async (req: Request, res: Response) => {
  const provider = providerStore.get(req.params.id);
  if (!provider) {
    return res.status(404).json({ error: 'Provider not found' });
  }

  const activeModels = provider.models.filter((m) => m.isActive !== false);
  const modelName = req.body.modelName || activeModels[0]?.name;
  if (!modelName) {
    return res.status(400).json({ error: 'No model specified' });
  }

  const apiKey = providerStore.getDecryptedApiKey(req.params.id);
  if (!apiKey) {
    return res.status(500).json({ error: 'Failed to decrypt API key' });
  }

  try {
    const result = await testProviderConnection({
      endpoint: provider.endpoint,
      apiKey,
      format: provider.format,
      modelName,
    });

    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Connection test failed';
    res.status(502).json({ error: 'Connection test failed', details: message });
  }
});

export default router;
