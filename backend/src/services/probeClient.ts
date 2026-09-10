import { ProviderFormat } from '../types';
import { providerStore } from './providerStore';
import { decrypt } from '../utils/encryption';
import { DynamicProvider, createDynamicProvider } from '../providers/adapter';

/**
 * Low-level probe plumbing for model identity verification.
 *
 * This client deliberately bypasses `benchmarkEngine`: the engine injects a
 * random prompt prefix to control cache hit rate, which would inflate
 * `prompt_tokens` and destroy the tokenizer fingerprint. Probes must send the
 * exact bytes we intend to measure.
 */

export interface ProbeTarget {
  /** `configId:modelName` as supplied by the caller. */
  providerKey: string;
  configId: string;
  providerName: string;
  modelName: string;
  endpoint: string;
  apiKey: string;
  format: ProviderFormat;
}

export interface RawProbeResponse {
  ok: boolean;
  status: number;
  json: Record<string, unknown> | null;
  latencyMs: number;
  error?: string;
}

/** Resolve `configId:modelName` (or a bare configId) into a concrete endpoint. */
export function resolveProbeTarget(providerKey: string): ProbeTarget | null {
  const [configId, explicitModel] = providerKey.includes(':')
    ? providerKey.split(':', 2)
    : [providerKey, undefined];

  const config = providerStore.get(configId);
  if (!config) return null;

  const model = explicitModel
    ? config.models.find((m) => m.name === explicitModel || m.id === explicitModel)
    : config.models.find((m) => m.isActive !== false);
  if (!model) return null;

  let apiKey: string;
  try {
    apiKey = decrypt(config.apiKey);
  } catch {
    return null;
  }

  return {
    providerKey,
    configId,
    providerName: config.name,
    modelName: model.name,
    endpoint: config.endpoint,
    apiKey,
    format: config.format,
  };
}

/** Only OpenAI-compatible endpoints expose the fields the T0 probes inspect. */
export function isOpenAICompatible(format: ProviderFormat): boolean {
  return format === 'openai' || format === 'custom';
}

/**
 * Send a raw chat completion request so probes can control every field
 * (`temperature`, `logprobs`, `response_format`, ...) instead of going through
 * `DynamicProvider`, which only sends `model`/`messages`/`max_tokens`.
 */
export async function rawChatCompletion(
  target: ProbeTarget,
  body: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<RawProbeResponse> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${target.endpoint.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${target.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const latencyMs = Date.now() - startedAt;
    let json: Record<string, unknown> | null = null;
    try {
      json = (await response.json()) as Record<string, unknown>;
    } catch {
      json = null;
    }
    return { ok: response.ok, status: response.status, json, latencyMs };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      json: null,
      latencyMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Canonical provider instance built from a stored config (handles all formats). */
export function createProbeProvider(providerKey: string): DynamicProvider | null {
  const [configId, explicitModel] = providerKey.includes(':')
    ? providerKey.split(':', 2)
    : [providerKey, undefined];

  if (explicitModel) return createDynamicProvider(configId, explicitModel);

  const config = providerStore.get(configId);
  if (!config) return null;
  const firstActive = config.models.find((m) => m.isActive !== false);
  return firstActive ? createDynamicProvider(configId, firstActive.name) : null;
}

/**
 * Ask the endpoint how many tokens a fixed probe text consumes.
 *
 * Uses `DynamicProvider` rather than a raw request so Anthropic / Gemini /
 * OpenAI payload differences are handled in one place.
 */
export async function countPromptTokens(providerKey: string, prompt: string): Promise<number> {
  const provider = createProbeProvider(providerKey);
  if (!provider) throw new Error(`Unknown provider or model: ${providerKey}`);

  // No system prompt, no random prefix — the count must reflect `prompt` alone.
  const result = await provider.execute(prompt, undefined, 8, '', false);
  return result.inputTokens;
}
