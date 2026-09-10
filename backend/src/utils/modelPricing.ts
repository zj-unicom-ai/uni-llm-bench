/**
 * Single source of truth for model pricing.
 *
 * All values are **USD per 1,000,000 tokens** (not per 1K). This is the only
 * place in the codebase that may contain a price literal — provider adapters
 * must call `estimateCost()` instead of inlining numbers.
 *
 * IMPORTANT: this table is a point-in-time snapshot. LLM prices change
 * frequently and vary by region, tier, batch vs. realtime, and context length.
 * Treat it as an estimate, verify against the provider's official pricing page
 * before relying on it, and bump PRICING_SNAPSHOT_DATE whenever you update it.
 */
export const PRICING_SNAPSHOT_DATE = '2026-09-07';

export interface ModelPrice {
  /** USD per 1M input tokens */
  input: number;
  /** USD per 1M output tokens */
  output: number;
  /** USD per 1M tokens read from prompt cache (defaults to a fraction of input where supported) */
  cacheRead?: number;
  /** USD per 1M tokens written into prompt cache (defaults to 1.25x input for Anthropic-style caching) */
  cacheWrite?: number;
}

export interface CostBreakdown {
  cost: number;
  /** False when the model was not in the table and a family default was used. */
  exact: boolean;
}

type Family = 'openai' | 'anthropic' | 'gemini' | 'glm' | 'unknown';

const OPENAI: Array<[string, ModelPrice]> = [
  ['gpt-4o-mini', { input: 0.15, output: 0.6 }],
  ['gpt-4o', { input: 2.5, output: 10 }],
  ['gpt-4.1-nano', { input: 0.1, output: 0.4 }],
  ['gpt-4.1-mini', { input: 0.4, output: 1.6 }],
  ['gpt-4.1', { input: 2, output: 8 }],
  ['gpt-4-turbo', { input: 10, output: 30 }],
  ['gpt-4', { input: 30, output: 60 }],
  ['o1-mini', { input: 1.1, output: 4.4 }],
  ['o1', { input: 15, output: 60 }],
  ['o3-mini', { input: 1.1, output: 4.4 }],
  ['o3', { input: 2, output: 8 }],
];

const ANTHROPIC: Array<[string, ModelPrice]> = [
  ['claude-opus-4', { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }],
  ['claude-sonnet-4', { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  ['claude-3-5-sonnet', { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  ['claude-3.5-sonnet', { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  ['claude-3-5-haiku', { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 }],
  ['claude-3.5-haiku', { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 }],
  ['claude-3-opus', { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }],
  ['claude-3-haiku', { input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite: 0.3 }],
  ['claude-3-sonnet', { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
];

const GEMINI: Array<[string, ModelPrice]> = [
  ['gemini-2.5-pro', { input: 1.25, output: 10 }],
  ['gemini-2.5-flash', { input: 0.3, output: 2.5 }],
  ['gemini-2.0-flash', { input: 0.1, output: 0.4 }],
  ['gemini-1.5-pro', { input: 1.25, output: 5 }],
  ['gemini-1.5-flash', { input: 0.075, output: 0.3 }],
];

const GLM: Array<[string, ModelPrice]> = [['glm-4.7', { input: 0.5, output: 1.5 }]];

const TABLE: Record<Exclude<Family, 'unknown'>, Array<[string, ModelPrice]>> = {
  openai: OPENAI,
  anthropic: ANTHROPIC,
  gemini: GEMINI,
  glm: GLM,
};

/** Used when the model is unknown. Chosen to be plausible, never precise. */
const FAMILY_DEFAULT: Record<Family, ModelPrice> = {
  openai: { input: 2.5, output: 10 },
  anthropic: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  gemini: { input: 0.3, output: 2.5 },
  glm: { input: 0.5, output: 1.5 },
  unknown: { input: 1, output: 3 },
};

export function pricingFamily(model: string): Family {
  const m = model.toLowerCase();
  if (m.includes('glm') || m.includes('z-ai') || m.startsWith('zai')) return 'glm';
  if (m.includes('gemini')) return 'gemini';
  if (m.includes('claude')) return 'anthropic';
  if (m.includes('gpt') || m.includes('o1') || m.includes('o3') || m.includes('o4')) return 'openai';
  return 'unknown';
}

/**
 * Resolve the price for a model.
 * Longest-prefix match wins so `gpt-4o-mini` does not fall through to `gpt-4`.
 */
export function resolvePrice(model: string): ModelPrice & { exact: boolean } {
  const family = pricingFamily(model);
  if (family === 'unknown') return { ...FAMILY_DEFAULT.unknown, exact: false };

  const m = model.toLowerCase();
  let best: ModelPrice | null = null;
  let bestLength = -1;
  for (const [pattern, price] of TABLE[family]) {
    if (m.startsWith(pattern) && pattern.length > bestLength) {
      best = price;
      bestLength = pattern.length;
    }
  }
  if (best) return { ...best, exact: true };
  return { ...FAMILY_DEFAULT[family], exact: false };
}

export interface CostInput {
  inputTokens: number;
  outputTokens: number;
  /** Tokens served from the provider's prompt cache, if reported. */
  cacheReadTokens?: number;
  /** Tokens written into the provider's prompt cache, if reported. */
  cacheWriteTokens?: number;
}

/**
 * Estimate the USD cost of a single request.
 * Cached tokens are billed at their own rates and must not be double-counted
 * against `inputTokens`, so callers should pass the *total* input tokens and
 * let the breakdown subtract the cached portion.
 */
export function estimateCost(model: string, input: CostInput): CostBreakdown {
  const price = resolvePrice(model);
  const cacheRead = Math.min(input.cacheReadTokens ?? 0, input.inputTokens);
  const cacheWrite = Math.min(input.cacheWriteTokens ?? 0, Math.max(0, input.inputTokens - cacheRead));
  const plainInput = Math.max(0, input.inputTokens - cacheRead - cacheWrite);

  const cost =
    (plainInput * price.input +
      cacheRead * (price.cacheRead ?? price.input * 0.1) +
      cacheWrite * (price.cacheWrite ?? price.input * 1.25) +
      input.outputTokens * price.output) /
    1_000_000;

  return { cost: Number(cost.toFixed(8)), exact: price.exact };
}
