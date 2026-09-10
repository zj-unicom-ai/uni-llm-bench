import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { DownOutlined, UpOutlined } from '@ant-design/icons';
import { Table, Tabs, Tag, Tooltip } from '../antdImports';
import { BenchmarkWorkflow, getProviderColor, TaskMetricPoint } from '../types';
import { ResultCharts } from './ResultCharts';

interface WorkflowResultsProps {
  workflow: BenchmarkWorkflow | null;
  onExport?: (id: string, format: 'json' | 'csv') => void;
}

type TabType = 'overview' | 'tasks';

function formatNumber(n: number, decimals = 0): string {
  if (n == null || isNaN(n)) return '0';
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** Collapsible prompt preview */
function PromptPreview({ text, t }: { text: string; t: any }) {
  const [open, setOpen] = useState(false);
  const maxLen = 150;
  const truncated = text.length > maxLen;

  return (
    <div className="space-y-1">
      <p className="text-[11px] text-text-secondary font-mono leading-relaxed whitespace-pre-wrap break-all">
        {open || !truncated ? text : text.slice(0, maxLen) + '...'}
      </p>
      {truncated && (
        <button
          onClick={() => setOpen(!open)}
          className="text-[10px] text-accent-blue hover:text-accent-blue/80 flex items-center gap-1"
        >
          {open ? <UpOutlined style={{ fontSize: 8 }} /> : <DownOutlined style={{ fontSize: 8 }} />}
          {open ? t('workflowResults.showLess') : t('workflowResults.showFullPrompt')}
        </button>
      )}
    </div>
  );
}

/** Column header with tooltip */
function tipTitle(label: string, tip: string) {
  return (
    <Tooltip title={tip}>
      <span className="cursor-help border-b border-dotted border-text-tertiary">{label}</span>
    </Tooltip>
  );
}

/** Shared provider column definitions */
function providerColumns(hasP95: boolean, t: any) {
  const cols: Array<{
    title: React.ReactNode;
    dataIndex: string;
    key: string;
    align?: 'left' | 'right' | 'center';
    render?: (value: any, record: any) => any;
  }> = [
    {
      title: t('workflowResults.provider'),
      dataIndex: 'providerName',
      key: 'providerName',
      render: (name: string, record: { providerKey: string }) => (
        <span style={{ color: getProviderColor(record.providerKey), fontWeight: 500 }}>{name}</span>
      ),
    },
    {
      title: t('workflowResults.model'),
      dataIndex: 'model',
      key: 'model',
      render: (model: string, record: { providerKey: string }) => (
        <span style={{ color: getProviderColor(record.providerKey), opacity: 0.8 }} className="font-mono text-[12px]">
          {model}
        </span>
      ),
    },
    {
      title: tipTitle(t('workflowResults.avgRt'), t('workflowResults.avgRtTooltip')),
      dataIndex: 'avgResponseTime',
      key: 'avgResponseTime',
      align: 'right' as const,
      render: (val: number) => `${formatNumber(val)}ms`,
    },
  ];

  if (hasP95) {
    cols.push({
      title: tipTitle(t('workflowResults.p95Rt'), t('workflowResults.p95RtTooltip')),
      dataIndex: 'p95ResponseTime',
      key: 'p95ResponseTime',
      align: 'right' as const,
      render: (val: number) => `${formatNumber(val)}ms`,
    });
  }

  cols.push(
    {
      title: tipTitle(t('workflowResults.ttft'), t('workflowResults.ttftTooltip')),
      dataIndex: 'avgFirstTokenLatency',
      key: 'avgFirstTokenLatency',
      align: 'right' as const,
      render: (val: number) => (val > 0 ? `${formatNumber(val)}ms` : t('common.status.na')),
    },
    {
      title: tipTitle(t('workflowResults.tps'), t('workflowResults.tpsTooltip')),
      dataIndex: 'avgTokensPerSecond',
      key: 'avgTokensPerSecond',
      align: 'right' as const,
      render: (val: number) => formatNumber(val),
    },
    {
      title: tipTitle(t('workflowResults.inTs'), t('workflowResults.inTsTooltip')),
      dataIndex: 'inputThroughput',
      key: 'inputThroughput',
      align: 'right' as const,
      render: (val: number) => (val > 0 ? formatNumber(val) : t('common.status.na')),
    },
    {
      title: tipTitle(t('workflowResults.outTs'), t('workflowResults.outTsTooltip')),
      dataIndex: 'outputThroughput',
      key: 'outputThroughput',
      align: 'right' as const,
      render: (val: number) => (val > 0 ? formatNumber(val) : t('common.status.na')),
    },
    {
      title: tipTitle(t('workflowResults.totalTs'), t('workflowResults.totalTsTooltip')),
      dataIndex: 'totalThroughput',
      key: 'totalThroughput',
      align: 'right' as const,
      render: (val: number) => (val > 0 ? formatNumber(val) : t('common.status.na')),
    },
    {
      title: tipTitle(t('workflowResults.tokens'), t('workflowResults.tokensTooltip')),
      dataIndex: 'totalTokens',
      key: 'totalTokens',
      align: 'right' as const,
      render: (val: number) => formatNumber(val),
    },
    {
      title: tipTitle(t('workflowResults.success'), t('workflowResults.successTooltip')),
      dataIndex: hasP95 ? 'successRate' : 'overallSuccessRate',
      key: hasP95 ? 'successRate' : 'overallSuccessRate',
      align: 'right' as const,
      render: (val: number) => {
        const pct = val * 100;
        const color = pct >= 95 ? 'green' : pct >= 80 ? 'orange' : 'red';
        return <Tag color={color}>{pct.toFixed(1)}%</Tag>;
      },
    },
  );

  return cols;
}

export function WorkflowResults({ workflow, onExport: _onExport }: WorkflowResultsProps) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<TabType>('overview');

  if (!workflow || !workflow.summary) return null;

  const { summary } = workflow;
  const providers = Object.keys(summary.providerSummaries || {});
  const completedTasks = (workflow.tasks || []).filter((_, i) => (workflow.taskResults || [])[i]?.status === 'completed');
  const isSingleTask = completedTasks.length <= 1;

  // Build metrics by provider
  const metricsByProvider: Record<string, TaskMetricPoint[]> = {};
  for (const [provider, ps] of Object.entries(summary.providerSummaries || {})) {
    metricsByProvider[provider] = [...(ps.perTaskMetrics || [])].sort((a, b) => a.taskOrder - b.taskOrder);
  }

  const overviewDataSource = providers
    .map((p) => {
      const ps = summary.providerSummaries[p];
      return {
        ...ps,
        key: p,
        providerKey: p,
        providerName: ps.provider,
        model: ps.model,
      };
    })
    .sort((a, b) => {
      const cmp = a.providerName.localeCompare(b.providerName);
      if (cmp !== 0) return cmp;
      return a.model.localeCompare(b.model);
    });

  /** Build table data for a specific task */
  function buildTaskDataSource(taskId: string) {
    return providers
      .map((p) => {
        const taskMetric = metricsByProvider[p]?.find((m) => m.taskId === taskId);
        if (!taskMetric) return null;
        const ps = summary.providerSummaries[p];
        return {
          key: p,
          providerKey: p,
          providerName: ps?.provider || '',
          model: ps?.model || '',
          ...taskMetric,
          totalTokens: taskMetric.promptTokens,
        };
      })
      .filter(Boolean) as Array<{ key: string; providerKey: string; providerName: string; [k: string]: unknown }>;
  }

  // Single task: flat view with summary table + charts, no tabs
  if (isSingleTask) {
    const task = completedTasks[0];
    const taskDataSource = task ? buildTaskDataSource(task.id) : [];

    // Sort
    taskDataSource.sort((a, b) => {
      const cmp = a.providerName.localeCompare(b.providerName);
      if (cmp !== 0) return cmp;
      return String(a.model).localeCompare(String(b.model));
    });

    return (
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="glass-card p-7 space-y-6">
        {/* Provider comparison charts */}
        <ResultCharts workflow={workflow} />

        {/* Provider comparison table */}
        <Table
          columns={providerColumns(true, t)}
          dataSource={taskDataSource.length > 0 ? taskDataSource : overviewDataSource}
          pagination={false}
          size="small"
        />

        {/* Prompt preview */}
        {task?.config?.prompt && (
          <div className="p-3 rounded border border-border/50 bg-bg-primary/50 space-y-1.5">
            <span className="text-[10px] text-text-secondary uppercase tracking-wider font-medium">
              {t('workflowResults.prompt')}
            </span>
            <PromptPreview text={task.config.prompt} t={t} />
            <div className="flex gap-3 text-[10px] text-text-tertiary font-mono">
              <span>
                {t('workflowResults.maxTokens')}
                {formatNumber(task.config.maxTokens)}
              </span>
              <span>
                {t('workflowResults.concurrency')}
                {task.config.concurrency}
              </span>
              <span>
                {t('workflowResults.iterations')}
                {task.config.iterations}
              </span>
            </div>
          </div>
        )}
      </motion.div>
    );
  }

  // Multi-task: tabbed view
  const tabItems = [
    {
      key: 'overview',
      label: t('workflowResults.overview'),
      children: (
        <Table columns={providerColumns(false, t)} dataSource={overviewDataSource} pagination={false} size="small" />
      ),
    },
    {
      key: 'tasks',
      label: t('workflowResults.byTask'),
      children: (
        <div className="space-y-5">
          {(workflow.tasks || []).map((task, index) => {
            const result = workflow.taskResults[index];
            if (result?.status !== 'completed') return null;

            const taskDataSource = buildTaskDataSource(task.id);
            taskDataSource.sort((a, b) => {
              const cmp = a.providerName.localeCompare(b.providerName);
              if (cmp !== 0) return cmp;
              return String(a.model).localeCompare(String(b.model));
            });

            return (
              <div key={task.id} className="p-4 rounded-md border border-border bg-bg-surface space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-text-secondary">#{index + 1}</span>
                    <span className="text-sm font-medium text-text-primary">{task.name}</span>
                  </div>
                  <span className="text-[10px] text-text-secondary">
                    {task.config.concurrency}c &times; {task.config.iterations}i &times; {task.config.maxTokens}t
                  </span>
                </div>

                <Table columns={providerColumns(true, t)} dataSource={taskDataSource} pagination={false} size="small" />

                {/* Prompt preview */}
                {task.config?.prompt && (
                  <div className="p-3 rounded border border-border/50 bg-bg-primary/50 space-y-1.5">
                    <span className="text-[10px] text-text-secondary uppercase tracking-wider font-medium">
                      {t('workflowResults.prompt')}
                    </span>
                    <PromptPreview text={task.config.prompt} t={t} />
                    <div className="flex gap-3 text-[10px] text-text-tertiary font-mono">
                      <span>
                        {t('workflowResults.maxTokens')}
                        {formatNumber(task.config.maxTokens)}
                      </span>
                      <span>
                        {t('workflowResults.concurrency')}
                        {task.config.concurrency}
                      </span>
                      <span>
                        {t('workflowResults.iterations')}
                        {task.config.iterations}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ),
    },
  ];

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="glass-card p-7 space-y-6">
      <ResultCharts workflow={workflow} />
      {/* Tabs */}
      <Tabs activeKey={activeTab} onChange={(key) => setActiveTab(key as TabType)} items={tabItems} size="small" />
    </motion.div>
  );
}
