import { useTranslation } from 'react-i18next';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';
import { BenchmarkWorkflow, WorkflowProviderSummary, getProviderColor } from '../types';

const AXIS_PROPS = { stroke: '#9ca3af', fontSize: 11, tickLine: false };
const GRID_STROKE = 'rgba(17,24,39,0.08)';
const TOOLTIP_STYLE = {
  background: '#ffffff',
  border: '1px solid #e5e7eb',
  borderRadius: 6,
  fontSize: 12,
  color: '#111827',
};

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="p-4 rounded-md border border-border bg-bg-surface">
      <div className="text-[11px] text-text-secondary uppercase tracking-wider font-medium mb-3">{title}</div>
      <div style={{ width: '100%', height: 220 }}>{children}</div>
    </div>
  );
}

/**
 * Visual comparison of benchmark results.
 * - Single task: per-provider bar comparisons (latency / cost / TTFT).
 * - Multi task: P95 latency trend across tasks, one line per provider.
 * Built purely from aggregated summary data (no raw samples needed).
 */
export function ResultCharts({ workflow }: { workflow: BenchmarkWorkflow }) {
  const { t } = useTranslation();
  if (!workflow.summary) return null;

  const { summary } = workflow;
  const providers = Object.keys(summary.providerSummaries || {});
  if (providers.length === 0) return null;

  const completedTasks = (workflow.tasks || []).filter((_, i) => (workflow.taskResults || [])[i]?.status === 'completed');
  const isSingle = completedTasks.length <= 1;

  const formatProviderLabel = (ps: WorkflowProviderSummary) =>
    ps.model ? `${ps.provider} / ${ps.model}` : ps.provider;

  // ---- Single task: one metric point per provider ----
  const singleData = providers.map((p) => {
    const ps = summary.providerSummaries[p];
    const m = ps.perTaskMetrics?.[0];
    return {
      key: p,
      name: formatProviderLabel(ps),
      avgRT: Math.round(m?.avgResponseTime ?? 0),
      p95RT: Math.round(m?.p95ResponseTime ?? 0),
      ttft: m?.avgFirstTokenLatency ? Math.round(m.avgFirstTokenLatency) : null,
      tps: Math.round(m?.avgTokensPerSecond ?? 0),
      cost: Number((m?.estimatedCost ?? 0).toFixed(4)),
      success: Math.round((m?.successRate ?? 0) * 100),
    };
  });

  // ---- Multi task: p95 latency trend, one line per provider ----
  const multiData = completedTasks.map((task, idx) => {
    const row: Record<string, string | number> = { task: `#${idx + 1}` };
    for (const p of providers) {
      const m = summary.providerSummaries[p]?.perTaskMetrics?.find((pt) => pt.taskId === task.id);
      if (m) row[p] = Math.round(m.p95ResponseTime);
    }
    return row;
  });

  if (isSingle) {
    const hasTTFT = singleData.some((d) => d.ttft != null);
    return (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title={t('charts.latencyCompare')}>
          <ResponsiveContainer>
            <BarChart data={singleData} margin={{ top: 8, right: 8, left: -8, bottom: 4 }}>
              <CartesianGrid stroke={GRID_STROKE} vertical={false} />
              <XAxis dataKey="name" {...AXIS_PROPS} interval={0} angle={singleData.length > 3 ? -20 : 0} textAnchor={singleData.length > 3 ? 'end' : 'middle'} height={singleData.length > 3 ? 48 : 24} />
              <YAxis {...AXIS_PROPS} unit="ms" />
              <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(17,24,39,0.04)' }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="avgRT" name={t('charts.avgRt')} fill="#4096ff" radius={[3, 3, 0, 0]} />
              <Bar dataKey="p95RT" name={t('charts.p95Rt')} fill="#f2495c" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title={t('charts.costCompare')}>
          <ResponsiveContainer>
            <BarChart data={singleData} margin={{ top: 8, right: 8, left: -8, bottom: 4 }}>
              <CartesianGrid stroke={GRID_STROKE} vertical={false} />
              <XAxis dataKey="name" {...AXIS_PROPS} interval={0} angle={singleData.length > 3 ? -20 : 0} textAnchor={singleData.length > 3 ? 'end' : 'middle'} height={singleData.length > 3 ? 48 : 24} />
              <YAxis {...AXIS_PROPS} />
              <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(17,24,39,0.04)' }} formatter={(v) => `$${(Number(v) || 0).toFixed(4)}`} />
              <Bar dataKey="cost" name={t('charts.estimatedCost')} fill="#73bf69" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title={t('charts.throughputCompare')}>
          <ResponsiveContainer>
            <BarChart data={singleData} margin={{ top: 8, right: 8, left: -8, bottom: 4 }}>
              <CartesianGrid stroke={GRID_STROKE} vertical={false} />
              <XAxis dataKey="name" {...AXIS_PROPS} interval={0} angle={singleData.length > 3 ? -20 : 0} textAnchor={singleData.length > 3 ? 'end' : 'middle'} height={singleData.length > 3 ? 48 : 24} />
              <YAxis {...AXIS_PROPS} />
              <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(17,24,39,0.04)' }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="tps" name={t('charts.tokPerSec')} fill="#ff9830" radius={[3, 3, 0, 0]} />
              <Bar dataKey="success" name={t('charts.successRate')} fill="#36a2eb" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        {hasTTFT && (
          <ChartCard title={t('charts.ttftCompare')}>
            <ResponsiveContainer>
              <BarChart data={singleData} margin={{ top: 8, right: 8, left: -8, bottom: 4 }}>
                <CartesianGrid stroke={GRID_STROKE} vertical={false} />
                <XAxis dataKey="name" {...AXIS_PROPS} interval={0} angle={singleData.length > 3 ? -20 : 0} textAnchor={singleData.length > 3 ? 'end' : 'middle'} height={singleData.length > 3 ? 48 : 24} />
                <YAxis {...AXIS_PROPS} unit="ms" />
                <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(17,24,39,0.04)' }} />
                <Bar dataKey="ttft" name={t('charts.ttft')} fill="#a78bfa" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        )}
      </div>
    );
  }

  // ---- Multi task: trend ----
  return (
    <ChartCard title={t('charts.p95Trend')}>
      <ResponsiveContainer>
        <LineChart data={multiData} margin={{ top: 8, right: 12, left: -8, bottom: 4 }}>
          <CartesianGrid stroke={GRID_STROKE} vertical={false} />
          <XAxis dataKey="task" {...AXIS_PROPS} />
          <YAxis {...AXIS_PROPS} unit="ms" />
          <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ stroke: 'rgba(17,24,39,0.15)' }} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {providers.map((p) => (
            <Line
              key={p}
              type="monotone"
              dataKey={p}
              name={formatProviderLabel(summary.providerSummaries[p])}
              stroke={getProviderColor(p)}
              strokeWidth={2}
              dot={{ r: 3 }}
              activeDot={{ r: 5 }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
