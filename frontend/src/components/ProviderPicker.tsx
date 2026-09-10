import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '../antdImports';
import { InfoCircleOutlined, SearchOutlined, CloseOutlined } from '@ant-design/icons';
import { FORMAT_COLORS, ProviderConfigResponse } from '../types';

export interface PickedModel {
  providerId: string;
  modelName: string;
  providerName: string;
  displayLabel: string;
  color: string;
}

interface ProviderPickerProps {
  providers: ProviderConfigResponse[];
  loading: boolean;
  selectedModels: PickedModel[];
  isSelected: (providerId: string, modelName: string) => boolean;
  onToggle: (provider: ProviderConfigResponse, modelName: string) => void;
  onClearAll: () => void;
}

/** Step 2 — choose which providers/models participate in the benchmark. */
export function ProviderPicker({
  providers,
  loading,
  selectedModels,
  isSelected,
  onToggle,
  onClearAll,
}: ProviderPickerProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return providers;
    return providers
      .map((p) => ({
        ...p,
        models: p.models.filter(
          (m) =>
            m.isActive !== false &&
            (p.name.toLowerCase().includes(q) ||
              (m.displayName || m.name).toLowerCase().includes(q)),
        ),
      }))
      .filter((p) => p.models.length > 0);
  }, [providers, query]);

  return (
    <section className="wf-rail-card" data-tour="config-providers">
      <div className="wf-section-head">
        <span className="wf-step-badge">2</span>
        <div>
          <h3>{t('workflow.providersAndModels')}</h3>
          <p>{t('workflow.providersHint')}</p>
        </div>
      </div>

      {loading && providers.length === 0 ? (
        <div className="wf-empty animate-pulse">{t('workflow.loadingProviders')}</div>
      ) : providers.length === 0 ? (
        <div className="wf-empty">
          <div>{t('workflow.noProviders')}</div>
          <div>{t('workflow.goToSettings')}</div>
        </div>
      ) : (
        <>
          <Input
            className="provider-search"
            allowClear
            size="small"
            prefix={<SearchOutlined className="text-text-tertiary" />}
            placeholder={t('workflow.searchModels')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />

          <div className="provider-list">
            {filtered.map((provider) => {
              const activeModels = provider.models.filter((m) => m.isActive !== false);
              const color = FORMAT_COLORS[provider.format] || '#999';
              const hasSelected = activeModels.some((m) => isSelected(provider.id, m.name));
              return (
                <div key={provider.id} className={`provider-group${hasSelected ? ' is-selected' : ''}`}>
                  <div className="provider-group-head">
                    <span className="provider-dot" style={{ backgroundColor: color }} />
                    <span className="provider-name">{provider.name}</span>
                    {hasSelected && (
                      <span className="provider-count">
                        {activeModels.filter((m) => isSelected(provider.id, m.name)).length}/
                        {activeModels.length}
                      </span>
                    )}
                  </div>
                  <div className="provider-models">
                    {activeModels.map((model) => {
                      const selected = isSelected(provider.id, model.name);
                      return (
                        <button
                          key={model.id}
                          type="button"
                          onClick={() => onToggle(provider, model.name)}
                          className={`model-chip${selected ? ' is-selected' : ''}`}
                          style={
                            selected
                              ? {
                                  borderColor: `${color}55`,
                                  backgroundColor: `${color}14`,
                                  color,
                                }
                              : undefined
                          }
                        >
                          {selected && <span className="model-check">✓</span>}
                          {model.displayName || model.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
            {filtered.length === 0 && <div className="wf-empty">{t('workflow.noProviders')}</div>}
          </div>

          {selectedModels.length > 0 && (
            <div className="selected-strip">
              <div className="selected-strip-head">
                <span className="selected-strip-title">
                  {t('workflow.selectedModels', { count: selectedModels.length })}
                </span>
                <button
                  type="button"
                  className="text-[10px] text-text-tertiary hover:text-accent-rose transition-colors"
                  onClick={onClearAll}
                >
                  {t('workflow.clearAll')}
                </button>
              </div>
              <div>
                {selectedModels.map((m) => (
                  <span key={`${m.providerId}:${m.modelName}`} className="selected-chip">
                    <span className="dot" style={{ backgroundColor: m.color }} />
                    <span style={{ color: m.color, fontWeight: 500 }}>{m.providerName}</span>
                    <span style={{ color: 'var(--color-text-tertiary)' }}>/ {m.modelName}</span>
                    <span
                      className="x"
                      role="button"
                      aria-label={t('workflow.clearAll')}
                      onClick={() => {
                        const provider = providers.find((p) => p.id === m.providerId);
                        if (provider) onToggle(provider, m.modelName);
                      }}
                    >
                      <CloseOutlined style={{ fontSize: 9 }} />
                    </span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      <div className="flex items-center gap-1 mt-3 text-[10px] text-text-tertiary">
        <InfoCircleOutlined />
        <span>{t('workflow.modelsSelected', { count: selectedModels.length })}</span>
      </div>
    </section>
  );
}
