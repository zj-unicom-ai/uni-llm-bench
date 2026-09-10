import { randomUUID } from 'crypto';
import {
  ErrorCategory,
  QualityCategoryBreakdown,
  QualityRun,
  QualityRunParams,
  QualitySample,
  QualitySampleResult,
  QualityTargetSummary,
} from '../types';
import { GenerationParams, DynamicProvider, createDynamicProvider } from '../providers/adapter';
import { resolveProbeTarget } from './probeClient';
import { gradeSample } from './graders';
import { classifyError } from '../utils/providerError';
import { qualityRunStore } from './qualityRunStore';

/**
 * The quality evaluation engine.
 *
 * Runs every sample in a frozen dataset against every target model, grades each
 * response locally, and aggregates a per-target report.
 *
 * The rule that shapes this whole file: a provider failure produces `error`, not
 * `fail`. A run where every request 401s must report 0% success and N errors —
 * never a plausible-looking accuracy figure. `summarize()` returns `null` rather
 * than 0 for a rate that has no judgeable sample behind it, and the contract test
 * asserts it.
 */

export interface QualitySseEvent {
  type: string;
  data: unknown;
}

type Listener = (event: QualitySseEvent) => void;

const subscribers = new Map<string, Set<Listener>>();
const cancelledRuns = new Set<string>();

/** Cap the in-flight requests regardless of what the client asks for. */
const MAX_CONCURRENCY = 16;
/**
 * Default output cap. 1024 is not enough for a reasoning model: it can spend the
 * entire budget on hidden reasoning and never emit an answer, which shows up as
 * an empty response. This is a ceiling, not a spend — unused tokens cost nothing.
 */
const DEFAULT_MAX_TOKENS = 4096;

export function subscribeQualityRun(runId: string, listener: Listener): () => void {
  let set = subscribers.get(runId);
  if (!set) {
    set = new Set();
    subscribers.set(runId, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) subscribers.delete(runId);
  };
}

function emit(runId: string, event: QualitySseEvent): void {
  const set = subscribers.get(runId);
  if (!set) return;
  for (const listener of set) {
    try {
      listener(event);
    } catch {
      // A broken pipe must not take the run down with it.
    }
  }
}

/** Ask a run to stop. Samples already in flight finish; no new ones start. */
export function cancelQualityRun(runId: string): boolean {
  const run = qualityRunStore.get(runId);
  if (!run || run.status !== 'running') return false;
  cancelledRuns.add(runId);
  return true;
}

/* -------------------------------------------------------------------------- */
/* Execution                                                                  */
/* -------------------------------------------------------------------------- */

/** Build and persist a new run in `pending`. The caller starts it afterwards. */
export function createQualityRun(input: {
  name: string;
  description?: string;
  datasetId: string;
  datasetName: string;
  datasetSnapshot: QualitySample[];
  targets: string[];
  targetLabels: Record<string, string>;
  params: Partial<QualityRunParams>;
}): QualityRun {
  const run: QualityRun = {
    id: `qr_${randomUUID().slice(0, 8)}`,
    name: input.name,
    description: input.description,
    status: 'pending',
    datasetId: input.datasetId,
    datasetName: input.datasetName,
    datasetSnapshot: input.datasetSnapshot,
    targets: input.targets,
    targetLabels: input.targetLabels,
    params: {
      // Reproducibility beats variety: default to greedy decoding so two runs of
      // the same suite are comparable.
      temperature: input.params.temperature ?? 0,
      topP: input.params.topP,
      seed: input.params.seed,
      maxTokens: input.params.maxTokens ?? DEFAULT_MAX_TOKENS,
      concurrency: Math.min(Math.max(1, input.params.concurrency ?? 4), MAX_CONCURRENCY),
      repeats: 1,
    },
    results: {},
    progress: { completed: 0, total: input.datasetSnapshot.length * input.targets.length },
    createdAt: new Date().toISOString(),
  };
  qualityRunStore.create(run);
  return run;
}

/** Bounded worker pool. `next` is safe to share — JS runs this single-threaded. */
async function runPool<T>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let next = 0;
  const runners = Array.from({ length: limit }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

async function runOneSample(
  provider: DynamicProvider,
  sample: QualitySample,
  index: number,
  params: QualityRunParams,
): Promise<QualitySampleResult> {
  const base = {
    sampleId: sample.id,
    index,
    category: sample.category ?? 'uncategorised',
    grader: sample.grader,
    input: sample.input,
    expected: sample.expected,
    output: '',
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    responseTime: 0,
    estimatedCost: 0,
  };

  const generation: GenerationParams = { temperature: params.temperature };
  if (params.topP !== undefined) generation.topP = params.topP;
  if (params.seed !== undefined) generation.seed = params.seed;

  try {
    // Non-streaming on purpose: quality evaluation is not measuring latency, and
    // a streaming path would only add failure modes.
    const response = await provider.execute(
      sample.input,
      sample.systemPrompt,
      params.maxTokens,
      '',
      false,
      sample.images,
      generation,
    );

    const text = response.text ?? '';
    const usage = {
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      reasoningTokens: response.reasoningTokens ?? 0,
      responseTime: response.responseTime,
      estimatedCost: response.estimatedCost,
      usageEstimated: response.usageEstimated,
    };

    // A 200 with no visible content is not an answer, so it cannot be graded as a
    // wrong one. Reasoning models routinely exhaust their output budget before
    // emitting anything, and counting that as "the model got it wrong" attributes
    // a fault to the model that may belong to the configuration.
    if (text.trim().length === 0) {
      const truncated = response.outputTokens >= params.maxTokens;
      const reasoningNote =
        usage.reasoningTokens > 0 ? ` (${usage.reasoningTokens} reasoning tokens)` : '';
      return {
        ...base,
        ...usage,
        status: 'error',
        score: null,
        detailKey: truncated ? 'quality.grade.truncatedResponse' : 'quality.grade.emptyResponse',
        params: {
          outputTokens: response.outputTokens,
          maxTokens: params.maxTokens,
          reasoningTokens: usage.reasoningTokens,
        },
        detail: truncated
          ? `provider returned no text: it consumed all ${params.maxTokens} output tokens without emitting an answer${reasoningNote}`
          : `provider returned an empty response${reasoningNote}`,
        error: truncated ? `empty response (output budget of ${params.maxTokens} tokens exhausted)` : 'empty response',
        errorCategory: 'empty_response',
      };
    }

    const grade = gradeSample(sample, text);

    return {
      ...base,
      ...usage,
      status: grade.status,
      score: grade.score,
      detailKey: grade.detailKey,
      params: grade.params,
      detail: grade.detail,
      output: text,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown provider error';
    // Not `fail`. The model was never given a chance to answer.
    return {
      ...base,
      status: 'error',
      score: null,
      detailKey: 'quality.grade.providerFailed',
      params: { error: message.slice(0, 160) },
      detail: `provider call failed: ${message}`,
      error: message,
      errorCategory: classifyError(err),
    };
  }
}

/** Build an all-error placeholder for a target we could not even resolve. */
function unresolvedSamples(samples: QualitySample[], reason: string): QualitySampleResult[] {
  return samples.map((sample, index) => ({
    sampleId: sample.id,
    index,
    category: sample.category ?? 'uncategorised',
    grader: sample.grader,
    status: 'error' as const,
    score: null,
    detailKey: 'quality.grade.targetUnresolved',
    params: { error: reason },
    detail: reason,
    input: sample.input,
    expected: sample.expected,
    output: '',
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    responseTime: 0,
    estimatedCost: 0,
    error: reason,
    errorCategory: 'unknown' as ErrorCategory,
  }));
}

const EMPTY_ERROR_BREAKDOWN = (): Record<ErrorCategory, number> => ({
  timeout: 0,
  rate_limit: 0,
  api_error: 0,
  network: 0,
  empty_response: 0,
  unknown: 0,
});

export function summarize(target: string, targetLabel: string, model: string, samples: QualitySampleResult[]): QualityTargetSummary {
  const passCount = samples.filter((s) => s.status === 'pass').length;
  const failCount = samples.filter((s) => s.status === 'fail').length;
  const errorCount = samples.filter((s) => s.status === 'error').length;
  const judged = passCount + failCount;

  // A rate with no judgeable sample behind it is null, not 0. Reporting 0% would
  // claim the model answered every question wrong when it was never asked.
  const passRate = judged > 0 ? passCount / judged : null;

  const scored = samples.filter((s) => s.score !== null);
  const avgScore = scored.length > 0 ? scored.reduce((sum, s) => sum + (s.score as number), 0) / scored.length : null;

  const categoryMap = new Map<string, QualitySampleResult[]>();
  for (const sample of samples) {
    const list = categoryMap.get(sample.category) ?? [];
    list.push(sample);
    categoryMap.set(sample.category, list);
  }
  const byCategory: QualityCategoryBreakdown[] = [...categoryMap.entries()]
    .map(([category, list]) => {
      const pass = list.filter((s) => s.status === 'pass').length;
      const fail = list.filter((s) => s.status === 'fail').length;
      const error = list.filter((s) => s.status === 'error').length;
      return {
        category,
        sampleCount: list.length,
        passCount: pass,
        failCount: fail,
        errorCount: error,
        passRate: pass + fail > 0 ? pass / (pass + fail) : null,
      };
    })
    .sort((a, b) => a.category.localeCompare(b.category));

  // Only samples that actually got a response contribute to latency — folding in
  // the zeros from errored requests would understate the model's real speed.
  const responded = samples.filter((s) => s.status !== 'error');
  const avgResponseTime =
    responded.length > 0 ? responded.reduce((sum, s) => sum + s.responseTime, 0) / responded.length : 0;

  const errorBreakdown = EMPTY_ERROR_BREAKDOWN();
  for (const sample of samples) {
    if (sample.status !== 'error') continue;
    const category = sample.errorCategory ?? 'unknown';
    errorBreakdown[category] += 1;
  }

  const usageEstimatedRatio =
    responded.length > 0 ? responded.filter((s) => s.usageEstimated).length / responded.length : 0;

  return {
    target,
    targetLabel,
    model,
    sampleCount: samples.length,
    passCount,
    failCount,
    errorCount,
    passRate,
    avgScore,
    byCategory,
    avgResponseTime,
    totalInputTokens: samples.reduce((sum, s) => sum + s.inputTokens, 0),
    totalOutputTokens: samples.reduce((sum, s) => sum + s.outputTokens, 0),
    totalCost: samples.reduce((sum, s) => sum + s.estimatedCost, 0),
    errorBreakdown,
    usageEstimatedRatio,
    samples,
  };
}

function headline(summary: QualityTargetSummary): Omit<QualityTargetSummary, 'samples'> {
  const { samples: _samples, ...rest } = summary;
  return rest;
}

export async function executeQualityRun(run: QualityRun): Promise<void> {
  const total = run.datasetSnapshot.length * run.targets.length;
  let completed = 0;

  qualityRunStore.update(run.id, {
    status: 'running',
    progress: { completed: 0, total },
    error: undefined,
  });
  emit(run.id, {
    type: 'quality:init',
    data: { runId: run.id, datasetName: run.datasetName, total, targets: run.targets },
  });

  const results: Record<string, QualityTargetSummary> = {};

  try {
    for (const target of run.targets) {
      if (cancelledRuns.has(run.id)) break;

      const targetLabel = run.targetLabels[target] ?? target;
      const resolved = resolveProbeTarget(target);
      const provider = resolved ? createDynamicProvider(resolved.configId, resolved.modelName) : null;

      let samples: QualitySampleResult[];

      if (!provider) {
        const reason = `cannot resolve provider or model: ${target}`;
        samples = unresolvedSamples(run.datasetSnapshot, reason);
        completed += samples.length;
      } else {
        // Hold index positions so the report keeps dataset order even though the
        // pool finishes out of order.
        samples = new Array<QualitySampleResult>(run.datasetSnapshot.length);
        await runPool(run.datasetSnapshot, run.params.concurrency, async (sample, index) => {
          if (cancelledRuns.has(run.id)) return;
          const result = await runOneSample(provider, sample, index, run.params);
          samples[index] = result;
          completed += 1;
          emit(run.id, {
            type: 'quality:progress',
            data: {
              runId: run.id,
              completed,
              total,
              currentTarget: target,
              latest: {
                sampleId: result.sampleId,
                index: result.index,
                status: result.status,
                category: result.category,
              },
            },
          });
        });
      }

      const summary = summarize(target, targetLabel, resolved?.modelName ?? '', samples);
      results[target] = summary;
      qualityRunStore.update(run.id, {
        results,
        progress: { completed, total, currentTarget: target },
      });
      emit(run.id, { type: 'quality:target', data: { runId: run.id, summary: headline(summary) } });
    }

    const wasCancelled = cancelledRuns.has(run.id);
    const status = wasCancelled ? 'cancelled' : 'completed';
    qualityRunStore.update(run.id, {
      status,
      results,
      progress: { completed, total },
      completedAt: new Date().toISOString(),
    });
    emit(run.id, {
      type: 'quality:complete',
      data: {
        runId: run.id,
        status,
        results: Object.fromEntries(Object.entries(results).map(([key, value]) => [key, headline(value)])),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Quality run failed';
    qualityRunStore.update(run.id, {
      status: 'failed',
      results,
      progress: { completed, total },
      completedAt: new Date().toISOString(),
      error: message,
    });
    emit(run.id, { type: 'quality:error', data: { runId: run.id, error: message } });
  } finally {
    cancelledRuns.delete(run.id);
  }
}
