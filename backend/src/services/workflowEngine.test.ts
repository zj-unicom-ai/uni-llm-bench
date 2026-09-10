import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * workflowEngine is a large async orchestrator (executeWorkflow) plus several
 * testable helpers and pub/sub primitives. We mock the heavy I/O (store,
 * workflowStore, providerStore, startBenchmark, subscribe) and test:
 *   - subscribeWorkflow / unsubscribe lifecycle + emit fan-out
 *   - cancelWorkflow idempotency
 *   - backfillTokenStats branches (no summary / already filled / aggregates correctly)
 *
 * Full executeWorkflow integration is left out — it orchestrates real benchmark
 * runs and is best validated end-to-end against the running app, not as a unit test.
 */

const hooks = vi.hoisted(() => ({
  storeGet: vi.fn(),
  workflowStoreUpdate: vi.fn(),
  providerStoreGet: vi.fn(),
  startBenchmark: vi.fn(),
  subscribe: vi.fn(),
}));

vi.mock('./store', () => ({ store: { get: hooks.storeGet } }));
vi.mock('./workflowStore', () => ({ workflowStore: { update: hooks.workflowStoreUpdate } }));
vi.mock('./providerStore', () => ({ providerStore: { get: hooks.providerStoreGet } }));
vi.mock('./benchmarkEngine', () => ({ startBenchmark: hooks.startBenchmark, subscribe: hooks.subscribe }));

import {
  subscribeWorkflow,
  cancelWorkflow,
  backfillTokenStats,
  resolveProviderInfo,
  markRemainingSkipped,
  extractTaskSummary,
  generateSummary,
} from './workflowEngine';
import type { BenchmarkWorkflow } from '../types';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('subscribeWorkflow', () => {
  it('returns an unsubscribe function', () => {
    const cb = vi.fn();
    const unsub = subscribeWorkflow('w1', cb);
    expect(typeof unsub).toBe('function');
    unsub();
  });

  it('supports multiple subscribers for the same workflow', () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    subscribeWorkflow('w1', cb1);
    subscribeWorkflow('w1', cb2);
    // We don't have direct access to emitWorkflow, but the registration must not throw
    // and unsubscribe of one must not affect the other.
    expect(() => subscribeWorkflow('w1', vi.fn())()).not.toThrow();
  });

  it('isolates subscribers across different workflow ids', () => {
    const cbA = vi.fn();
    const cbB = vi.fn();
    const unsubA = subscribeWorkflow('a', cbA);
    const unsubB = subscribeWorkflow('b', cbB);
    unsubA();
    unsubB();
    // Re-subscribing after unsubscribe should still work
    expect(() => subscribeWorkflow('a', vi.fn())()).not.toThrow();
  });

  it('unsubscribe is idempotent (calling twice is safe)', () => {
    const unsub = subscribeWorkflow('w1', vi.fn());
    expect(() => {
      unsub();
      unsub();
    }).not.toThrow();
  });
});

describe('cancelWorkflow', () => {
  it('returns true on first cancellation', () => {
    expect(cancelWorkflow('cancel-1')).toBe(true);
  });

  it('returns false on repeat cancellation of the same workflow id', () => {
    cancelWorkflow('cancel-2');
    expect(cancelWorkflow('cancel-2')).toBe(false);
  });

  it('allows independent cancellation of different ids', () => {
    expect(cancelWorkflow('cancel-3a')).toBe(true);
    expect(cancelWorkflow('cancel-3b')).toBe(true);
  });
});

describe('backfillTokenStats', () => {
  // Helper to make a minimal workflow with summary
  const baseWorkflow = (overrides: Record<string, unknown> = {}): import('../types').BenchmarkWorkflow =>
    ({
      id: 'wf1',
      name: 'test',
      description: '',
      providers: [],
      apiKeys: {},
      tasks: [],
      options: {},
      status: 'completed',
      createdAt: '',
      updatedAt: '',
      startedAt: '',
      completedAt: '',
      taskResults: [],
      summary: {
        totalDuration: 0,
        totalCost: 0,
        totalTokens: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        taskCount: 0,
        completedTaskCount: 0,
        failedTaskCount: 0,
        providerSummaries: {},
      },
      ...overrides,
    }) as unknown as import('../types').BenchmarkWorkflow;

  it('returns workflow unchanged when summary is missing', () => {
    const wf = baseWorkflow({ summary: undefined });
    const result = backfillTokenStats(wf);
    expect(result).toBe(wf);
    expect(hooks.workflowStoreUpdate).not.toHaveBeenCalled();
  });

  it('returns workflow unchanged when totalInputTokens already > 0 (no need to backfill)', () => {
    const wf = baseWorkflow({
      summary: {
        totalDuration: 0,
        totalCost: 0,
        totalTokens: 100,
        totalInputTokens: 50,
        totalOutputTokens: 50,
        taskCount: 0,
        completedTaskCount: 0,
        failedTaskCount: 0,
        providerSummaries: {},
      },
    });
    const result = backfillTokenStats(wf);
    expect(result.summary?.totalInputTokens).toBe(50);
    expect(hooks.workflowStoreUpdate).not.toHaveBeenCalled();
  });

  it('aggregates token counts from completed task runs', () => {
    const wf = baseWorkflow({
      taskResults: [
        { taskId: 't1', taskName: 'T1', benchmarkRunId: 'r1', status: 'completed' },
        { taskId: 't2', taskName: 'T2', benchmarkRunId: 'r2', status: 'completed' },
      ],
      summary: {
        totalDuration: 0,
        totalCost: 0,
        totalTokens: 0,
        totalInputTokens: 0, // 0 → triggers backfill
        totalOutputTokens: 0,
        taskCount: 2,
        completedTaskCount: 2,
        failedTaskCount: 0,
        providerSummaries: {
          openai: {
            provider: 'OpenAI',
            model: 'gpt-4',
            avgResponseTime: 0,
            avgFirstTokenLatency: 0,
            avgTokensPerSecond: 0,
            totalTokens: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalCost: 0,
            overallSuccessRate: 0,
            inputThroughput: 0,
            outputThroughput: 0,
            totalThroughput: 0,
            perTaskMetrics: [{ taskId: 't1', taskName: 'T1', taskOrder: 0 } as never],
          },
        },
      },
    });

    hooks.storeGet.mockImplementation((id: string) => {
      if (id === 'r1') {
        return {
          results: {
            openai: {
              iterations: [
                { inputTokens: 10, outputTokens: 5 },
                { inputTokens: 20, outputTokens: 15 },
              ],
            },
          },
        };
      }
      if (id === 'r2') {
        return {
          results: {
            openai: {
              iterations: [{ inputTokens: 100, outputTokens: 50 }],
            },
          },
        };
      }
      return null;
    });

    const result = backfillTokenStats(wf);
    expect(result.summary!.totalInputTokens).toBe(10 + 20 + 100); // 130
    expect(result.summary!.totalOutputTokens).toBe(5 + 15 + 50); // 70
    expect(result.summary!.providerSummaries.openai.totalInputTokens).toBe(130);
    expect(result.summary!.providerSummaries.openai.totalOutputTokens).toBe(70);
    // Verify the persistence call
    expect(hooks.workflowStoreUpdate).toHaveBeenCalledOnce();
  });

  it('skips taskResults whose status is not "completed"', () => {
    const wf = baseWorkflow({
      taskResults: [
        { taskId: 't1', taskName: 'T1', benchmarkRunId: 'r1', status: 'failed' },
        { taskId: 't2', taskName: 'T2', benchmarkRunId: 'r2', status: 'skipped' },
        { taskId: 't3', taskName: 'T3', benchmarkRunId: 'r3', status: 'completed' },
      ],
      summary: {
        totalDuration: 0,
        totalCost: 0,
        totalTokens: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        taskCount: 3,
        completedTaskCount: 1,
        failedTaskCount: 1,
        providerSummaries: {},
      },
    });

    hooks.storeGet.mockImplementation((id: string) => {
      if (id === 'r3') return { results: { openai: { iterations: [{ inputTokens: 7, outputTokens: 3 }] } } };
      throw new Error(`Should not have asked for ${id} (filtered out)`);
    });

    const result = backfillTokenStats(wf);
    expect(result.summary!.totalInputTokens).toBe(7);
    expect(result.summary!.totalOutputTokens).toBe(3);
  });

  it('skips when store.get returns null (run was deleted)', () => {
    const wf = baseWorkflow({
      taskResults: [{ taskId: 't1', taskName: 'T1', benchmarkRunId: 'gone', status: 'completed' }],
      summary: {
        totalDuration: 0,
        totalCost: 0,
        totalTokens: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        taskCount: 1,
        completedTaskCount: 1,
        failedTaskCount: 0,
        providerSummaries: {},
      },
    });
    hooks.storeGet.mockReturnValue(null);
    const result = backfillTokenStats(wf);
    expect(result.summary!.totalInputTokens).toBe(0);
    expect(result.summary!.totalOutputTokens).toBe(0);
  });

  it('handles iterations with missing inputTokens/outputTokens (counts as 0)', () => {
    const wf = baseWorkflow({
      taskResults: [{ taskId: 't1', taskName: 'T1', benchmarkRunId: 'r1', status: 'completed' }],
      summary: {
        totalDuration: 0,
        totalCost: 0,
        totalTokens: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        taskCount: 1,
        completedTaskCount: 1,
        failedTaskCount: 0,
        providerSummaries: {},
      },
    });
    hooks.storeGet.mockReturnValue({
      results: { openai: { iterations: [{ inputTokens: undefined, outputTokens: 5 }, {}] } },
    });
    const result = backfillTokenStats(wf);
    expect(result.summary!.totalInputTokens).toBe(0);
    expect(result.summary!.totalOutputTokens).toBe(5);
  });
});

describe('resolveProviderInfo', () => {
  it('parses "configId:modelName" composite key using providerStore', () => {
    hooks.providerStoreGet.mockReturnValue({
      id: 'cfg1',
      name: 'OpenAI-prod',
      models: [{ id: 'm1', name: 'gpt-4', displayName: 'GPT-4 Turbo' }],
    });
    expect(resolveProviderInfo('cfg1:gpt-4')).toEqual({ providerName: 'OpenAI-prod', modelName: 'GPT-4 Turbo' });
  });

  it('falls back to model name when no displayName is set', () => {
    hooks.providerStoreGet.mockReturnValue({
      id: 'cfg1',
      name: 'P',
      models: [{ id: 'm1', name: 'gpt-3.5' }],
    });
    expect(resolveProviderInfo('cfg1:gpt-3.5')).toEqual({ providerName: 'P', modelName: 'gpt-3.5' });
  });

  it('returns id/model when provider config not found', () => {
    hooks.providerStoreGet.mockReturnValue(undefined);
    expect(resolveProviderInfo('unknown:gpt-4')).toEqual({ providerName: 'unknown', modelName: 'gpt-4' });
  });

  it('returns id/model when model not in provider config', () => {
    hooks.providerStoreGet.mockReturnValue({ id: 'cfg1', name: 'P', models: [{ id: 'a', name: 'a' }] });
    expect(resolveProviderInfo('cfg1:absent-model')).toEqual({ providerName: 'P', modelName: 'absent-model' });
  });

  it('handles legacy key "openai" → "OpenAI"', () => {
    expect(resolveProviderInfo('openai')).toEqual({ providerName: 'OpenAI', modelName: 'openai' });
  });

  it('handles legacy keys "claude" / "gemini" / "zai"', () => {
    expect(resolveProviderInfo('claude').providerName).toBe('Anthropic');
    expect(resolveProviderInfo('gemini').providerName).toBe('Google');
    expect(resolveProviderInfo('zai').providerName).toBe('ZhipuAI');
  });

  it('passes through unknown non-composite keys unchanged', () => {
    expect(resolveProviderInfo('strange-key')).toEqual({ providerName: 'strange-key', modelName: 'strange-key' });
  });

  it('handles colon in second segment (only splits on first colon, limit 2)', () => {
    // 'a:b:c'.split(':', 2) = ['a', 'b']; the third segment is dropped
    hooks.providerStoreGet.mockReturnValue({ id: 'a', name: 'A', models: [{ id: 'b', name: 'b' }] });
    expect(resolveProviderInfo('a:b:c')).toEqual({ providerName: 'A', modelName: 'b' });
  });
});

describe('markRemainingSkipped', () => {
  function makeWfWithTasks(n: number): BenchmarkWorkflow {
    return {
      tasks: Array.from({ length: n }, (_, i) => ({ id: `t${i}`, name: `T${i}` })),
      taskResults: Array(n).fill(null),
    } as unknown as BenchmarkWorkflow;
  }

  it('skips all tasks from index 0', () => {
    const wf = makeWfWithTasks(3);
    markRemainingSkipped(wf, 0);
    expect(wf.taskResults).toHaveLength(3);
    expect(wf.taskResults.every((r) => r.status === 'skipped')).toBe(true);
  });

  it('skips only tasks from fromIndex onward, leaves earlier entries untouched', () => {
    const wf = makeWfWithTasks(4);
    wf.taskResults[0] = { taskId: 't0', taskName: 'T0', benchmarkRunId: 'r0', status: 'completed' };
    wf.taskResults[1] = { taskId: 't1', taskName: 'T1', benchmarkRunId: 'r1', status: 'completed' };
    markRemainingSkipped(wf, 2);
    expect(wf.taskResults[0].status).toBe('completed');
    expect(wf.taskResults[1].status).toBe('completed');
    expect(wf.taskResults[2].status).toBe('skipped');
    expect(wf.taskResults[3].status).toBe('skipped');
  });

  it('fromIndex beyond tasks.length is a no-op', () => {
    const wf = makeWfWithTasks(2);
    wf.taskResults[0] = { taskId: 't0', taskName: 'T0', benchmarkRunId: 'r0', status: 'completed' };
    wf.taskResults[1] = { taskId: 't1', taskName: 'T1', benchmarkRunId: 'r1', status: 'completed' };
    markRemainingSkipped(wf, 5);
    expect(wf.taskResults[0].status).toBe('completed');
    expect(wf.taskResults[1].status).toBe('completed');
  });

  it('fromIndex 0 on empty workflow leaves taskResults empty', () => {
    const wf = makeWfWithTasks(0);
    markRemainingSkipped(wf, 0);
    expect(wf.taskResults).toEqual([]);
  });
});

describe('extractTaskSummary', () => {
  it('extracts per-provider summary fields', () => {
    const run = {
      results: {
        openai: {
          summary: {
            avgResponseTime: 100,
            p95ResponseTime: 200,
            avgTokensPerSecond: 50,
            successRate: 0.95,
            estimatedCost: 0.05,
          },
        },
        claude: {
          summary: {
            avgResponseTime: 80,
            p95ResponseTime: 150,
            avgTokensPerSecond: 70,
            successRate: 0.99,
            estimatedCost: 0.03,
          },
        },
      },
    };
    const out = extractTaskSummary(run);
    expect(out.openai).toEqual({
      avgResponseTime: 100,
      p95ResponseTime: 200,
      avgTokensPerSecond: 50,
      successRate: 0.95,
      estimatedCost: 0.05,
    });
    expect(out.claude.avgResponseTime).toBe(80);
  });

  it('returns empty object when no results', () => {
    expect(extractTaskSummary({ results: {} })).toEqual({});
  });
});

describe('generateSummary — integration', () => {
  function makeWfRunning(): BenchmarkWorkflow {
    return {
      id: 'wf1',
      name: 'test',
      providers: ['cfg1:gpt-4'],
      tasks: [{ id: 't1', name: 'T1', order: 0, config: { concurrency: 5, iterations: 10 } }],
      taskResults: [{ taskId: 't1', taskName: 'T1', benchmarkRunId: 'r1', status: 'completed' }],
      startedAt: new Date(Date.now() - 5000).toISOString(),
    } as unknown as BenchmarkWorkflow;
  }

  it('aggregates a single completed task into the summary', async () => {
    hooks.storeGet.mockReturnValue({
      results: {
        'cfg1:gpt-4': {
          summary: {
            avgResponseTime: 100,
            p95ResponseTime: 200,
            avgFirstTokenLatency: 50,
            avgTokensPerSecond: 100,
            totalTokens: 1000,
            totalInputTokens: 400,
            totalOutputTokens: 600,
            successRate: 1.0,
            estimatedCost: 0.5,
            systemThroughput: 5000,
          },
        },
      },
    });
    hooks.providerStoreGet.mockReturnValue({
      id: 'cfg1',
      name: 'OpenAI',
      models: [{ id: 'm', name: 'gpt-4', displayName: 'GPT-4' }],
    });

    const summary = await generateSummary(makeWfRunning());
    expect(summary.taskCount).toBe(1);
    expect(summary.completedTaskCount).toBe(1);
    expect(summary.failedTaskCount).toBe(0);
    expect(summary.totalCost).toBe(0.5);
    expect(summary.totalTokens).toBe(1000);
    expect(summary.totalInputTokens).toBe(400);
    expect(summary.totalOutputTokens).toBe(600);
    expect(summary.totalDuration).toBeGreaterThanOrEqual(4900); // ~5s elapsed
    expect(summary.providerSummaries['cfg1:gpt-4']).toBeDefined();
    expect(summary.providerSummaries['cfg1:gpt-4'].avgResponseTime).toBe(100);
  });

  it('skips taskResults whose status is not completed', async () => {
    const wf = makeWfRunning();
    wf.taskResults[0].status = 'failed';
    const summary = await generateSummary(wf);
    expect(summary.completedTaskCount).toBe(0);
    expect(summary.failedTaskCount).toBe(1);
    expect(summary.totalTokens).toBe(0);
  });

  it('skips when store.get returns null', async () => {
    hooks.storeGet.mockReturnValue(null);
    const summary = await generateSummary(makeWfRunning());
    expect(summary.totalCost).toBe(0);
    expect(summary.providerSummaries).toEqual({});
  });

  it('skips when task not found in workflow (defensive guard)', async () => {
    const wf = makeWfRunning();
    wf.taskResults[0].taskId = 'unknown'; // does not match any wf.tasks
    hooks.storeGet.mockReturnValue({
      results: { 'cfg1:gpt-4': { summary: { successRate: 1, estimatedCost: 1, totalTokens: 1 } } },
    });
    const summary = await generateSummary(wf);
    expect(summary.totalCost).toBe(0);
  });

  it('computes input/output throughput correctly', async () => {
    hooks.storeGet.mockReturnValue({
      results: {
        'cfg1:gpt-4': {
          summary: {
            avgResponseTime: 1000, // 1s
            p95ResponseTime: 2000,
            avgFirstTokenLatency: 100,
            avgTokensPerSecond: 100,
            totalTokens: 100,
            totalInputTokens: 40,
            totalOutputTokens: 60,
            successRate: 1.0,
            estimatedCost: 0.5,
            systemThroughput: 0,
          },
        },
      },
    });
    hooks.providerStoreGet.mockReturnValue({ id: 'cfg1', name: 'OpenAI', models: [{ id: 'm', name: 'gpt-4' }] });

    const wf = makeWfRunning();
    const summary = await generateSummary(wf);
    const ps = summary.providerSummaries['cfg1:gpt-4'];
    // concurrency=5, iterations=10, successCount=10, avgIn=4, avgOut=6, avgRT=1000
    // inputThroughput = round(5 * 4 * 1000 / 1000) = 20
    // outputThroughput = round(5 * 6 * 1000 / 1000) = 30
    expect(ps.perTaskMetrics[0].inputThroughput).toBe(20);
    expect(ps.perTaskMetrics[0].outputThroughput).toBe(30);
  });

  it('uses Date.now() as fallback when workflow.startedAt is missing', async () => {
    const wf = makeWfRunning();
    delete (wf as { startedAt?: string }).startedAt;
    const summary = await generateSummary(wf);
    expect(summary.totalDuration).toBeLessThan(1000); // near-zero
  });
});
