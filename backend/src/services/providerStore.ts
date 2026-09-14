import { ProviderConfig, ProviderConfigInput } from '../types';
import { encrypt, decrypt, maskApiKey } from '../utils/encryption';
import { getDb } from './database';
import { randomUUID } from 'node:crypto';

/** Throw if two model entries share the same id or name. Exported for tests. */
export function assertUniqueModels(models: Array<{ id: string; name: string }>): void {
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  for (const m of models) {
    if (seenIds.has(m.id)) throw new Error(`Duplicate model id within provider: "${m.id}"`);
    if (seenNames.has(m.name)) throw new Error(`Duplicate model name within provider: "${m.name}"`);
    seenIds.add(m.id);
    seenNames.add(m.name);
  }
}

class ProviderStore {
  private providers: Map<string, ProviderConfig> = new Map();
  private db = getDb();

  constructor() {
    this.initDatabase();
    this.load();
  }

  private initDatabase() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        api_key_encrypted TEXT NOT NULL,
        format TEXT NOT NULL,
        models TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    console.log('Provider store initialized');
  }

  private load() {
    try {
      const rows = this.db.prepare('SELECT * FROM providers ORDER BY created_at DESC').all() as Array<{
        id: string;
        name: string;
        endpoint: string;
        api_key_encrypted: string;
        format: string;
        models: string;
        created_at: string;
        updated_at: string;
      }>;
      for (const row of rows) {
        this.providers.set(row.id, {
          id: row.id,
          name: row.name,
          endpoint: row.endpoint,
          apiKey: row.api_key_encrypted,
          format: row.format as ProviderConfig['format'],
          models: JSON.parse(row.models).map((m: Record<string, unknown>) => ({
            ...m,
            supportsStreaming: (m.supportsStreaming as boolean) ?? true,
            isActive: (m.isActive as boolean) ?? true,
          })),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        });
      }
      console.log(`Loaded ${this.providers.size} provider(s)`);
    } catch (err) {
      console.error('Failed to load providers:', err);
    }
  }

  create(input: ProviderConfigInput): ProviderConfig {
    const now = new Date().toISOString();
    const normalizedModels = input.models.map((m) => ({
      ...m,
      id: m.id || randomUUID(),
      supportsStreaming: m.supportsStreaming ?? true,
      isActive: m.isActive ?? true,
    }));
    // Bug #5 guard: enforce unique model id + name per provider. Without this,
    // duplicate-named models cause confusing CRUD behavior downstream.
    assertUniqueModels(normalizedModels);
    const provider: ProviderConfig = {
      id: randomUUID(),
      name: input.name,
      endpoint: input.endpoint,
      apiKey: encrypt(input.apiKey),
      format: input.format,
      models: normalizedModels,
      createdAt: now,
      updatedAt: now,
    };

    // Write to SQLite first, then update Map on success
    this.db
      .prepare(
        `
        INSERT INTO providers (id, name, endpoint, api_key_encrypted, format, models, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        provider.id,
        provider.name,
        provider.endpoint,
        provider.apiKey,
        provider.format,
        JSON.stringify(provider.models),
        provider.createdAt,
        provider.updatedAt,
      );

    this.providers.set(provider.id, provider);
    return provider;
  }

  get(id: string): ProviderConfig | undefined {
    return this.providers.get(id);
  }

  getAll(): ProviderConfig[] {
    return Array.from(this.providers.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  update(id: string, input: Partial<ProviderConfigInput>): ProviderConfig | undefined {
    const existing = this.providers.get(id);
    if (!existing) return undefined;

    const nextModels = input.models
      ? input.models.map((m) => ({
          ...m,
          id: m.id || randomUUID(),
          supportsStreaming: m.supportsStreaming ?? true,
          isActive: m.isActive ?? true,
        }))
      : existing.models;
    if (input.models) assertUniqueModels(nextModels);

    const updated: ProviderConfig = {
      ...existing,
      name: input.name ?? existing.name,
      endpoint: input.endpoint ?? existing.endpoint,
      apiKey: input.apiKey ? encrypt(input.apiKey) : existing.apiKey,
      format: input.format ?? existing.format,
      models: nextModels,
      updatedAt: new Date().toISOString(),
    };

    // Write to SQLite first, then update Map on success
    this.db
      .prepare(
        `
        UPDATE providers
        SET name = ?, endpoint = ?, api_key_encrypted = ?, format = ?, models = ?, updated_at = ?
        WHERE id = ?
      `,
      )
      .run(
        updated.name,
        updated.endpoint,
        updated.apiKey,
        updated.format,
        JSON.stringify(updated.models),
        updated.updatedAt,
        id,
      );

    this.providers.set(id, updated);
    return updated;
  }

  delete(id: string): boolean {
    const exists = this.providers.has(id);
    if (!exists) return false;

    // Delete from SQLite first, then remove from Map
    this.db.prepare('DELETE FROM providers WHERE id = ?').run(id);
    this.providers.delete(id);
    return true;
  }

  getDecryptedApiKey(id: string): string | undefined {
    const provider = this.providers.get(id);
    if (!provider) return undefined;
    try {
      return decrypt(provider.apiKey);
    } catch {
      return undefined;
    }
  }

  toResponse(provider: ProviderConfig) {
    let maskedKey = '****';
    try {
      maskedKey = maskApiKey(decrypt(provider.apiKey));
    } catch {
      /* ignore */
    }

    return {
      id: provider.id,
      name: provider.name,
      endpoint: provider.endpoint,
      apiKeyMasked: maskedKey,
      format: provider.format,
      models: provider.models,
      createdAt: provider.createdAt,
      updatedAt: provider.updatedAt,
    };
  }
}

export const providerStore = new ProviderStore();
