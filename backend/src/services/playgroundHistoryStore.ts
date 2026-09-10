import { randomUUID } from 'crypto';
import { getDb } from './database';
import type { GenerationParams } from '../providers/adapter';

export interface PlaygroundHistoryEntry {
  id: string;
  providerId: string;
  providerName: string;
  modelName: string;
  prompt: string;
  systemPrompt?: string;
  maxTokens: number;
  useStreaming: boolean;
  enableThinking: boolean;
  genParams?: GenerationParams;
  responseText?: string;
  reasoningText?: string;
  metrics?: Record<string, unknown>;
  error?: string;
  createdAt: string;
}

export interface PlaygroundHistoryListItem {
  id: string;
  providerName: string;
  providerId: string;
  modelName: string;
  promptSnippet: string;
  createdAt: string;
  responseTime?: number;
  error?: string;
}

class PlaygroundHistoryStore {
  private entries: Map<string, PlaygroundHistoryEntry> = new Map();
  private db = getDb();

  constructor() {
    this.initDatabase();
    this.load();
  }

  private initDatabase() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS playground_history (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        provider_name TEXT NOT NULL,
        model_name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        system_prompt TEXT,
        max_tokens INTEGER NOT NULL,
        use_streaming INTEGER NOT NULL DEFAULT 1,
        enable_thinking INTEGER NOT NULL DEFAULT 0,
        response_text TEXT,
        reasoning_text TEXT,
        metrics TEXT,
        error TEXT,
        created_at TEXT NOT NULL
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_ph_created_at ON playground_history(created_at DESC);
    `);

    // Idempotent migration: genParams column was added later; ALTER fails if it already exists.
    const hasGenParams = this.db
      .prepare("SELECT COUNT(*) AS c FROM pragma_table_info('playground_history') WHERE name = 'gen_params'")
      .get() as { c: number };
    if (hasGenParams.c === 0) {
      this.db.exec(`ALTER TABLE playground_history ADD COLUMN gen_params TEXT`);
    }

    console.log('Playground history store initialized');
  }

  private load() {
    try {
      const rows = this.db.prepare('SELECT * FROM playground_history ORDER BY created_at DESC').all() as Array<{
        id: string;
        provider_id: string;
        provider_name: string;
        model_name: string;
        prompt: string;
        system_prompt: string | null;
        max_tokens: number;
        use_streaming: number;
        enable_thinking: number;
        gen_params: string | null;
        response_text: string | null;
        reasoning_text: string | null;
        metrics: string | null;
        error: string | null;
        created_at: string;
      }>;
      for (const row of rows) {
        const entry: PlaygroundHistoryEntry = {
          id: row.id,
          providerId: row.provider_id,
          providerName: row.provider_name,
          modelName: row.model_name,
          prompt: row.prompt,
          systemPrompt: row.system_prompt || undefined,
          maxTokens: row.max_tokens,
          useStreaming: !!row.use_streaming,
          enableThinking: !!row.enable_thinking,
          genParams: row.gen_params ? JSON.parse(row.gen_params) : undefined,
          responseText: row.response_text || undefined,
          reasoningText: row.reasoning_text || undefined,
          metrics: row.metrics ? JSON.parse(row.metrics) : undefined,
          error: row.error || undefined,
          createdAt: row.created_at,
        };
        this.entries.set(entry.id, entry);
      }
      console.log(`Loaded ${this.entries.size} playground history entries`);
    } catch (err) {
      console.error('Failed to load playground history:', err);
    }
  }

  create(data: Omit<PlaygroundHistoryEntry, 'id' | 'createdAt'>): PlaygroundHistoryEntry {
    const entry: PlaygroundHistoryEntry = {
      ...data,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };

    // Write to SQLite first, then update Map on success
    this.db
      .prepare(
        `
        INSERT INTO playground_history (id, provider_id, provider_name, model_name, prompt, system_prompt, max_tokens, use_streaming, enable_thinking, gen_params, response_text, reasoning_text, metrics, error, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        entry.id,
        entry.providerId,
        entry.providerName,
        entry.modelName,
        entry.prompt,
        entry.systemPrompt || null,
        entry.maxTokens,
        entry.useStreaming ? 1 : 0,
        entry.enableThinking ? 1 : 0,
        entry.genParams ? JSON.stringify(entry.genParams) : null,
        entry.responseText || null,
        entry.reasoningText || null,
        entry.metrics ? JSON.stringify(entry.metrics) : null,
        entry.error || null,
        entry.createdAt,
      );

    this.entries.set(entry.id, entry);
    return entry;
  }

  get(id: string): PlaygroundHistoryEntry | undefined {
    return this.entries.get(id);
  }

  getList(): PlaygroundHistoryListItem[] {
    return Array.from(this.entries.values())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((e) => ({
        id: e.id,
        providerName: e.providerName,
        providerId: e.providerId,
        modelName: e.modelName,
        promptSnippet: e.prompt.slice(0, 80),
        createdAt: e.createdAt,
        responseTime: e.metrics?.responseTime as number | undefined,
        error: e.error,
      }));
  }

  delete(id: string): boolean {
    const existed = this.entries.has(id);
    this.db.prepare('DELETE FROM playground_history WHERE id = ?').run(id);
    this.entries.delete(id);
    return existed;
  }

  deleteAll(): void {
    this.db.prepare('DELETE FROM playground_history').run();
    this.entries.clear();
  }
}

export const playgroundHistoryStore = new PlaygroundHistoryStore();
