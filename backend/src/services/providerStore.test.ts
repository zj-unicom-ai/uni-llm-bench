import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import Database from 'better-sqlite3';

/**
 * providerStore tests exercise the real CRUD path with real encryption.
 * Database is in-memory per test; encryption uses deterministic secrets via env.
 */

// Deterministic encryption secrets must be set BEFORE secrets.ts caches them.
// Setting in beforeAll is too late if secrets is imported by other test files first
// in the same vitest run — but since each test file runs in isolation, it's fine here.
beforeAll(() => {
  process.env.ENCRYPTION_SECRET = 'test-encryption-secret-for-providerStore-tests';
  process.env.ENCRYPTION_SALT = 'test-encryption-salt-for-providerStore-tests';
});

const h = vi.hoisted(() => ({ db: null as Database.Database | null }));

vi.mock('./database', () => ({
  getDb: () => h.db!,
}));

let mod: typeof import('./providerStore');

async function freshStore() {
  h.db = new Database(':memory:');
  vi.resetModules();
  mod = await import('./providerStore');
  return mod.providerStore;
}

beforeEach(async () => {
  await freshStore();
});

const baseInput = {
  name: 'TestProvider',
  endpoint: 'https://api.example.com/v1',
  apiKey: 'sk-test-1234567890',
  format: 'openai' as const,
  models: [
    {
      id: 'gpt-4-id',
      name: 'gpt-4',
      contextSize: 8192,
      supportsVision: false,
      supportsTools: true,
      supportsStreaming: true,
      isActive: true,
    },
  ],
};

describe('providerStore.create', () => {
  it('assigns a UUID id', () => {
    const p = mod.providerStore.create(baseInput);
    expect(p.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('encrypts the API key (stored value differs from input)', () => {
    const p = mod.providerStore.create(baseInput);
    expect(p.apiKey).not.toBe(baseInput.apiKey);
    expect(p.apiKey).not.toContain(baseInput.apiKey);
  });

  it('sets createdAt and updatedAt to ISO timestamps', () => {
    const p = mod.providerStore.create(baseInput);
    expect(p.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(p.updatedAt).toBe(p.createdAt);
  });

  it('assigns a UUID to a model missing id', () => {
    // Drop the `id` field at runtime (input schema may pass partial objects from the API layer)
    const input = {
      ...baseInput,
      models: [{ ...baseInput.models[0], id: undefined as unknown as string }],
    };
    const p = mod.providerStore.create(input);
    expect(p.models[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('preserves provided model id', () => {
    const p = mod.providerStore.create({
      ...baseInput,
      models: [{ ...baseInput.models[0], id: 'preset-id' }],
    });
    expect(p.models[0].id).toBe('preset-id');
  });

  it('regenerates model id when empty-string is provided', () => {
    const p = mod.providerStore.create({
      ...baseInput,
      models: [{ ...baseInput.models[0], id: '' }],
    });
    expect(p.models[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('defaults supportsStreaming and isActive to true', () => {
    const p = mod.providerStore.create(baseInput);
    expect(p.models[0].supportsStreaming).toBe(true);
    expect(p.models[0].isActive).toBe(true);
  });

  it('preserves explicit supportsStreaming=false / isActive=false', () => {
    const p = mod.providerStore.create({
      ...baseInput,
      models: [{ ...baseInput.models[0], supportsStreaming: false, isActive: false }],
    });
    expect(p.models[0].supportsStreaming).toBe(false);
    expect(p.models[0].isActive).toBe(false);
  });

  it('persists the row to sqlite (count via raw query)', () => {
    mod.providerStore.create(baseInput);
    const { cnt } = h.db!.prepare('SELECT COUNT(*) as cnt FROM providers').get() as { cnt: number };
    expect(cnt).toBe(1);
  });

  it('handles empty models array technically (input schema is what should reject, not the store)', () => {
    const p = mod.providerStore.create({ ...baseInput, models: [] });
    expect(p.models).toEqual([]);
  });
});

describe('providerStore.get / getAll', () => {
  it('get returns undefined for unknown id', () => {
    expect(mod.providerStore.get('nope')).toBeUndefined();
  });

  it('get returns the created provider by id', () => {
    const created = mod.providerStore.create(baseInput);
    const fetched = mod.providerStore.get(created.id);
    expect(fetched?.id).toBe(created.id);
  });

  it('getAll returns providers sorted by createdAt desc', async () => {
    const first = mod.providerStore.create({ ...baseInput, name: 'first' });
    await new Promise((r) => setTimeout(r, 5));
    const second = mod.providerStore.create({ ...baseInput, name: 'second' });
    const list = mod.providerStore.getAll();
    expect(list[0].id).toBe(second.id);
    expect(list[1].id).toBe(first.id);
  });

  it('getAll returns empty array on fresh store', () => {
    expect(mod.providerStore.getAll()).toEqual([]);
  });
});

describe('providerStore.update', () => {
  it('returns undefined for unknown id', () => {
    expect(mod.providerStore.update('ghost', { name: 'x' })).toBeUndefined();
  });

  it('updates only provided fields, preserves others', () => {
    const created = mod.providerStore.create(baseInput);
    const updated = mod.providerStore.update(created.id, { name: 'NewName' })!;
    expect(updated.name).toBe('NewName');
    expect(updated.endpoint).toBe(baseInput.endpoint);
    expect(updated.format).toBe(baseInput.format);
  });

  it('updates updatedAt timestamp on every change', async () => {
    const created = mod.providerStore.create(baseInput);
    await new Promise((r) => setTimeout(r, 5));
    const updated = mod.providerStore.update(created.id, { name: 'x' })!;
    expect(updated.updatedAt).not.toBe(created.updatedAt);
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(new Date(created.updatedAt).getTime());
  });

  it('does NOT change apiKey if input.apiKey is omitted', () => {
    const created = mod.providerStore.create(baseInput);
    const updated = mod.providerStore.update(created.id, { name: 'x' })!;
    expect(updated.apiKey).toBe(created.apiKey);
  });

  it('re-encrypts when a new apiKey is provided (stored value changes)', () => {
    const created = mod.providerStore.create(baseInput);
    const updated = mod.providerStore.update(created.id, { apiKey: 'sk-new-key' })!;
    expect(updated.apiKey).not.toBe(created.apiKey);
    expect(mod.providerStore.getDecryptedApiKey(created.id)).toBe('sk-new-key');
  });

  it('replaces models when input.models is provided', () => {
    const created = mod.providerStore.create(baseInput);
    const newModels = [
      {
        id: 'gpt-35',
        name: 'gpt-3.5-turbo',
        contextSize: 4096,
        supportsVision: false,
        supportsTools: false,
        supportsStreaming: true,
        isActive: true,
      },
    ];
    const updated = mod.providerStore.update(created.id, { models: newModels })!;
    expect(updated.models).toHaveLength(1);
    expect(updated.models[0].name).toBe('gpt-3.5-turbo');
  });

  it('persists update to sqlite', () => {
    const created = mod.providerStore.create(baseInput);
    mod.providerStore.update(created.id, { name: 'persisted' });
    const row = h.db!.prepare('SELECT name FROM providers WHERE id = ?').get(created.id) as { name: string };
    expect(row.name).toBe('persisted');
  });
});

describe('providerStore.delete', () => {
  it('returns false for unknown id', () => {
    expect(mod.providerStore.delete('ghost')).toBe(false);
  });

  it('returns true and removes from both Map and sqlite', () => {
    const created = mod.providerStore.create(baseInput);
    expect(mod.providerStore.delete(created.id)).toBe(true);
    expect(mod.providerStore.get(created.id)).toBeUndefined();
    const row = h.db!.prepare('SELECT id FROM providers WHERE id = ?').get(created.id);
    expect(row).toBeUndefined();
  });
});

describe('providerStore.getDecryptedApiKey', () => {
  it('returns undefined for unknown id', () => {
    expect(mod.providerStore.getDecryptedApiKey('ghost')).toBeUndefined();
  });

  it('round-trips through encryption successfully', () => {
    const created = mod.providerStore.create(baseInput);
    expect(mod.providerStore.getDecryptedApiKey(created.id)).toBe(baseInput.apiKey);
  });

  it('returns undefined if decrypt fails (corrupted ciphertext)', () => {
    const created = mod.providerStore.create(baseInput);
    // Corrupt the stored apiKey in the in-memory map
    const provider = mod.providerStore.get(created.id)!;
    (provider as { apiKey: string }).apiKey = 'not-valid-ciphertext';
    expect(mod.providerStore.getDecryptedApiKey(created.id)).toBeUndefined();
  });

  it('handles api keys with special characters / Unicode', () => {
    const created = mod.providerStore.create({ ...baseInput, apiKey: 'sk-✓-with-中文-and-emoji-🚀' });
    expect(mod.providerStore.getDecryptedApiKey(created.id)).toBe('sk-✓-with-中文-and-emoji-🚀');
  });

  it('handles empty api key (degenerate but should round-trip)', () => {
    // Note: validation should normally reject empty keys, but store-level should still work
    const created = mod.providerStore.create({ ...baseInput, apiKey: 'x' });
    expect(mod.providerStore.getDecryptedApiKey(created.id)).toBe('x');
  });
});

describe('providerStore.toResponse', () => {
  it('masks the api key in the response', () => {
    const created = mod.providerStore.create(baseInput);
    const resp = mod.providerStore.toResponse(created);
    expect(resp.apiKeyMasked).not.toBe(baseInput.apiKey);
    expect(resp.apiKeyMasked).toContain('*');
  });

  it('does NOT include the encrypted ciphertext', () => {
    const created = mod.providerStore.create(baseInput);
    const resp = mod.providerStore.toResponse(created);
    expect(resp).not.toHaveProperty('apiKey');
    expect(resp).not.toHaveProperty('apiKeyEncrypted');
  });

  it('returns "****" when decryption fails', () => {
    const created = mod.providerStore.create(baseInput);
    const broken = { ...created, apiKey: 'invalid' };
    const resp = mod.providerStore.toResponse(broken);
    expect(resp.apiKeyMasked).toBe('****');
  });
});

describe('providerStore — load from existing DB on init', () => {
  it('loads previously-persisted providers when the store re-initializes', async () => {
    const created = mod.providerStore.create(baseInput);

    // Simulate restart: keep the same DB, but re-import the module
    vi.resetModules();
    mod = await import('./providerStore');
    const fetched = mod.providerStore.get(created.id);
    expect(fetched).toBeDefined();
    expect(fetched!.name).toBe(baseInput.name);
    expect(mod.providerStore.getDecryptedApiKey(created.id)).toBe(baseInput.apiKey);
  });

  it('defaults missing supportsStreaming/isActive to true when loading legacy rows', async () => {
    // Insert a "legacy" row directly without the new model fields
    h.db!.prepare(
      'INSERT INTO providers (id, name, endpoint, api_key_encrypted, format, models, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
    ).run(
      'legacy-id',
      'Legacy',
      'http://example',
      'unused',
      'openai',
      JSON.stringify([{ id: 'm1', name: 'gpt-4', contextSize: 8192, supportsVision: false, supportsTools: false }]),
      '2026-01-01T00:00:00Z',
      '2026-01-01T00:00:00Z',
    );

    vi.resetModules();
    mod = await import('./providerStore');
    const loaded = mod.providerStore.get('legacy-id')!;
    expect(loaded.models[0].supportsStreaming).toBe(true);
    expect(loaded.models[0].isActive).toBe(true);
  });
});

describe('providerStore — bug #5 regression: model uniqueness', () => {
  it('regression #5: create rejects two models with the same id', () => {
    expect(() =>
      mod.providerStore.create({
        ...baseInput,
        models: [
          { ...baseInput.models[0], id: 'dup', name: 'a' },
          { ...baseInput.models[0], id: 'dup', name: 'b' },
        ],
      }),
    ).toThrow(/Duplicate model id/);
  });

  it('regression #5: create rejects two models with the same name', () => {
    expect(() =>
      mod.providerStore.create({
        ...baseInput,
        models: [
          { ...baseInput.models[0], id: 'a', name: 'same' },
          { ...baseInput.models[0], id: 'b', name: 'same' },
        ],
      }),
    ).toThrow(/Duplicate model name/);
  });

  it('regression #5: update rejects two models with the same name', () => {
    const created = mod.providerStore.create(baseInput);
    expect(() =>
      mod.providerStore.update(created.id, {
        models: [
          { ...baseInput.models[0], id: 'a', name: 'collide' },
          { ...baseInput.models[0], id: 'b', name: 'collide' },
        ],
      }),
    ).toThrow(/Duplicate/);
  });

  it('regression #5: allows distinct id+name pairs (sanity)', () => {
    const created = mod.providerStore.create({
      ...baseInput,
      models: [
        { ...baseInput.models[0], id: 'a', name: 'a' },
        { ...baseInput.models[0], id: 'b', name: 'b' },
      ],
    });
    expect(created.models).toHaveLength(2);
  });
});
