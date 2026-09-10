import { useTranslation } from 'react-i18next';
import { Alert, Button, Card, Checkbox, Collapse, InputNumber, Select, Space, Tag, Tooltip } from '../../antdImports';
import { QualityDatasetSummary, QualityEstimate } from '../../types';
import { QualityProviderOption, QualityRunParamsInput } from '../../hooks/useQuality';
import { formatCost } from './gradeDetail';

interface QualityRunFormProps {
  providers: QualityProviderOption[];
  datasets: QualityDatasetSummary[];
  running: boolean;
  target: string | null;
  onTargetChange: (value: string | null) => void;
  selected: string[];
  onSelectedChange: (ids: string[]) => void;
  params: QualityRunParamsInput;
  onParamsChange: (params: QualityRunParamsInput) => void;
  estimate: QualityEstimate[] | null;
  estimating: boolean;
  onStart: () => void;
  onCancel: () => void;
}

export function QualityRunForm({
  providers,
  datasets,
  running,
  target,
  onTargetChange,
  selected,
  onSelectedChange,
  params,
  onParamsChange,
  estimate,
  estimating,
  onStart,
  onCancel,
}: QualityRunFormProps) {
  const { t } = useTranslation();

  const modelOptions = providers.map((provider) => ({
    label: provider.name,
    title: provider.name,
    options: provider.models
      .filter((model) => model.isActive !== false)
      .map((model) => ({
        label: `${provider.name} / ${model.displayName || model.name}`,
        value: `${provider.id}:${model.name}`,
      })),
  }));

  const allSelected = datasets.length > 0 && selected.length === datasets.length;

  const totalSamples = datasets
    .filter((dataset) => selected.includes(dataset.id))
    .reduce((sum, dataset) => sum + dataset.sampleCount, 0);
  const totalCost = estimate?.reduce((sum, item) => sum + (item.totalTypicalCost ?? 0), 0) ?? null;
  const pricedDatasets = estimate?.filter((item) => item.totalTypicalCost !== null).length ?? 0;

  const toggle = (id: string, checked: boolean) => {
    onSelectedChange(checked ? [...selected, id] : selected.filter((value) => value !== id));
  };

  return (
    <Card size="small" title={t('quality.form.title')} data-tour="quality-config">
      <div className="space-y-5">
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <div className="config-section-sub mb-1.5">{t('quality.form.model')}</div>
            <Select
              className="w-full"
              showSearch
              optionFilterProp="label"
              placeholder={t('quality.form.modelPlaceholder')}
              value={target ?? undefined}
              onChange={(value) => onTargetChange(value ?? null)}
              options={modelOptions}
              disabled={running || providers.length === 0}
            />
          </div>
          <div>
            <div className="config-section-sub mb-1.5">{t('quality.form.datasets')}</div>
            <Space wrap size={6}>
              <Button size="small" disabled={running} onClick={() => onSelectedChange(datasets.map((d) => d.id))}>
                {t('quality.form.selectAll')}
              </Button>
              <Button size="small" disabled={running || selected.length === 0} onClick={() => onSelectedChange([])}>
                {t('quality.form.clearAll')}
              </Button>
              <span className="text-[12px] text-text-tertiary">
                {t('quality.form.selectedCount', { count: selected.length, total: datasets.length })}
              </span>
            </Space>
          </div>
        </div>

        <div className="space-y-2">
          {datasets.map((dataset) => {
            const checked = selected.includes(dataset.id);
            return (
              <label
                key={dataset.id}
                className={`flex items-start gap-3 rounded-lg border p-2.5 transition-colors ${
                  checked ? 'border-primary/40 bg-primary/[0.04]' : 'border-border hover:bg-black/[0.015]'
                } ${running ? 'cursor-not-allowed opacity-70' : 'cursor-pointer'}`}
              >
                <Checkbox
                  className="mt-0.5"
                  checked={checked}
                  disabled={running}
                  onChange={(event) => toggle(dataset.id, event.target.checked)}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] text-text-primary">{dataset.name}</span>
                    <Tag>{t('quality.form.sampleCount', { count: dataset.sampleCount })}</Tag>
                    {dataset.builtin && <Tag color="blue">{t('quality.form.builtin')}</Tag>}
                    {dataset.tags.map((tag) => (
                      <span key={tag} className="param-chip">
                        {tag}
                      </span>
                    ))}
                  </span>
                  <span className="mt-0.5 block text-[12px] leading-relaxed text-text-secondary">
                    {dataset.description}
                  </span>
                  {dataset.note && (
                    <Tooltip title={dataset.note}>
                      <span className="mt-1 block cursor-help text-[11.5px] text-text-tertiary underline decoration-dotted">
                        {t('quality.form.provenance')}
                      </span>
                    </Tooltip>
                  )}
                </span>
              </label>
            );
          })}
        </div>

        <Collapse
          ghost
          items={[
            {
              key: 'advanced',
              label: t('quality.form.advanced'),
              children: (
                <div className="grid gap-4 md:grid-cols-3">
                  <div>
                    <div className="config-section-sub mb-1.5">{t('quality.form.temperature')}</div>
                    <InputNumber
                      className="w-full"
                      min={0}
                      max={2}
                      step={0.1}
                      value={params.temperature}
                      disabled={running}
                      onChange={(value) => onParamsChange({ ...params, temperature: value ?? 0 })}
                    />
                    <div className="mt-1 text-[11.5px] leading-relaxed text-text-tertiary">
                      {t('quality.form.temperatureHint')}
                    </div>
                  </div>
                  <div>
                    <div className="config-section-sub mb-1.5">{t('quality.form.maxTokens')}</div>
                    <InputNumber
                      className="w-full"
                      min={16}
                      max={32000}
                      value={params.maxTokens}
                      disabled={running}
                      onChange={(value) => onParamsChange({ ...params, maxTokens: value ?? 1024 })}
                    />
                    <div className="mt-1 text-[11.5px] leading-relaxed text-text-tertiary">
                      {t('quality.form.maxTokensHint')}
                    </div>
                  </div>
                  <div>
                    <div className="config-section-sub mb-1.5">{t('quality.form.concurrency')}</div>
                    <InputNumber
                      className="w-full"
                      min={1}
                      max={16}
                      value={params.concurrency}
                      disabled={running}
                      onChange={(value) => onParamsChange({ ...params, concurrency: value ?? 4 })}
                    />
                    <div className="mt-1 text-[11.5px] leading-relaxed text-text-tertiary">
                      {t('quality.form.concurrencyHint')}
                    </div>
                  </div>
                </div>
              ),
            },
          ]}
        />

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <div className="text-[12px] leading-relaxed text-text-secondary">
            {selected.length === 0 ? (
              t('quality.form.noneSelected')
            ) : (
              <>
                <span className="data-value">{t('quality.form.totalRequests', { count: totalSamples })}</span>
                <span className="mx-2 text-text-tertiary">·</span>
                {estimating ? (
                  t('quality.form.estimateLoading')
                ) : totalCost === null || pricedDatasets === 0 ? (
                  t('quality.form.estimateUnavailable')
                ) : (
                  t('quality.form.estimatedCost', { cost: formatCost(totalCost) })
                )}
              </>
            )}
          </div>
          <Space>
            {running && (
              <Button danger onClick={onCancel}>
                {t('quality.form.cancel')}
              </Button>
            )}
            <Button
              type="primary"
              loading={running}
              disabled={!target || selected.length === 0 || running}
              onClick={onStart}
            >
              {running
                ? t('quality.form.running')
                : selected.length === 0
                  ? t('quality.form.start')
                  : t('quality.form.startCount', { count: selected.length })}
            </Button>
          </Space>
        </div>

        {allSelected && datasets.length > 0 && (
          <Alert
            type="info"
            showIcon
            message={t('quality.form.allSelectedNote', { count: totalSamples })}
            className="!text-[12px]"
          />
        )}
      </div>
    </Card>
  );
}
