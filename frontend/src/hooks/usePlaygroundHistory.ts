import { useState, useCallback } from 'react';
import { apiFetch } from '../services/api';
import { PlaygroundMetrics, GenerationParams } from './usePlayground';
import { maskProviderName, maskModelName } from '../utils/demo';

export interface PlaygroundHistoryItem {
  id: string;
  providerName: string;
  providerId: string;
  modelName: string;
  promptSnippet: string;
  createdAt: string;
  responseTime?: number;
  error?: string;
}

export interface PlaygroundHistoryDetail {
  id: string;
  providerId: string;
  providerName: string;
  modelName: string;
  prompt: string;
  systemPrompt?: string;
  maxTokens: number;
  useStreaming: boolean;
  enableThinking: boolean;
  genParams?: GenerationParams;
  responseText?: string;
  reasoningText?: string;
  metrics?: PlaygroundMetrics;
  error?: string;
  createdAt: string;
}

export function usePlaygroundHistory() {
  const [items, setItems] = useState<PlaygroundHistoryItem[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/playground/history');
      if (res.ok) {
        const data = (await res.json()) as PlaygroundHistoryItem[];
        setItems(
          data.map((it) => ({
            ...it,
            providerName: maskProviderName(it.providerName, it.providerId),
            modelName: maskModelName(it.modelName),
          })),
        );
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  const getDetail = useCallback(async (id: string): Promise<PlaygroundHistoryDetail | null> => {
    try {
      const res = await apiFetch(`/api/playground/history/${id}`);
      if (res.ok) {
        const detail = (await res.json()) as PlaygroundHistoryDetail;
        return {
          ...detail,
          providerName: maskProviderName(detail.providerName, detail.providerId),
          modelName: maskModelName(detail.modelName),
        };
      }
    } catch {
      /* ignore */
    }
    return null;
  }, []);

  const deleteEntry = useCallback(async (id: string): Promise<boolean> => {
    // Only remove from local state AFTER the server confirms. Previously this
    // unconditionally removed the item on any response, causing a "phantom delete"
    // where the UI hid an item that was still in the server's DB — reload would
    // bring it back, surprising the user.
    try {
      const res = await apiFetch(`/api/playground/history/${id}`, { method: 'DELETE' });
      if (!res.ok) return false;
      setItems((prev) => prev.filter((i) => i.id !== id));
      return true;
    } catch {
      return false;
    }
  }, []);

  const clearAll = useCallback(async (): Promise<boolean> => {
    try {
      const res = await apiFetch('/api/playground/history', { method: 'DELETE' });
      if (!res.ok) return false;
      setItems([]);
      return true;
    } catch {
      return false;
    }
  }, []);

  return { items, loading, fetchHistory, getDetail, deleteEntry, clearAll };
}
