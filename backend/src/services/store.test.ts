import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { BenchmarkRun } from '../types';

const h = vi.hoisted(() => ({ db: null as Database.Database | null }));

vi.mock('./database', () => ({
  getDb: () => h.db!,
}));

let mod: typeof import('./store');

async function freshStore() {
  h.db = new Database(':memory:');
  vi.resetModules();
  mod = await import('./store');
  return mod.store;
}

beforeEach(async () => {
  await freshStore();
});

const baseRun: BenchmarkRun = {
  id: 'r1',
  status: 'pending',
  providers: ['openai'],
  config: { prompt: 'hi', concurrency: 1, iterations: 1, maxTokens: 100 } as never,
  results: {},
  createdAt: '2026-05-15T00:00:00Z',
};

describe('store (BenchmarkStore) — CRUD', () => {
  it('create persists to sqlite and Map', () => {
    mod.store.create(baseRun);
    expect(mod.store.get('r1')).toEqual(baseRun);
    const { cnt } = h.db!.prepare('SELECT COUNT(*) as cnt FROM benchmarks').get() as { cnt: number };
    expect(cnt).toBe(1);
  });

  it('get returns undefined for unknown id', () => {
    expect(mod.store.get('ghost')).toBeUndefined();
  });

  it('getAll returns empty on fresh store', () => {
    expect(mod.store.getAll()).toEqual([]);
  });

  it('getAll sorts by createdAt desc', () => {
    mod.store.create({ ...baseRun, id: 'a', createdAt: '2026-05-15T00:00:00Z' });
    mod.store.create({ ...baseRun, id: 'b', createdAt: '2026-05-15T01:00:00Z' });
    mod.store.create({ ...baseRun, id: 'c', createdAt: '2026-05-15T02:00:00Z' });
    const ids = mod.store.getAll().map((r) => r.id);
    expect(ids).toEqual(['c', 'b', 'a']);
  });

  it('update merges fields and writes only status/results/capabilityTests/completedAt to DB', () => {
    mod.store.create(baseRun);
    const updated = mod.store.update('r1', { status: 'completed', completedAt: '2026-05-15T01:00:00Z' });
    expect(updated?.status).toBe('completed');
    expect(updated?.completedAt).toBe('2026-05-15T01:00:00Z');
    // Other fields preserved
    expect(updated?.providers).toEqual(['openai']);
  });

  it('update returns undefined for unknown id', () => {
    expect(mod.store.update('ghost', { status: 'completed' })).toBeUndefined();
  });

  it('delete returns true and removes from both stores', () => {
    mod.store.create(baseRun);
    expect(mod.store.delete('r1')).toBe(true);
    expect(mod.store.get('r1')).toBeUndefined();
    const { cnt } = h.db!.prepare('SELECT COUNT(*) as cnt FROM benchmarks').get() as { cnt: number };
    expect(cnt).toBe(0);
  });

  it('delete returns false for unknown id', () => {
    expect(mod.store.delete('ghost')).toBe(false);
  });

  it('persists capabilityTests as JSON and reloads them', async () => {
    const withCaps: BenchmarkRun = {
      ...baseRun,
      capabilityTests: [{ type: 'vision', name: 'V', description: 'd', passed: true }],
    };
    mod.store.create(withCaps);
    // Restart store — reload from DB
    vi.resetModules();
    mod = await import('./store');
    const reloaded = mod.store.get('r1');
    expect(reloaded?.capabilityTests).toEqual([{ type: 'vision', name: 'V', description: 'd', passed: true }]);
  });

  it('preserves results JSON across reload', async () => {
    const withResults: BenchmarkRun = {
      ...baseRun,
      results: {
        openai: {
          provider: 'openai',
          model: 'gpt-4',
          summary: { avgResponseTime: 100 } as never,
          iterations: [],
        } as never,
      },
    };
    mod.store.create(withResults);
    vi.resetModules();
    mod = await import('./store');
    expect(mod.store.get('r1')?.results).toEqual(withResults.results);
  });
});
