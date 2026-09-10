import { useState, useCallback, useEffect } from 'react';
import { apiFetch } from '../services/api';
import { App } from '../antdImports';
import type { WorkflowTemplate, WorkflowTemplateRecord } from '../types';

/** A single task as edited inside the module-library editor. */
export interface EditableTask {
  name: string;
  description?: string;
  prompt: string;
  systemPrompt?: string;
  maxTokens: number;
  concurrency: number;
  iterations: number;
  streaming: boolean;
}

/**
 * Payload sent to the backend when creating/updating a template. Matches the
 * backend `WorkflowTemplateSchema` and the stored record shape: each task
 * nests its benchmark settings under `config`.
 */
export interface TemplatePayload {
  name: string;
  description?: string;
  tasks: WorkflowTemplate['tasks'];
  options: { stopOnFailure: boolean; cooldownBetweenTasks: number };
}

interface UseTemplatesReturn {
  templates: WorkflowTemplateRecord[];
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  createTemplate: (data: TemplatePayload) => Promise<WorkflowTemplateRecord | null>;
  updateTemplate: (id: string, data: TemplatePayload) => Promise<WorkflowTemplateRecord | null>;
  removeTemplate: (id: string) => Promise<boolean>;
}

/**
 * Manages the module library: lists built-in + user-defined workflow templates
 * and provides CRUD operations backed by /api/templates.
 */
export function useTemplates(): UseTemplatesReturn {
  const { message } = App.useApp();
  const [templates, setTemplates] = useState<WorkflowTemplateRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/templates');
      if (!res.ok) throw new Error('Failed to load templates');
      const data = (await res.json()) as WorkflowTemplateRecord[];
      setTemplates(data);
    } catch {
      setError('Failed to load templates');
      message.error('加载模版失败');
    } finally {
      setLoading(false);
    }
  }, [message]);

  const createTemplate = useCallback(
    async (data: TemplatePayload): Promise<WorkflowTemplateRecord | null> => {
      try {
        const res = await apiFetch('/api/templates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(err.error || 'Create failed');
        }
        const created = (await res.json()) as WorkflowTemplateRecord;
        setTemplates((prev) => [created, ...prev]);
        message.success('模版已创建');
        return created;
      } catch (e) {
        message.error(e instanceof Error ? e.message : '创建模版失败');
        return null;
      }
    },
    [message],
  );

  const updateTemplate = useCallback(
    async (id: string, data: TemplatePayload): Promise<WorkflowTemplateRecord | null> => {
      try {
        const res = await apiFetch(`/api/templates/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(err.error || 'Update failed');
        }
        const updated = (await res.json()) as WorkflowTemplateRecord;
        setTemplates((prev) => prev.map((t) => (t.id === id ? updated : t)));
        message.success('模版已保存');
        return updated;
      } catch (e) {
        message.error(e instanceof Error ? e.message : '保存模版失败');
        return null;
      }
    },
    [message],
  );

  const removeTemplate = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        const res = await apiFetch(`/api/templates/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Delete failed');
        setTemplates((prev) => prev.filter((t) => t.id !== id));
        message.success('模版已删除');
        return true;
      } catch {
        message.error('删除模版失败');
        return false;
      }
    },
    [message],
  );

  // Load once on mount.
  useEffect(() => {
    void load();
  }, [load]);

  return { templates, loading, error, load, createTemplate, updateTemplate, removeTemplate };
}
