import { randomUUID } from 'crypto';
import {
  FingerprintBaseline,
  IdentityProbeResult,
  IdentityRun,
  IdentityVerdict,
} from '../types';
import { ProbeTarget, countPromptTokens, resolveProbeTarget } from './probeClient';
import {
  PROBE_DESCRIPTORS,
  TOKENIZER_PROBE_IDS,
  TOKENIZER_PROBE_TEXTS,
  runProtocolProbes,
} from './identityProbes';

/**
 * Orchestrates the probes and turns raw observations into a verdict.
 *
 * Design rule: the score and the verdict are reported separately, and a single
 * hard gate outranks any weighted score. Averaging would let a fatal signal be
 * diluted by a dozen passing ones.
 */

/** Small count differences are usually billing granularity, not a different tokenizer. */
const TOKEN_TOLERANCE = 1;

const SCORE_PENALTY = { fail: 40, warn: 15 } as const;

function descriptorFor(id: string) {
  return PROBE_DESCRIPTORS.find((d) => d.id === id);
}

function tokenizerProbe(id: string, observed: number): IdentityProbeResult {
  const d = descriptorFor(id)!;
  return {
    id,
    tier: d.tier,
    group: d.group,
    status: 'skipped',
    observed,
    detailKey: 'common.recordedForBaseline',
  };
}

async function runTokenizerProbes(providerKey: string): Promise<IdentityProbeResult[]> {
  const entries = Object.entries(TOKENIZER_PROBE_TEXTS) as Array<
    [keyof typeof TOKENIZER_PROBE_TEXTS, string]
  >;

  return Promise.all(
    entries.map(async ([key, text]) => {
      const id = `tokenizer.${key}`;
      const d = descriptorFor(id)!;
      try {
        const tokens = await countPromptTokens(providerKey, text);
        return tokenizerProbe(id, tokens);
      } catch (err) {
        return {
          id,
          tier: d.tier,
          group: d.group,
          status: 'error' as const,
          detailKey: 'common.probeFailed',
          params: { message: err instanceof Error ? err.message : 'unknown error' },
        };
      }
    }),
  );
}

/** Run every T0 + T1 probe against a provider key. */
export async function runAllProbes(providerKey: string): Promise<IdentityProbeResult[]> {
  const target = resolveProbeTarget(providerKey);
  if (!target) {
    throw new Error(`Unknown provider or model: ${providerKey}`);
  }

  const protocol = await runProtocolProbes(target);
  const tokenizer = await runTokenizerProbes(providerKey);

  // Keep a stable order matching the descriptor catalog.
  const order = PROBE_DESCRIPTORS.map((d) => d.id);
  return [...protocol, ...tokenizer].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}

/** Collapse probe results into the compact fingerprint stored as a baseline. */
export function toFingerprint(probes: IdentityProbeResult[]): Record<string, string | number> {
  const fingerprint: Record<string, string | number> = {};
  for (const probe of probes) {
    if (probe.observed === undefined || probe.observed === null) continue;
    fingerprint[probe.id] = probe.observed;
  }
  return fingerprint;
}

interface ComparisonOutcome {
  probes: IdentityProbeResult[];
  hardGates: string[];
  score: number;
  verdict: IdentityVerdict;
}

function compareTokenValue(baseline: unknown, observed: unknown): 'pass' | 'warn' | 'fail' {
  const b = typeof baseline === 'number' ? baseline : Number(baseline);
  const o = typeof observed === 'number' ? observed : Number(observed);
  if (!Number.isFinite(b) || !Number.isFinite(o)) return 'fail';
  const diff = Math.abs(o - b);
  if (diff === 0) return 'pass';
  if (diff <= TOKEN_TOLERANCE) return 'warn';
  return 'fail';
}

/**
 * Compare observed probes against a baseline fingerprint and derive the verdict.
 */
export function compareWithBaseline(
  probes: IdentityProbeResult[],
  baseline: FingerprintBaseline,
): ComparisonOutcome {
  const reference = baseline.fingerprint ?? {};
  const judged: IdentityProbeResult[] = [];
  const hardGates: string[] = [];
  const tokenDiffs: number[] = [];

  for (const probe of probes) {
    const expected = reference[probe.id];

    if (probe.status === 'error') {
      judged.push(probe);
      continue;
    }

    // Self-judged probes (model echo, cache replay) already carry their verdict.
    if (probe.id === 'protocol.modelEcho' || probe.id === 'protocol.cacheReplay') {
      judged.push(probe);
      if (probe.status === 'fail') hardGates.push('model_echo');
      continue;
    }

    if (expected === undefined) {
      judged.push({
        ...probe,
        status: 'skipped',
        detailKey: 'compare.baselineMissing',
      });
      continue;
    }

    if (probe.id.startsWith('tokenizer.')) {
      const status = compareTokenValue(expected, probe.observed);
      const diff = Number(probe.observed) - Number(expected);
      if (Number.isFinite(diff)) tokenDiffs.push(diff);
      judged.push({
        ...probe,
        baseline: expected,
        status,
        detailKey:
          status === 'pass'
            ? 'compare.tokenizerMatch'
            : status === 'warn'
              ? 'compare.tokenizerWarn'
              : 'compare.tokenizerFail',
        params:
          status === 'pass'
            ? { expected }
            : status === 'warn'
              ? { diff: Math.abs(diff), expected }
              : { observed: probe.observed as number, expected },
      });
      continue;
    }

    const same = String(expected) === String(probe.observed);
    judged.push({
      ...probe,
      baseline: expected,
      status: same ? 'pass' : 'warn',
      detailKey: same ? 'compare.match' : 'compare.mismatch',
      params: same ? { expected } : { expected, observed: probe.observed as string | number },
    });
    if (!same && probe.id === 'protocol.invalidModelError') hardGates.push('error_shape');
  }

  // A constant, non-zero offset across all four counts means a fixed-length
  // system prompt is being injected somewhere along the path. The tokenizer
  // still matches, so those probes are only a caution — not a mismatch.
  const constantOffset =
    tokenDiffs.length === TOKENIZER_PROBE_IDS.length &&
    tokenDiffs.every((d) => d === tokenDiffs[0]) &&
    Math.abs(tokenDiffs[0]) >= 2
      ? tokenDiffs[0]
      : null;

  if (constantOffset !== null) {
    for (const probe of judged) {
      const isTokenizer = TOKENIZER_PROBE_IDS.includes(probe.id as (typeof TOKENIZER_PROBE_IDS)[number]);
      if (!isTokenizer || probe.status !== 'fail') continue;
      probe.status = 'warn';
      probe.detailKey = 'compare.constantOffsetOverride';
      probe.params = { observed: probe.observed as number, baseline: probe.baseline as number, offset: constantOffset };
    }

    judged.push({
      id: 'tokenizer.constantOffset',
      tier: 'T1',
      group: 'tokenizer',
      status: 'warn',
      baseline: 0,
      observed: constantOffset,
      detailKey: 'compare.constantOffsetSummary',
      params: { offset: constantOffset },
    });
  }

  const tokenProbes = judged.filter((p) => TOKENIZER_PROBE_IDS.includes(p.id as (typeof TOKENIZER_PROBE_IDS)[number]));
  if (tokenProbes.length === TOKENIZER_PROBE_IDS.length && tokenProbes.every((p) => p.status === 'fail')) {
    hardGates.push('tokenizer');
  }

  let score = 100;
  for (const probe of judged) {
    if (probe.status === 'fail') score -= SCORE_PENALTY.fail;
    else if (probe.status === 'warn') score -= SCORE_PENALTY.warn;
    else if (probe.status === 'error') score -= SCORE_PENALTY.warn;
  }
  score = Math.max(0, Math.min(100, score));

  let verdict: IdentityVerdict;
  if (hardGates.includes('model_echo') || hardGates.includes('tokenizer')) {
    verdict = 'mismatch';
  } else if (hardGates.includes('error_shape') || judged.some((p) => p.status === 'warn')) {
    verdict = 'suspicious';
  } else if (judged.some((p) => p.status === 'error')) {
    verdict = 'error';
  } else if (judged.every((p) => p.status === 'pass' || p.status === 'skipped')) {
    verdict = judged.some((p) => p.status === 'pass') ? 'consistent' : 'inconclusive';
  } else {
    verdict = 'inconclusive';
  }

  return { probes: judged, hardGates, score, verdict };
}

function summarize(probes: IdentityProbeResult[]): IdentityRun['summary'] {
  const summary = { pass: 0, warn: 0, fail: 0, error: 0, skipped: 0 };
  for (const probe of probes) {
    if (probe.status in summary) summary[probe.status] += 1;
  }
  return summary;
}

/** Full verification pass: probe the target, compare against a baseline, persist. */
export async function buildRunRecord(
  target: string,
  targetLabel: string,
  baseline: FingerprintBaseline | undefined,
): Promise<Omit<IdentityRun, 'status'>> {
  const probes = await runAllProbes(target);
  const createdAt = new Date().toISOString();

  if (!baseline) {
    return {
      id: randomUUID(),
      target,
      targetLabel,
      probes,
      verdict: 'inconclusive',
      score: 0,
      hardGates: [],
      summary: summarize(probes),
      createdAt,
    };
  }

  const outcome = compareWithBaseline(probes, baseline);
  return {
    id: randomUUID(),
    target,
    targetLabel,
    baselineId: baseline.id,
    baselineLabel: `${baseline.providerName} / ${baseline.modelName}`,
    probes: outcome.probes,
    verdict: outcome.verdict,
    score: outcome.score,
    hardGates: outcome.hardGates,
    summary: summarize(outcome.probes),
    createdAt,
  };
}

export type { ProbeTarget };
