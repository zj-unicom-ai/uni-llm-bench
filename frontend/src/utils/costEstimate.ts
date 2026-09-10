import type { ModelConfig } from '../types';
import { countTokens } from './tokenCount';

const MILLION = 1_000_000;

/** Price fields used for cost estimation. All optional — when absent, cost is unknown. */
export type ModelPricing = Pick<ModelConfig, 'inputPrice' | 'outputPrice' | 'cacheReadPrice' | 'cacheWritePrice'>;

/**
 * Input tokens for one request. Uses the real cl100k tokenizer shipped with the
 * app instead of a character heuristic, so the estimate tracks the actual prompt.
 */
export function estimateInputTokens(prompt?: string, systemPrompt?: string): number {
  return countTokens(prompt ?? '') + countTokens(systemPrompt ?? '');
}

/** True when at least one price is configured, so a cost can be estimated at all. */
export function hasPricing(price?: ModelPricing | null): boolean {
  return !!price && (price.inputPrice != null || price.outputPrice != null);
}

export interface TaskCostInput {
  inputTokens: number;
  outputTokens: number;
  requests: number;
  /** Fraction of input tokens served from cache (0..1). */
  cacheHitRate?: number;
}

/**
 * Estimated total cost for one model across all tasks.
 * Cache-read price (when configured) applies to the cached portion of the input;
 * the remainder is billed at the normal input price. Cache-write price is not
 * applied to estimates because write volume is not knowable before a run.
 */
export function estimateModelCost(price: ModelPricing, tasks: TaskCostInput[]): number {
  let total = 0;
  for (const task of tasks) {
    const { inputTokens, outputTokens, requests, cacheHitRate = 0 } = task;
    const rate = Math.min(Math.max(cacheHitRate, 0), 1);
    const cachedTokens = inputTokens * rate;
    const freshTokens = inputTokens - cachedTokens;

    const inputCost = (freshTokens / MILLION) * (price.inputPrice ?? 0);
    const cacheCost = (cachedTokens / MILLION) * (price.cacheReadPrice ?? price.inputPrice ?? 0);
    const outputCost = (outputTokens / MILLION) * (price.outputPrice ?? 0);

    total += (inputCost + cacheCost + outputCost) * requests;
  }
  return total;
}

/** Human-readable cost. Prices are per 1M tokens, so small totals need more precision. */
export function formatCost(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0';
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(6)}`;
}
