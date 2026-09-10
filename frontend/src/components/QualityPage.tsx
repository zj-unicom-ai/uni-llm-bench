import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Drawer, Tag } from '../antdImports';
import { useQuality } from '../hooks/useQuality';
import { downloadUrl } from '../services/api';
import { QualityRunParamsInput } from '../hooks/useQuality';
import { QualityRunForm } from './quality/QualityRunForm';
import { QualityProgress } from './quality/QualityProgress';
import { QualityReport } from './quality/QualityReport';
import { QualityHistory } from './quality/QualityHistory';
import { QualityEstimate, QualityRun } from '../types';
import { formatWhen } from './quality/gradeDetail';

/**
 * 4096 rather than 1024: a reasoning model can spend its whole budget on hidden
 * reasoning and return nothing at all, and an unused ceiling is not billed.
 */
const DEFAULT_PARAMS: QualityRunParamsInput = { temperature: 0, maxTokens: 4096, concurrency: 4 };

/**
 * Quality health check — one model, every selected dataset, one scorecard.
 *
 * Datasets run sequentially (see `useQuality`), so the report grows one row at a
 * time and a failure part-way leaves an honest partial result rather than a
 * blank page.
 */
export function QualityPage() {
  const { t } = useTranslation();
  const {
    providers,
    datasets,
    history,
    loading,
    error,
    setError,
    phase,
    active,
    tally,
    report,
    refresh,
    estimate,
    startReport,
    cancel,
    loadRun,
    deleteRun,
    reset,
  } = useQuality();

  const [target, setTarget] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [params, setParams] = useState<QualityRunParamsInput>(DEFAULT_PARAMS);
  // Estimates are keyed by the inputs that produced them, so a stale figure can
  // never be shown for a different selection — no state reset needed in the effect.
  const [estimateState, setEstimateState] = useState<{ key: string; data: QualityEstimate[] | null } | null>(null);
  const estimateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A past run opens in place, next to the row that was clicked. Rendering it
  // further up the page meant the click produced no visible change at all.
  const [viewingRun, setViewingRun] = useState<QualityRun | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const estimateKey =
    target && selected.length > 0
      ? `${target}|${selected.join(',')}|${params.temperature}|${params.maxTokens}|${params.concurrency}`
      : '';
  const estimates = estimateState?.key === estimateKey ? estimateState.data : null;
  const estimating = estimateKey !== '' && estimateState?.key !== estimateKey;

  // Re-estimate whenever the inputs that drive cost change. Debounced so typing
  // in the token field does not fire a request per keystroke.
  useEffect(() => {
    if (estimateTimer.current) clearTimeout(estimateTimer.current);
    if (!target || selected.length === 0) return;

    estimateTimer.current = setTimeout(async () => {
      const result = await estimate(target, selected, params);
      setEstimateState({ key: estimateKey, data: result });
    }, 400);

    return () => {
      if (estimateTimer.current) clearTimeout(estimateTimer.current);
    };
  }, [target, selected, params, estimate, estimateKey]);

  const running = phase === 'running';

  const targetLabel = useMemo(() => {
    if (!target) return '';
    const [providerId, modelName] = target.split(':', 2);
    const provider = providers.find((p) => p.id === providerId);
    const model = provider?.models.find((m) => m.name === modelName);
    return provider ? `${provider.name} / ${model?.displayName || modelName}` : modelName;
  }, [target, providers]);

  const datasetProgress = active && active.total > 0 ? active.index / active.total : 0;

  const handleStart = useCallback(() => {
    if (!target || selected.length === 0) return;
    void startReport(target, selected, params, targetLabel);
  }, [target, selected, params, targetLabel, startReport]);

  const handleExport = useCallback(async (id: string, format: 'json' | 'csv') => {
    const url = await downloadUrl(`/api/quality/runs/${id}/export?format=${format}`);
    window.open(url, '_blank');
  }, []);

  const handleDelete = useCallback(
    async (id: string) => {
      await deleteRun(id);
    },
    [deleteRun],
  );

  const handleOpen = useCallback(
    async (id: string) => {
      setOpeningId(id);
      try {
        const run = await loadRun(id);
        if (run) setViewingRun(run);
      } finally {
        setOpeningId(null);
      }
    },
    [loadRun],
  );

  const handleReset = useCallback(() => {
    reset();
    setEstimateState(null);
  }, [reset]);

  return (
    <div className="space-y-6">
      <div data-tour="quality-intro">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-[15px] font-semibold text-text-primary">{t('page.quality.title')}</h2>
            <p className="mt-1 max-w-3xl text-[12.5px] leading-relaxed text-text-secondary">
              {t('page.quality.subtitle')}
            </p>
          </div>
          {phase !== 'idle' && (
            <Button size="small" onClick={handleReset} disabled={running}>
              {t('quality.report.newCheck')}
            </Button>
          )}
        </div>
      </div>

      {error && (
        <Alert type="error" showIcon closable message={error} onClose={() => setError(null)} className="!text-[12.5px]" />
      )}

      <QualityRunForm
        providers={providers}
        datasets={datasets}
        running={running}
        target={target}
        onTargetChange={setTarget}
        selected={selected}
        onSelectedChange={setSelected}
        params={params}
        onParamsChange={setParams}
        estimate={estimates}
        estimating={estimating}
        onStart={handleStart}
        onCancel={() => void cancel()}
      />

      {loading && <Alert type="info" showIcon message={t('common.status.loading')} className="!text-[12.5px]" />}

      {running && <QualityProgress active={active} tally={tally} datasetProgress={datasetProgress} />}

      {(report.length > 0 || phase === 'done') && (
        <>
          {running && report.length > 0 && (
            <Alert type="info" showIcon message={t('quality.report.partialHint')} className="!text-[12.5px]" />
          )}
          <QualityReport runs={report} partial={running} />
        </>
      )}

      {!running && (
        <QualityHistory
          history={history}
          openingId={openingId}
          onOpen={(id) => void handleOpen(id)}
          onDelete={(id) => void handleDelete(id)}
          onExport={(id, format) => void handleExport(id, format)}
        />
      )}

      <Drawer
        open={viewingRun !== null}
        onClose={() => setViewingRun(null)}
        placement="right"
        styles={{
          wrapper: { width: 'min(1100px, 96vw)' },
          header: { background: '#ffffff', borderBottom: '1px solid var(--color-border)' },
          body: { background: '#f5f6f9', padding: 16 },
        }}
        title={t('quality.history.drawerTitle')}
        extra={
          viewingRun && (
            <Button size="small" onClick={() => void handleExport(viewingRun.id, 'csv')}>
              {t('common.action.export')} CSV
            </Button>
          )
        }
      >
        {viewingRun && (
          <div className="space-y-4">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[14px] font-medium text-text-primary">{viewingRun.name}</span>
                <Tag color={viewingRun.status === 'completed' ? 'green' : 'orange'}>
                  {t(`quality.run.status.${viewingRun.status}`)}
                </Tag>
              </div>
              <div className="mt-1 text-[11.5px] text-text-tertiary">
                {formatWhen(viewingRun.createdAt)} · {viewingRun.datasetName}
              </div>
              <Alert
                type="info"
                showIcon
                message={t('quality.history.frozenHint')}
                className="mt-3 !text-[12px]"
              />
            </div>
            <QualityReport runs={[viewingRun]} />
          </div>
        )}
      </Drawer>
    </div>
  );
}
