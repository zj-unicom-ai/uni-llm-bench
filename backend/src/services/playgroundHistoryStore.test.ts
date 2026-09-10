import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

const h = vi.hoisted(() => ({ db: null as Database.Database | null }));

vi.mock('./database', () => ({
  getDb: () => h.db!,
}));

let mod: typeof import('./playgroundHistoryStore');

async function freshStore() {
  h.db = new Database(':memory:');
  vi.resetModules();
  mod = await import('./playgroundHistoryStore');
  return mod.playgroundHistoryStore;
}

beforeEach(async () => {
  await freshStore();
});

const baseEntry = {
  providerId: 'p1',
  providerName: 'OpenAI',
  modelName: 'gpt-4',
  prompt: 'hello',
  maxTokens: 100,
  useStreaming: true,
  enableThinking: false,
};

describe('playgroundHistoryStore — CRUD', () => {
  it('create assigns id + createdAt and persists', () => {
    const e = mod.playgroundHistoryStore.create(baseEntry);
    expect(e.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(e.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(mod.playgroundHistoryStore.get(e.id)).toEqual(e);
  });

  it('get returns undefined for unknown id', () => {
    expect(mod.playgroundHistoryStore.get('ghost')).toBeUndefined();
  });

  it('getList returns list items sorted by createdAt desc with snipped prompt', async () => {
    mod.playgroundHistoryStore.create({ ...baseEntry, prompt: 'first short' });
    await new Promise((r) => setTimeout(r, 5));
    mod.playgroundHistoryStore.create({ ...baseEntry, prompt: 'a'.repeat(100) }); // > 80 chars
    const list = mod.playgroundHistoryStore.getList();
    expect(list).toHaveLength(2);
    expect(list[0].promptSnippet).toHaveLength(80);
    expect(list[1].promptSnippet).toBe('first short');
  });

  it('getList exposes responseTime from metrics if present', () => {
    mod.playgroundHistoryStore.create({ ...baseEntry, metrics: { responseTime: 1234 } });
    expect(mod.playgroundHistoryStore.getList()[0].responseTime).toBe(1234);
  });

  it('getList exposes error message when set', () => {
    mod.playgroundHistoryStore.create({ ...baseEntry, error: 'rate limited' });
    expect(mod.playgroundHistoryStore.getList()[0].error).toBe('rate limited');
  });

  it('persists metrics JSON and reloads correctly', async () => {
    const e = mod.playgroundHistoryStore.create({
      ...baseEntry,
      metrics: { responseTime: 500, inputTokens: 10, outputTokens: 20 },
    });
    vi.resetModules();
    mod = await import('./playgroundHistoryStore');
    const reloaded = mod.playgroundHistoryStore.get(e.id);
    expect(reloaded?.metrics).toEqual({ responseTime: 500, inputTokens: 10, outputTokens: 20 });
  });

  it('persists boolean flags as 1/0 and parses back to booleans', async () => {
    const e1 = mod.playgroundHistoryStore.create({ ...baseEntry, useStreaming: true, enableThinking: true });
    const e2 = mod.playgroundHistoryStore.create({ ...baseEntry, useStreaming: false, enableThinking: false });
    vi.resetModules();
    mod = await import('./playgroundHistoryStore');
    expect(mod.playgroundHistoryStore.get(e1.id)?.useStreaming).toBe(true);
    expect(mod.playgroundHistoryStore.get(e1.id)?.enableThinking).toBe(true);
    expect(mod.playgroundHistoryStore.get(e2.id)?.useStreaming).toBe(false);
    expect(mod.playgroundHistoryStore.get(e2.id)?.enableThinking).toBe(false);
  });

  it('delete removes from both stores', () => {
    const e = mod.playgroundHistoryStore.create(baseEntry);
    expect(mod.playgroundHistoryStore.delete(e.id)).toBe(true);
    expect(mod.playgroundHistoryStore.get(e.id)).toBeUndefined();
  });

  it('delete returns false for unknown id', () => {
    expect(mod.playgroundHistoryStore.delete('ghost')).toBe(false);
  });

  it('deleteAll clears the table', () => {
    mod.playgroundHistoryStore.create(baseEntry);
    mod.playgroundHistoryStore.create(baseEntry);
    mod.playgroundHistoryStore.create(baseEntry);
    mod.playgroundHistoryStore.deleteAll();
    expect(mod.playgroundHistoryStore.getList()).toEqual([]);
    const { cnt } = h.db!.prepare('SELECT COUNT(*) as cnt FROM playground_history').get() as { cnt: number };
    expect(cnt).toBe(0);
  });

  it('handles entries with optional fields omitted', () => {
    const e = mod.playgroundHistoryStore.create(baseEntry); // no systemPrompt, no responseText, etc.
    expect(e.systemPrompt).toBeUndefined();
    expect(e.responseText).toBeUndefined();
    expect(e.error).toBeUndefined();
  });

  it('roundtrips systemPrompt and reasoningText', async () => {
    const e = mod.playgroundHistoryStore.create({
      ...baseEntry,
      systemPrompt: 'You are a helpful assistant',
      responseText: 'Hello!',
      reasoningText: 'thinking step',
    });
    vi.resetModules();
    mod = await import('./playgroundHistoryStore');
    const r = mod.playgroundHistoryStore.get(e.id)!;
    expect(r.systemPrompt).toBe('You are a helpful assistant');
    expect(r.responseText).toBe('Hello!');
    expect(r.reasoningText).toBe('thinking step');
  });
});
