import { describe, it, expect } from 'vitest';
import { compareWithBaseline, toFingerprint } from './identityEngine';
import { FingerprintBaseline, IdentityProbeResult } from '../types';

function tokenizerProbe(id: string, observed: number): IdentityProbeResult {
  return {
    id,
    tier: 'T1',
    group: 'tokenizer',
    status: 'skipped',
    observed,
    detailKey: 'common.recordedForBaseline',
  };
}

function protocolProbe(id: string, observed: string, status: IdentityProbeResult['status'] = 'skipped'): IdentityProbeResult {
  return { id, tier: 'T0', group: 'protocol', status, observed, detailKey: 'compare.match', params: { expected: observed } };
}

function baselineOf(fingerprint: Record<string, string | number>): FingerprintBaseline {
  return {
    id: 'b1',
    providerKey: 'p1:gpt-4',
    providerName: 'OpenAI',
    modelName: 'gpt-4',
    fingerprint,
    capturedAt: '2026-09-01T00:00:00.000Z',
  };
}

const TOKEN_IDS = ['tokenizer.en', 'tokenizer.zh', 'tokenizer.code', 'tokenizer.emoji'];

describe('toFingerprint', () => {
  it('keeps only probes that produced an observation', () => {
    const probes = [
      tokenizerProbe('tokenizer.en', 20),
      protocolProbe('protocol.invalidModelError', '400:unknown model'),
      { ...protocolProbe('protocol.modelEcho', ''), observed: undefined } as IdentityProbeResult,
    ];
    expect(toFingerprint(probes)).toEqual({
      'tokenizer.en': 20,
      'protocol.invalidModelError': '400:unknown model',
    });
  });
});

describe('compareWithBaseline', () => {
  it('reports consistent when every probe matches the baseline', () => {
    const probes = [
      protocolProbe('protocol.modelEcho', 'gpt-4', 'pass'),
      protocolProbe('protocol.invalidModelError', '400:unknown model'),
      protocolProbe('protocol.cacheReplay', 'distinct', 'pass'),
      ...TOKEN_IDS.map((id, i) => tokenizerProbe(id, 20 + i)),
    ];
    const baseline = baselineOf({
      'protocol.invalidModelError': '400:unknown model',
      'tokenizer.en': 20,
      'tokenizer.zh': 21,
      'tokenizer.code': 22,
      'tokenizer.emoji': 23,
    });

    const out = compareWithBaseline(probes, baseline);
    expect(out.verdict).toBe('consistent');
    expect(out.score).toBe(100);
    expect(out.hardGates).toEqual([]);
    expect(out.probes.filter((p) => p.status === 'fail')).toHaveLength(0);
  });

  it('flags a mismatch and fires the tokenizer hard gate when all counts differ', () => {
    // Deliberately non-uniform deltas so this is not read as a constant offset.
    const observed = [90, 95, 70, 88];
    const probes = TOKEN_IDS.map((id, i) => tokenizerProbe(id, observed[i]));
    const baseline = baselineOf({
      'tokenizer.en': 20,
      'tokenizer.zh': 21,
      'tokenizer.code': 22,
      'tokenizer.emoji': 23,
    });

    const out = compareWithBaseline(probes, baseline);
    expect(out.hardGates).toContain('tokenizer');
    expect(out.verdict).toBe('mismatch');
    expect(out.probes.filter((p) => p.status === 'fail')).toHaveLength(4);
  });

  it('detects a constant offset as an injected system prompt', () => {
    const probes = TOKEN_IDS.map((id, i) => tokenizerProbe(id, 20 + i + 12));
    const baseline = baselineOf({
      'tokenizer.en': 20,
      'tokenizer.zh': 21,
      'tokenizer.code': 22,
      'tokenizer.emoji': 23,
    });

    const out = compareWithBaseline(probes, baseline);
    const offset = out.probes.find((p) => p.id === 'tokenizer.constantOffset');
    expect(offset).toBeDefined();
    expect(offset?.status).toBe('warn');
    expect(offset?.observed).toBe(12);
    expect(out.verdict).toBe('suspicious');
  });

  it('treats a one-token difference as caution rather than a mismatch', () => {
    const probes = TOKEN_IDS.map((id, i) => tokenizerProbe(id, 20 + i + (i === 0 ? 1 : 0)));
    const baseline = baselineOf({
      'tokenizer.en': 20,
      'tokenizer.zh': 21,
      'tokenizer.code': 22,
      'tokenizer.emoji': 23,
    });

    const out = compareWithBaseline(probes, baseline);
    expect(out.hardGates).not.toContain('tokenizer');
    expect(out.probes.find((p) => p.id === 'tokenizer.en')?.status).toBe('warn');
  });

  it('fires the model echo hard gate when the endpoint reports another model', () => {
    const probes = [protocolProbe('protocol.modelEcho', 'gpt-3.5-turbo', 'fail')];
    const out = compareWithBaseline(probes, baselineOf({}));
    expect(out.hardGates).toContain('model_echo');
    expect(out.verdict).toBe('mismatch');
  });

  it('marks probes the baseline cannot answer as skipped instead of failing them', () => {
    const probes = [protocolProbe('protocol.logprobsSupport', 'supported')];
    const out = compareWithBaseline(probes, baselineOf({}));
    expect(out.probes[0].status).toBe('skipped');
    expect(out.verdict).toBe('inconclusive');
  });

  it('fires the error shape gate when the invalid-model error differs', () => {
    const probes = [protocolProbe('protocol.invalidModelError', '404:no such model')];
    const out = compareWithBaseline(probes, baselineOf({ 'protocol.invalidModelError': '400:unknown model' }));
    expect(out.hardGates).toContain('error_shape');
    expect(out.verdict).toBe('suspicious');
  });

  it('never returns a negative score', () => {
    const observed = [500, 610, 430, 720];
    const probes = TOKEN_IDS.map((id, i) => tokenizerProbe(id, observed[i]));
    const baseline = baselineOf({
      'tokenizer.en': 20,
      'tokenizer.zh': 21,
      'tokenizer.code': 22,
      'tokenizer.emoji': 23,
    });
    expect(compareWithBaseline(probes, baseline).score).toBeGreaterThanOrEqual(0);
  });
});
