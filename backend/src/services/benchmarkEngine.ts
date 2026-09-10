import { v4 as uuidv4 } from 'uuid';
import { randomBytes } from 'crypto';
import {
  BenchmarkConfig,
  BenchmarkRun,
  ErrorCategory,
  ImageInput,
  IterationResult,
  LLMProvider,
  LLMResponse,
  ProviderResult,
  ProviderSummary,
  SSEEvent,
} from '../types';
import { store } from './store';
import { testCapabilities } from './capabilityTester';
import { OpenAIProvider, DEFAULT_OPENAI_MODEL } from '../providers/openai';
import { ClaudeProvider, DEFAULT_CLAUDE_MODEL } from '../providers/claude';
import { GeminiProvider, DEFAULT_GEMINI_MODEL } from '../providers/gemini';
import { ZaiProvider, DEFAULT_ZAI_MODEL } from '../providers/zai';
import { createDynamicProvider } from '../providers/adapter';
import { providerStore } from './providerStore';
import { classifyError, isRetryableError } from '../utils/providerError';

// Re-exported so existing callers and tests keep a single import site.
export { classifyError };

/**
 * Resolve a provider name to an LLMProvider instance.
 * Supports: legacy IDs (openai, claude, etc.), configId:modelName, or bare configId.
 *
 * Legacy providers now accept an explicit model instead of hardcoding one, so
 * retired model IDs can no longer be baked into the binary.
 */
function resolveProvider(providerName: string, _apiKey: string, model?: string): LLMProvider | null {
  switch (providerName) {
    case 'openai':
      return new OpenAIProvider(model || DEFAULT_OPENAI_MODEL);
    case 'claude':
      return new ClaudeProvider(model || DEFAULT_CLAUDE_MODEL);
    case 'gemini':
      return new GeminiProvider(model || DEFAULT_GEMINI_MODEL);
    case 'zai':
      return new ZaiProvider(model || DEFAULT_ZAI_MODEL);
    default:
      break;
  }

  // Try configId:modelName format
  if (providerName.includes(':')) {
    const [configId, modelName] = providerName.split(':', 2);
    const dp = createDynamicProvider(configId, modelName);
    if (dp) return dp;
  }

  // Try as a bare config ID — use first active model
  const config = providerStore.get(providerName);
  if (config) {
    const activeModel = config.models.find((m) => m.isActive !== false);
    if (activeModel) {
      const dp = createDynamicProvider(providerName, activeModel.name);
      if (dp) return dp;
    }
  }

  return null;
}

type EventCallback = (event: SSEEvent) => void;

const activeListeners: Map<string, Set<EventCallback>> = new Map();
const cancelledRuns: Set<string> = new Set();

// ── Token Bucket (per-benchmark, lazy-refill) ────────────────────────────────
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly intervalMs: number;

  constructor(maxQps: number) {
    this.intervalMs = 1000 / maxQps;
    this.tokens = 1; // pre-charge one token so the first request is immediate
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const newTokens = elapsed / this.intervalMs;
    if (newTokens >= 1) {
      // Advance lastRefill by whole intervals only, preserving fractional progress
      const wholeIntervals = Math.floor(newTokens);
      this.lastRefill += wholeIntervals * this.intervalMs;
      this.tokens = Math.min(1, this.tokens + wholeIntervals);
    }
  }

  tryAcquire(): number {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0; // got a token immediately
    }
    // Time until next token is available
    return this.intervalMs - (Date.now() - this.lastRefill);
  }
}

const tokenBuckets: Map<string, TokenBucket> = new Map();

async function acquireToken(benchmarkId: string, maxQps: number): Promise<void> {
  if (!maxQps || maxQps <= 0) return;
  if (!tokenBuckets.has(benchmarkId)) {
    tokenBuckets.set(benchmarkId, new TokenBucket(maxQps));
  }
  const bucket = tokenBuckets.get(benchmarkId)!;
  while (true) {
    const waitMs = bucket.tryAcquire();
    if (waitMs <= 0) return;
    if (isCancelled(benchmarkId)) return;
    await sleep(Math.ceil(waitMs), benchmarkId);
    if (isCancelled(benchmarkId)) return;
  }
}

export function isCancelled(benchmarkId: string): boolean {
  return cancelledRuns.has(benchmarkId);
}

export function cancelRun(benchmarkId: string): boolean {
  if (cancelledRuns.has(benchmarkId)) {
    return false;
  }
  cancelledRuns.add(benchmarkId);
  emit(benchmarkId, { type: 'error', data: { message: 'Benchmark cancelled by user' } });
  return true;
}

export function subscribe(benchmarkId: string, callback: EventCallback): () => void {
  if (!activeListeners.has(benchmarkId)) {
    activeListeners.set(benchmarkId, new Set());
  }
  activeListeners.get(benchmarkId)!.add(callback);

  return () => {
    const listeners = activeListeners.get(benchmarkId);
    if (listeners) {
      listeners.delete(callback);
      if (listeners.size === 0) {
        activeListeners.delete(benchmarkId);
      }
    }
  };
}

function emit(benchmarkId: string, event: SSEEvent): void {
  const listeners = activeListeners.get(benchmarkId);
  if (listeners) {
    listeners.forEach((cb) => cb(event));
  }
}

/**
 * Percentile with linear interpolation between closest ranks (the numpy /
 * Prometheus default). Nearest-rank was previously used, which on small samples
 * made p95 collapse onto the maximum and p50 of two values return the lower one.
 */
export function calculatePercentile(values: number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];

  const rank = (percentile / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (rank - lower) * (sorted[upper] - sorted[lower]);
}

// Sleep utility with cancellation support
function sleep(ms: number, benchmarkId: string): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Check cancellation every 100ms for responsiveness
    const check = setInterval(() => {
      if (isCancelled(benchmarkId)) {
        clearTimeout(timer);
        clearInterval(check);
        resolve();
      }
    }, 100);
    setTimeout(() => {
      clearInterval(check);
    }, ms + 10);
  });
}

// Generate a random prefix sized to the prompt to bust KV-cache blocks.
// The prefix scales with input size: ~5% of prompt length, clamped to
// [128 chars, 4096 chars] (~32–1024 tokens). Uses base62 characters with
// spaces every 4-6 chars to form realistic token boundaries.
const BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
export function generateRandomPrefix(promptLength: number): string {
  const targetChars = Math.min(4096, Math.max(128, Math.round(promptLength * 0.05)));
  const bytes = randomBytes(targetChars);
  let result = '';
  for (let i = 0; i < bytes.length; i++) {
    result += BASE62[bytes[i] % 62];
    if (i > 0 && i % (4 + (bytes[i] % 3)) === 0) result += ' ';
  }
  return result;
}

export interface RetryOutcome {
  response: LLMResponse;
  /** How many retries were consumed (0 = succeeded first try). */
  retries: number;
  /**
   * Wall-clock milliseconds from the first attempt to the final result,
   * including exponential-backoff sleeps. `response.responseTime` only covers
   * the final attempt, so it understates what the caller actually waited.
   */
  e2eTime: number;
}

// Exponential backoff retry
export async function executeWithRetry(
  provider: LLMProvider,
  prompt: string,
  systemPrompt: string | undefined,
  maxTokens: number,
  apiKey: string,
  streaming: boolean | undefined,
  images: ImageInput[] | undefined,
  maxRetries: number = 2,
): Promise<RetryOutcome> {
  const start = Date.now();
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await provider.execute(prompt, systemPrompt, maxTokens, apiKey, streaming, images);
      return { response, retries: attempt, e2eTime: Date.now() - start };
    } catch (error) {
      lastError = error;
      // Retry on rate limits, network blips, and transient 5xx — never on 4xx.
      if (attempt < maxRetries && isRetryableError(error)) {
        const backoffMs = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 10000);
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

/**
 * Duration attributable to one iteration.
 * Successful requests report their own response time; failed ones report how
 * long they burned before failing, because that time was really spent.
 */
function latencyOf(iteration: IterationResult): number | null {
  const value = iteration.e2eTime ?? iteration.responseTime;
  return value > 0 ? value : null;
}

export function calculateSummary(iterations: IterationResult[], totalTestDurationMs?: number): ProviderSummary {
  const successful = iterations.filter((i) => i.success);
  // Include failed requests that consumed measurable time: a 180s timeout
  // genuinely took 180s and must not vanish from the latency distribution.
  const latencySamples = iterations.map(latencyOf).filter((v): v is number => v !== null);
  const firstTokenLatencies = successful
    .map((i) => i.firstTokenLatency)
    .filter((v): v is number => typeof v === 'number' && v > 0);

  const errorBreakdown = buildErrorBreakdown(iterations);
  const sampleSize = iterations.length;
  const retryCount = iterations.reduce((a, b) => a + (b.retries ?? 0), 0);

  if (successful.length === 0) {
    return {
      avgResponseTime: 0,
      p50ResponseTime: 0,
      p95ResponseTime: 0,
      p99ResponseTime: 0,
      avgTokensPerSecond: 0,
      avgFirstTokenLatency: null,
      p50FirstTokenLatency: null,
      p95FirstTokenLatency: null,
      p99FirstTokenLatency: null,
      totalTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      estimatedCost: 0,
      successRate: 0,
      errorCount: iterations.length,
      errorBreakdown,
      totalTestDuration: totalTestDurationMs,
      sampleSize,
      stdDevResponseTime: 0,
      cvResponseTime: 0,
      retryCount,
      retryRate: sampleSize > 0 ? retryCount / sampleSize : 0,
      ttftSampleCount: 0,
      hasRetries: retryCount > 0,
    };
  }

  const responseTimes = latencySamples;
  const mean = responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length;
  const variance = responseTimes.reduce((a, b) => a + (b - mean) ** 2, 0) / responseTimes.length;
  const stdDev = Math.sqrt(variance);

  // System throughput: total output tokens over wall-clock time.
  const totalOutputTokens = successful.reduce((a, b) => a + b.outputTokens, 0);
  let systemThroughput: number;
  if (totalTestDurationMs && totalTestDurationMs > 0) {
    systemThroughput = Math.round((totalOutputTokens * 1000) / totalTestDurationMs);
  } else {
    const batchMaxTime = Math.max(...responseTimes);
    systemThroughput = batchMaxTime > 0 ? Math.round((totalOutputTokens * 1000) / batchMaxTime) : 0;
  }

  // Ratio of means, not mean of ratios. Averaging per-request tokens/sec lets
  // very short requests dominate and inflates the headline number.
  const totalSuccessfulMs = successful.reduce((a, b) => a + b.responseTime, 0);
  const avgTokensPerSecond = totalSuccessfulMs > 0 ? (totalOutputTokens * 1000) / totalSuccessfulMs : 0;

  return {
    avgResponseTime: Math.round(mean),
    p50ResponseTime: Math.round(calculatePercentile(responseTimes, 50)),
    p95ResponseTime: Math.round(calculatePercentile(responseTimes, 95)),
    p99ResponseTime: Math.round(calculatePercentile(responseTimes, 99)),
    avgTokensPerSecond: Math.round(avgTokensPerSecond),
    avgFirstTokenLatency:
      firstTokenLatencies.length > 0
        ? Math.round(firstTokenLatencies.reduce((a, b) => a + b, 0) / firstTokenLatencies.length)
        : null,
    p50FirstTokenLatency:
      firstTokenLatencies.length > 0 ? Math.round(calculatePercentile(firstTokenLatencies, 50)) : null,
    p95FirstTokenLatency:
      firstTokenLatencies.length > 0 ? Math.round(calculatePercentile(firstTokenLatencies, 95)) : null,
    p99FirstTokenLatency:
      firstTokenLatencies.length > 0 ? Math.round(calculatePercentile(firstTokenLatencies, 99)) : null,
    totalTokens: iterations.reduce((a, b) => a + b.totalTokens, 0),
    totalInputTokens: iterations.reduce((a, b) => a + b.inputTokens, 0),
    totalOutputTokens,
    estimatedCost: Number(iterations.reduce((a, b) => a + b.estimatedCost, 0).toFixed(6)),
    successRate: successful.length / iterations.length,
    errorCount: iterations.length - successful.length,
    systemThroughput,
    errorBreakdown,
    totalTestDuration: totalTestDurationMs,
    sampleSize,
    stdDevResponseTime: Math.round(stdDev),
    cvResponseTime: mean > 0 ? Number((stdDev / mean).toFixed(4)) : 0,
    retryCount,
    retryRate: sampleSize > 0 ? Number((retryCount / sampleSize).toFixed(4)) : 0,
    ttftSampleCount: firstTokenLatencies.length,
    hasRetries: retryCount > 0,
  };
}

export function buildErrorBreakdown(iterations: IterationResult[]): Record<ErrorCategory, number> {
  const breakdown: Record<ErrorCategory, number> = {
    timeout: 0,
    rate_limit: 0,
    api_error: 0,
    network: 0,
    // Only the quality engine produces this one; benchmarks keep the bucket at
    // zero so both modules report the same category set.
    empty_response: 0,
    unknown: 0,
  };
  iterations
    .filter((i) => !i.success && i.errorCategory)
    .forEach((i) => {
      breakdown[i.errorCategory!]++;
    });
  return breakdown;
}

async function runProviderBenchmark(
  benchmarkId: string,
  providerName: string,
  config: BenchmarkConfig,
  apiKey: string,
): Promise<ProviderResult> {
  const maybeProvider = resolveProvider(providerName, apiKey, config.model);
  if (!maybeProvider) {
    throw new Error(`Unknown provider: ${providerName}`);
  }
  const provider: LLMProvider = maybeProvider;

  const iterations: IterationResult[] = [];
  const { concurrency, iterations: totalIterations } = config;
  const warmupRuns = config.warmupRuns ?? 0;
  const requestInterval = config.requestInterval ?? 0;
  const randomizeInterval = config.randomizeInterval ?? false;
  const maxQps = config.maxQps ?? 0;

  // Build random-prefix schedule for cache hit rate control.
  // Each request independently rolls: P(new prefix) = 1 − rate,
  // P(reuse existing) = rate. Reuse picks from a sliding window of
  // the most recent prefixes (sized to concurrency) so the chosen
  // prefix is still likely warm in the inference engine's KV cache
  // (SGLang/vLLM evict old entries under memory pressure).
  //
  // Prefix size adapts to prompt length (~5%, clamped 128–4096 chars)
  // so short prompts aren't bloated while long prompts still bust
  // block-level KV cache reliably.
  let variantSchedule: string[] | null = null;
  if (config.targetCacheHitRate !== undefined && config.targetCacheHitRate < 1) {
    const schedule: string[] = [];
    const pool: string[] = [];
    const promptLen = config.prompt.length;
    // Keep the reuse window small (5) so the inference engine can hold
    // all warm entries in KV cache — especially important for large
    // prompts where each entry consumes significant GPU memory.
    const windowSize = 5;

    for (let i = 0; i < totalIterations; i++) {
      if (pool.length === 0 || Math.random() >= config.targetCacheHitRate) {
        // New unique prefix → cache miss when first executed
        const p = generateRandomPrefix(promptLen);
        pool.push(p);
        schedule.push(p);
      } else {
        // Reuse a recent prefix → likely still in KV cache
        const windowStart = Math.max(0, pool.length - windowSize);
        const idx = windowStart + Math.floor(Math.random() * (pool.length - windowStart));
        schedule.push(pool[idx]);
      }
    }
    variantSchedule = schedule;
  }

  // === Warmup Phase ===
  if (warmupRuns > 0) {
    emit(benchmarkId, {
      type: 'progress',
      data: {
        provider: providerName,
        phase: 'warmup',
        completed: 0,
        total: warmupRuns,
      },
    });

    for (let w = 0; w < warmupRuns; w++) {
      if (isCancelled(benchmarkId)) {
        throw new Error('Benchmark cancelled by user');
      }
      const warmupStart = Date.now();
      try {
        const warmupPrompt = variantSchedule
          ? `${variantSchedule[w % variantSchedule.length]}\n${config.prompt}`
          : config.prompt;
        await provider.execute(
          warmupPrompt,
          config.systemPrompt,
          config.maxTokens,
          apiKey,
          config.streaming,
          config.images,
        );
      } catch (error) {
        // Warmup failures are not scored, but they are recorded: a provider
        // that cannot complete warmup will not produce trustworthy numbers.
        emit(benchmarkId, {
          type: 'error',
          data: {
            provider: providerName,
            phase: 'warmup',
            error: error instanceof Error ? error.message : 'Unknown warmup error',
            durationMs: Date.now() - warmupStart,
          },
        });
      }

      emit(benchmarkId, {
        type: 'progress',
        data: {
          provider: providerName,
          phase: 'warmup',
          completed: w + 1,
          total: warmupRuns,
        },
      });
    }
  }

  // === Main Test Phase ===
  const testStartTime = Date.now();

  let nextIndex = 0;
  let completedCount = 0;

  async function worker(): Promise<void> {
    while (true) {
      // Claim the next iteration index (atomic in JS single-threaded event loop)
      const iterIndex = nextIndex;
      if (iterIndex >= totalIterations) break;
      nextIndex++;

      if (isCancelled(benchmarkId)) return;

      // Token bucket rate limiting
      await acquireToken(benchmarkId, maxQps);
      if (isCancelled(benchmarkId)) return;

      const iterationStart = Date.now();
      let result: IterationResult;
      try {
        const effectivePrompt = variantSchedule ? `${variantSchedule[iterIndex]}\n${config.prompt}` : config.prompt;

        const { response, retries, e2eTime } = await executeWithRetry(
          provider,
          effectivePrompt,
          config.systemPrompt,
          config.maxTokens,
          apiKey,
          config.streaming,
          config.images,
        );

        result = {
          iteration: iterIndex + 1,
          responseTime: response.responseTime,
          firstTokenLatency: response.firstTokenLatency,
          tokensPerSecond: response.responseTime > 0 ? Math.round((response.outputTokens / response.responseTime) * 1000) : 0,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          reasoningTokens: response.reasoningTokens,
          totalTokens: response.totalTokens,
          estimatedCost: response.estimatedCost,
          success: true,
          retries,
          e2eTime,
        };
      } catch (error) {
        const errorCategory = classifyError(error);
        result = {
          iteration: iterIndex + 1,
          // Record the time actually burned before failure. Zero would erase
          // slow failures (timeouts) from the latency distribution.
          responseTime: Date.now() - iterationStart,
          firstTokenLatency: null,
          tokensPerSecond: 0,
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          totalTokens: 0,
          estimatedCost: 0,
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
          errorCategory,
          e2eTime: Date.now() - iterationStart,
        };
      }

      iterations.push(result);
      completedCount++;

      // Per-request progress event
      emit(benchmarkId, {
        type: 'progress',
        data: {
          provider: providerName,
          phase: 'testing',
          completed: completedCount,
          total: totalIterations,
          latestResults: [result],
        },
      });

      // Per-request interval (applied after completing a request, before starting the next)
      if (requestInterval > 0) {
        const interval = randomizeInterval ? Math.round(requestInterval * (0.5 + Math.random())) : requestInterval;
        await sleep(interval, benchmarkId);
        if (isCancelled(benchmarkId)) return;
      }
    }
  }

  // Spawn `concurrency` workers to maintain steady in-flight request count
  const workerCount = Math.min(concurrency, totalIterations);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (isCancelled(benchmarkId)) {
    throw new Error('Benchmark cancelled by user');
  }

  const totalTestDuration = Date.now() - testStartTime;

  // Determine model name — for dynamic providers, extract from provider name or provider key
  let model: string;
  if (providerName.includes(':')) {
    model = providerName.split(':', 2)[1];
  } else {
    model = config.model || provider.name || providerName;
  }

  const result: ProviderResult = {
    provider: providerName,
    model,
    iterations,
    summary: calculateSummary(iterations, totalTestDuration),
  };

  emit(benchmarkId, {
    type: 'complete',
    data: { provider: providerName, summary: result.summary },
  });

  return result;
}

export async function startBenchmark(
  providerNames: string[],
  config: BenchmarkConfig,
  apiKeys: Record<string, string>,
): Promise<BenchmarkRun> {
  const id = `bench_${uuidv4().slice(0, 8)}`;

  const run: BenchmarkRun = {
    id,
    status: 'running',
    providers: providerNames,
    config,
    results: {},
    createdAt: new Date().toISOString(),
  };

  store.create(run);

  const providerPromises = providerNames.map(async (name) => {
    try {
      const result = await runProviderBenchmark(id, name, config, apiKeys[name] || '');
      run.results[name] = result;
    } catch (error) {
      emit(id, {
        type: 'error',
        data: {
          provider: name,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
      });
    }
  });

  Promise.all(providerPromises)
    .then(async () => {
      if (isCancelled(id)) {
        run.status = 'failed';
        run.completedAt = new Date().toISOString();
        store.update(id, run);
        emit(id, { type: 'done', data: { id, cancelled: true } });
        cancelledRuns.delete(id);
        tokenBuckets.delete(id);
        return;
      }

      try {
        const testProvider = providerNames.find((name) => apiKeys[name]);
        if (testProvider) {
          run.capabilityTests = await testCapabilities(testProvider, apiKeys[testProvider]);
        }
      } catch (err) {
        console.error('Capability tests failed:', err);
      }

      run.status = 'completed';
      run.completedAt = new Date().toISOString();
      store.update(id, run);
      cancelledRuns.delete(id);
      tokenBuckets.delete(id);
      emit(id, { type: 'done', data: { id } });
    })
    .catch((err) => {
      console.error('Benchmark completion error:', err);
      cancelledRuns.delete(id);
      tokenBuckets.delete(id);
      run.status = 'failed';
      run.completedAt = new Date().toISOString();
      try {
        store.update(id, run);
      } catch (storeErr) {
        console.error('Failed to update failed benchmark:', storeErr);
      }
      emit(id, { type: 'done', data: { id, error: 'Internal error' } });
    });

  return run;
}
