import { IdentityProbeDescriptor, IdentityProbeResult } from '../types';
import { ProbeTarget, isOpenAICompatible, rawChatCompletion } from './probeClient';

/**
 * Tier 0 (protocol contract) and Tier 1 (tokenizer) probes.
 *
 * Probe inputs are hard-coded constants on purpose: a fingerprint is only
 * comparable across machines and across time if everyone sends identical bytes.
 *
 * Each probe emits a `detailKey` (resolved against `identity.detail.*` in the
 * UI) plus optional `params` for interpolation — no human-readable sentence is
 * built server-side, so the evidence table is fully localizable.
 */

/** Fixed probe texts. Must not change — changing them invalidates every baseline. */
export const TOKENIZER_PROBE_TEXTS = {
  en: 'The quick brown fox jumps over the lazy dog while considering the implications of distributed systems design.',
  zh: '今天天气很好，我准备出去走走，顺便思考一下大规模语言模型评测体系的设计原则。',
  code: 'def fibonacci(n: int) -> int:\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a\n',
  emoji: '🙂🙃🚀👩‍💻👨‍👩‍👧‍👦🏳️‍🌈𝕏⨌𠜎𠮷٤𝟘​‌‍',
} as const;

export const TOKENIZER_PROBE_IDS = ['tokenizer.en', 'tokenizer.zh', 'tokenizer.code', 'tokenizer.emoji'] as const;

export const PROBE_DESCRIPTORS: IdentityProbeDescriptor[] = [
  {
    id: 'protocol.modelEcho',
    tier: 'T0',
    group: 'protocol',
    cost: 'one-token',
    requiresBaseline: false,
  },
  {
    id: 'protocol.invalidModelError',
    tier: 'T0',
    group: 'protocol',
    cost: 'free',
    requiresBaseline: true,
  },
  {
    id: 'protocol.logprobsSupport',
    tier: 'T0',
    group: 'protocol',
    cost: 'one-token',
    requiresBaseline: true,
  },
  {
    id: 'protocol.jsonModeSupport',
    tier: 'T0',
    group: 'protocol',
    cost: 'one-token',
    requiresBaseline: true,
  },
  {
    id: 'protocol.cacheReplay',
    tier: 'T0',
    group: 'protocol',
    cost: 'two-requests',
    requiresBaseline: false,
  },
  {
    id: 'tokenizer.en',
    tier: 'T1',
    group: 'tokenizer',
    cost: 'one-token',
    requiresBaseline: true,
  },
  {
    id: 'tokenizer.zh',
    tier: 'T1',
    group: 'tokenizer',
    cost: 'one-token',
    requiresBaseline: true,
  },
  {
    id: 'tokenizer.code',
    tier: 'T1',
    group: 'tokenizer',
    cost: 'one-token',
    requiresBaseline: true,
  },
  {
    id: 'tokenizer.emoji',
    tier: 'T1',
    group: 'tokenizer',
    cost: 'one-token',
    requiresBaseline: true,
  },
  {
    id: 'tokenizer.constantOffset',
    tier: 'T1',
    group: 'tokenizer',
    cost: 'free',
    requiresBaseline: true,
  },
];

const MINIMAL_PROMPT = 'Reply with the single word: ok';
const CACHE_PROBE_PROMPT = 'Reply with the single word: ping';

/** Reduce an error body to a comparable signature (no ids, no numbers). */
function errorSignature(json: Record<string, unknown> | null, status: number): string {
  const raw =
    (json?.error as Record<string, unknown> | undefined)?.message ??
    json?.message ??
    json?.msg ??
    (json ? JSON.stringify(json) : '');
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
  return `${status}:${text
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)}`;
}

/** Is `reported` an acceptable alias of `requested` (version suffix, provider prefix)? */
function classifyModelEcho(requested: string, reported: string): 'pass' | 'warn' | 'fail' {
  const a = requested.trim().toLowerCase();
  const b = reported.trim().toLowerCase();
  if (!b) return 'warn';
  if (a === b) return 'pass';
  if (b.startsWith(a) || a.startsWith(b)) return 'warn';
  return 'fail';
}

async function probeModelEcho(target: ProbeTarget): Promise<IdentityProbeResult> {
  const base: IdentityProbeResult = {
    id: 'protocol.modelEcho',
    tier: 'T0',
    group: 'protocol',
    status: 'skipped',
    detailKey: 'protocol.modelEcho.noModel',
  };

  const res = await rawChatCompletion(target, {
    model: target.modelName,
    messages: [{ role: 'user', content: MINIMAL_PROMPT }],
    max_tokens: 8,
    temperature: 0,
  });

  if (res.error) {
    return { ...base, status: 'error', detailKey: 'common.requestFailed', params: { message: res.error } };
  }

  const reported = (res.json?.model as string | undefined) ?? '';
  if (!reported) {
    return { ...base, status: 'warn' };
  }

  const status = classifyModelEcho(target.modelName, reported);
  const detailKey =
    status === 'pass'
      ? 'protocol.modelEcho.pass'
      : status === 'warn'
        ? 'protocol.modelEcho.warnAlias'
        : 'protocol.modelEcho.fail';
  return {
    ...base,
    status,
    observed: reported,
    detailKey,
    params:
      status === 'pass'
        ? { reported }
        : { reported, requested: target.modelName },
  };
}

async function probeInvalidModelError(target: ProbeTarget): Promise<IdentityProbeResult> {
  const base: IdentityProbeResult = {
    id: 'protocol.invalidModelError',
    tier: 'T0',
    group: 'protocol',
    status: 'skipped',
    detailKey: 'protocol.invalidModelError.recorded',
  };

  const res = await rawChatCompletion(target, {
    model: '__probe_nonexistent_model__',
    messages: [{ role: 'user', content: MINIMAL_PROMPT }],
    max_tokens: 8,
  });

  if (res.error) {
    return { ...base, status: 'error', detailKey: 'common.requestFailed', params: { message: res.error } };
  }
  return {
    ...base,
    observed: errorSignature(res.json, res.status),
  };
}

async function probeLogprobsSupport(target: ProbeTarget): Promise<IdentityProbeResult> {
  const base: IdentityProbeResult = {
    id: 'protocol.logprobsSupport',
    tier: 'T0',
    group: 'protocol',
    status: 'skipped',
    detailKey: 'protocol.logprobsSupport.supported',
  };

  const res = await rawChatCompletion(target, {
    model: target.modelName,
    messages: [{ role: 'user', content: MINIMAL_PROMPT }],
    max_tokens: 8,
    temperature: 0,
    logprobs: true,
    top_logprobs: 1,
  });

  if (res.error) {
    return { ...base, status: 'error', detailKey: 'common.requestFailed', params: { message: res.error } };
  }

  const choice = (res.json?.choices as Array<Record<string, unknown>> | undefined)?.[0];
  const supported = Boolean(choice && choice.logprobs);
  return {
    ...base,
    observed: supported ? 'supported' : 'unsupported',
    detailKey: supported
      ? 'protocol.logprobsSupport.supported'
      : res.ok
        ? 'protocol.logprobsSupport.unsupportedOk'
        : 'protocol.logprobsSupport.rejected',
    params: supported || !res.ok ? undefined : { status: res.status },
  };
}

async function probeJsonModeSupport(target: ProbeTarget): Promise<IdentityProbeResult> {
  const base: IdentityProbeResult = {
    id: 'protocol.jsonModeSupport',
    tier: 'T0',
    group: 'protocol',
    status: 'skipped',
    detailKey: 'protocol.jsonModeSupport.supported',
  };

  const res = await rawChatCompletion(target, {
    model: target.modelName,
    messages: [{ role: 'user', content: MINIMAL_PROMPT }],
    max_tokens: 8,
    response_format: { type: 'json_object' },
  });

  if (res.error) {
    return { ...base, status: 'error', detailKey: 'common.requestFailed', params: { message: res.error } };
  }

  const supported = res.ok;
  return {
    ...base,
    observed: supported ? 'supported' : 'unsupported',
    detailKey: supported ? 'protocol.jsonModeSupport.supported' : 'protocol.jsonModeSupport.rejected',
    params: supported ? undefined : { status: res.status },
  };
}

async function probeCacheReplay(target: ProbeTarget): Promise<IdentityProbeResult> {
  const base: IdentityProbeResult = {
    id: 'protocol.cacheReplay',
    tier: 'T0',
    group: 'protocol',
    status: 'skipped',
    detailKey: 'protocol.cacheReplay.passIdentical',
  };

  const body = {
    model: target.modelName,
    messages: [{ role: 'user', content: CACHE_PROBE_PROMPT }],
    max_tokens: 32,
    temperature: 0,
  };

  const first = await rawChatCompletion(target, body);
  if (first.error) return { ...base, status: 'error', detailKey: 'common.requestFailed', params: { message: first.error } };
  const second = await rawChatCompletion(target, body);
  if (second.error) return { ...base, status: 'error', detailKey: 'common.requestFailed', params: { message: second.error } };

  const textOf = (r: typeof first): string => {
    const message = (r.json?.choices as Array<Record<string, unknown>> | undefined)?.[0]?.message as
      | Record<string, unknown>
      | undefined;
    const content = message?.content;
    return content == null ? '' : String(content);
  };

  const a = textOf(first);
  const b = textOf(second);
  if (!a || !b) {
    return { ...base, status: 'warn', detailKey: 'protocol.cacheReplay.noText' };
  }

  if (a !== b) {
    return {
      ...base,
      status: 'pass',
      observed: 'distinct',
      detailKey: 'protocol.cacheReplay.passDistinct',
    };
  }

  const speedup = second.latencyMs > 0 ? first.latencyMs / second.latencyMs : Infinity;
  if (speedup >= 2) {
    return {
      ...base,
      status: 'warn',
      observed: 'identical',
      detailKey: 'protocol.cacheReplay.warnSpeedup',
      params: { speedup: Number(speedup.toFixed(1)) },
    };
  }
  return {
    ...base,
    status: 'pass',
    observed: 'identical',
    detailKey: 'protocol.cacheReplay.passIdentical',
  };
}

/**
 * Run every T0 probe. Non OpenAI-compatible endpoints skip the raw probes
 * because those inspect OpenAI-specific response fields.
 */
export async function runProtocolProbes(target: ProbeTarget): Promise<IdentityProbeResult[]> {
  if (!isOpenAICompatible(target.format)) {
    return PROBE_DESCRIPTORS.filter((d) => d.group === 'protocol').map((d) => ({
      id: d.id,
      tier: d.tier,
      group: d.group,
      status: 'skipped' as const,
      detailKey: 'protocol.skip.notCompatible',
      params: { format: target.format },
    }));
  }

  return Promise.all([
    probeModelEcho(target),
    probeInvalidModelError(target),
    probeLogprobsSupport(target),
    probeJsonModeSupport(target),
    probeCacheReplay(target),
  ]);
}

export { errorSignature };
