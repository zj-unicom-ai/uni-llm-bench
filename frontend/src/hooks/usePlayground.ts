import { useState, useRef, useCallback } from 'react';
import { ImageInput } from '../types';
import { apiFetch } from '../services/api';

/** Generation / sampling parameters for the Playground. Mirrors the backend GenerationParams. */
export interface GenerationParams {
  temperature?: number;
  topP?: number;
  topK?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stop?: string[];
  seed?: number;
  responseFormat?: 'text' | 'json_object';
}

export interface PlaygroundMetrics {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  responseTime: number;
  firstTokenLatency: number;
  tokensPerSecond: number;
  model: string;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
}

export interface PlaygroundParams {
  providerId: string;
  modelName: string;
  prompt: string;
  systemPrompt?: string;
  maxTokens: number;
  images?: ImageInput[];
  enableThinking?: boolean;
  useStreaming?: boolean;
  genParams?: GenerationParams;
}

/** Per-model result panel (used for both single mode and A/B compare). */
export interface PlaygroundPanelState {
  loading: boolean;
  streaming: boolean;
  responseText: string;
  reasoningText: string;
  metrics: PlaygroundMetrics | null;
  error: string | null;
}

function emptyPanel(): PlaygroundPanelState {
  return {
    loading: false,
    streaming: false,
    responseText: '',
    reasoningText: '',
    metrics: null,
    error: null,
  };
}

function metricsFromRun(data: any): PlaygroundMetrics {
  return {
    inputTokens: data.inputTokens || 0,
    outputTokens: data.outputTokens || 0,
    reasoningTokens: data.reasoningTokens || 0,
    totalTokens: data.totalTokens || 0,
    responseTime: data.responseTime || 0,
    firstTokenLatency: data.firstTokenLatency || 0,
    tokensPerSecond: data.tokensPerSecond || 0,
    model: data.model || '',
    ...(data.cacheCreationTokens && { cacheCreationTokens: data.cacheCreationTokens }),
    ...(data.cacheReadTokens && { cacheReadTokens: data.cacheReadTokens }),
  };
}

export function usePlayground() {
  const [panels, setPanels] = useState<Record<string, PlaygroundPanelState>>({});
  const abortRefs = useRef<Record<string, AbortController | null>>({});

  const setPanel = useCallback((id: string, patch: Partial<PlaygroundPanelState>) => {
    setPanels((prev) => {
      const base = prev[id] || emptyPanel();
      return { ...prev, [id]: { ...base, ...patch } };
    });
  }, []);

  const resetPanel = useCallback((id: string) => {
    setPanels((prev) => ({ ...prev, [id]: emptyPanel() }));
    abortRefs.current[id]?.abort();
    abortRefs.current[id] = null;
  }, []);

  const resetAll = useCallback(() => {
    setPanels({});
    for (const id of Object.keys(abortRefs.current)) {
      abortRefs.current[id]?.abort();
      abortRefs.current[id] = null;
    }
  }, []);

  const abortPanel = useCallback((id: string) => {
    abortRefs.current[id]?.abort();
    abortRefs.current[id] = null;
    // Mirror abortAll: an aborted non-streaming run never reaches its success path,
    // so without this the panel would be stuck showing a spinner forever.
    setPanels((prev) => {
      const base = prev[id];
      if (!base) return prev;
      return { ...prev, [id]: { ...base, loading: false, streaming: false } };
    });
  }, []);

  const abortAll = useCallback(() => {
    for (const id of Object.keys(abortRefs.current)) {
      abortRefs.current[id]?.abort();
      abortRefs.current[id] = null;
    }
    setPanels((prev) => {
      const next: Record<string, PlaygroundPanelState> = {};
      for (const [k, v] of Object.entries(prev)) next[k] = { ...v, loading: false, streaming: false };
      return next;
    });
  }, []);

  /** Non-streaming: POST /api/playground/run */
  const runPanel = useCallback(
    async (id: string, params: PlaygroundParams) => {
      resetPanel(id);
      setPanel(id, { loading: true });
      abortRefs.current[id] = new AbortController();

      try {
        const res = await apiFetch('/api/playground/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params),
          signal: abortRefs.current[id]!.signal,
        });

        const data = await res.json();

        if (!res.ok || !data.success) {
          setPanel(id, { loading: false, error: data.error || `HTTP ${res.status}` });
          return;
        }

        setPanel(id, {
          loading: false,
          streaming: false,
          responseText: data.text || '',
          reasoningText: '',
          metrics: metricsFromRun(data),
          error: null,
        });
      } catch (err: any) {
        if (err.name !== 'AbortError') {
          setPanel(id, { loading: false, error: err.message || 'Request failed' });
        }
      } finally {
        abortRefs.current[id] = null;
      }
    },
    [resetPanel, setPanel],
  );

  /** Streaming: POST /api/playground/stream (SSE) */
  const streamPanel = useCallback(
    async (id: string, params: PlaygroundParams) => {
      resetPanel(id);
      setPanel(id, { loading: true, streaming: true });
      abortRefs.current[id] = new AbortController();

      try {
        const res = await apiFetch('/api/playground/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params),
          signal: abortRefs.current[id]!.signal,
        });

        // If the response is JSON (error case), handle it
        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          const errData = await res.json();
          setPanel(id, { loading: false, streaming: false, error: errData.error || `HTTP ${res.status}` });
          return;
        }

        if (!res.ok) {
          setPanel(id, { loading: false, streaming: false, error: `HTTP ${res.status}` });
          return;
        }

        const reader = res.body?.getReader();
        if (!reader) {
          setPanel(id, { loading: false, streaming: false, error: 'No response body' });
          return;
        }

        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) continue;
            const raw = trimmed.slice(6);
            if (raw === '[DONE]') continue;

            try {
              const event = JSON.parse(raw);

              if (event.type === 'chunk') {
                setPanels((prev) => {
                  const base = prev[id] || emptyPanel();
                  return { ...prev, [id]: { ...base, responseText: base.responseText + event.text } };
                });
              } else if (event.type === 'reasoning') {
                setPanels((prev) => {
                  const base = prev[id] || emptyPanel();
                  return { ...prev, [id]: { ...base, reasoningText: base.reasoningText + event.text } };
                });
              } else if (event.type === 'done') {
                setPanels((prev) => {
                  const base = prev[id] || emptyPanel();
                  return {
                    ...prev,
                    [id]: {
                      ...base,
                      responseText: event.text || base.responseText,
                      reasoningText: event.reasoningText || base.reasoningText,
                      metrics: {
                        inputTokens: event.inputTokens || 0,
                        outputTokens: event.outputTokens || 0,
                        reasoningTokens: event.reasoningTokens || 0,
                        totalTokens: event.totalTokens || 0,
                        responseTime: event.responseTime || 0,
                        firstTokenLatency: event.firstTokenLatency || 0,
                        tokensPerSecond: event.tokensPerSecond || 0,
                        model: event.model || '',
                        ...(event.cacheCreationTokens && { cacheCreationTokens: event.cacheCreationTokens }),
                        ...(event.cacheReadTokens && { cacheReadTokens: event.cacheReadTokens }),
                      },
                    },
                  };
                });
              } else if (event.type === 'error') {
                setPanel(id, { error: event.message || 'Stream error' });
              }
            } catch {
              /* skip malformed */
            }
          }
        }
      } catch (err: any) {
        if (err.name !== 'AbortError') {
          setPanel(id, { error: err.message || 'Stream failed' });
        }
      } finally {
        setPanel(id, { loading: false, streaming: false });
        abortRefs.current[id] = null;
      }
    },
    [resetPanel, setPanel],
  );

  /** Run multiple panels in parallel (used by A/B compare mode). */
  const runAll = useCallback(
    async (entries: { id: string; params: PlaygroundParams }[]) => {
      resetAll();
      await Promise.all(
        entries.map((e) => (e.params.useStreaming ? streamPanel(e.id, e.params) : runPanel(e.id, e.params))),
      );
    },
    [resetAll, streamPanel, runPanel],
  );

  /** Restore a single-panel history entry (into panel "A"). */
  const restore = useCallback(
    (data: { responseText?: string; reasoningText?: string; metrics?: PlaygroundMetrics | null }) => {
      setPanels((prev) => ({
        ...prev,
        A: {
          ...emptyPanel(),
          responseText: data.responseText || '',
          reasoningText: data.reasoningText || '',
          metrics: data.metrics || null,
        },
      }));
    },
    [],
  );

  const anyLoading = Object.values(panels).some((p) => p.loading);

  return {
    panels,
    anyLoading,
    runPanel,
    streamPanel,
    runAll,
    abortPanel,
    abortAll,
    resetPanel,
    resetAll,
    restore,
  };
}
