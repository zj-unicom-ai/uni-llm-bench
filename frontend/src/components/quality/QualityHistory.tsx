import { useTranslation } from 'react-i18next';
import { Button, Card, Empty, Popconfirm, Space, Table, Tag } from '../../antdImports';
import { QualityRunListItem } from '../../types';
import { formatPercent, formatWhen } from './gradeDetail';

interface QualityHistoryProps {
  history: QualityRunListItem[];
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onExport: (id: string, format: 'json' | 'csv') => void;
  /** Id of the run currently being fetched, so the button shows its own spinner. */
  openingId?: string | null;
}

/** Earlier health checks. A run's conditions are frozen, so reopening one is honest. */
export function QualityHistory({ history, onOpen, onDelete, onExport, openingId }: QualityHistoryProps) {
  const { t } = useTranslation();

  const columns = [
    {
      title: t('quality.history.name'),
      dataIndex: 'name',
      render: (name: string, run: QualityRunListItem) => (
        <Space size={6} direction="vertical" className="!gap-0">
          <span className="text-[13px] text-text-primary">{name}</span>
          <span className="text-[11px] text-text-tertiary">
            {run.targets.map((target) => run.targetLabels[target] ?? target).join(', ')}
          </span>
        </Space>
      ),
    },
    {
      title: t('quality.history.target'),
      dataIndex: 'datasetName',
      width: 200,
      render: (name: string, run: QualityRunListItem) => (
        <span className="text-[12px] text-text-secondary">
          {name}
          <span className="ml-1.5 font-mono text-text-tertiary">{run.sampleCount}</span>
        </span>
      ),
    },
    {
      title: t('quality.history.passRate'),
      width: 120,
      render: (_value: unknown, run: QualityRunListItem) => {
        const summary = Object.values(run.results)[0];
        // A run that produced no results (interrupted before the first sample, or
        // cancelled) has nothing to judge. Saying "not judgeable" would imply we
        // tried and failed; a dash says what actually happened.
        if (!summary) return <span className="font-mono text-[12px] text-text-tertiary">—</span>;
        const errors = summary.errorCount > 0;
        return (
          <Space size={4}>
            <span className="font-mono text-[12px]">
              {formatPercent(summary.passRate, t('quality.report.notJudgeable'))}
            </span>
            {errors && (
              <Tag color="orange" className="!mr-0">
                {t('quality.history.errors', { count: summary.errorCount })}
              </Tag>
            )}
          </Space>
        );
      },
    },
    {
      title: t('quality.history.status'),
      width: 110,
      dataIndex: 'status',
      render: (status: QualityRunListItem['status']) => (
        <Tag color={status === 'completed' ? 'green' : status === 'running' ? 'blue' : 'orange'}>
          {t(`quality.run.status.${status}`)}
        </Tag>
      ),
    },
    {
      title: t('quality.history.createdAt'),
      dataIndex: 'createdAt',
      width: 170,
      render: (iso: string) => <span className="text-[12px] text-text-secondary">{formatWhen(iso)}</span>,
    },
    {
      title: t('quality.history.actions'),
      width: 200,
      render: (_value: unknown, run: QualityRunListItem) => (
        <Space size={4}>
          <Button
            size="small"
            type="link"
            loading={openingId === run.id}
            onClick={() => onOpen(run.id)}
          >
            {t('quality.history.open')}
          </Button>
          <Button size="small" type="link" onClick={() => onExport(run.id, 'csv')}>
            CSV
          </Button>
          <Popconfirm title={t('quality.history.confirmDelete')} onConfirm={() => onDelete(run.id)}>
            <Button size="small" type="link" danger>
              {t('common.action.delete')}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card size="small" title={t('quality.history.title')} data-tour="quality-history">
      {history.length === 0 ? (
        <Empty description={t('quality.history.empty')} />
      ) : (
        <Table
          size="small"
          rowKey="id"
          columns={columns}
          dataSource={history}
          pagination={history.length > 10 ? { pageSize: 10, size: 'small' } : false}
          scroll={{ x: 900 }}
        />
      )}
    </Card>
  );
}
