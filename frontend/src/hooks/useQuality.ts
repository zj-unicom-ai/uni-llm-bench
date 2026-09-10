import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, sseUrl } from '../services/api';
import {
  GraderDescriptor,
  QualityActiveStep,
  QualityDatasetSummary,
  QualityEstimate,
  QualityLiveTally,
  QualityRun,
  QualityRunListItem,
  GraderStatus,
} from '../types';

/**
 * Data + orchestration for the quality health check.
 *
 * The evaluation is deliberately sequential across datasets: one run at a time,
 * waiting for each to finish before starting the next. Firing six datasets at an
 * endpoint simultaneously would produce latency and rate-limit artefacts that
 * have nothing to do with model quality — the exact kind of contaminated
 * measurement this project is built to avoid.
 */

export interface QualityProviderOption {
  id: string;
  name: string;
  models: { id: string; name: string; displayName?: string; isActive?: boolean }[];
}

export interface QualityRunParamsInput {
  temperature: number;
  maxTokens: number;
  concurrency: number;
}

interface ProgressEventData {
  completed?: number;
  total?: number;
  latest?: { status?: GraderStatus };
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string; error?: string };
    return body.message || body.error || fallback;
  } catch {
    return fallback;
  }
}

export function useQuality() {
  const [providers, setProviders] = useState<QualityProviderOption[]>([]);
  const [datasets, setDatasets] = useState<QualityDatasetSummary[]>([]);
  const [graders, setGraders] = useState<GraderDescriptor[]>([]);
  const [history, setHistory] = useState<QualityRunListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [phase, setPhase] = useState<'idle' | 'running' | 'done'>('idle');
  const [active, setActive] = useState<QualityActiveStep | null>(null);
  const [tally, setTally] = useState<QualityLiveTally>({ pass: 0, fail: 0, error: 0 });
  const [report, setReport] = useState<QualityRun[]>([]);

  const eventSourceRef = useRef<EventSource | null>(null);
  const activeRunIdRef = useRef<string | null>(null);
  const cancelRef = useRef(false);

  const fetchRun = useCallback(async (id: string): Promise<QualityRun> => {
    const res = await apiFetch(`/api/quality/runs/${id}`);
    if (!res.ok) throw new Error(await readError(res, 'Failed to load run'));
    return (await res.json()) as QualityRun;
  }, []);

  const fetchHistory = useCallback(async () => {
    try {
      const res = await apiFetch('/api/quality/runs?limit=50');
      if (res.ok) setHistory((await res.json()) as QualityRunListItem[]);
    } catch {
      /* a history refresh failure must not disturb an in-flight run */
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [providersRes, datasetsRes, gradersRes] = await Promise.all([
        apiFetch('/api/providers'),
        apiFetch('/api/quality/datasets'),
        apiFetch('/api/quality/graders'),
      ]);
      if (providersRes.ok) setProviders((await providersRes.json()) as QualityProviderOption[]);
      if (datasetsRes.ok) setDatasets((await datasetsRes.json()) as QualityDatasetSummary[]);
      if (gradersRes.ok) setGraders((await gradersRes.json()) as GraderDescriptor[]);
      await fetchHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load quality data');
    } finally {
      setLoading(false);
    }
  }, [fetchHistory]);

  useEffect(() => () => eventSourceRef.current?.close(), []);

  /**
   * Follow a run until it reaches a terminal state. Streams progress over SSE and
   * falls back to polling if the stream drops, so a flaky connection degrades the
   * experience instead of hanging it.
   */
  const waitForRun = useCallback(
    (runId: string, onProgress: (data: ProgressEventData) => void): Promise<QualityRun> =>
      new Promise<QualityRun>((resolve, reject) => {
        let finished = false;
        let pollTimer: ReturnType<typeof setInterval> | null = null;

        const stop = () => {
          eventSourceRef.current?.close();
          eventSourceRef.current = null;
          if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
          }
        };
        const settle = async () => {
          if (finished) return;
          finished = true;
          stop();
          try {
            resolve(await fetchRun(runId));
          } catch (err) {
            reject(err instanceof Error ? err : new Error('Failed to load run'));
          }
        };
        const startPolling = () => {
          if (pollTimer || finished) return;
          pollTimer = setInterval(async () => {
            if (finished) return;
            try {
              const run = await fetchRun(runId);
              onProgress({ completed: run.progress.completed, total: run.progress.total });
              if (run.status !== 'running' && run.status !== 'pending') {
                finished = true;
                stop();
                resolve(run);
              }
            } catch {
              /* keep polling */
            }
          }, 1500);
        };

        void sseUrl(`/api/quality/runs/${runId}/stream`)
          .then((url) => {
            if (finished) return;
            const es = new EventSource(url);
            eventSourceRef.current = es;
            es.onmessage = (event) => {
              try {
                const parsed = JSON.parse(event.data) as { type: string; data: ProgressEventData };
                if (parsed.type === 'quality:progress') onProgress(parsed.data);
                if (parsed.type === 'quality:complete' || parsed.type === 'quality:error') void settle();
              } catch {
                /* ignore a malformed frame rather than tearing the run down */
              }
            };
            es.onerror = () => {
              es.close();
              eventSourceRef.current = null;
              startPolling();
            };
          })
          .catch(() => startPolling());
      }),
    [fetchRun],
  );

  const estimate = useCallback(
    async (target: string, datasetIds: string[], params: QualityRunParamsInput): Promise<QualityEstimate[] | null> => {
      try {
        const results = await Promise.all(
          datasetIds.map(async (datasetId) => {
            const res = await apiFetch('/api/quality/estimate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ datasetId, targets: [target], params }),
            });
            if (!res.ok) return null;
            return (await res.json()) as QualityEstimate;
          }),
        );
        return results.filter((r): r is QualityEstimate => r !== null);
      } catch {
        return null;
      }
    },
    [],
  );

  const startReport = useCallback(
    async (target: string, datasetIds: string[], params: QualityRunParamsInput, targetLabel: string) => {
      setError(null);
      setReport([]);
      setTally({ pass: 0, fail: 0, error: 0 });
      setPhase('running');
      cancelRef.current = false;

      const collected: QualityRun[] = [];

      for (let index = 0; index < datasetIds.length; index += 1) {
        if (cancelRef.current) break;
        const dataset = datasets.find((d) => d.id === datasetIds[index]);
        if (!dataset) continue;

        setActive({
          index,
          total: datasetIds.length,
          datasetId: dataset.id,
          datasetName: dataset.name,
          completed: 0,
          samples: dataset.sampleCount,
        });

        try {
          const res = await apiFetch('/api/quality/runs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: `${dataset.name} · ${targetLabel}`,
              datasetId: dataset.id,
              targets: [target],
              params,
            }),
          });
          if (!res.ok) throw new Error(await readError(res, 'Failed to start run'));
          const created = (await res.json()) as { id: string };
          activeRunIdRef.current = created.id;

          const run = await waitForRun(created.id, (data) => {
            if (typeof data.completed === 'number') {
              setActive((prev) => (prev ? { ...prev, completed: data.completed as number } : prev));
            }
            const status = data.latest?.status;
            if (status) setTally((prev) => ({ ...prev, [status]: prev[status] + 1 }));
          });

          collected.push(run);
          setReport([...collected]);
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Evaluation stopped unexpectedly');
          break;
        } finally {
          activeRunIdRef.current = null;
        }
      }

      setActive(null);
      setPhase('done');
      await fetchHistory();
    },
    [datasets, fetchHistory, waitForRun],
  );

  const cancel = useCallback(async () => {
    cancelRef.current = true;
    const runId = activeRunIdRef.current;
    if (!runId) return;
    try {
      await apiFetch(`/api/quality/runs/${runId}/cancel`, { method: 'POST' });
    } catch {
      /* the run may have finished between the click and the request */
    }
  }, []);

  /**
   * Load one stored run for viewing.
   *
   * Deliberately does NOT touch `report` / `phase`: opening a past run is a
   * read of history, and it must not repaint the page as if the user had just
   * finished a health check. The caller decides where to show it.
   */
  const loadRun = useCallback(
    async (id: string): Promise<QualityRun | null> => {
      setError(null);
      try {
        return await fetchRun(id);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load run');
        return null;
      }
    },
    [fetchRun],
  );

  const deleteRun = useCallback(
    async (id: string) => {
      const res = await apiFetch(`/api/quality/runs/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        setError(await readError(res, 'Failed to delete run'));
        return false;
      }
      await fetchHistory();
      return true;
    },
    [fetchHistory],
  );

  const reset = useCallback(() => {
    setReport([]);
    setTally({ pass: 0, fail: 0, error: 0 });
    setActive(null);
    setPhase('idle');
    setError(null);
  }, []);

  return {
    providers,
    datasets,
    graders,
    history,
    loading,
    error,
    setError,
    phase,
    active,
    tally,
    report,
    refresh,
    estimate,
    startReport,
    cancel,
    loadRun,
    deleteRun,
    reset,
  };
}
