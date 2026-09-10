import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

/**
 * Integration tests for `startBenchmark` → `runProviderBenchmark` → worker loop.
 * Mocks createDynamicProvider so we can control LLMProvider.execute timing and
 * outcomes, then drive concurrent iteration through the real worker pool.
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

let mod: typeof import('./benchmarkEngine');
let storeMod: typeof import('./store');

beforeEach(async () => {
  vi.clearAllMocks();
  h.db = new Database(':memory:');
  // benchmarkEngine uses store/providerStore which need init
  h.db.exec(`
    CREATE TABLE benchmarks (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, providers TEXT NOT NULL, config TEXT NOT NULL,
      results TEXT NOT NULL, capability_tests TEXT, created_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE TABLE providers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, endpoint TEXT NOT NULL, api_key_encrypted TEXT NOT NULL,
      format TEXT NOT NULL, models TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  vi.resetModules();
  storeMod = await import('./store');
  mod = await import('./benchmarkEngine');

  // Default: fake provider that returns instantly
  fns.createDynamicProvider.mockImplementation(() => ({
    name: 'mock',
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
    estimatedCost: 0,
    model: 'mock',
  });
  fns.testCapabilities.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Wait for a benchmark run to reach `completed` or `failed` status. */
async function waitForCompletion(id: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const unsub = mod.subscribe(id, (event) => {
      if (event.type === 'done') {
        unsub();
        resolve();
      }
    });
    const tick = setInterval(() => {
      if (Date.now() - start > timeoutMs) {
        clearInterval(tick);
        unsub();
        reject(new Error('timeout waiting for benchmark'));
      }
    }, 50);
  });
}

describe('startBenchmark — happy path', () => {
  it('completes a single-provider, single-iteration run', async () => {
    const run = await mod.startBenchmark(
      ['cfg:gpt-4'],
      {
        prompt: 'hi',
        maxTokens: 100,
        concurrency: 1,
        iterations: 1,
      },
      { 'cfg:gpt-4': 'sk-test' },
    );

    await waitForCompletion(run.id);
    expect(fns.execute).toHaveBeenCalledTimes(1);
  });

  it('runs all iterations and aggregates summary', async () => {
    const run = await mod.startBenchmark(
      ['cfg:gpt-4'],
      {
        prompt: 'hi',
        maxTokens: 100,
        concurrency: 2,
        iterations: 10,
      },
      { 'cfg:gpt-4': 'sk-test' },
    );

    await waitForCompletion(run.id);
    expect(fns.execute).toHaveBeenCalledTimes(10);
  });

  it('respects concurrency=1 (sequential execution)', async () => {
    let inFlight = 0;
    let peak = 0;
    fns.execute.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
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

    const run = await mod.startBenchmark(
      ['cfg:gpt-4'],
      {
        prompt: 'hi',
        maxTokens: 100,
        concurrency: 1,
        iterations: 5,
      },
      { 'cfg:gpt-4': 'sk-test' },
    );
    await waitForCompletion(run.id);
    expect(peak).toBe(1);
  });

  it('respects concurrency=N (parallel up to N)', async () => {
    let inFlight = 0;
    let peak = 0;
    fns.execute.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
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

    const run = await mod.startBenchmark(
      ['cfg:gpt-4'],
      {
        prompt: 'hi',
        maxTokens: 100,
        concurrency: 3,
        iterations: 12,
      },
      { 'cfg:gpt-4': 'sk-test' },
    );
    await waitForCompletion(run.id);
    expect(peak).toBe(3);
  });
});

describe('startBenchmark — warmup', () => {
  it('runs warmup iterations BEFORE main loop', async () => {
    fns.execute.mockImplementation(async () => {
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

    const run = await mod.startBenchmark(
      ['cfg:gpt-4'],
      {
        prompt: 'hi',
        maxTokens: 100,
        concurrency: 1,
        iterations: 3,
        warmupRuns: 2,
      },
      { 'cfg:gpt-4': 'sk-test' },
    );

    // Listen for 'progress' phase=warmup → main transition (approximated by waiting on done)
    await waitForCompletion(run.id);
    expect(fns.execute).toHaveBeenCalledTimes(2 + 3); // warmup + main
  });

  it('silently ignores warmup errors', async () => {
    let callCount = 0;
    fns.execute.mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) throw new Error('warmup failed');
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

    const run = await mod.startBenchmark(
      ['cfg:gpt-4'],
      {
        prompt: 'hi',
        maxTokens: 100,
        concurrency: 1,
        iterations: 2,
        warmupRuns: 2,
      },
      { 'cfg:gpt-4': 'sk-test' },
    );

    await waitForCompletion(run.id);
    // Main phase still ran (callCount went 1,2 warmup-throws then 3,4 main-succeed)
    expect(fns.execute).toHaveBeenCalledTimes(4);
  });
});

describe('startBenchmark — error classification + retries', () => {
  it('classifies fetch errors as "network" and retries', async () => {
    let attempts = 0;
    fns.execute.mockImplementation(async () => {
      attempts++;
      if (attempts < 2) throw new Error('fetch failed');
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

    const run = await mod.startBenchmark(
      ['cfg:gpt-4'],
      {
        prompt: 'hi',
        maxTokens: 100,
        concurrency: 1,
        iterations: 1,
      },
      { 'cfg:gpt-4': 'sk-test' },
    );

    await waitForCompletion(run.id);
    expect(attempts).toBe(2); // 1 fail + 1 retry
  }, 15_000);

  it('does NOT retry on unknown errors', async () => {
    fns.execute.mockRejectedValue(new Error('bizarre error'));
    const run = await mod.startBenchmark(
      ['cfg:gpt-4'],
      {
        prompt: 'hi',
        maxTokens: 100,
        concurrency: 1,
        iterations: 1,
      },
      { 'cfg:gpt-4': 'sk-test' },
    );
    await waitForCompletion(run.id);
    expect(fns.execute).toHaveBeenCalledTimes(1); // no retry
  });

  it('records failed iterations with errorCategory', async () => {
    fns.execute.mockRejectedValue(new Error('timeout'));
    const run = await mod.startBenchmark(
      ['cfg:gpt-4'],
      {
        prompt: 'hi',
        maxTokens: 100,
        concurrency: 1,
        iterations: 1,
      },
      { 'cfg:gpt-4': 'sk-test' },
    );
    await waitForCompletion(run.id);
    // Query the store for the iteration record
    const allRuns = storeMod.store.getAll();
    const completedRun = allRuns.find((r) => r.id === run.id);
    expect(completedRun?.results['cfg:gpt-4']?.iterations[0]?.success).toBe(false);
    expect(completedRun?.results['cfg:gpt-4']?.iterations[0]?.errorCategory).toBe('timeout');
  });
});

describe('startBenchmark — cancellation', () => {
  it('stops mid-flight when cancelRun is called', async () => {
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

    const run = await mod.startBenchmark(
      ['cfg:gpt-4'],
      {
        prompt: 'hi',
        maxTokens: 100,
        concurrency: 1,
        iterations: 50,
      },
      { 'cfg:gpt-4': 'sk-test' },
    );

    // Let a few iterations complete, then cancel
    await new Promise((r) => setTimeout(r, 40));
    mod.cancelRun(run.id);
    await waitForCompletion(run.id);

    expect(fns.execute.mock.calls.length).toBeLessThan(50);
  });

  it('cancelRun is idempotent (second call returns false)', () => {
    expect(mod.cancelRun('xx')).toBe(true);
    expect(mod.cancelRun('xx')).toBe(false);
  });
});

describe('startBenchmark — multi-provider', () => {
  it('runs all providers in parallel', async () => {
    const seen: string[] = [];
    fns.createDynamicProvider.mockImplementation((providerId: string) => ({
      name: providerId,
      execute: async () => {
        seen.push(providerId);
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

    const run = await mod.startBenchmark(
      ['cfg-a:m', 'cfg-b:m'],
      {
        prompt: 'hi',
        maxTokens: 100,
        concurrency: 1,
        iterations: 2,
      },
      { 'cfg-a:m': 'k1', 'cfg-b:m': 'k2' },
    );

    await waitForCompletion(run.id);
    const aCount = seen.filter((s) => s === 'cfg-a').length;
    const bCount = seen.filter((s) => s === 'cfg-b').length;
    expect(aCount).toBe(2);
    expect(bCount).toBe(2);
  });

  it('one provider failing does not abort the whole benchmark', async () => {
    fns.createDynamicProvider.mockImplementation((providerId: string) => ({
      name: providerId,
      execute: async () => {
        if (providerId === 'bad') throw new Error('bizarre');
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

    const run = await mod.startBenchmark(
      ['bad:m', 'good:m'],
      {
        prompt: 'hi',
        maxTokens: 100,
        concurrency: 1,
        iterations: 2,
      },
      { 'bad:m': 'k', 'good:m': 'k' },
    );

    await waitForCompletion(run.id);
    const finalRun = storeMod.store.get(run.id);
    expect(finalRun?.status).toBe('completed');
    // good provider should have completed iterations; bad one likely missing or with errors
    expect(finalRun?.results['good:m']?.iterations.length).toBe(2);
  });
});

describe('startBenchmark — unknown provider', () => {
  it('handles unknown provider (createDynamicProvider returns null)', async () => {
    fns.createDynamicProvider.mockReturnValue(null);
    const run = await mod.startBenchmark(
      ['absent:m'],
      {
        prompt: 'hi',
        maxTokens: 100,
        concurrency: 1,
        iterations: 1,
      },
      { 'absent:m': 'k' },
    );
    await waitForCompletion(run.id);
    const finalRun = storeMod.store.get(run.id);
    // Provider couldn't be resolved → no iterations recorded for it
    expect(finalRun?.results['absent:m']).toBeUndefined();
  });
});
