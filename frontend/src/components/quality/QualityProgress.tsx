import { useTranslation } from 'react-i18next';
import { Card, Progress, Space, Statistic } from '../../antdImports';
import { QualityActiveStep, QualityLiveTally } from '../../types';

interface QualityProgressProps {
  active: QualityActiveStep | null;
  tally: QualityLiveTally;
  datasetProgress: number;
}

/**
 * Live progress while the health check runs.
 *
 * The error counter sits next to pass/fail rather than in a footnote: if a run
 * is producing errors, that is the single most important thing on screen — the
 * pass rate means nothing until you know how much of the suite actually ran.
 */
export function QualityProgress({ active, tally, datasetProgress }: QualityProgressProps) {
  const { t } = useTranslation();

  return (
    <Card size="small" title={t('quality.progress.title')} data-tour="quality-progress" className="running-card-glow">
      <div className="space-y-4">
        <div>
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 text-[12.5px] text-text-secondary">
            <span className="truncate">
              {t('quality.progress.dataset', {
                index: (active?.index ?? 0) + 1,
                total: active?.total ?? 0,
              })}
              {active ? ` · ${active.datasetName}` : ''}
            </span>
            <span className="font-mono">
              {active?.completed ?? 0} / {active?.samples ?? 0}
            </span>
          </div>
          <Progress
            percent={Math.round(
              active && active.samples > 0 ? (active.completed / active.samples) * 100 : 0,
            )}
            status="active"
            strokeColor="#2563eb"
          />
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Statistic title={t('quality.progress.overall')} value={Math.round(datasetProgress * 100)} suffix="%" />
          <Statistic title={t('quality.progress.passed')} value={tally.pass} valueStyle={{ color: '#10b981' }} />
          <Statistic title={t('quality.progress.failed')} value={tally.fail} valueStyle={{ color: '#ef4444' }} />
          <Statistic title={t('quality.progress.errors')} value={tally.error} valueStyle={{ color: '#f59e0b' }} />
        </div>

        <Space size={6} className="!text-[11.5px] text-text-tertiary">
          <span>{t('quality.progress.keepOpen')}</span>
        </Space>
      </div>
    </Card>
  );
}
