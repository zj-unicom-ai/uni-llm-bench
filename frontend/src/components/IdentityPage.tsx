import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Button,
  Card,
  Collapse,
  Empty,
  Select,
  Space,
  Spin,
  Steps,
  Table,
  Tag,
} from '../antdImports';
import { useIdentity, IdentityProbeResult, IdentityRun, ProbeStatus } from '../hooks/useIdentity';

const STATUS_COLOR: Record<ProbeStatus, string> = {
  pass: 'green',
  warn: 'orange',
  fail: 'red',
  error: 'red',
  skipped: 'default',
};

const VERDICT_COLOR: Record<string, string> = {
  consistent: 'green',
  suspicious: 'orange',
  mismatch: 'red',
  inconclusive: 'blue',
  error: 'red',
};

function providerOptions(providers: ReturnType<typeof useIdentity>['providers']) {
  return providers.map((p) => ({
    label: p.name,
    title: p.name,
    options: p.models.map((m) => ({
      label: `${p.name} / ${m.name}`,
      value: `${p.id}:${m.name}`,
    })),
  }));
}

interface IdentityPageProps {
  onStartTour?: () => void;
}

export function IdentityPage({ onStartTour }: IdentityPageProps) {
  const { t } = useTranslation();
  const {
    providers,
    baselines,
    runs,
    probes,
    loading,
    busy,
    error,
    refresh,
    captureBaseline,
    verify,
    deleteBaseline,
  } = useIdentity();

  const [target, setTarget] = useState<string>();
  const [baselineId, setBaselineId] = useState<string>();
  const [current, setCurrent] = useState<IdentityRun | null>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const groupedProviders = useMemo(() => providerOptions(providers), [providers]);

  const baselineOptions = useMemo(
    () =>
      baselines.map((b) => ({
        label: `${b.providerName} / ${b.modelName} · ${new Date(b.capturedAt).toLocaleString()}`,
        value: b.id,
      })),
    [baselines],
  );

  const handleCapture = async () => {
    if (!target) return;
    await captureBaseline(target);
  };

  const handleVerify = async () => {
    if (!target) return;
    const run = await verify(target, baselineId);
    setCurrent(run);
  };

  const activeRun = current ?? runs[0] ?? null;

  const evidenceColumns = [
    {
      title: t('identity.evidence.probe'),
      dataIndex: 'id',
      key: 'name',
      width: 200,
      render: (id: string, row: IdentityProbeResult) => (
        <div>
          <div className="text-[12.5px] font-medium text-text-primary">
            {t(`identity.probe.${id}.name`)}
          </div>
          <div className="text-[11px] text-text-tertiary font-mono">
            {row.tier} · {row.id}
          </div>
        </div>
      ),
    },
    { title: t('identity.evidence.baseline'), dataIndex: 'baseline', key: 'baseline', width: 120, render: (v?: string | number | null) => (v === undefined || v === null ? '—' : String(v)) },
    {
      title: t('identity.evidence.observed'),
      dataIndex: 'observed',
      key: 'observed',
      width: 120,
      render: (v?: string | number | null) => (v === undefined || v === null ? '—' : String(v)),
    },
    {
      title: t('identity.evidence.status'),
      dataIndex: 'status',
      key: 'status',
      width: 90,
      render: (status: ProbeStatus) => (
        <Tag color={STATUS_COLOR[status]}>{t(`identity.status.${status}`)}</Tag>
      ),
    },
    {
      title: t('identity.evidence.detail'),
      dataIndex: 'detailKey',
      key: 'detail',
      render: (detailKey: string, row: IdentityProbeResult) => (
        <span className="text-[12px] text-text-secondary">
          {detailKey
            ? t(`identity.detail.${detailKey}`, row.params)
            : (row as unknown as { detail?: string }).detail}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      <div data-tour="identity-intro">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-[15px] font-semibold text-text-primary">{t('identity.title')}</h2>
            <p className="text-[12.5px] text-text-secondary mt-1 max-w-2xl leading-relaxed">
              {t('identity.subtitle')}
            </p>
          </div>
          {onStartTour && (
            <Button size="small" onClick={onStartTour}>
              {t('identity.showGuide')}
            </Button>
          )}
        </div>
      </div>

      {error && <Alert type="error" showIcon message={error} closable onClose={() => undefined} />}

      {!loading && baselines.length === 0 && (
        <Alert
          type="info"
          showIcon
          message={t('identity.empty.title')}
          description={
            <div className="mt-2">
              <Steps
                size="small"
                direction="horizontal"
                current={0}
                items={[
                  { title: t('identity.empty.step1') },
                  { title: t('identity.empty.step2') },
                  { title: t('identity.empty.step3') },
                ]}
              />
            </div>
          }
        />
      )}

      <div className="grid grid-cols-1 xl:grid-cols-[380px_1fr] gap-5">
        <Card size="small" title={t('identity.setup.title')} data-tour="identity-target">
          <div className="space-y-4">
            <div>
              <div className="text-[12px] text-text-secondary mb-1.5">{t('identity.setup.target')}</div>
              <Select
                size="small"
                className="w-full"
                placeholder={t('identity.setup.targetPlaceholder')}
                value={target}
                onChange={setTarget}
                options={groupedProviders}
                showSearch
                optionFilterProp="label"
              />
            </div>

            <div data-tour="identity-baseline">
              <div className="text-[12px] text-text-secondary mb-1.5">{t('identity.setup.baseline')}</div>
              <Select
                size="small"
                className="w-full"
                placeholder={t('identity.setup.baselinePlaceholder')}
                value={baselineId}
                onChange={setBaselineId}
                options={baselineOptions}
                allowClear
                notFoundContent={t('identity.setup.noBaseline')}
              />
              <div className="mt-2 flex items-center gap-2 flex-wrap">
                <Button size="small" disabled={!target || busy} onClick={handleCapture}>
                  {t('identity.setup.capture')}
                </Button>
                {baselineId && (
                  <Button size="small" danger onClick={() => void deleteBaseline(baselineId).then(() => setBaselineId(undefined))}>
                    {t('identity.setup.deleteBaseline')}
                  </Button>
                )}
              </div>
              <p className="text-[11.5px] text-text-tertiary mt-2 leading-relaxed">
                {t('identity.setup.baselineHint')}
              </p>
            </div>

            <div data-tour="identity-run">
              <Button type="primary" block disabled={!target || busy} loading={busy} onClick={handleVerify}>
                {t('identity.setup.run')}
              </Button>
            </div>
          </div>
        </Card>

        <div className="space-y-5" data-tour="identity-evidence">
          {loading ? (
            <Card size="small">
              <div className="py-10 flex justify-center">
                <Spin />
              </div>
            </Card>
          ) : activeRun ? (
            <>
              <Card size="small">
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <div>
                    <div className="text-[12px] text-text-tertiary">{activeRun.targetLabel}</div>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-[16px] font-semibold text-text-primary">
                        {t(`identity.verdict.${activeRun.verdict}`)}
                      </span>
                      <Tag color={VERDICT_COLOR[activeRun.verdict] ?? 'default'}>{activeRun.score}/100</Tag>
                    </div>
                    <div className="text-[11.5px] text-text-tertiary mt-1">
                      {activeRun.baselineLabel
                        ? `${t('identity.against')} ${activeRun.baselineLabel}`
                        : t('identity.noBaselineUsed')}
                    </div>
                  </div>
                  {activeRun.hardGates.length > 0 && (
                    <div className="text-right">
                      <div className="text-[11px] text-text-tertiary mb-1">{t('identity.hardGates')}</div>
                      <Space wrap>
                        {activeRun.hardGates.map((g) => (
                          <Tag key={g} color="red">
                            {g}
                          </Tag>
                        ))}
                      </Space>
                    </div>
                  )}
                </div>
              </Card>

              <Card size="small" title={t('identity.evidence.title')}>
                <Table
                  size="small"
                  rowKey={(row) => row.id}
                  columns={evidenceColumns}
                  dataSource={activeRun.probes}
                  pagination={false}
                />
              </Card>
            </>
          ) : (
            <Card size="small">
              <Empty description={t('identity.noRun')} />
            </Card>
          )}

          <Collapse
            size="small"
            items={[
              {
                key: 'probes',
                label: t('identity.howItWorks'),
                children: (
                  <div className="space-y-2">
                    {probes.map((p) => (
                      <div key={p.id} className="border-b border-border last:border-0 pb-2 last:pb-0">
                        <div className="flex items-center gap-2">
                          <Tag>{p.tier}</Tag>
                          <span className="text-[12.5px] font-medium text-text-primary">
                            {t(`identity.probe.${p.id}.name`)}
                          </span>
                          <span className="text-[11px] text-text-tertiary font-mono">
                            {t(`identity.cost.${p.cost}`)}
                          </span>
                        </div>
                        <p className="text-[12px] text-text-secondary mt-1">
                          {t(`identity.probe.${p.id}.desc`)}
                        </p>
                        <p className="text-[11.5px] text-text-tertiary mt-0.5">
                          {t(`identity.probe.${p.id}.rationale`)}
                        </p>
                      </div>
                    ))}
                  </div>
                ),
              },
            ]}
          />
        </div>
      </div>
    </div>
  );
}
