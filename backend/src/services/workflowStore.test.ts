import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { BenchmarkWorkflow } from '../types';

const h = vi.hoisted(() => ({ db: null as Database.Database | null }));

vi.mock('./database', () => ({
  getDb: () => h.db!,
}));

let mod: typeof import('./workflowStore');

async function freshStore() {
  h.db = new Database(':memory:');
  vi.resetModules();
  mod = await import('./workflowStore');
  return mod.workflowStore;
}

beforeEach(async () => {
  await freshStore();
});

const baseWf: BenchmarkWorkflow = {
  id: 'wf1',
  name: 'test wf',
  description: '',
  status: 'pending',
  providers: ['openai'],
  apiKeys: {},
  tasks: [
    {
      id: 't1',
      name: 'T1',
      order: 0,
      config: { prompt: 'hi', concurrency: 1, iterations: 1, maxTokens: 100 },
    } as never,
  ],
  options: {},
  taskResults: [],
  createdAt: '2026-05-15T00:00:00Z',
  updatedAt: '2026-05-15T00:00:00Z',
} as unknown as BenchmarkWorkflow;

describe('workflowStore — CRUD', () => {
  it('create persists and is gettable', () => {
    mod.workflowStore.create(baseWf);
    expect(mod.workflowStore.get('wf1')?.id).toBe('wf1');
    const { cnt } = h.db!.prepare('SELECT COUNT(*) as cnt FROM workflows').get() as { cnt: number };
    expect(cnt).toBe(1);
  });

  it('get returns undefined for unknown id', () => {
    expect(mod.workflowStore.get('ghost')).toBeUndefined();
  });

  it('getAll sorts by createdAt desc', () => {
    mod.workflowStore.create({ ...baseWf, id: 'a', createdAt: '2026-05-15T00:00:00Z' });
    mod.workflowStore.create({ ...baseWf, id: 'b', createdAt: '2026-05-15T02:00:00Z' });
    mod.workflowStore.create({ ...baseWf, id: 'c', createdAt: '2026-05-15T01:00:00Z' });
    expect(mod.workflowStore.getAll().map((w) => w.id)).toEqual(['b', 'c', 'a']);
  });

  it('update sets updatedAt to a fresh timestamp', async () => {
    mod.workflowStore.create(baseWf);
    await new Promise((r) => setTimeout(r, 5));
    const updated = mod.workflowStore.update('wf1', { status: 'completed' });
    expect(updated?.status).toBe('completed');
    expect(new Date(updated!.updatedAt).getTime()).toBeGreaterThan(new Date(baseWf.updatedAt).getTime());
  });

  it('update returns undefined for unknown id', () => {
    expect(mod.workflowStore.update('ghost', { status: 'completed' })).toBeUndefined();
  });

  it('persists summary JSON and reloads it', async () => {
    const wfWithSummary = {
      ...baseWf,
      summary: {
        totalDuration: 1000,
        totalCost: 0.5,
        totalTokens: 100,
        totalInputTokens: 50,
        totalOutputTokens: 50,
        taskCount: 1,
        completedTaskCount: 1,
        failedTaskCount: 0,
        providerSummaries: {},
      },
    } as BenchmarkWorkflow;
    mod.workflowStore.create(wfWithSummary);
    vi.resetModules();
    mod = await import('./workflowStore');
    expect(mod.workflowStore.get('wf1')?.summary?.totalCost).toBe(0.5);
  });

  it('persists providerLabels JSON', async () => {
    const wfWithLabels = { ...baseWf, providerLabels: { openai: 'OpenAI GPT-4' } } as BenchmarkWorkflow;
    mod.workflowStore.create(wfWithLabels);
    vi.resetModules();
    mod = await import('./workflowStore');
    expect(mod.workflowStore.get('wf1')?.providerLabels?.openai).toBe('OpenAI GPT-4');
  });

  it('delete returns false for unknown id', () => {
    expect(mod.workflowStore.delete('ghost')).toBe(false);
  });

  it('delete returns true and removes from both stores', () => {
    mod.workflowStore.create(baseWf);
    expect(mod.workflowStore.delete('wf1')).toBe(true);
    expect(mod.workflowStore.get('wf1')).toBeUndefined();
  });

  it('migrates legacy schema (adds provider_labels column on import)', async () => {
    h.db = new Database(':memory:');
    h.db.exec(`
      CREATE TABLE workflows (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, status TEXT NOT NULL,
        providers TEXT NOT NULL, tasks TEXT NOT NULL, options TEXT NOT NULL,
        task_results TEXT NOT NULL DEFAULT '[]', summary TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        started_at TEXT, completed_at TEXT
      )
    `);
    vi.resetModules();
    await import('./workflowStore');
    const cols = (h.db.pragma('table_info(workflows)') as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('provider_labels');
  });

  it('marks stale "running" workflows as failed on store load (crash recovery)', async () => {
    // Pre-seed a running workflow row directly
    h.db = new Database(':memory:');
    h.db.exec(`
      CREATE TABLE workflows (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, status TEXT NOT NULL,
        providers TEXT NOT NULL, provider_labels TEXT, tasks TEXT NOT NULL, options TEXT NOT NULL,
        task_results TEXT NOT NULL DEFAULT '[]', summary TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        started_at TEXT, completed_at TEXT
      )
    `);
    h.db
      .prepare(
        'INSERT INTO workflows (id,name,description,status,providers,tasks,options,task_results,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        'stale',
        'stale-wf',
        null,
        'running', // ← stale
        '[]',
        '[]',
        '{}',
        '[{"taskId":"t1","taskName":"T1","benchmarkRunId":"","status":"running"}]',
        '2026-05-15T00:00:00Z',
        '2026-05-15T00:00:00Z',
      );

    vi.resetModules();
    mod = await import('./workflowStore');
    const recovered = mod.workflowStore.get('stale')!;
    expect(recovered.status).toBe('failed');
    expect(recovered.taskResults[0].status).toBe('failed');
    expect(recovered.completedAt).toBeDefined();
  });
});
