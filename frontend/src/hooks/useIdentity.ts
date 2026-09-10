import { useCallback, useState } from 'react';
import { apiFetch } from '../services/api';

export type ProbeStatus = 'pass' | 'warn' | 'fail' | 'skipped' | 'error';
export type IdentityVerdict = 'consistent' | 'suspicious' | 'mismatch' | 'inconclusive' | 'error';

export interface IdentityProbeDescriptor {
  id: string;
  tier: 'T0' | 'T1';
  group: 'protocol' | 'tokenizer';
  cost: 'free' | 'one-token' | 'two-requests';
  requiresBaseline: boolean;
}

export interface IdentityProbeResult {
  id: string;
  tier: 'T0' | 'T1';
  group: 'protocol' | 'tokenizer';
  status: ProbeStatus;
  detailKey: string;
  params?: Record<string, string | number>;
  baseline?: string | number | null;
  observed?: string | number | null;
}

export interface FingerprintBaseline {
  id: string;
  providerKey: string;
  providerName: string;
  modelName: string;
  fingerprint: Record<string, string | number>;
  note?: string;
  capturedAt: string;
}

export interface IdentityRun {
  id: string;
  target: string;
  targetLabel: string;
  baselineId?: string;
  baselineLabel?: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  probes: IdentityProbeResult[];
  verdict: IdentityVerdict;
  score: number;
  hardGates: string[];
  summary: { pass: number; warn: number; fail: number; error: number; skipped: number };
  createdAt: string;
  completedAt?: string;
  error?: string;
}

export interface ProviderOption {
  id: string;
  name: string;
  models: { id: string; name: string; isActive?: boolean }[];
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string; error?: string };
    return body.message || body.error || fallback;
  } catch {
    return fallback;
  }
}

export function useIdentity() {
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [baselines, setBaselines] = useState<FingerprintBaseline[]>([]);
  const [runs, setRuns] = useState<IdentityRun[]>([]);
  const [probes, setProbes] = useState<IdentityProbeDescriptor[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [providersRes, baselinesRes, runsRes, probesRes] = await Promise.all([
        apiFetch('/api/providers'),
        apiFetch('/api/identity/baselines'),
        apiFetch('/api/identity/runs?limit=20'),
        apiFetch('/api/identity/probes'),
      ]);

      if (providersRes.ok) setProviders((await providersRes.json()) as ProviderOption[]);
      if (baselinesRes.ok) setBaselines((await baselinesRes.json()) as FingerprintBaseline[]);
      if (runsRes.ok) setRuns((await runsRes.json()) as IdentityRun[]);
      if (probesRes.ok) setProbes((await probesRes.json()) as IdentityProbeDescriptor[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load identity data');
    } finally {
      setLoading(false);
    }
  }, []);

  const captureBaseline = useCallback(async (providerKey: string, note?: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch('/api/identity/baselines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerKey, note }),
      });
      if (!res.ok) throw new Error(await readError(res, 'Failed to capture baseline'));
      await refresh();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to capture baseline');
      return false;
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const verify = useCallback(
    async (target: string, baselineId?: string) => {
      setBusy(true);
      setError(null);
      try {
        const res = await apiFetch('/api/identity/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target, baselineId }),
        });
        if (!res.ok) throw new Error(await readError(res, 'Verification failed'));
        const run = (await res.json()) as IdentityRun;
        setRuns((prev) => [run, ...prev]);
        return run;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Verification failed');
        return null;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const deleteBaseline = useCallback(
    async (id: string) => {
      setError(null);
      const res = await apiFetch(`/api/identity/baselines/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        setError(await readError(res, 'Failed to delete baseline'));
        return false;
      }
      await refresh();
      return true;
    },
    [refresh],
  );

  return {
    providers,
    baselines,
    runs,
    probes,
    loading,
    busy,
    error,
    setError,
    refresh,
    captureBaseline,
    verify,
    deleteBaseline,
  };
}
