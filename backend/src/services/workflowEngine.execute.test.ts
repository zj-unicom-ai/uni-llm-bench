import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BenchmarkWorkflow, BenchmarkRun, SSEEvent } from '../types';

/**
 * executeWorkflow integration tests. Mocks startBenchmark, subscribe, store, workflowStore,
 * providerStore so the orchestration runs without real benchmarking.
 *
 * Each test exercises one major path:
 *   - happy: all tasks succeed → workflow completed with summary
 *   - single failure + stopOnFailure → remaining tasks skipped
 *   - single failure without stopOnFailure → keeps going
 *   - cancellation before any task → cancelled status
 *   - cancellation mid-task → cancellation honored at next iteration
 *   - benchmark returns "failed" status → task:error emitted
 */

interface SubscribeCallback {
  (event: SSEEvent): void;
}

const h = vi.hoisted(() => ({
  // Per-run state: run id → { status, listeners, result }
  runs: new Map<string, { run: BenchmarkRun; listeners: Set<SubscribeCallback> }>(),
  // Per-workflow state stored back via workflowStore
  workflowState: new Map<string, BenchmarkWorkflow>(),
}));

const fns = vi.hoisted(() => ({
  storeGet: vi.fn(),
  workflowStoreUpdate: vi.fn(),
  providerStoreGet: vi.fn(),
  startBenchmark: vi.fn(),
  subscribe: vi.fn(),
}));

vi.mock('./store', () => ({ store: { get: fns.storeGet } }));
vi.mock('./workflowStore', () => ({ workflowStore: { update: fns.workflowStoreUpdate } }));
vi.mock('./providerStore', () => ({ providerStore: { get: fns.providerStoreGet } }));
vi.mock('./benchmarkEngine', () => ({ startBenchmark: fns.startBenchmark, subscribe: fns.subscribe }));

import { executeWorkflow, subscribeWorkflow, cancelWorkflow } from './workflowEngine';

let runIdCounter = 0;

function mkRun(): BenchmarkRun {
  return {
    id: `run-${++runIdCounter}`,
    status: 'pending',
    providers: ['cfg1:gpt-4'],
    config: {} as never,
    results: {
      'cfg1:gpt-4': {
        iterations: [],
        summary: {
          avgResponseTime: 100,
          p95ResponseTime: 100,
          avgFirstTokenLatency: 50,
          avgTokensPerSecond: 50,
          totalTokens: 100,
          totalInputTokens: 40,
          totalOutputTokens: 60,
          successRate: 1.0,
          estimatedCost: 0.1,
          systemThroughput: 0,
        } as never,
      },
    } as never,
    createdAt: new Date().toISOString(),
  };
}

function setupHappyPath() {
  fns.startBenchmark.mockImplementation(async () => {
    const run = mkRun();
    h.runs.set(run.id, { run, listeners: new Set() });
    // Schedule async completion
    setTimeout(() => {
      const e = h.runs.get(run.id)!;
      e.run.status = 'completed';
      e.run.completedAt = new Date().toISOString();
      for (const l of e.listeners) l({ type: 'done' } as SSEEvent);
    }, 5);
    return run;
  });

  fns.subscribe.mockImplementation((runId: string, cb: SubscribeCallback) => {
    const e = h.runs.get(runId);
    if (e) e.listeners.add(cb);
    return () => e?.listeners.delete(cb);
  });

  fns.storeGet.mockImplementation((runId: string) => h.runs.get(runId)?.run);

  fns.workflowStoreUpdate.mockImplementation((id: string, updates: Partial<BenchmarkWorkflow>) => {
    const existing = h.workflowState.get(id);
    if (existing) h.workflowState.set(id, { ...existing, ...updates });
    return existing;
  });

  fns.providerStoreGet.mockReturnValue({
    id: 'cfg1',
    name: 'OpenAI',
    models: [{ id: 'm', name: 'gpt-4', displayName: 'GPT-4' }],
  });
}

function makeWorkflow(
  taskCount: number,
  options: { stopOnFailure?: boolean; cooldown?: number } = {},
): BenchmarkWorkflow {
  const wf: BenchmarkWorkflow = {
    id: `wf-${Math.random().toString(36).slice(2)}`,
    name: 'test wf',
    description: '',
    status: 'pending',
    providers: ['cfg1:gpt-4'],
    apiKeys: {},
    tasks: Array.from(
      { length: taskCount },
      (_, i) =>
        ({
          id: `t${i}`,
          name: `Task ${i}`,
          order: i,
          config: { prompt: 'hi', concurrency: 1, iterations: 1, maxTokens: 100 } as never,
        }) as never,
    ),
    options: { stopOnFailure: options.stopOnFailure, cooldownBetweenTasks: options.cooldown ?? 0 } as never,
    taskResults: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as unknown as BenchmarkWorkflow;
  h.workflowState.set(wf.id, wf);
  return wf;
}

beforeEach(() => {
  h.runs.clear();
  h.workflowState.clear();
  vi.clearAllMocks();
  runIdCounter = 0;
});

describe('executeWorkflow — happy path', () => {
  beforeEach(setupHappyPath);

  it('completes a single-task workflow successfully', async () => {
    const events: Array<{ type: string }> = [];
    const wf = makeWorkflow(1);
    subscribeWorkflow(wf.id, (e) => events.push(e));

    await executeWorkflow(wf, {});

    expect(wf.status).toBe('completed');
    expect(wf.taskResults).toHaveLength(1);
    expect(wf.taskResults[0].status).toBe('completed');
    expect(wf.summary).toBeDefined();
    expect(events.map((e) => e.type)).toContain('workflow:init');
    expect(events.map((e) => e.type)).toContain('task:start');
    expect(events.map((e) => e.type)).toContain('task:complete');
    expect(events.map((e) => e.type)).toContain('workflow:complete');
  });

  it('runs tasks sequentially and emits task:start for each', async () => {
    const taskStartIds: string[] = [];
    const wf = makeWorkflow(3);
    subscribeWorkflow(wf.id, (e) => {
      if (e.type === 'task:start') taskStartIds.push((e.data as { taskId: string }).taskId);
    });

    await executeWorkflow(wf, {});

    expect(taskStartIds).toEqual(['t0', 't1', 't2']);
    expect(wf.taskResults.every((r) => r.status === 'completed')).toBe(true);
  });

  it('records startedAt + completedAt on workflow', async () => {
    const wf = makeWorkflow(1);
    await executeWorkflow(wf, {});
    expect(wf.startedAt).toBeDefined();
    expect(wf.completedAt).toBeDefined();
    expect(new Date(wf.completedAt!).getTime()).toBeGreaterThanOrEqual(new Date(wf.startedAt!).getTime());
  });

  it('passes apiKeys through to startBenchmark', async () => {
    const wf = makeWorkflow(1);
    const keys = { openai: 'sk-test' };
    await executeWorkflow(wf, keys);
    expect(fns.startBenchmark).toHaveBeenCalledWith(['cfg1:gpt-4'], expect.anything(), keys);
  });
});

describe('executeWorkflow — failure paths', () => {
  beforeEach(setupHappyPath);

  it('emits task:error and marks task failed when benchmark "failed" status returned', async () => {
    // Override startBenchmark to mark the run as failed
    fns.startBenchmark.mockImplementationOnce(async () => {
      const run = mkRun();
      h.runs.set(run.id, { run, listeners: new Set() });
      setTimeout(() => {
        const e = h.runs.get(run.id)!;
        e.run.status = 'failed';
        for (const l of e.listeners) l({ type: 'done' } as SSEEvent);
      }, 5);
      return run;
    });

    const errEvents: unknown[] = [];
    const wf = makeWorkflow(1);
    subscribeWorkflow(wf.id, (e) => {
      if (e.type === 'task:error') errEvents.push(e.data);
    });
    await executeWorkflow(wf, {});
    expect(errEvents).toHaveLength(1);
    expect(wf.taskResults[0].status).toBe('failed');
    // No stopOnFailure → workflow status still 'completed' overall at the end
    expect(wf.status).toBe('completed');
  });

  it('with stopOnFailure=true, marks remaining tasks as skipped and workflow as failed', async () => {
    // First call succeeds, second fails
    let callCount = 0;
    fns.startBenchmark.mockImplementation(async () => {
      callCount++;
      const run = mkRun();
      h.runs.set(run.id, { run, listeners: new Set() });
      const willFail = callCount === 2;
      setTimeout(() => {
        const e = h.runs.get(run.id)!;
        e.run.status = willFail ? 'failed' : 'completed';
        for (const l of e.listeners) l({ type: 'done' } as SSEEvent);
      }, 5);
      return run;
    });

    const wf = makeWorkflow(3, { stopOnFailure: true });
    await executeWorkflow(wf, {});
    expect(wf.status).toBe('failed');
    expect(wf.taskResults[0].status).toBe('completed');
    expect(wf.taskResults[1].status).toBe('failed');
    expect(wf.taskResults[2].status).toBe('skipped');
  });

  it('startBenchmark throws → task marked failed with error message', async () => {
    fns.startBenchmark.mockRejectedValueOnce(new Error('rate limit exceeded'));
    const wf = makeWorkflow(1);
    await executeWorkflow(wf, {});
    expect(wf.taskResults[0].status).toBe('failed');
    expect(wf.taskResults[0].error).toContain('rate limit');
  });
});

describe('executeWorkflow — cancellation', () => {
  beforeEach(setupHappyPath);

  it('honors cancellation BEFORE any task starts', async () => {
    const wf = makeWorkflow(3);
    cancelWorkflow(wf.id); // queued before execute
    await executeWorkflow(wf, {});
    expect(wf.status).toBe('cancelled');
    expect(wf.taskResults.every((r) => r.status === 'skipped')).toBe(true);
  });

  it('honors cancellation MID-EXECUTION (next iteration check)', async () => {
    const wf = makeWorkflow(3);
    // Cancel after the first task starts running
    setTimeout(() => cancelWorkflow(wf.id), 1);
    await executeWorkflow(wf, {});
    expect(wf.status).toBe('cancelled');
    // At least one task should be skipped due to cancellation
    expect(wf.taskResults.filter((r) => r.status === 'skipped').length).toBeGreaterThan(0);
  });
});

describe('executeWorkflow — cooldown', () => {
  beforeEach(setupHappyPath);

  it('emits "cooldown" event when cooldownBetweenTasks > 0 (smoke check)', async () => {
    const events: Array<{ type: string }> = [];
    const wf = makeWorkflow(2, { cooldown: 10 });
    subscribeWorkflow(wf.id, (e) => events.push(e));
    await executeWorkflow(wf, {});
    expect(events.some((e) => e.type === 'cooldown')).toBe(true);
  });

  it('does NOT emit cooldown after the last task', async () => {
    const events: Array<{ type: string }> = [];
    const wf = makeWorkflow(1, { cooldown: 10 });
    subscribeWorkflow(wf.id, (e) => events.push(e));
    await executeWorkflow(wf, {});
    expect(events.some((e) => e.type === 'cooldown')).toBe(false);
  });
});

describe('executeWorkflow — store update calls', () => {
  beforeEach(setupHappyPath);

  it('calls workflowStore.update at least once per task (status updates)', async () => {
    const wf = makeWorkflow(2);
    await executeWorkflow(wf, {});
    // start → running update, completion update per task, final summary update = ≥ 4 calls for 2 tasks
    expect(fns.workflowStoreUpdate.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('persists the final summary in the last update', async () => {
    const wf = makeWorkflow(1);
    await executeWorkflow(wf, {});
    const lastCall = fns.workflowStoreUpdate.mock.calls[fns.workflowStoreUpdate.mock.calls.length - 1];
    const lastUpdate = lastCall[1] as Partial<BenchmarkWorkflow>;
    expect(lastUpdate.summary).toBeDefined();
    expect(lastUpdate.status).toBe('completed');
    expect(lastUpdate.completedAt).toBeDefined();
  });
});
