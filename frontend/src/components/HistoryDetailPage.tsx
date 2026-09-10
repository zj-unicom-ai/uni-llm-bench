import { useEffect, useState, useRef, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Spin } from '../antdImports';
import type { InputRef } from 'antd';
import { BenchmarkWorkflow } from '../types';
import { apiFetch, sseUrl } from '../services/api';
import { WorkflowHeader } from './WorkflowHeader';
import { WorkflowProgress } from './WorkflowProgress';
import { WorkflowResults } from './WorkflowResults';
import type { TaskIterationProgress } from '../hooks/useWorkflow';

interface HistoryDetailPageProps {
  workflowId: string;
  onExport?: (id: string, format: 'json' | 'csv') => void;
  onCancel?: (id: string) => Promise<boolean>;
  onRerun?: (id: string) => void;
  onBack: () => void;
}

// 归一化 workflow：强制关键数组/对象/状态字段一定存在，
// 避免渲染层（WorkflowHeader / WorkflowProgress / WorkflowResults / ResultCharts）
// 对 undefined 调用 .map / .slice / .length 而崩溃，
// 或对缺失 status 拼出 "common.status.undefined" 的字面 key。
function normalizeWorkflow(w: BenchmarkWorkflow | null): BenchmarkWorkflow | null {
  if (!w) return w;
  // WorkflowStatus 联合类型断言：'unknown' 在 UI 层用 fallback 映射
  const status = ((w.status as string) || 'unknown') as BenchmarkWorkflow['status'];
  return {
    ...w,
    id: w.id ?? '',
    name: w.name ?? '',
    status,
    tasks: Array.isArray(w.tasks) ? w.tasks : [],
    taskResults: Array.isArray(w.taskResults) ? w.taskResults : [],
    providers: Array.isArray(w.providers) ? w.providers : [],
    providerLabels: w.providerLabels || {},
    options: w.options || {},
    summary: w.summary
      ? {
          ...w.summary,
          // 数字字段缺省为 0，避免下游 formatDuration/number.toLocaleString/toFixed 抛 NaN
          totalDuration: typeof w.summary.totalDuration === 'number' ? w.summary.totalDuration : 0,
          totalCost: typeof w.summary.totalCost === 'number' ? w.summary.totalCost : 0,
          totalTokens: typeof w.summary.totalTokens === 'number' ? w.summary.totalTokens : 0,
          totalInputTokens: typeof w.summary.totalInputTokens === 'number' ? w.summary.totalInputTokens : 0,
          totalOutputTokens: typeof w.summary.totalOutputTokens === 'number' ? w.summary.totalOutputTokens : 0,
          taskCount:
            typeof w.summary.taskCount === 'number'
              ? w.summary.taskCount
              : Array.isArray(w.tasks)
              ? w.tasks.length
              : 0,
          completedTaskCount:
            typeof w.summary.completedTaskCount === 'number' ? w.summary.completedTaskCount : 0,
          failedTaskCount:
            typeof w.summary.failedTaskCount === 'number' ? w.summary.failedTaskCount : 0,
          providerSummaries: w.summary.providerSummaries || {},
        }
      : w.summary,
  };
}

export function HistoryDetailPage({ workflowId, onExport, onCancel, onRerun, onBack }: HistoryDetailPageProps) {
  const [workflow, setWorkflow] = useState<BenchmarkWorkflow | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [taskProgress, setTaskProgress] = useState<Record<string, TaskIterationProgress>>({});
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [liveMetrics, setLiveMetrics] = useState<Record<string, { avgRT: number; avgTPS: number; recentRT: number }>>(
    {},
  );
  const [cooldown, setCooldown] = useState<{ taskId: string; remainingMs: number } | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const inputRef = useRef<InputRef>(null);
  const providerProgressRef = useRef<Record<string, Record<string, { completed: number; total: number }>>>({});

  const fetchWorkflow = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/workflows/${workflowId}`);
      if (!res.ok) {
        // 404 / 5xx 时不要把错误体当作 workflow 渲染，否则会触发 displayName 上的 .slice() 崩溃
        setNotFound(res.status === 404);
        return null;
      }
      const data = await res.json();
      setNotFound(false);
      setWorkflow(normalizeWorkflow(data as BenchmarkWorkflow));
      return data as BenchmarkWorkflow;
    } catch {
      return null;
    }
  }, [workflowId]);

  // Connect SSE for running workflows
  const connectSSE = useCallback(async () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }
    const url = await sseUrl(`/api/workflows/${workflowId}/stream`);
    const es = new EventSource(url);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      const parsed = JSON.parse(event.data);

      if (parsed.type === 'task:progress') {
        const taskId = parsed.data?.taskId as string | undefined;
        const provider = parsed.data?.data?.provider as string | undefined;
        const completed = parsed.data?.data?.completed as number | undefined;
        const total = parsed.data?.data?.total as number | undefined;
        if (taskId && provider && completed != null && total != null) {
          const ref = providerProgressRef.current;
          if (!ref[taskId]) ref[taskId] = {};
          ref[taskId][provider] = { completed, total };
          const providers = Object.values(ref[taskId]);
          setTaskProgress((prev) => ({
            ...prev,
            [taskId]: {
              taskId,
              completed: providers.reduce((a, p) => a + p.completed, 0),
              total: providers.reduce((a, p) => a + p.total, 0),
            },
          }));
        }
        // Extract latest iteration metrics for live display
        if (taskId && parsed.data?.data?.latestResults?.length) {
          const results = parsed.data.data.latestResults as Array<{
            success: boolean;
            responseTime: number;
            tokensPerSecond: number;
          }>;
          const successResults = results.filter((r) => r.success);
          if (successResults.length) {
            setLiveMetrics((prev) => ({
              ...prev,
              [taskId]: {
                avgRT: Math.round(successResults.reduce((a, r) => a + r.responseTime, 0) / successResults.length),
                avgTPS: Math.round(successResults.reduce((a, r) => a + r.tokensPerSecond, 0) / successResults.length),
                recentRT: successResults[successResults.length - 1].responseTime,
              },
            }));
          }
        }
      }

      if (
        parsed.type === 'workflow:init' ||
        parsed.type === 'task:start' ||
        parsed.type === 'task:progress' ||
        parsed.type === 'task:complete' ||
        parsed.type === 'task:error'
      ) {
        if (parsed.type === 'task:start') setCooldown(null);
        fetchWorkflow();
      }

      if (parsed.type === 'cooldown') {
        setCooldown({ taskId: parsed.data.nextTaskId, remainingMs: parsed.data.remainingMs });
        fetchWorkflow();
      }

      if (parsed.type === 'workflow:complete') {
        es.close();
        eventSourceRef.current = null;
        setTaskProgress({});
        setLiveMetrics({});
        setCooldown(null);
        providerProgressRef.current = {};
        fetchWorkflow();
      }
    };

    es.onerror = () => {
      es.close();
      eventSourceRef.current = null;
      fetchWorkflow();
    };
  }, [workflowId, fetchWorkflow]);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setTaskProgress({});
    setNotFound(false);
    providerProgressRef.current = {};

    fetchWorkflow().then((data) => {
      if (cancelled) return;
      setLoading(false);
      if (data && data.status === 'running') {
        connectSSE();
      }
    });

    return () => {
      cancelled = true;
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [workflowId, fetchWorkflow, connectSSE]);

  const displayName = workflow?.name || workflow?.id?.slice(0, 8) || workflowId.slice(0, 8) || '';

  const startEditing = () => {
    setEditName(displayName);
    setEditing(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const cancelEditing = () => {
    setEditing(false);
  };

  const saveName = async () => {
    const trimmed = editName.trim();
    if (!trimmed || trimmed === displayName) {
      setEditing(false);
      return;
    }
    try {
      const res = await apiFetch(`/api/workflows/${workflowId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      if (res.ok) {
        const updated = await res.json();
        setWorkflow((prev) => (prev ? { ...prev, name: updated.name } : prev));
      }
    } catch {
      /* no-op: name update is non-critical */
    }
    setEditing(false);
  };

  if (notFound) {
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="glass-card p-16 flex flex-col items-center justify-center gap-4 min-h-[400px] text-center"
      >
        <div className="w-12 h-12 rounded-2xl brand-gradient flex items-center justify-center text-white text-xl">
          !
        </div>
        <div className="text-[15px] font-medium text-text-primary">未找到该工作流</div>
        <p className="text-[13px] text-text-secondary leading-relaxed max-w-md">
          找不到 ID 为 <span className="font-mono">{workflowId}</span>{' '}
          的工作流。它可能已被删除，或后端服务重启后内存中的数据已清空。
        </p>
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-[13px] font-medium rounded-[8px] text-white brand-gradient"
        >
          返回历史列表
        </button>
      </motion.div>
    );
  }

  if (loading || !workflow) {
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="glass-card p-16 flex items-center justify-center min-h-[400px]"
      >
        <Spin size="large" />
      </motion.div>
    );
  }

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <WorkflowHeader
        workflow={workflow}
        onCancel={onCancel}
        onExport={onExport}
        onRerun={onRerun}
        onBack={onBack}
        editing={editing}
        editName={editName}
        onStartEditing={startEditing}
        onSaveName={saveName}
        onCancelEditing={cancelEditing}
        onEditNameChange={setEditName}
        inputRef={inputRef}
      />

      {/* Progress */}
      <WorkflowProgress workflow={workflow} taskProgress={taskProgress} liveMetrics={liveMetrics} cooldown={cooldown} />

      {/* Results */}
      {workflow.summary && <WorkflowResults workflow={workflow} />}
    </motion.div>
  );
}
