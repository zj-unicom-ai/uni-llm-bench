import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  MinusCircleOutlined,
  LoadingOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { BenchmarkWorkflow, getProviderColor } from '../types';
import { Progress, Tag, Timeline } from '../antdImports';
import type { TaskIterationProgress } from '../hooks/useWorkflow';

interface LiveMetric {
  avgRT: number;
  avgTPS: number;
  recentRT: number;
}

interface Cooldown {
  taskId: string;
  remainingMs: number;
}

interface WorkflowProgressProps {
  workflow: BenchmarkWorkflow | null;
  taskProgress?: Record<string, TaskIterationProgress>;
  liveMetrics?: Record<string, LiveMetric>;
  cooldown?: Cooldown | null;
}

function getStatusTagColor(status: string): string {
  switch (status) {
    case 'completed':
      return 'success';
    case 'running':
      return 'processing';
    case 'failed':
      return 'error';
    case 'skipped':
      return 'default';
    default:
      return 'default';
  }
}

function getTimelineItemColor(status: string): string {
  switch (status) {
    case 'completed':
      return 'green';
    case 'running':
      return 'blue';
    case 'failed':
      return 'red';
    case 'skipped':
      return 'gray';
    default:
      return 'gray';
  }
}

function getTimelineDot(status: string) {
  switch (status) {
    case 'completed':
      return <CheckCircleOutlined style={{ fontSize: 14 }} />;
    case 'running':
      return <LoadingOutlined style={{ fontSize: 14 }} spin />;
    case 'failed':
      return <CloseCircleOutlined style={{ fontSize: 14 }} />;
    case 'skipped':
      return <MinusCircleOutlined style={{ fontSize: 14 }} />;
    default:
      return <ClockCircleOutlined style={{ fontSize: 14 }} />;
  }
}

function formatDuration(ms: number | undefined | null): string {
  if (ms == null || isNaN(ms) || ms <= 0) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatDate(dateStr: string | undefined | null): string {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '-';
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatRT(ms: number): string {
  if (ms == null || isNaN(ms)) return '-';
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

/** Elapsed time counter that ticks every second */
function ElapsedTimer({ startedAt }: { startedAt: string }) {
  const [elapsed, setElapsed] = useState(() => Date.now() - new Date(startedAt).getTime());

  useEffect(() => {
    const id = setInterval(() => setElapsed(Date.now() - new Date(startedAt).getTime()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  return <span className="text-[10px] text-accent-amber font-mono">{formatDuration(elapsed)}</span>;
}

/** Completed task result summary pills */
function CompletedTaskSummary({ workflow, taskIndex }: { workflow: BenchmarkWorkflow; taskIndex: number }) {
  const { t } = useTranslation();
  const task = (workflow.tasks || [])[taskIndex];
  if (!task || !workflow.summary) return null;

  const providers = Object.entries(workflow.summary.providerSummaries || {});
  if (providers.length === 0) return null;

  // Find best provider for this task
  const taskMetrics = providers
    .map(([key, ps]) => {
      const m = (ps.perTaskMetrics || []).find((pt) => pt.taskId === task.id);
      return m ? { key, ...m } : null;
    })
    .filter(Boolean) as Array<{
    key: string;
    avgResponseTime: number;
    avgTokensPerSecond: number;
    successRate: number;
    totalThroughput: number;
  }>;

  if (taskMetrics.length === 0) return null;

  const bestRT = taskMetrics.reduce((a, b) => (a.avgResponseTime < b.avgResponseTime ? a : b));
  const bestTPS = taskMetrics.reduce((a, b) => (a.avgTokensPerSecond > b.avgTokensPerSecond ? a : b));

  return (
    <div className="flex items-center gap-3 mt-1 flex-wrap">
      <span className="text-[10px] font-mono" style={{ color: getProviderColor(bestRT.key) }}>
        {formatRT(bestRT.avgResponseTime)}
        <span className="text-text-tertiary ml-1">{t('workflowProgress.fastest')}</span>
      </span>
      <span className="text-[10px] font-mono" style={{ color: getProviderColor(bestTPS.key) }}>
        {bestTPS.avgTokensPerSecond.toLocaleString()} {t('common.unit.tok/s')}
        <span className="text-text-tertiary ml-1">{t('workflowProgress.highest')}</span>
      </span>
      {taskMetrics.length > 1 && (
        <span className="text-[10px] text-text-tertiary font-mono">
          {taskMetrics.length} {t('workflowProgress.providers')}
        </span>
      )}
    </div>
  );
}

export function WorkflowProgress({ workflow, taskProgress, liveMetrics, cooldown }: WorkflowProgressProps) {
  const { t } = useTranslation();
  const [cooldownLeft, setCooldownLeft] = useState(0);

  // Countdown tick for cooldown
  useEffect(() => {
    if (!cooldown) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCooldownLeft(0);
      return;
    }
    setCooldownLeft(Math.ceil(cooldown.remainingMs / 1000));
    const id = setInterval(() => {
      setCooldownLeft((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(id);
  }, [cooldown]);

  if (!workflow) return null;

  const _isRunning = workflow.status === 'running';
  const isDone = workflow.status === 'completed' || workflow.status === 'failed' || workflow.status === 'cancelled';
  const completedCount = (workflow.taskResults || []).filter((r) => r.status === 'completed').length;
  const failedCount = (workflow.taskResults || []).filter((r) => r.status === 'failed').length;
  const taskList = workflow.tasks || [];
  const progress = taskList.length > 0 ? (completedCount / taskList.length) * 100 : 0;

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="glass-card p-7 space-y-5">
      {/* Overall Progress Bar */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs text-text-secondary">
          <span>
            {t('workflowProgress.tasksCompleted', { completed: completedCount, total: workflow.tasks?.length ?? 0 })}
            {failedCount > 0 && (
              <span className="text-accent-rose ml-2">
                {failedCount} {t('workflowProgress.failed')}
              </span>
            )}
          </span>
          <span className="font-mono">{Math.round(progress)}%</span>
        </div>
        <Progress
          percent={Math.round(progress)}
          showInfo={false}
          strokeColor={isDone && failedCount > 0 ? '#ff9830' : '#73bf69'}
          railColor="#f1f2f4"
          size={isDone ? (['100%', 4] as [string, number]) : 'small'}
          style={isDone ? { margin: 0 } : undefined}
        />
      </div>

      {/* Task Pipeline */}
      <div className="space-y-2">
        <label className="text-xs text-text-secondary uppercase tracking-wider font-medium">
          {t('workflowProgress.taskPipeline')}
        </label>
        <Timeline
          items={(workflow.tasks || []).map((task, index) => {
            const result = workflow.taskResults[index];
            const status = result?.status || 'pending';
            const isActive = status === 'running';
            const isCompleted = status === 'completed';
            const metrics = liveMetrics?.[task.id];
            const duration =
              result?.startedAt && result?.completedAt
                ? new Date(result.completedAt).getTime() - new Date(result.startedAt).getTime()
                : null;

            const showCooldown = cooldown && cooldown.taskId === task.id && status === 'pending';

            return {
              color: getTimelineItemColor(status),
              icon: getTimelineDot(status),
              content: (
                <>
                  <div
                    className={`flex items-center gap-3 p-2.5 rounded border transition-all ${
                      isActive
                        ? 'running-row-active'
                        : isCompleted
                          ? 'border-border bg-accent-teal/5'
                          : status === 'failed'
                            ? 'border-border bg-accent-rose/5'
                            : 'border-border bg-bg-surface'
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`text-sm font-medium ${isActive ? 'text-accent-amber' : 'text-text-primary'}`}>
                          {task.name}
                        </span>
                        <span className="text-[10px] text-text-secondary font-mono">
                          {task.config.concurrency}c × {task.config.iterations}i
                        </span>
                        {isActive && result?.startedAt && <ElapsedTimer startedAt={result.startedAt} />}
                      </div>
                      {isActive &&
                        taskProgress?.[task.id] &&
                        taskProgress[task.id].total > 0 &&
                        (() => {
                          const p = taskProgress[task.id];
                          const pct = Math.round((p.completed / p.total) * 100);
                          return (
                            <div className="flex items-center gap-2 mt-1.5">
                              <Progress
                                percent={pct}
                                showInfo={false}
                                strokeColor="#f5a623"
                                railColor="#f1f2f4"
                                size="small"
                                style={{ flex: 1, margin: 0 }}
                              />
                              <span className="text-[10px] text-accent-amber font-mono whitespace-nowrap">
                                {p.completed}/{p.total}
                              </span>
                            </div>
                          );
                        })()}
                      {/* Live metrics strip — running only */}
                      {isActive && metrics && (
                        <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                          <span className="text-[10px] text-text-secondary font-mono flex items-center gap-1">
                            <ThunderboltOutlined style={{ fontSize: 9, color: '#f5a623' }} />
                            {t('workflowProgress.avgRt')}
                            <span className="text-accent-blue">{formatRT(metrics.avgRT)}</span>
                          </span>
                          <span className="text-[10px] text-text-secondary font-mono">
                            {t('workflowProgress.tps')}
                            <span className="text-accent-teal">{metrics.avgTPS.toLocaleString()}</span>
                          </span>
                          <span className="text-[10px] text-text-secondary font-mono">
                            {t('workflowProgress.last')}
                            <span className="text-text-primary">{formatRT(metrics.recentRT)}</span>
                          </span>
                        </div>
                      )}
                      {/* Completed task summary — done state */}
                      {isCompleted && <CompletedTaskSummary workflow={workflow} taskIndex={index} />}
                      {result?.error && <p className="text-[10px] text-accent-rose mt-0.5 truncate">{result.error}</p>}
                    </div>
                    <div className="text-right flex-shrink-0">
                      <Tag
                        color={getStatusTagColor(status)}
                        style={{ fontSize: 10, margin: 0, lineHeight: '16px', padding: '0 4px' }}
                      >
                        {isCompleted && duration ? formatDuration(duration) : t('common.status.' + status, status)}
                      </Tag>
                    </div>
                    {isActive && (
                      <motion.div
                        className="w-1.5 h-1.5 rounded-full bg-accent-amber"
                        animate={{ opacity: [1, 0.3, 1] }}
                        transition={{ duration: 1.5, repeat: Infinity }}
                      />
                    )}
                  </div>
                  {/* Cooldown row */}
                  {showCooldown && cooldownLeft > 0 && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      className="flex items-center gap-2 px-3 py-1.5 ml-6 mt-1 rounded border border-accent-blue/15 bg-accent-blue/5"
                    >
                      <ClockCircleOutlined style={{ fontSize: 11, color: '#4096ff' }} spin />
                      <span className="text-[11px] text-accent-blue font-mono">
                        {t('workflowProgress.cooldownSeconds', { seconds: cooldownLeft })}
                      </span>
                    </motion.div>
                  )}
                </>
              ),
            };
          })}
        />
      </div>

      {/* Timing info */}
      {workflow.startedAt && (
        <div className="text-[10px] text-text-secondary flex gap-5 font-mono">
          <span>
            {t('workflowProgress.started')}
            {formatDate(workflow.startedAt)}
          </span>
          {workflow.completedAt && (
            <span>
              {t('workflowProgress.duration')}{' '}
              {formatDuration(new Date(workflow.completedAt).getTime() - new Date(workflow.startedAt).getTime())}
            </span>
          )}
        </div>
      )}
    </motion.div>
  );
}
