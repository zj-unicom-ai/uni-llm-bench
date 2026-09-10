import { useTranslation } from 'react-i18next';
import {
  BenchmarkConfig,
  ProviderConfigResponse,
  FORMAT_COLORS,
} from '../types';
import {
  PRESET_PROMPTS,
  QUICK_MAX_TOKENS,
  QUICK_CONCURRENCY,
  QUICK_ITERATIONS,
  QUICK_WARMUP,
  QUICK_INTERVAL,
  QUICK_QPS,
  OUTPUT_SCOPE_OPTIONS,
  applyOutputScope,
  getStoredOutputScope,
  storeOutputScope,
  getStoredMaxTokens,
  storeMaxTokens,
  loadHeavyPreset,
} from '../constants';
import { countTokens } from '../utils/tokenCount';
import { Input, InputNumber, Switch, Tooltip, Select } from '../antdImports';
import { InfoCircleOutlined } from '@ant-design/icons';
import type { TaskConfig } from './WorkflowConfigPanel';

const HEAVY_THRESHOLD = 10_000; // chars

/** Compact quick-pick row for numeric parameters (concurrency / iterations / tokens …). */
function QuickButtons({
  options,
  value,
  onChange,
  color = '#10b981',
}: {
  options: { label: string; labelKey?: string; value: number }[];
  value: number;
  onChange: (v: number) => void;
  color?: string;
}) {
  const { t } = useTranslation();
  // Adaptive sizing: shrink when many options to stay on one line
  const compact = options.length > 7;
  const fontSize = compact ? '9px' : '10px';
  const px = compact ? '0.25rem' : '0.5rem';
  return (
    <div className="flex flex-nowrap gap-0.5 mb-1.5 overflow-x-auto">
      {options.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            className="rounded font-mono transition-all whitespace-nowrap shrink-0"
            style={{
              fontSize,
              padding: `2px ${px}`,
              fontWeight: active ? 600 : 400,
              border: active ? `1px solid ${color}50` : '1px solid transparent',
              backgroundColor: active ? `${color}18` : 'transparent',
              color: active ? color : 'rgba(17,24,39,0.35)',
            }}
          >
            {opt.labelKey ? t(opt.labelKey) : opt.label}
          </button>
        );
      })}
    </div>
  );
}

interface TaskEditorProps {
  task: TaskConfig;
  index: number;
  tasks: TaskConfig[];
  configuredProviders: ProviderConfigResponse[];
  heavyPromptsRef: React.MutableRefObject<Map<number, string>>;
  heavyTaskIndexes: Set<number>;
  setHeavyTaskIndexes: React.Dispatch<React.SetStateAction<Set<number>>>;
  setTasks: React.Dispatch<React.SetStateAction<TaskConfig[]>>;
  updateTask: (index: number, updates: Partial<TaskConfig>) => void;
  updateTaskConfig: (index: number, configUpdates: Partial<BenchmarkConfig>) => void;
}

export function TaskEditor({
  task,
  index,
  tasks,
  configuredProviders,
  heavyPromptsRef,
  heavyTaskIndexes,
  setHeavyTaskIndexes,
  setTasks,
  updateTask,
  updateTaskConfig,
}: TaskEditorProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-5">
      {/* Row 1: Preset Prompt Buttons */}
      <div className="space-y-2">
        <div className="flex items-center gap-1">
          <span className="text-[10px] font-mono font-semibold uppercase tracking-wider text-text-tertiary">
            {t('workflow.presetPrompts')}
          </span>
          <Tooltip title={t('workflow.presetPromptsTooltip')}>
            <InfoCircleOutlined className="text-[9px] text-text-tertiary cursor-help" />
          </Tooltip>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {PRESET_PROMPTS.map((preset) => (
            <button
              key={preset.labelKey || preset.label}
              onClick={async () => {
                const isLC = !!preset.multiDoc;
                const scope = task._outputScope ?? getStoredOutputScope();
                let raw: string;
                if (preset.heavy) {
                  const bucket = preset.tokens >= 200_000 ? '256k' : preset.tokens >= 100_000 ? '150k' : '64k';
                  raw = await loadHeavyPreset(bucket);
                } else {
                  raw = preset.prompt;
                }
                const finalText = isLC ? applyOutputScope(raw, scope) : raw;
                const newTasks = [...tasks];
                const updated = {
                  ...newTasks[index],
                  _isLongContext: isLC,
                  _outputScope: scope,
                  _activePreset: preset.labelKey || preset.label,
                };
                if (finalText.length > HEAVY_THRESHOLD) {
                  heavyPromptsRef.current.set(index, finalText);
                  setHeavyTaskIndexes((prev) => new Set(prev).add(index));
                  updated.config = {
                    ...updated.config,
                    prompt:
                      finalText.slice(0, 200) +
                      `\n\n… ${t('workflow.charsTotalLoaded', { count: finalText.length })}`,
                  };
                } else {
                  heavyPromptsRef.current.delete(index);
                  setHeavyTaskIndexes((prev) => {
                    const s = new Set(prev);
                    s.delete(index);
                    return s;
                  });
                  updated.config = { ...updated.config, prompt: finalText };
                }
                newTasks[index] = updated;
                setTasks(newTasks);
              }}
              className={`text-[10px] px-2 py-1 rounded border transition-all font-medium ${
                task._activePreset === (preset.labelKey || preset.label)
                  ? 'border-accent-teal/40 bg-accent-teal/8 text-accent-teal'
                  : 'border-border text-text-secondary hover:border-border-hover hover:text-text-primary'
              }`}
            >
              {preset.labelKey ? t(preset.labelKey) : preset.label}
            </button>
          ))}
        </div>
      </div>

      {/* Output Scope (long-context only) */}
      {task._isLongContext && (
        <div className="flex items-center gap-2">
          <Tooltip title={t('config.outputScopeTooltip')}>
            <label className="text-[11px] text-text-secondary font-medium whitespace-nowrap cursor-help">
              {t('workflow.outputScope')}
            </label>
          </Tooltip>
          <Select
            size="small"
            value={task._outputScope ?? getStoredOutputScope()}
            onChange={(v) => {
              storeOutputScope(v);
              const fullPrompt = heavyPromptsRef.current.get(index) || task.config.prompt;
              const newPrompt = applyOutputScope(fullPrompt, v);
              const newTasks = [...tasks];
              const updated = { ...newTasks[index], _outputScope: v };
              if (newPrompt.length > HEAVY_THRESHOLD) {
                heavyPromptsRef.current.set(index, newPrompt);
                setHeavyTaskIndexes((prev) => new Set(prev).add(index));
                updated.config = {
                  ...updated.config,
                  prompt:
                    newPrompt.slice(0, 200) +
                    `\n\n… ${t('workflow.charsTotalLoaded', { count: newPrompt.length })}`,
                };
              } else {
                heavyPromptsRef.current.delete(index);
                setHeavyTaskIndexes((prev) => {
                  const s = new Set(prev);
                  s.delete(index);
                  return s;
                });
                updated.config = { ...updated.config, prompt: newPrompt };
              }
              newTasks[index] = updated;
              setTasks(newTasks);
            }}
            options={OUTPUT_SCOPE_OPTIONS}
            style={{ width: 160, fontSize: 11 }}
          />
        </div>
      )}

      {/* Row 3: Prompt TextArea + System Prompt */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="space-y-2 lg:col-span-2">
          <label className="text-[11px] text-text-secondary font-medium">{t('workflow.testPrompt')}</label>
          <Tooltip title={t('workflow.testPromptTooltip')}>
            <InfoCircleOutlined className="text-[10px] text-text-tertiary cursor-help ml-1" />
          </Tooltip>
          <Input.TextArea
            value={task.config.prompt}
            onChange={(e) => {
              heavyPromptsRef.current.delete(index);
              setHeavyTaskIndexes((prev) => {
                const s = new Set(prev);
                s.delete(index);
                return s;
              });
              updateTaskConfig(index, { prompt: e.target.value });
              updateTask(index, { _activePreset: undefined } as Partial<TaskConfig>);
            }}
            readOnly={heavyTaskIndexes.has(index)}
            autoSize={{ minRows: 3, maxRows: 8 }}
            placeholder={t('workflow.testPromptPlaceholder')}
            style={{ fontSize: 13 }}
          />
          {heavyTaskIndexes.has(index) && (
            <div className="px-2 py-1 rounded bg-surface-secondary border border-border flex items-center justify-between gap-2">
              <span className="text-[11px] text-text-tertiary">{t('workflow.largePromptLoaded')}</span>
              <button
                onClick={() => {
                  heavyPromptsRef.current.delete(index);
                  setHeavyTaskIndexes((prev) => {
                    const s = new Set(prev);
                    s.delete(index);
                    return s;
                  });
                  updateTaskConfig(index, { prompt: '' });
                }}
                className="text-[11px] text-text-secondary hover:text-text-primary transition-colors"
              >
                {t('common.action.clear')}
              </button>
            </div>
          )}
          {!heavyTaskIndexes.has(index) && (
            <span className="text-[10px] text-text-tertiary font-mono">
              {countTokens(task.config.prompt)} {t('common.unit.tokens').toLowerCase()}
            </span>
          )}
        </div>
        <div className="space-y-2">
          <label className="text-[11px] text-text-secondary font-medium">{t('workflow.systemPrompt')}</label>
          <Tooltip title={t('workflow.systemPromptTooltip')}>
            <InfoCircleOutlined className="text-[10px] text-text-tertiary cursor-help ml-1" />
          </Tooltip>
          <Input.TextArea
            value={task.config.systemPrompt || ''}
            onChange={(e) => updateTaskConfig(index, { systemPrompt: e.target.value })}
            autoSize={{ minRows: 3, maxRows: 8 }}
            placeholder={t('workflow.systemPromptPlaceholder')}
            style={{ fontSize: 13 }}
          />
        </div>
      </div>

      {/* Row 4: Core Parameters with QuickButtons */}
      <div className="section-header" data-color="teal">
        {t('workflow.coreParameters')}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="space-y-2">
          <div className="flex items-center gap-1">
            <label className="param-chip-label">{t('workflow.maxTokens')}</label>
            <Tooltip title={t('workflow.maxTokensTooltip')}>
              <InfoCircleOutlined className="text-[10px] text-text-tertiary cursor-help" />
            </Tooltip>
          </div>
          <QuickButtons
            options={QUICK_MAX_TOKENS}
            value={task.config.maxTokens}
            onChange={(v) => {
              updateTaskConfig(index, { maxTokens: v });
              storeMaxTokens(v);
            }}
            color="#10b981"
          />
          <InputNumber
            changeOnBlur
            value={task.config.maxTokens}
            onChange={(v) => {
              const val = v ?? getStoredMaxTokens();
              updateTaskConfig(index, { maxTokens: val });
              storeMaxTokens(val);
            }}
            min={50}
            max={32000}
            size="small"
            className="font-mono"
            style={{ width: '100%' }}
          />
        </div>
        <div className="space-y-2">
          <div className="flex items-center gap-1">
            <label className="param-chip-label">{t('workflow.concurrency')}</label>
            <Tooltip title={t('workflow.concurrencyTooltip')}>
              <InfoCircleOutlined className="text-[10px] text-text-tertiary cursor-help" />
            </Tooltip>
          </div>
          <QuickButtons
            options={QUICK_CONCURRENCY}
            value={task.config.concurrency}
            onChange={(v) => updateTaskConfig(index, { concurrency: v })}
            color="#2563eb"
          />
          <InputNumber
            changeOnBlur
            value={task.config.concurrency}
            onChange={(v) => updateTaskConfig(index, { concurrency: v ?? 1 })}
            min={1}
            max={5000}
            size="small"
            className="font-mono"
            style={{ width: '100%' }}
          />
        </div>
        <div className="space-y-2">
          <div className="flex items-center gap-1">
            <label className="param-chip-label">{t('workflow.iterations')}</label>
            <Tooltip title={t('workflow.iterationsTooltip')}>
              <InfoCircleOutlined className="text-[10px] text-text-tertiary cursor-help" />
            </Tooltip>
          </div>
          <QuickButtons
            options={QUICK_ITERATIONS}
            value={task.config.iterations}
            onChange={(v) => updateTaskConfig(index, { iterations: v })}
            color="#10b981"
          />
          <InputNumber
            changeOnBlur
            value={task.config.iterations}
            onChange={(v) => updateTaskConfig(index, { iterations: v ?? 10 })}
            min={1}
            max={10000000}
            size="small"
            className="font-mono"
            style={{ width: '100%' }}
          />
        </div>
      </div>

      {/* Advanced Parameters */}
      <div className="section-header" data-color="amber">
        {t('workflow.tuning')}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="space-y-2">
          <div className="flex items-center gap-1">
            <label className="param-chip-label">{t('workflow.warmupRuns')}</label>
            <Tooltip title={t('workflow.warmupRunsTooltip')}>
              <InfoCircleOutlined className="text-[10px] text-text-tertiary cursor-help" />
            </Tooltip>
          </div>
          <QuickButtons
            options={QUICK_WARMUP}
            value={task.config.warmupRuns ?? 0}
            onChange={(v) => updateTaskConfig(index, { warmupRuns: v })}
            color="#f59e0b"
          />
          <InputNumber
            changeOnBlur
            value={task.config.warmupRuns ?? 0}
            onChange={(v) => updateTaskConfig(index, { warmupRuns: v ?? 0 })}
            min={0}
            max={5}
            size="small"
            className="font-mono"
            style={{ width: '100%' }}
          />
        </div>
        <div className="space-y-2">
          <div className="flex items-center gap-1">
            <label className="param-chip-label">{t('workflow.intervalMs')}</label>
            <Tooltip title={t('workflow.intervalTooltip')}>
              <InfoCircleOutlined className="text-[10px] text-text-tertiary cursor-help" />
            </Tooltip>
          </div>
          <QuickButtons
            options={QUICK_INTERVAL}
            value={task.config.requestInterval ?? 0}
            onChange={(v) => updateTaskConfig(index, { requestInterval: v })}
            color="#f59e0b"
          />
          <InputNumber
            changeOnBlur
            value={task.config.requestInterval ?? 0}
            onChange={(v) => updateTaskConfig(index, { requestInterval: v ?? 0 })}
            min={0}
            max={10000}
            size="small"
            className="font-mono"
            style={{ width: '100%' }}
          />
        </div>
        <div className="space-y-2">
          <div className="flex items-center gap-1">
            <label className="param-chip-label">{t('workflow.maxQps')}</label>
            <Tooltip title={t('workflow.maxQpsTooltip')}>
              <InfoCircleOutlined className="text-[10px] text-text-tertiary cursor-help" />
            </Tooltip>
          </div>
          <QuickButtons
            options={QUICK_QPS}
            value={task.config.maxQps ?? 0}
            onChange={(v) => updateTaskConfig(index, { maxQps: v })}
            color="#8b5cf6"
          />
          <InputNumber
            changeOnBlur
            value={task.config.maxQps ?? 0}
            onChange={(v) => updateTaskConfig(index, { maxQps: v ?? 0 })}
            min={0}
            max={1000}
            step={0.1}
            size="small"
            className="font-mono"
            style={{ width: '100%' }}
            placeholder={t('workflow.unlimited')}
          />
        </div>
      </div>

      {/* Streaming + Cache Hit Rate + Custom Providers dropdown — one row */}
      <div className="section-header" data-color="violet">
        {t('workflow.options')}
      </div>
      <div className="flex items-center gap-6 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            <span className="param-chip-label">{t('workflow.streaming')}</span>
            <Tooltip title={t('workflow.streamingTooltip')}>
              <InfoCircleOutlined className="text-[10px] text-text-tertiary cursor-help" />
            </Tooltip>
          </div>
          <Switch
            checked={task.config.streaming}
            onChange={(v) => updateTaskConfig(index, { streaming: v })}
            size="small"
          />
        </div>
        <div className="flex items-center gap-2">
          <Switch
            checked={task.config.targetCacheHitRate !== undefined}
            onChange={(v) => updateTaskConfig(index, { targetCacheHitRate: v ? 0.8 : undefined })}
            size="small"
          />
          <div className="flex items-center gap-1">
            <span className="param-chip-label">{t('workflow.cacheHitRate')}</span>
            <Tooltip title={t('workflow.cacheHitRateTooltip')}>
              <InfoCircleOutlined className="text-[10px] text-text-tertiary cursor-help" />
            </Tooltip>
          </div>
          {task.config.targetCacheHitRate !== undefined && (
            <InputNumber
              changeOnBlur
              value={Math.round(task.config.targetCacheHitRate * 100)}
              onChange={(v) => updateTaskConfig(index, { targetCacheHitRate: (v ?? 80) / 100 })}
              min={0}
              max={99}
              size="small"
              className="font-mono"
              style={{ width: 72 }}
              addonAfter="%"
            />
          )}
        </div>
        <div className="flex items-center gap-2 flex-1 min-w-[220px]">
          <Tooltip title={t('workflow.customProvidersTooltip')}>
            <span className="text-[11px] text-text-secondary font-medium whitespace-nowrap cursor-help">
              {t('workflow.customProviders')}
            </span>
          </Tooltip>
          <Select
            mode="multiple"
            size="small"
            value={task.providers ?? []}
            onChange={(keys: string[]) => {
              updateTask(index, { providers: keys.length > 0 ? keys : undefined });
            }}
            placeholder={t('workflow.usingGlobalProviders')}
            allowClear
            showSearch
            style={{ minWidth: 200, maxWidth: 360, fontSize: 11 }}
            popupStyle={{ fontSize: 11 }}
            options={configuredProviders.flatMap((p) => {
              const color = FORMAT_COLORS[p.format] || '#999';
              return p.models
                .filter((m) => m.isActive !== false)
                .map((m) => ({
                  label: (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: '50%',
                          backgroundColor: color,
                          display: 'inline-block',
                          flexShrink: 0,
                        }}
                      />
                      <span style={{ fontWeight: 500 }}>{p.name}</span>
                      <span style={{ color: '#888' }}>/ {m.displayName || m.name}</span>
                    </span>
                  ),
                  value: `${p.id}:${m.name}`,
                }));
            })}
            optionFilterProp="label"
            maxTagCount={2}
            maxTagPlaceholder={(omitted) => `+${omitted.length}`}
            tagRender={(props) => {
              const { label, closable, onClose } = props;
              const val = String(props.value ?? '');
              const provider = configuredProviders.find((p) => val.startsWith(p.id + ':'));
              const color = provider ? FORMAT_COLORS[provider.format] || '#999' : '#999';
              return (
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 2,
                    padding: '0 4px',
                    margin: '1px 2px',
                    borderRadius: 3,
                    fontSize: 10,
                    backgroundColor: `${color}14`,
                    border: `1px solid ${color}30`,
                    color,
                  }}
                >
                  {typeof label === 'string' ? label : val.split(':').slice(1).join(':')}
                  {closable && (
                    <span onClick={onClose} style={{ cursor: 'pointer', marginLeft: 2, opacity: 0.6 }}>
                      ✕
                    </span>
                  )}
                </span>
              );
            }}
          />
        </div>
      </div>

      {/* Randomize Interval (only when interval > 0) */}
      {(task.config.requestInterval ?? 0) > 0 && (
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            <span className="param-chip-label">{t('workflow.randomizeInterval')}</span>
            <Tooltip title={t('workflow.randomizeIntervalTooltip')}>
              <InfoCircleOutlined className="text-[10px] text-text-tertiary cursor-help" />
            </Tooltip>
          </div>
          <Switch
            checked={task.config.randomizeInterval ?? false}
            onChange={(v) => updateTaskConfig(index, { randomizeInterval: v })}
            size="small"
          />
        </div>
      )}
    </div>
  );
}
