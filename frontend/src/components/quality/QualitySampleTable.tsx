import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Empty, Segmented, Table, Tag } from '../../antdImports';
import { QualitySampleResult } from '../../types';
import { STATUS_TAG_COLOR, formatCost, formatMs, gradeDetailText, graderLabel } from './gradeDetail';

type Filter = 'all' | 'fail' | 'error';

interface QualitySampleTableProps {
  samples: QualitySampleResult[];
}

function truncate(value: string, max = 90): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return '—';
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/** Per-sample drill-down: what was asked, what came back, and why it was graded that way. */
export function QualitySampleTable({ samples }: QualitySampleTableProps) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<Filter>('all');

  const rows = useMemo(() => {
    if (filter === 'fail') return samples.filter((sample) => sample.status === 'fail');
    if (filter === 'error') return samples.filter((sample) => sample.status === 'error');
    return samples;
  }, [samples, filter]);

  const columns = [
    {
      title: t('quality.detail.col.index'),
      dataIndex: 'index',
      width: 56,
      render: (index: number) => <span className="font-mono text-[12px] text-text-tertiary">{index + 1}</span>,
    },
    {
      title: t('quality.detail.col.category'),
      dataIndex: 'category',
      width: 150,
      render: (category: string) => <span className="text-[12px] text-text-secondary">{category}</span>,
    },
    {
      title: t('quality.detail.col.grader'),
      dataIndex: 'grader',
      width: 130,
      render: (grader: QualitySampleResult['grader']) => (
        <span className="text-[12px] text-text-secondary">{graderLabel(t, grader)}</span>
      ),
    },
    {
      title: t('quality.detail.col.status'),
      dataIndex: 'status',
      width: 90,
      render: (status: QualitySampleResult['status']) => (
        <Tag color={STATUS_TAG_COLOR[status]}>{t(`quality.status.${status}`)}</Tag>
      ),
    },
    {
      title: t('quality.detail.col.expected'),
      dataIndex: 'expected',
      width: 180,
      render: (expected: string | undefined) => (
        <span className="font-mono text-[11.5px] text-text-secondary">{expected ? truncate(expected, 40) : '—'}</span>
      ),
    },
    {
      title: t('quality.detail.col.output'),
      dataIndex: 'output',
      render: (output: string) => (
        <span className="font-mono text-[11.5px] text-text-primary">{truncate(output)}</span>
      ),
    },
    {
      title: t('quality.detail.col.reason'),
      dataIndex: 'detailKey',
      width: 260,
      render: (_key: string, sample: QualitySampleResult) => (
        <span className="text-[11.5px] leading-relaxed text-text-secondary">{gradeDetailText(t, sample)}</span>
      ),
    },
  ];

  if (samples.length === 0) {
    return <Empty description={t('quality.report.empty')} />;
  }

  return (
    <div className="space-y-3">
      <Segmented
        size="small"
        value={filter}
        onChange={(value) => setFilter(value as Filter)}
        options={[
          { label: t('quality.detail.filter.all', { count: samples.length }), value: 'all' },
          {
            label: t('quality.detail.filter.failed', {
              count: samples.filter((sample) => sample.status === 'fail').length,
            }),
            value: 'fail',
          },
          {
            label: t('quality.detail.filter.error', {
              count: samples.filter((sample) => sample.status === 'error').length,
            }),
            value: 'error',
          },
        ]}
      />

      <Table
        size="small"
        rowKey="sampleId"
        columns={columns}
        dataSource={rows}
        pagination={rows.length > 20 ? { pageSize: 20, size: 'small' } : false}
        scroll={{ x: 900 }}
        expandable={{
          expandedRowRender: (sample: QualitySampleResult) => (
            <div className="space-y-3 py-1">
              <div>
                <div className="data-label">{t('quality.detail.fullInput')}</div>
                <pre className="mt-1 max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/[0.035] p-2.5 font-mono text-[11.5px] leading-relaxed text-text-primary">
                  {sample.input}
                </pre>
              </div>
              {sample.expected && (
                <div>
                  <div className="data-label">{t('quality.detail.fullExpected')}</div>
                  <pre className="mt-1 whitespace-pre-wrap break-words rounded-md bg-black/[0.035] p-2.5 font-mono text-[11.5px] leading-relaxed text-text-primary">
                    {sample.expected}
                  </pre>
                </div>
              )}
              <div>
                <div className="data-label">{t('quality.detail.fullOutput')}</div>
                <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/[0.035] p-2.5 font-mono text-[11.5px] leading-relaxed text-text-primary">
                  {sample.output || t('quality.detail.emptyOutput')}
                </pre>
              </div>
              <div>
                <div className="data-label">{t('quality.detail.justification')}</div>
                <div className="mt-1 text-[12px] leading-relaxed text-text-secondary">{gradeDetailText(t, sample)}</div>
              </div>
              {sample.error && (
                <div>
                  <div className="data-label">{t('quality.detail.providerError')}</div>
                  <div className="mt-1 font-mono text-[11.5px] leading-relaxed text-accent-rose">
                    {sample.error}
                    {sample.errorCategory ? ` · ${sample.errorCategory}` : ''}
                  </div>
                </div>
              )}
              <div className="flex flex-wrap gap-x-5 gap-y-1 text-[11.5px] text-text-tertiary">
                <span>
                  {t('quality.detail.tokens', { input: sample.inputTokens, output: sample.outputTokens })}
                </span>
                {sample.reasoningTokens > 0 && (
                  <span>{t('quality.detail.reasoningTokens', { count: sample.reasoningTokens })}</span>
                )}
                <span>{t('quality.detail.latency', { value: formatMs(sample.responseTime) })}</span>
                <span>{t('quality.detail.cost', { value: formatCost(sample.estimatedCost) })}</span>
                {sample.usageEstimated && <span>{t('quality.detail.usageEstimated')}</span>}
              </div>
            </div>
          ),
        }}
      />
    </div>
  );
}
