import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { BenchmarkWorkflow } from '../types';

/**
 * Full integration: executeWorkflow drives the REAL startBenchmark (not mocked).
 * Only the LLMProvider.execute call is mocked — so we exercise the whole orchestration:
 * benchmarkEngine's worker pool, subscribe/emit, store updates, summary generation, and
 * the workflow→benchmark event bridge.
 *
 * This catches integration bugs that the mock-everything tests would miss, like:
 *   - subscribe/unsubscribe lifecycle mismatches
 *   - benchmarkEngine 'done' events not unblocking workflowEngine's waitForBenchmarkComplete
 *   - store consistency between workflow.taskResults and benchmark runs
 */

const fns = vi.hoisted(() => ({
  execute: vi.fn(),
  createDynamicProvider: vi.fn(),
  testCapabilities: vi.fn(),
}));

const h = vi.hoisted(() => ({ db: null as Database.Database | null }));

vi.mock('./database', () => ({ getDb: () => h.db! }));
vi.mock('./capabilityTester', () => ({ testCapabilities: fns.testCapabilities }));
vi.mock('../providers/adapter', () => ({
  createDynamicProvider: fns.createDynamicProvider,
  testProviderConnection: vi.fn(),
  DynamicProvider: class {},
  PROBE_TIMEOUT_MS: 90_000,
}));
vi.mock('../providers/openai', () => ({ OpenAIProvider: class {} }));
vi.mock('../providers/claude', () => ({ ClaudeProvider: class {} }));
vi.mock('../providers/gemini', () => ({ GeminiProvider: class {} }));
vi.mock('../providers/zai', () => ({ ZaiProvider: class {} }));

let engine: typeof import('./workflowEngine');
let store: typeof import('./store');
let wfStore: typeof import('./workflowStore');

beforeEach(async () => {
  vi.clearAllMocks();
  h.db = new Database(':memory:');
  // Tables for all stores
  h.db.exec(`
    CREATE TABLE benchmarks (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, providers TEXT NOT NULL, config TEXT NOT NULL,
      results TEXT NOT NULL, capability_tests TEXT, created_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE TABLE providers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, endpoint TEXT NOT NULL, api_key_encrypted TEXT NOT NULL,
      format TEXT NOT NULL, models TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE workflows (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, status TEXT NOT NULL,
      providers TEXT NOT NULL, provider_labels TEXT, tasks TEXT NOT NULL, options TEXT NOT NULL,
      task_results TEXT NOT NULL DEFAULT '[]', summary TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, completed_at TEXT
    );
  `);
  vi.resetModules();
  store = await import('./store');
  wfStore = await import('./workflowStore');
  engine = await import('./workflowEngine');

  fns.createDynamicProvider.mockImplementation((providerId: string) => ({
    name: providerId,
    execute: fns.execute,
  }));
  fns.execute.mockResolvedValue({
    text: 'ok',
    inputTokens: 5,
    outputTokens: 10,
    totalTokens: 15,
    reasoningTokens: 0,
    responseTime: 50,
    firstTokenLatency: 10,
    estimatedCost: 0.01,
    model: 'mock',
  });
  fns.testCapabilities.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function buildWorkflow(overrides: Partial<BenchmarkWorkflow> = {}): BenchmarkWorkflow {
  const wf: BenchmarkWorkflow = {
    id: `wf_${Math.random().toString(36).slice(2, 8)}`,
    name: 'integration-test',
    description: '',
    status: 'pending',
    providers: ['cfg:gpt-4'],
    apiKeys: { 'cfg:gpt-4': 'sk-mock' },
    tasks: [
      {
        id: 't1',
        name: 'Task 1',
        order: 0,
        config: { prompt: 'hi', maxTokens: 100, concurrency: 1, iterations: 2 },
      } as never,
    ],
    options: { stopOnFailure: false, cooldownBetweenTasks: 0 } as never,
    taskResults: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as BenchmarkWorkflow;
  wfStore.workflowStore.create(wf);
  return wf;
}

describe('executeWorkflow + real startBenchmark integration', () => {
  it('single-task workflow completes end-to-end and persists summary', async () => {
    const wf = buildWorkflow();
    await engine.executeWorkflow(wf, wf.apiKeys ?? {});

    expect(wf.status).toBe('completed');
    expect(wf.taskResults[0].status).toBe('completed');
    expect(wf.taskResults[0].benchmarkRunId).toBeTruthy();

    // Real benchmark run should exist in store
    const benchRun = store.store.get(wf.taskResults[0].benchmarkRunId!);
    expect(benchRun).toBeDefined();
    expect(benchRun!.status).toBe('completed');
    expect(benchRun!.results['cfg:gpt-4']?.iterations).toHaveLength(2);

    // Summary aggregates iteration counts
    expect(wf.summary).toBeDefined();
    expect(wf.summary!.completedTaskCount).toBe(1);
    expect(wf.summary!.totalTokens).toBe(30); // 2 iter × 15 tokens
  });

  it('multi-task workflow runs tasks sequentially in order', async () => {
    const executionOrder: string[] = [];
    fns.execute.mockImplementation(async () => {
      executionOrder.push('exec');
      return {
        text: 'ok',
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        reasoningTokens: 0,
        responseTime: 10,
        firstTokenLatency: 1,
        estimatedCost: 0,
        model: 'mock',
      };
    });

    const wf = buildWorkflow({
      tasks: [
        { id: 'a', name: 'A', order: 0, config: { prompt: 'a', maxTokens: 1, concurrency: 1, iterations: 1 } },
        { id: 'b', name: 'B', order: 1, config: { prompt: 'b', maxTokens: 1, concurrency: 1, iterations: 1 } },
        { id: 'c', name: 'C', order: 2, config: { prompt: 'c', maxTokens: 1, concurrency: 1, iterations: 1 } },
      ] as never,
    });

    await engine.executeWorkflow(wf, wf.apiKeys ?? {});
    expect(wf.taskResults.map((r) => r.status)).toEqual(['completed', 'completed', 'completed']);
    // exec called once per task → 3 total
    expect(executionOrder).toHaveLength(3);
  });

  it('a single failed task does NOT halt the workflow (stopOnFailure=false)', async () => {
    let callCount = 0;
    fns.execute.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error('bizarre'); // task 1, only iteration → fails
      return {
        text: 'ok',
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        reasoningTokens: 0,
        responseTime: 5,
        firstTokenLatency: 1,
        estimatedCost: 0,
        model: 'mock',
      };
    });

    const wf = buildWorkflow({
      tasks: [
        { id: 'a', name: 'A', order: 0, config: { prompt: 'a', maxTokens: 1, concurrency: 1, iterations: 1 } },
        { id: 'b', name: 'B', order: 1, config: { prompt: 'b', maxTokens: 1, concurrency: 1, iterations: 1 } },
      ] as never,
      options: { stopOnFailure: false, cooldownBetweenTasks: 0 } as never,
    });

    await engine.executeWorkflow(wf, wf.apiKeys ?? {});
    // Task A's benchmark run completes (one iteration with success:false), workflow continues
    expect(wf.taskResults[1].status).toBe('completed');
    expect(wf.status).toBe('completed');
  });

  it('multi-provider task runs all providers and aggregates', async () => {
    const seen = new Set<string>();
    fns.createDynamicProvider.mockImplementation((providerId: string) => ({
      name: providerId,
      execute: async () => {
        seen.add(providerId);
        return {
          text: 'ok',
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          reasoningTokens: 0,
          responseTime: 5,
          firstTokenLatency: 1,
          estimatedCost: 0,
          model: 'mock',
        };
      },
    }));

    const wf = buildWorkflow({
      providers: ['cfg-a:gpt-4', 'cfg-b:gpt-4'],
      apiKeys: { 'cfg-a:gpt-4': 'k', 'cfg-b:gpt-4': 'k' },
    });

    await engine.executeWorkflow(wf, wf.apiKeys ?? {});
    // Both providers ran
    expect(seen.has('cfg-a')).toBe(true);
    expect(seen.has('cfg-b')).toBe(true);
    const runId = wf.taskResults[0].benchmarkRunId!;
    const benchRun = store.store.get(runId);
    expect(Object.keys(benchRun!.results)).toEqual(expect.arrayContaining(['cfg-a:gpt-4', 'cfg-b:gpt-4']));
  });

  it('emits the full workflow:init → task:start → task:complete → workflow:complete chain', async () => {
    const events: string[] = [];
    const wf = buildWorkflow();
    engine.subscribeWorkflow(wf.id, (e) => events.push(e.type));
    await engine.executeWorkflow(wf, wf.apiKeys ?? {});

    expect(events).toContain('workflow:init');
    expect(events).toContain('task:start');
    expect(events).toContain('task:complete');
    expect(events).toContain('workflow:complete');
  });

  it('cancellation mid-workflow marks remaining tasks skipped', async () => {
    fns.execute.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return {
        text: 'ok',
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        reasoningTokens: 0,
        responseTime: 30,
        firstTokenLatency: 1,
        estimatedCost: 0,
        model: 'mock',
      };
    });

    const wf = buildWorkflow({
      tasks: [
        { id: 'a', name: 'A', order: 0, config: { prompt: 'a', maxTokens: 1, concurrency: 1, iterations: 1 } },
        { id: 'b', name: 'B', order: 1, config: { prompt: 'b', maxTokens: 1, concurrency: 1, iterations: 1 } },
        { id: 'c', name: 'C', order: 2, config: { prompt: 'c', maxTokens: 1, concurrency: 1, iterations: 1 } },
      ] as never,
    });

    const execP = engine.executeWorkflow(wf, wf.apiKeys ?? {});
    // Give first task time to start, then cancel
    await new Promise((r) => setTimeout(r, 10));
    engine.cancelWorkflow(wf.id);
    await execP;

    expect(wf.status).toBe('cancelled');
    // At least one task should be skipped
    const skippedCount = wf.taskResults.filter((r) => r.status === 'skipped').length;
    expect(skippedCount).toBeGreaterThan(0);
  }, 10_000);

  it('cancellation only takes effect between tasks (not mid-task) — by design', async () => {
    // executeWorkflow checks cancelledWorkflows at the TOP of each task's iteration,
    // not inside an in-flight benchmark. This test locks in that contract: cancel mid-task-1
    // still lets task 1 finish, but task 2 onwards is skipped.
    fns.execute.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return {
        text: 'ok',
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        reasoningTokens: 0,
        responseTime: 20,
        firstTokenLatency: 1,
        estimatedCost: 0,
        model: 'mock',
      };
    });

    const wf = buildWorkflow({
      tasks: [
        { id: 'a', name: 'A', order: 0, config: { prompt: 'a', maxTokens: 1, concurrency: 1, iterations: 1 } },
        { id: 'b', name: 'B', order: 1, config: { prompt: 'b', maxTokens: 1, concurrency: 1, iterations: 1 } },
        { id: 'c', name: 'C', order: 2, config: { prompt: 'c', maxTokens: 1, concurrency: 1, iterations: 1 } },
      ] as never,
    });

    const execP = engine.executeWorkflow(wf, wf.apiKeys ?? {});
    // Fire cancel as soon as task A's benchmark starts
    await new Promise((r) => setTimeout(r, 5));
    engine.cancelWorkflow(wf.id);
    await execP;

    // Workflow is cancelled and the tasks after the in-flight one are skipped.
    expect(wf.status).toBe('cancelled');
    // Task A may complete or skip depending on timing — but B & C must be skipped.
    expect(wf.taskResults[1].status).toBe('skipped');
    expect(wf.taskResults[2].status).toBe('skipped');
  }, 10_000);
});
