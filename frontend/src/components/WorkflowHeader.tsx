import { Button, Dropdown, Tooltip, Tag, Input } from '../antdImports';
import type { InputRef } from 'antd';
import { ArrowLeftOutlined, DownloadOutlined, EditOutlined, CheckOutlined, CloseOutlined, ReloadOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { BenchmarkWorkflow, getProviderColor, getProviderDisplayName } from '../types';

interface WorkflowHeaderProps {
  workflow: BenchmarkWorkflow;
  onCancel?: (id: string) => Promise<boolean>;
  onExport?: (id: string, format: 'json' | 'csv') => void;
  onBack?: () => void;
  onRerun?: (id: string) => void;
  editing?: boolean;
  editName?: string;
  onStartEditing?: () => void;
  onSaveName?: () => void;
  onCancelEditing?: () => void;
  onEditNameChange?: (name: string) => void;
  inputRef?: React.RefObject<InputRef | null>;
}

function statusToTagColor(status: string): string {
  switch (status) {
    case 'completed':
      return 'green';
    case 'running':
      return 'orange';
    case 'failed':
      return 'red';
    case 'cancelled':
      return 'default';
    default:
      return 'default';
  }
}

/**
 * Status text fallback. 当 i18n 没有对应键时（也兼容 workflow.status 是 undefined 的情况），
 * 用这张静态表兜底，避免页面展示 "common.status.undefined" 这种字面 key。
 */
const STATUS_FALLBACK: Record<string, string> = {
  completed: '已完成',
  running: '运行中',
  failed: '失败',
  cancelled: '已取消',
  pending: '等待中',
  draft: '草稿',
  unknown: '未知',
};

function formatDate(dateStr: string | undefined): string {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '-';
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
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

/** 安全把任意值转为数字，null/undefined/NaN/非数 → fallback */
function safeNumber(v: unknown, fallback = 0): number {
  if (v == null) return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  return isFinite(n) ? n : fallback;
}

export function WorkflowHeader({
  workflow,
  onCancel,
  onExport,
  onBack,
  onRerun,
  editing,
  editName,
  onStartEditing,
  onSaveName,
  onCancelEditing,
  onEditNameChange,
  inputRef,
}: WorkflowHeaderProps) {
  const { t } = useTranslation();
  const displayName = workflow.name || (workflow.id ? workflow.id.slice(0, 8) : '');

  const exportMenuItems = onExport
    ? [
        { key: 'json', label: t('workflowHeader.exportJson') },
        { key: 'csv', label: t('workflowHeader.exportCsv') },
      ]
    : [];

  const handleExportClick = ({ key }: { key: string }) => {
    if (onExport) {
      onExport(workflow.id, key as 'json' | 'csv');
    }
  };

  // Token stats
  const tokenStats = (() => {
    if (!workflow.summary) return null;
    const summaries = Object.values(workflow.summary.providerSummaries || {});
    const inputTokens =
      workflow.summary.totalInputTokens || summaries.reduce((a, s) => a + (s.totalInputTokens || 0), 0);
    const outputTokens =
      workflow.summary.totalOutputTokens || summaries.reduce((a, s) => a + (s.totalOutputTokens || 0), 0);
    if (inputTokens === 0 && outputTokens === 0) return null;
    const avgInputThroughput = summaries.length
      ? Math.round(summaries.reduce((a, s) => a + (s.inputThroughput || 0), 0) / summaries.length)
      : 0;
    const avgOutputThroughput = summaries.length
      ? Math.round(summaries.reduce((a, s) => a + (s.outputThroughput || 0), 0) / summaries.length)
      : 0;
    const avgTotalThroughput = summaries.length
      ? Math.round(summaries.reduce((a, s) => a + (s.totalThroughput || 0), 0) / summaries.length)
      : 0;
    return { inputTokens, outputTokens, avgInputThroughput, avgOutputThroughput, avgTotalThroughput };
  })();

  const isCompleted =
    workflow.status === 'completed' || workflow.status === 'failed' || workflow.status === 'cancelled';

  const statCards =
    isCompleted && workflow.summary
      ? (() => {
          const s = workflow.summary;
          const ps = Object.values(s.providerSummaries || {})
            // 仅保留有意义的 provider summary 行（避免 null/undefined 触发崩溃）
            .filter((p): boolean => !!p && typeof p === 'object') as Array<{
            avgResponseTime?: number;
            overallSuccessRate?: number;
            inputThroughput?: number;
            outputThroughput?: number;
            totalThroughput?: number;
          }>;
          const safeRT = (p: { avgResponseTime?: number }) => safeNumber(p.avgResponseTime, 0);
          const bestRT = ps.length ? Math.min(...ps.map(safeRT)) : 0;
          const avgSuccess = ps.length
            ? safeNumber(
                ps.reduce((a, p) => a + safeNumber((p as { overallSuccessRate?: number }).overallSuccessRate, 0), 0) /
                  ps.length,
              )
            : 0;
          const avgInT = ps.length
            ? Math.round(
                ps.reduce(
                  (a, p) => a + safeNumber((p as { inputThroughput?: number }).inputThroughput, 0),
                  0,
                ) / ps.length,
              )
            : 0;
          const avgOutT = ps.length
            ? Math.round(
                ps.reduce(
                  (a, p) => a + safeNumber((p as { outputThroughput?: number }).outputThroughput, 0),
                  0,
                ) / ps.length,
              )
            : 0;
          const avgTotalT = ps.length
            ? Math.round(
                ps.reduce(
                  (a, p) => a + safeNumber((p as { totalThroughput?: number }).totalThroughput, 0),
                  0,
                ) / ps.length,
              )
            : 0;
          return { s, bestRT, avgSuccess, avgInT, avgOutT, avgTotalT };
        })()
      : null;

  return (
    <div className={`glass-card p-5${workflow.status === 'running' ? ' running-card-glow' : ''}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {onBack && (
            <Button
              type="text"
              icon={<ArrowLeftOutlined />}
              onClick={onBack}
              className="text-text-secondary hover:text-text-primary"
            />
          )}
          <div>
            <div className="flex items-center gap-2">
              {editing !== undefined && editing && onStartEditing ? (
                <Input
                  ref={inputRef}
                  size="small"
                  className="text-sm font-medium"
                  style={{ width: Math.max(240, (editName || '').length * 10 + 60) }}
                  value={editName}
                  onChange={(e) => onEditNameChange?.(e.target.value)}
                  onPressEnter={onSaveName}
                  addonAfter={
                    <div className="flex items-center gap-2">
                      <CheckOutlined className="text-green-500 cursor-pointer text-xs" onClick={onSaveName} />
                      <CloseOutlined className="text-text-tertiary cursor-pointer text-xs" onClick={onCancelEditing} />
                    </div>
                  }
                />
              ) : (
                <span
                  className={`text-sm font-medium text-text-primary rounded px-1.5 py-0.5 -ml-1.5 border border-transparent transition-colors ${
                    onStartEditing ? 'cursor-pointer hover:border-border group' : ''
                  }`}
                  onClick={onStartEditing}
                >
                  {displayName}
                  {onStartEditing && (
                    <EditOutlined className="text-text-tertiary text-[10px] ml-1.5 opacity-0 group-hover:opacity-100 transition-opacity" />
                  )}
                </span>
              )}
              <Tag
                color={statusToTagColor(workflow.status || '')}
                style={{ fontSize: '11px', margin: 0 }}
                className="font-mono"
              >
                {STATUS_FALLBACK[workflow.status || 'unknown'] ??
                  t('common.status.' + (workflow.status || 'unknown'), workflow.status || 'unknown')}
              </Tag>
            </div>
            <div className="flex items-center gap-1.5 mt-1 flex-wrap max-w-full">
              {workflow.summary
                ? Object.entries(workflow.summary?.providerSummaries || {})
                    .sort(([, a], [, b]) => {
                      const cmp = a.provider.localeCompare(b.provider);
                      if (cmp !== 0) return cmp;
                      return a.model.localeCompare(b.model);
                    })
                    .map(([key, ps]) => (
                      <Tag
                        key={key}
                        style={{
                          backgroundColor: `${getProviderColor(key)}0a`,
                          color: getProviderColor(key),
                          border: `1px solid ${getProviderColor(key)}20`,
                          fontSize: '10px',
                          margin: 0,
                          fontFamily: 'monospace',
                          maxWidth: '100%',
                        }}
                      >
                        <span className="truncate max-w-[180px] inline-block align-bottom">
                          {ps.provider}/{ps.model}
                        </span>
                      </Tag>
                    ))
                : (workflow.providers || []).map((p) => (
                    <Tag
                      key={p}
                      style={{
                        backgroundColor: `${getProviderColor(p)}0a`,
                        color: getProviderColor(p),
                        border: `1px solid ${getProviderColor(p)}20`,
                        fontSize: '10px',
                        margin: 0,
                      }}
                    >
                      {workflow.providerLabels?.[p] || getProviderDisplayName(p)}
                    </Tag>
                  ))}
              <span className="text-[10px] text-text-tertiary font-mono ml-2">
                {workflow.tasks?.length ?? 0} {t('workflowHeader.tasks')} · {formatDate(workflow.createdAt)}
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {workflow.status === 'running' && onCancel && (
            <Button size="small" danger onClick={() => onCancel(workflow.id)}>
              {t('workflowHeader.cancel')}
            </Button>
          )}
          {onRerun && (
            <Tooltip title={t('workflowHeader.rerun')}>
              <Button size="small" icon={<ReloadOutlined />} onClick={() => onRerun(workflow.id)}>
                {t('workflowHeader.rerun')}
              </Button>
            </Tooltip>
          )}
          {onExport && (
            <Dropdown menu={{ items: exportMenuItems, onClick: handleExportClick }}>
              <Tooltip title={t('workflowHeader.exportResults')}>
                <Button size="small" icon={<DownloadOutlined />}>
                  {t('workflowHeader.export')}
                </Button>
              </Tooltip>
            </Dropdown>
          )}
        </div>
      </div>

      {/* Stat Cards Dashboard — completed/failed/cancelled only */}
      {statCards && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3 mt-4">
          <Tooltip title={t('workflowHeader.durationTooltip')}>
            <div className="stat-card">
              <span className="stat-value text-accent-blue">{formatDuration(safeNumber(statCards.s.totalDuration))}</span>
              <span className="stat-label">{t('workflowHeader.duration')}</span>
            </div>
          </Tooltip>
          <Tooltip title={t('workflowHeader.tokensTooltip')}>
            <div className="stat-card">
              <span className="stat-value text-accent-violet">{safeNumber(statCards.s.totalTokens).toLocaleString()}</span>
              <span className="stat-label">{t('workflowHeader.tokens')}</span>
            </div>
          </Tooltip>
          <Tooltip title={t('workflowHeader.bestAvgRtTooltip')}>
            <div className="stat-card">
              <span className="stat-value text-accent-teal">{safeNumber(statCards.bestRT).toLocaleString()}ms</span>
              <span className="stat-label">{t('workflowHeader.bestAvgRt')}</span>
            </div>
          </Tooltip>
          <Tooltip title={t('workflowHeader.successRateTooltip')}>
            <div className="stat-card">
              <span
                className={`stat-value ${safeNumber(statCards.avgSuccess) >= 0.95 ? 'text-accent-teal' : safeNumber(statCards.avgSuccess) >= 0.8 ? 'text-accent-amber' : 'text-accent-rose'}`}
              >
                {(safeNumber(statCards.avgSuccess) * 100).toFixed(1)}%
              </span>
              <span className="stat-label">{t('workflowHeader.successRate')}</span>
            </div>
          </Tooltip>
          <Tooltip title={t('workflowHeader.estCostTooltip')}>
            <div className="stat-card">
              <span className="stat-value text-accent-coral">${safeNumber(statCards.s.totalCost).toFixed(4)}</span>
              <span className="stat-label">{t('workflowHeader.estCost')}</span>
            </div>
          </Tooltip>
          <Tooltip title={t('workflowHeader.totalTsTooltip')}>
            <div className="stat-card">
              <span className="stat-value text-accent-violet">
                {safeNumber(statCards.avgTotalT) > 0 ? safeNumber(statCards.avgTotalT).toLocaleString() : '-'}
              </span>
              <span className="stat-label">{t('workflowHeader.totalTs')}</span>
            </div>
          </Tooltip>
        </div>
      )}

      {/* Token Stats — running state inline display */}
      {tokenStats && !isCompleted && (
        <>
          <div className="flex items-center gap-3 mt-2 flex-wrap">
            <Tooltip title={t('workflowHeader.inputTokensTooltip')}>
              <span className="text-[11px] text-text-secondary font-mono cursor-help">
                {t('workflowHeader.inputTokens')}
                <span className="text-accent-blue">{tokenStats.inputTokens.toLocaleString()}</span>
              </span>
            </Tooltip>
            <Tooltip title={t('workflowHeader.outputTokensTooltip')}>
              <span className="text-[11px] text-text-secondary font-mono cursor-help">
                {t('workflowHeader.outputTokens')}
                <span className="text-accent-teal">{tokenStats.outputTokens.toLocaleString()}</span>
              </span>
            </Tooltip>
            <Tooltip title={t('workflowHeader.ratioTooltip')}>
              <span className="text-[11px] text-text-secondary font-mono cursor-help">
                {t('workflowHeader.ratio')}{' '}
                <span className="text-accent-violet">
                  {tokenStats.outputTokens > 0 && tokenStats.inputTokens > 0
                    ? (() => {
                        const r = tokenStats.inputTokens / tokenStats.outputTokens;
                        if (r >= 10) return `${Math.round(r)}:1`;
                        return `${r.toFixed(2)}:1`;
                      })()
                    : '-'}
                </span>
              </span>
            </Tooltip>
          </div>
          {(tokenStats.avgInputThroughput > 0 || tokenStats.avgOutputThroughput > 0) && (
            <div className="flex items-center gap-3 mt-1 flex-wrap">
              <Tooltip title={t('workflowHeader.inTsTooltip')}>
                <span className="text-[11px] text-text-secondary font-mono cursor-help">
                  {t('workflowHeader.inTs')}
                  <span className="text-accent-blue">{tokenStats.avgInputThroughput.toLocaleString()}</span>
                </span>
              </Tooltip>
              <Tooltip title={t('workflowHeader.outTsTooltip')}>
                <span className="text-[11px] text-text-secondary font-mono cursor-help">
                  {t('workflowHeader.outTs')}
                  <span className="text-accent-teal">{tokenStats.avgOutputThroughput.toLocaleString()}</span>
                </span>
              </Tooltip>
              <Tooltip title={t('workflowHeader.totalTsLabelTooltip')}>
                <span className="text-[11px] text-text-secondary font-mono cursor-help">
                  {t('workflowHeader.totalTsLabel')}{' '}
                  <span className="text-accent-violet">{tokenStats.avgTotalThroughput.toLocaleString()}</span>
                </span>
              </Tooltip>
            </div>
          )}
        </>
      )}
    </div>
  );
}
