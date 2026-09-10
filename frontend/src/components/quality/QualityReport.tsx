import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Card, Empty, Space, Table, Tag, Tooltip } from '../../antdImports';
import { QualityRun, QualitySampleResult } from '../../types';
import { QualitySampleTable } from './QualitySampleTable';
import { formatCost, formatMs, formatPercent } from './gradeDetail';

interface QualityReportProps {
  runs: QualityRun[];
  /** True while the health check is still producing datasets. */
  partial?: boolean;
}

function rateColor(rate: number | null): string {
  if (rate === null) return 'default';
  if (rate >= 0.9) return 'green';
  if (rate >= 0.7) return 'orange';
  return 'red';
}

/**
 * The health report: one model, several datasets, one scorecard.
 *
 * Errors are never folded into the pass rate. If part of the suite could not be
 * judged, the headline says so explicitly and names the count, because a rate
 * that silently drops failures is worse than no rate at all.
 */
export function QualityReport({ runs, partial }: QualityReportProps) {
  const { t } = useTranslation();

  const totals = useMemo(() => {
    let samples = 0;
    let pass = 0;
    let fail = 0;
    let error = 0;
    let cost = 0;
    for (const run of runs) {
      for (const summary of Object.values(run.results)) {
        samples += summary.sampleCount;
        pass += summary.passCount;
        fail += summary.failCount;
        error += summary.errorCount;
        cost += summary.totalCost;
      }
    }
    const judged = pass + fail;
    return { samples, pass, fail, error, cost, judged, passRate: judged > 0 ? pass / judged : null };
  }, [runs]);

  const modelLabel = useMemo(() => {
    const labels = new Set<string>();
    for (const run of runs) {
      for (const target of run.targets) labels.add(run.targetLabels[target] ?? target);
    }
    return [...labels].join(' · ');
  }, [runs]);

  const params = runs[0]?.params;
  const graderTypes = useMemo(
    () => [...new Set(runs.flatMap((run) => run.datasetSnapshot.map((sample) => sample.grader)))],
    [runs],
  );

  if (runs.length === 0) {
    return (
      <Card size="small" title={t('quality.report.title')}>
        <Empty description={t('quality.report.empty')} />
      </Card>
    );
  }

  // An interrupted run has a record but no samples. Rendering a scorecard full of
  // zeros and a "not judgeable" rate would describe a measurement that never
  // happened; say so instead.
  if (totals.samples === 0) {
    return (
      <Card size="small" title={t('quality.report.title')}>
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <span className="text-[12.5px] text-text-secondary">{t('quality.report.noResults')}</span>
          }
        />
      </Card>
    );
  }

  const columns = [
    {
      title: t('quality.scorecard.dataset'),
      dataIndex: 'datasetName',
      render: (name: string, run: QualityRun) => (
        <Space size={6} direction="vertical" className="!gap-0">
          <span className="text-[13px] text-text-primary">{name}</span>
          <span className="font-mono text-[11px] text-text-tertiary">
            {t('quality.scorecard.samples', { count: run.progress.total || run.datasetSnapshot.length })}
          </span>
        </Space>
      ),
    },
    {
      title: t('quality.scorecard.passRate'),
      dataIndex: 'passRate',
      width: 130,
      render: (_value: unknown, run: QualityRun) => {
        const summary = Object.values(run.results)[0];
        // No summary means the run produced nothing to judge — a dash, not a verdict.
        if (!summary) return <span className="font-mono text-[12px] text-text-tertiary">—</span>;
        return (
          <Space size={6}>
            <Tag color={rateColor(summary.passRate)}>
              {formatPercent(summary.passRate, t('quality.report.notJudgeable'))}
            </Tag>
          </Space>
        );
      },
    },
    {
      title: t('quality.scorecard.breakdown'),
      width: 170,
      render: (_value: unknown, run: QualityRun) => {
        const summary = Object.values(run.results)[0];
        if (!summary) return '—';
        return (
          <span className="font-mono text-[12px]">
            <span style={{ color: '#10b981' }}>{summary.passCount}</span>
            <span className="text-text-tertiary"> / </span>
            <span style={{ color: '#ef4444' }}>{summary.failCount}</span>
            <span className="text-text-tertiary"> / </span>
            <span style={{ color: '#f59e0b' }}>{summary.errorCount}</span>
          </span>
        );
      },
    },
    {
      title: t('quality.scorecard.latency'),
      width: 110,
      render: (_value: unknown, run: QualityRun) => {
        const summary = Object.values(run.results)[0];
        return <span className="font-mono text-[12px]">{formatMs(summary?.avgResponseTime ?? 0)}</span>;
      },
    },
    {
      title: t('quality.scorecard.cost'),
      width: 110,
      render: (_value: unknown, run: QualityRun) => {
        const summary = Object.values(run.results)[0];
        return <span className="font-mono text-[12px]">{formatCost(summary?.totalCost ?? 0)}</span>;
      },
    },
    {
      title: t('quality.scorecard.status'),
      width: 110,
      render: (_value: unknown, run: QualityRun) => (
        <Tag color={run.status === 'completed' ? 'green' : run.status === 'running' ? 'blue' : 'orange'}>
          {t(`quality.run.status.${run.status}`)}
        </Tag>
      ),
    },
  ];

  return (
    <div className="space-y-4" data-tour="quality-report">
      <Card
        size="small"
        title={t('quality.report.title')}
        extra={
          partial ? <Tag color="blue">{t('quality.report.partial')}</Tag> : <Tag color="green">{t('quality.report.done')}</Tag>
        }
      >
        <div className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <div className="data-label">{t('quality.report.subject')}</div>
              <div className="mt-0.5 text-[15px] font-medium text-text-primary">{modelLabel || '—'}</div>
            </div>
            <div className="flex flex-wrap gap-x-8 gap-y-3">
              <div>
                <div className="data-label">{t('quality.report.overallRate')}</div>
                <div className="mt-0.5 flex items-baseline gap-2">
                  <span className="text-[26px] font-medium leading-none text-text-primary">
                    {formatPercent(totals.passRate, t('quality.report.notJudgeable'))}
                  </span>
                  <span className="text-[12px] text-text-tertiary">
                    {t('quality.report.of', { pass: totals.pass, judged: totals.judged })}
                  </span>
                </div>
              </div>
              <div>
                <div className="data-label">{t('quality.report.questions')}</div>
                <div className="mt-0.5 font-mono text-[15px] text-text-primary">{totals.samples}</div>
              </div>
              <div>
                <div className="data-label">{t('quality.report.totalCost')}</div>
                <div className="mt-0.5 font-mono text-[15px] text-text-primary">{formatCost(totals.cost)}</div>
              </div>
            </div>
          </div>

          {totals.error > 0 && (
            <Alert
              type="warning"
              showIcon
              message={t('quality.report.errorBanner', { count: totals.error })}
              className="!text-[12px]"
            />
          )}

          <div className="hairline-top" />

          <div className="flex flex-wrap gap-x-6 gap-y-2 text-[11.5px] text-text-tertiary">
            <span>
              {t('quality.report.conditions.temperature', { value: params?.temperature ?? 0 })}
            </span>
            <span>{t('quality.report.conditions.maxTokens', { value: params?.maxTokens ?? 0 })}</span>
            <span>{t('quality.report.conditions.concurrency', { value: params?.concurrency ?? 1 })}</span>
            <Tooltip title={graderTypes.join(', ')}>
              <span className="cursor-help">
                {t('quality.report.conditions.graders', { count: graderTypes.length })}
              </span>
            </Tooltip>
            <span>{t('quality.report.conditions.frozen')}</span>
          </div>
        </div>
      </Card>

      <Card size="small" title={t('quality.scorecard.title')}>
        <Table
          size="small"
          rowKey="id"
          columns={columns}
          dataSource={runs}
          pagination={false}
          scroll={{ x: 820 }}
          expandable={{
            expandedRowRender: (run: QualityRun) => {
              const summary = Object.values(run.results)[0];
              const samples = (summary?.samples ?? []) as QualitySampleResult[];
              return (
                <div className="space-y-4 py-1">
                  {summary && summary.byCategory.length > 1 && (
                    <div>
                      <div className="data-label mb-2">{t('quality.scorecard.byCategory')}</div>
                      <div className="flex flex-wrap gap-2">
                        {summary.byCategory.map((category) => (
                          <span key={category.category} className="param-chip">
                            {category.category}
                            <span className="ml-1.5 font-mono text-text-primary">
                              {formatPercent(category.passRate, t('quality.report.notJudgeable'))}
                            </span>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  <div>
                    <div className="data-label mb-2">{t('quality.scorecard.detail')}</div>
                    <QualitySampleTable samples={samples} />
                  </div>
                </div>
              );
            },
          }}
        />
      </Card>
    </div>
  );
}
