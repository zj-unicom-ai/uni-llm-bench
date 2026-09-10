import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Select, Input, InputNumber, Switch, Collapse, Alert, Tooltip, Segmented, Button } from '../antdImports';
import {
  SendOutlined,
  StopOutlined,
  ThunderboltOutlined,
  ClockCircleOutlined,
  DashboardOutlined,
  WarningOutlined,
  CodeOutlined,
  BulbOutlined,
  DeleteOutlined,
  PictureOutlined,
  CopyOutlined,
  CheckOutlined,
  CrownOutlined,
} from '@ant-design/icons';
import { HistoryOutlined, ExperimentOutlined, SwapOutlined, DiffOutlined } from '@ant-design/icons';
import { useProviders } from '../hooks/useProviders';
import { usePlayground, PlaygroundMetrics, GenerationParams } from '../hooks/usePlayground';
import { usePlaygroundHistory } from '../hooks/usePlaygroundHistory';
import { PlaygroundHistorySidebar } from './PlaygroundHistorySidebar';
import { ImageInput, getProviderColor, ProviderConfigResponse } from '../types';
import {
  PRESET_PROMPTS,
  QUICK_MAX_TOKENS,
  loadHeavyPreset,
  OUTPUT_SCOPE_OPTIONS,
  applyOutputScope,
  getStoredOutputScope,
  storeOutputScope,
  getStoredMaxTokens,
  storeMaxTokens,
} from '../constants';
import { useTokenCount } from '../utils/tokenCount';

const { TextArea } = Input;

const STANDARD_PRESETS = PRESET_PROMPTS.filter((p) => p.category === 'standard');
const SHAREGPT_PRESETS = PRESET_PROMPTS.filter((p) => p.category === 'long-context');

const A_COLOR = '#4096ff'; // accent-blue
const B_COLOR = '#8a6dff'; // accent-violet

const PROVIDER_A_KEY = 'llm-radar:playground-provider';
const MODEL_A_KEY = 'llm-radar:playground-model';
const PROVIDER_B_KEY = 'llm-radar:playground-provider-b';
const MODEL_B_KEY = 'llm-radar:playground-model-b';

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* ignore */
  }
}
function safeRemove(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function PlaygroundPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { providers, fetchProviders } = useProviders();
  const { panels, anyLoading, runPanel, runAll, abortAll, resetAll, restore } = usePlayground();
  const {
    items: historyItems,
    loading: historyLoading,
    fetchHistory,
    getDetail,
    deleteEntry,
    clearAll,
  } = usePlaygroundHistory();

  // ---- Mode ----
  const [mode, setMode] = useState<'single' | 'compare'>('single');

  // ---- Shared config ----
  const [prompt, setPrompt] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [maxTokens, setMaxTokensRaw] = useState(getStoredMaxTokens);
  const setMaxTokens = (v: number) => {
    setMaxTokensRaw(v);
    storeMaxTokens(v);
  };
  const [useStreaming, setUseStreaming] = useState(true);
  const [hasRun, setHasRun] = useState(false);
  const [images, setImages] = useState<ImageInput[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [showLongContext, setShowLongContext] = useState(true);
  const [isMultiDoc, setIsMultiDoc] = useState(false);
  const [outputScope, setOutputScope] = useState(getStoredOutputScope);
  const [activePreset, setActivePreset] = useState<string | undefined>();
  const [enableThinking, setEnableThinking] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(true);
  const [selectedHistoryId, setSelectedHistoryId] = useState<string>();

  // ---- Generation params (advanced) ----
  const [genParams, setGenParams] = useState<GenerationParams>({});
  const [stopText, setStopText] = useState('');
  const updateGenParam = <K extends keyof GenerationParams>(key: K, value: GenerationParams[K] | null) => {
    setGenParams((prev) => {
      const next = { ...prev };
      if (value === null || value === undefined) delete next[key];
      else next[key] = value;
      return next;
    });
  };
  const resetAdvanced = () => {
    setGenParams({});
    setStopText('');
  };
  const advancedCount = Object.keys(genParams).length;

  // ---- Model selection (A / B) ----
  const [aProviderId, setAProviderIdRaw] = useState<string | null>(
    () => searchParams.get('provider') || safeGet(PROVIDER_A_KEY),
  );
  const [aModelName, setAModelNameRaw] = useState<string | null>(() => searchParams.get('model') || safeGet(MODEL_A_KEY));
  const [bProviderId, setBProviderIdRaw] = useState<string | null>(() => safeGet(PROVIDER_B_KEY));
  const [bModelName, setBModelNameRaw] = useState<string | null>(() => safeGet(MODEL_B_KEY));

  const setAProviderId = useCallback(
    (v: string | null) => {
      setAProviderIdRaw(v);
      if (v) {
        safeSet(PROVIDER_A_KEY, v);
        setSearchParams((prev) => {
          prev.set('provider', v);
          return prev;
        }, { replace: true });
      } else {
        safeRemove(PROVIDER_A_KEY);
        setSearchParams((prev) => {
          prev.delete('provider');
          return prev;
        }, { replace: true });
      }
    },
    [setSearchParams],
  );
  const setAModelName = useCallback(
    (v: string | null) => {
      setAModelNameRaw(v);
      if (v) {
        safeSet(MODEL_A_KEY, v);
        setSearchParams((prev) => {
          prev.set('model', v);
          return prev;
        }, { replace: true });
      } else {
        safeRemove(MODEL_A_KEY);
        setSearchParams((prev) => {
          prev.delete('model');
          return prev;
        }, { replace: true });
      }
    },
    [setSearchParams],
  );
  const setBProviderId = useCallback((v: string | null) => {
    setBProviderIdRaw(v);
    if (v) safeSet(PROVIDER_B_KEY, v);
    else safeRemove(PROVIDER_B_KEY);
  }, []);
  const setBModelName = useCallback((v: string | null) => {
    setBModelNameRaw(v);
    if (v) safeSet(MODEL_B_KEY, v);
    else safeRemove(MODEL_B_KEY);
  }, []);

  // Heavy prompt handling (keep full text in a ref to avoid textarea lag)
  const HEAVY_THRESHOLD = 10_000;
  const fullPromptRef = useRef<string | null>(null);
  const [isHeavyPrompt, setIsHeavyPrompt] = useState(false);
  const effectivePrompt = fullPromptRef.current ?? prompt;
  const promptTokenCount = useTokenCount(isHeavyPrompt ? '' : prompt);

  // Reset panels when switching mode
  useEffect(() => {
    resetAll();
    setHasRun(false);
  }, [mode, resetAll]);

  useEffect(() => {
    fetchProviders();
    fetchHistory();
  }, [fetchProviders, fetchHistory]);

  // Auto-refresh history after a run completes
  const prevLoadingRef = useRef(false);
  useEffect(() => {
    if (prevLoadingRef.current && !anyLoading) {
      fetchHistory();
    }
    prevLoadingRef.current = anyLoading;
  }, [anyLoading, fetchHistory]);

  const modelDisplayNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of providers) {
      for (const m of p.models ?? []) {
        if (m.displayName) map[m.name] = m.displayName;
      }
    }
    return map;
  }, [providers]);

  const enrichedHistoryItems = useMemo(
    () =>
      historyItems.map((it) => {
        const display =
          modelDisplayNames[it.modelName] ||
          modelDisplayNames[it.modelName.includes('/') ? it.modelName.split('/').pop()! : it.modelName] ||
          it.modelName;
        return display !== it.modelName ? { ...it, modelName: display } : it;
      }),
    [historyItems, modelDisplayNames],
  );

  const canRun =
    !!prompt.trim() &&
    !!aProviderId &&
    !!aModelName &&
    (mode === 'single' ? true : !!bProviderId && !!bModelName);

  const setPromptSmart = (text: string) => {
    if (text.length > HEAVY_THRESHOLD) {
      fullPromptRef.current = text;
      setIsHeavyPrompt(true);
      setPrompt(text.slice(0, 200) + '\n\n… ' + t('workflow.charsTotalLoaded', { count: text.length }));
    } else {
      fullPromptRef.current = null;
      setIsHeavyPrompt(false);
      setPrompt(text);
    }
  };

  const computeGenParams = (): GenerationParams | undefined => {
    if (Object.keys(genParams).length === 0 && !stopText.trim()) return undefined;
    return {
      ...genParams,
      ...(stopText.trim() ? { stop: stopText.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
    };
  };
  const buildCommon = () => ({
    prompt: effectivePrompt.trim(),
    systemPrompt: systemPrompt.trim() || undefined,
    maxTokens,
    images: images.length > 0 ? images : undefined,
    enableThinking: enableThinking || undefined,
    useStreaming,
    genParams: computeGenParams(),
  });

  const handleRun = () => {
    if (!canRun) return;
    setHasRun(true);
    const common = buildCommon();
    if (mode === 'single') {
      runPanel('A', { providerId: aProviderId!, modelName: aModelName!, ...common });
    } else {
      runAll([
        { id: 'A', params: { providerId: aProviderId!, modelName: aModelName!, ...common } },
        { id: 'B', params: { providerId: bProviderId!, modelName: bModelName!, ...common } },
      ]);
    }
  };

  // ---- Images ----
  const fileInputRef = useRef<HTMLInputElement>(null);
  const addImageFiles = (files: FileList | File[]) => {
    Array.from(files).forEach((file) => {
      if (!file.type.startsWith('image/')) return;
      if (file.size > 10 * 1024 * 1024) return;
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1];
        setImages((prev) => [...prev, { type: 'base64', mediaType: file.type, data: base64 }]);
      };
      reader.readAsDataURL(file);
    });
  };
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) addImageFiles(e.target.files);
    e.target.value = '';
  };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files.length > 0) addImageFiles(e.dataTransfer.files);
  };
  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    const imageFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      addImageFiles(imageFiles);
    }
  };
  const removeImage = (index: number) => setImages((prev) => prev.filter((_, i) => i !== index));

  const handleCopy = async (text: string, onCopied: () => void) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      onCopied();
    } catch {
      /* ignore */
    }
  };

  const handleSelectHistory = async (id: string) => {
    const detail = await getDetail(id);
    if (!detail) return;
    setSelectedHistoryId(id);
    setMode('single');
    const providerExists = providers.some((p) => p.id === detail.providerId);
    if (providerExists) {
      setAProviderId(detail.providerId);
      setAModelName(detail.modelName);
    } else {
      setAProviderId(null);
      setAModelName(null);
    }
    setPromptSmart(detail.prompt);
    setSystemPrompt(detail.systemPrompt || '');
    setMaxTokens(detail.maxTokens);
    setUseStreaming(detail.useStreaming);
    setEnableThinking(detail.enableThinking);
    if (detail.genParams) {
      setGenParams(detail.genParams);
      setStopText((detail.genParams.stop || []).join(', '));
    } else {
      setGenParams({});
      setStopText('');
    }
    setHasRun(true);
    restore({ responseText: detail.responseText, reasoningText: detail.reasoningText, metrics: detail.metrics });
  };

  const panelA = panels['A'] || {
    loading: false,
    streaming: false,
    responseText: '',
    reasoningText: '',
    metrics: null,
    error: null,
  };
  const panelB = panels['B'] || {
    loading: false,
    streaming: false,
    responseText: '',
    reasoningText: '',
    metrics: null,
    error: null,
  };

  const aProvider = providers.find((p) => p.id === aProviderId);
  const bProvider = providers.find((p) => p.id === bProviderId);
  const aModel = aProvider?.models?.find((m) => m.name === aModelName);
  const bModel = bProvider?.models?.find((m) => m.name === bModelName);
  const aSupportsVision = aModel?.supportsVision ?? false;

  // Clear images when current (A) model can't use them
  useEffect(() => {
    if (!aSupportsVision && images.length > 0) setImages([]);
  }, [aSupportsVision]); // eslint-disable-line react-hooks/exhaustive-deps

  const tokenEstimate = isHeavyPrompt ? '—' : promptTokenCount;

  return (
    <div className="flex gap-4 items-start">
      <div className="flex-1 min-w-0 space-y-5">
        {/* Page header */}
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="arena-eyebrow mb-2">LLM ARENA</div>
            <h2 className="text-[22px] font-semibold text-text-primary tracking-tight leading-tight">
              {t('page.playground.title')}
            </h2>
            <p className="text-[13px] text-text-secondary mt-1.5 max-w-2xl leading-relaxed">
              {t('page.playground.subtitle')}
            </p>
          </div>
          <div className="shrink-0 pt-1">
            <Segmented
              size="small"
              value={mode}
              onChange={(v) => setMode(v as 'single' | 'compare')}
              options={[
                { value: 'single', label: <span className="flex items-center gap-1"><ExperimentOutlined />{t('playground.singleMode')}</span> },
                { value: 'compare', label: <span className="flex items-center gap-1"><DiffOutlined />{t('playground.compareMode')}</span> },
              ]}
            />
          </div>
        </div>

        {/* Match setup */}
        <section className="glass-card p-5">
          <div className="section-header" data-color="violet">{t('playground.setupSection')}</div>
          {mode === 'single' ? (
            <CombatantCard
              side="A"
              title={t('playground.combatant')}
              accent={A_COLOR}
              providers={providers}
              providerId={aProviderId}
              modelName={aModelName}
              onProvider={setAProviderId}
              onModel={setAModelName}
            />
          ) : (
            <div className="relative">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-stretch">
                <CombatantCard
                  side="A"
                  title={`${t('playground.combatant')} A`}
                  accent={A_COLOR}
                  providers={providers}
                  providerId={aProviderId}
                  modelName={aModelName}
                  onProvider={setAProviderId}
                  onModel={setAModelName}
                />
                <CombatantCard
                  side="B"
                  title={`${t('playground.combatant')} B`}
                  accent={B_COLOR}
                  providers={providers}
                  providerId={bProviderId}
                  modelName={bModelName}
                  onProvider={setBProviderId}
                  onModel={setBModelName}
                />
              </div>
              <div className="arena-vs" aria-hidden>
                {t('playground.vs')}
              </div>
            </div>
          )}
        </section>

        {/* Prompt + params */}
        <section className="glass-card p-5 space-y-4">
          <div className="section-header">{t('playground.promptSection')}</div>

          {/* System Prompt */}
          <Collapse
            ghost
            items={[
              {
                key: 'system',
                label: <span className="text-[12px] text-text-secondary">{t('playground.systemPrompt')}</span>,
                children: (
                  <TextArea
                    value={systemPrompt}
                    onChange={(e) => setSystemPrompt(e.target.value)}
                    placeholder={t('playground.systemPromptPlaceholder')}
                    autoSize={{ minRows: 2, maxRows: 6 }}
                    className="font-mono text-[13px]"
                  />
                ),
              },
            ]}
          />

          {/* Config row */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <label className="text-[12px] text-text-tertiary">{t('playground.maxTokens')}</label>
              <InputNumber
                changeOnBlur
                min={1}
                max={128000}
                value={maxTokens}
                onChange={(v) => v && setMaxTokens(v)}
                size="small"
                className="w-24"
              />
              <div className="flex gap-1">
                {QUICK_MAX_TOKENS.map((q) => (
                  <button
                    key={q.value}
                    onClick={() => setMaxTokens(q.value)}
                    className={`text-[11px] px-2 py-0.5 rounded border transition-colors ${
                      maxTokens === q.value
                        ? 'border-accent-blue/50 text-accent-blue bg-accent-blue/10'
                        : 'border-border text-text-tertiary hover:text-text-secondary'
                    }`}
                  >
                    {q.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Tooltip title={t('playground.streamingTooltip')}>
                <label className="text-[12px] text-text-tertiary cursor-help">{t('playground.streaming')}</label>
              </Tooltip>
              <Switch size="small" checked={useStreaming} onChange={setUseStreaming} />
            </div>
            <div className="flex items-center gap-2">
              <Tooltip title={t('playground.thinkingTooltip')}>
                <label className="text-[12px] text-text-tertiary cursor-help">{t('playground.thinking')}</label>
              </Tooltip>
              <Switch size="small" checked={enableThinking} onChange={setEnableThinking} />
            </div>
          </div>

          {/* Advanced params */}
          <Collapse
            ghost
            items={[
              {
                key: 'advanced',
                label: (
                  <span className="text-[12px] text-text-secondary flex items-center gap-2">
                    {t('playground.advancedParams')}
                    {advancedCount > 0 && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-blue/10 text-accent-blue font-mono">
                        {t('playground.advancedSetCount', { count: advancedCount })}
                      </span>
                    )}
                  </span>
                ),
                children: (
                  <div className="pt-1 space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                      <ParamField label={t('playground.temperature')} hint="0–2">
                        <InputNumber
                          changeOnBlur
                          min={0}
                          max={2}
                          step={0.1}
                          value={genParams.temperature}
                          onChange={(v) => updateGenParam('temperature', v)}
                          size="small"
                          className="w-full"
                        />
                      </ParamField>
                      <ParamField label={t('playground.topP')} hint="0–1">
                        <InputNumber
                          changeOnBlur
                          min={0}
                          max={1}
                          step={0.05}
                          value={genParams.topP}
                          onChange={(v) => updateGenParam('topP', v)}
                          size="small"
                          className="w-full"
                        />
                      </ParamField>
                      <ParamField label={t('playground.topK')} hint="int">
                        <InputNumber
                          changeOnBlur
                          min={0}
                          max={100}
                          step={1}
                          precision={0}
                          value={genParams.topK}
                          onChange={(v) => updateGenParam('topK', v)}
                          size="small"
                          className="w-full"
                        />
                      </ParamField>
                      <ParamField label={t('playground.frequencyPenalty')} hint="-2–2">
                        <InputNumber
                          changeOnBlur
                          min={-2}
                          max={2}
                          step={0.1}
                          value={genParams.frequencyPenalty}
                          onChange={(v) => updateGenParam('frequencyPenalty', v)}
                          size="small"
                          className="w-full"
                        />
                      </ParamField>
                      <ParamField label={t('playground.presencePenalty')} hint="-2–2">
                        <InputNumber
                          changeOnBlur
                          min={-2}
                          max={2}
                          step={0.1}
                          value={genParams.presencePenalty}
                          onChange={(v) => updateGenParam('presencePenalty', v)}
                          size="small"
                          className="w-full"
                        />
                      </ParamField>
                      <ParamField label={t('playground.seed')} hint="int">
                        <InputNumber
                          changeOnBlur
                          min={0}
                          step={1}
                          precision={0}
                          value={genParams.seed}
                          onChange={(v) => updateGenParam('seed', v)}
                          size="small"
                          className="w-full"
                        />
                      </ParamField>
                      <ParamField label={t('playground.stopSequences')} full>
                        <Input
                          size="small"
                          value={stopText}
                          onChange={(e) => setStopText(e.target.value)}
                          placeholder=","
                          className="w-full font-mono text-[12px]"
                        />
                      </ParamField>
                      <ParamField label={t('playground.responseFormat')}>
                        <Select
                          size="small"
                          className="w-full"
                          value={genParams.responseFormat || 'text'}
                          onChange={(v) => updateGenParam('responseFormat', v)}
                          options={[
                            { value: 'text', label: t('playground.formatText') },
                            { value: 'json_object', label: t('playground.formatJson') },
                          ]}
                        />
                      </ParamField>
                    </div>
                    <button
                      onClick={resetAdvanced}
                      className="text-[11px] px-2 py-0.5 rounded border border-border text-text-tertiary hover:text-text-secondary transition-colors"
                    >
                      {t('playground.resetAdvanced')}
                    </button>
                  </div>
                ),
              },
            ]}
          />

          {/* Prompt */}
          <div>
            <label className="block text-[12px] text-text-tertiary mb-1.5 uppercase tracking-wider">
              {t('playground.prompt')}
            </label>
            <div
              className={`relative rounded-lg border transition-colors ${
                isDragging ? 'border-accent-blue border-dashed bg-accent-blue/5' : 'border-border'
              }`}
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={(e) => {
                e.preventDefault();
                setIsDragging(false);
              }}
              onDrop={handleDrop}
            >
              {images.length > 0 && (
                <div className="flex flex-wrap gap-2 p-2 pb-0">
                  {images.map((img, i) => (
                    <div
                      key={i}
                      className="relative group rounded border border-border overflow-hidden"
                      style={{ width: 64, height: 64 }}
                    >
                      <img
                        src={`data:${img.mediaType};base64,${img.data}`}
                        alt={`Image ${i + 1}`}
                        className="w-full h-full object-cover"
                      />
                      <button
                        onClick={() => removeImage(i)}
                        className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-black/70 text-white flex items-center justify-center opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
                      >
                        <DeleteOutlined style={{ fontSize: 9 }} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {isDragging && (
                <div className="absolute inset-0 flex items-center justify-center bg-accent-blue/5 rounded-lg z-10 pointer-events-none">
                  <span className="text-[13px] text-accent-blue">{t('playground.dropImagesHere')}</span>
                </div>
              )}
              <TextArea
                value={prompt}
                onChange={(e) => {
                  fullPromptRef.current = null;
                  setIsHeavyPrompt(false);
                  setPrompt(e.target.value);
                  setActivePreset(undefined);
                }}
                placeholder={t('playground.promptPlaceholder')}
                autoSize={{ minRows: 4, maxRows: 12 }}
                className="font-mono text-[13px] !border-0 !shadow-none !bg-transparent"
                readOnly={isHeavyPrompt}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canRun && !anyLoading) handleRun();
                }}
                onPaste={handlePaste}
              />
              {isHeavyPrompt && (
                <div className="mx-2 mb-1 px-2 py-1 rounded bg-surface-secondary border border-border flex items-center justify-between gap-2">
                  <span className="text-[11px] text-text-tertiary">{t('playground.largePromptLoaded')}</span>
                  <button
                    onClick={() => {
                      fullPromptRef.current = null;
                      setIsHeavyPrompt(false);
                      setPrompt('');
                    }}
                    className="text-[11px] text-text-secondary hover:text-text-primary transition-colors"
                  >
                    {t('common.action.clear')}
                  </button>
                </div>
              )}
              {(prompt || isHeavyPrompt) && (
                <div className="px-2 pb-1">
                  <span className="text-[10px] text-text-tertiary font-mono">
                    {isHeavyPrompt
                      ? `~${(effectivePrompt.length / 4).toFixed(0)} ${t('common.unit.tokens')}`
                      : `${promptTokenCount} ${t('common.unit.tokens')}`}
                  </span>
                </div>
              )}
              {/* Bottom bar */}
              <div className="flex items-center gap-2 px-2 pb-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={handleFileUpload}
                  className="hidden"
                />
                <Tooltip title={aSupportsVision ? t('playground.addImages') : t('playground.noVisionSupport')}>
                  <button
                    onClick={() => aSupportsVision && fileInputRef.current?.click()}
                    disabled={!aSupportsVision}
                    className={`flex items-center gap-1 text-[12px] px-2 py-1 rounded transition-colors ${
                      !aSupportsVision
                        ? 'text-text-tertiary/40 cursor-not-allowed'
                        : images.length > 0
                          ? 'text-accent-teal bg-accent-teal/10'
                          : 'text-text-tertiary hover:text-text-secondary hover:bg-black/5'
                    }`}
                  >
                    <PictureOutlined />
                    {images.length > 0 && <span className="font-mono">{images.length}</span>}
                  </button>
                </Tooltip>

                <div className="flex flex-wrap gap-1 flex-1 min-w-0">
                  {STANDARD_PRESETS.map((preset) => (
                    <button
                      key={preset.label}
                      onClick={() => {
                        setIsMultiDoc(false);
                        setActivePreset(preset.label);
                        setPromptSmart(preset.prompt);
                      }}
                      className={`text-[10px] px-2 py-0.5 rounded border transition-colors whitespace-nowrap ${
                        activePreset === preset.label
                          ? 'border-accent-blue/40 bg-accent-blue/8 text-accent-blue'
                          : 'border-border text-text-tertiary hover:text-text-secondary hover:border-accent-blue/40'
                      }`}
                    >
                      {preset.labelKey ? t(preset.labelKey) : preset.label}
                    </button>
                  ))}
                  {!showLongContext ? (
                    <button
                      onClick={() => setShowLongContext(true)}
                      className="text-[10px] px-2 py-0.5 rounded border border-border text-text-tertiary hover:text-text-secondary transition-colors whitespace-nowrap"
                    >
                      {t('playground.longContext')}
                    </button>
                  ) : (
                    SHAREGPT_PRESETS.map((preset) => (
                      <button
                        key={preset.label}
                        onClick={async () => {
                          const md = !!preset.multiDoc;
                          setIsMultiDoc(md);
                          setActivePreset(preset.label);
                          let raw: string;
                          if (preset.heavy) {
                            const bucket = preset.tokens >= 200_000 ? '256k' : preset.tokens >= 100_000 ? '150k' : '64k';
                            raw = await loadHeavyPreset(bucket);
                          } else {
                            raw = preset.prompt;
                          }
                          setPromptSmart(md ? applyOutputScope(raw, outputScope) : raw);
                        }}
                        className={`text-[10px] px-2 py-0.5 rounded border transition-colors whitespace-nowrap ${
                          activePreset === preset.label
                            ? 'border-accent-blue/40 bg-accent-blue/8 text-accent-blue'
                            : 'border-border text-text-tertiary hover:text-text-secondary hover:border-accent-blue/40'
                        }`}
                      >
                        {preset.labelKey ? t(preset.labelKey) : preset.label}
                      </button>
                    ))
                  )}
                </div>

                {isMultiDoc && (
                  <Tooltip title={t('playground.outputScopeTooltip')}>
                    <Select
                      size="small"
                      value={outputScope}
                      onChange={(v) => {
                        setOutputScope(v);
                        storeOutputScope(v);
                        const fullText = fullPromptRef.current || prompt;
                        setPromptSmart(applyOutputScope(fullText, v));
                      }}
                      options={OUTPUT_SCOPE_OPTIONS}
                      style={{ width: 140, fontSize: 10 }}
                    />
                  </Tooltip>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* Sticky run bar */}
        <div className="config-action-bar">
          <div className="flex items-center gap-4 flex-wrap">
            <div className="summary-stat">
              <span className="summary-label">{t('playground.mode')}</span>
              <span className="summary-value">{mode === 'compare' ? 'A·B' : '1v0'}</span>
            </div>
            <div className="summary-divider" />
            <div className="summary-stat">
              <span className="summary-label">{t('playground.model')}</span>
              <span className="summary-value">{mode === 'compare' ? '2' : '1'}</span>
            </div>
            <div className="summary-divider" />
            <div className="summary-stat">
              <span className="summary-label">{t('common.unit.tokens')}</span>
              <span className="summary-value">{tokenEstimate}</span>
            </div>
            <div className="summary-divider" />
            <span className="action-hint">
              {mode === 'compare' ? t('playground.runHintCompare') : t('playground.runHintSingle')}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setHistoryOpen((v) => !v)}
              className={`text-[12px] flex items-center gap-1.5 px-2 py-1.5 rounded-md transition-colors ${
                historyOpen ? 'text-accent-blue' : 'text-text-tertiary hover:text-text-secondary'
              }`}
            >
              <HistoryOutlined />
              {t('playground.history')}
            </button>
            {anyLoading ? (
              <Button danger size="middle" icon={<StopOutlined />} onClick={abortAll}>
                {t('playground.stop')}
              </Button>
            ) : (
              <Tooltip title={canRun ? t('playground.cmdEnter') : t('playground.selectPromptModel')}>
                <Button
                  type="primary"
                  size="middle"
                  className="start-btn"
                  icon={<SendOutlined />}
                  disabled={!canRun}
                  onClick={handleRun}
                >
                  {t('playground.startMatch')}
                </Button>
              </Tooltip>
            )}
          </div>
        </div>

        {/* Pre-run arena stage (friendly empty state) */}
        {!hasRun && !anyLoading && (
          <div className="arena-stage">
            <div className="arena-stage__ring" />
            <div className="relative text-center px-4">
              <div className="text-[15px] font-semibold text-text-primary">{t('playground.emptyTitle')}</div>
              <p className="text-[12.5px] text-text-secondary mt-1.5 max-w-md mx-auto leading-relaxed">
                {t('playground.emptyHint')}
              </p>
            </div>
          </div>
        )}

        {/* Compare summary */}
        {mode === 'compare' && panelA.metrics && panelB.metrics && (
          <CompareSummary a={panelA.metrics} b={panelB.metrics} />
        )}

        {/* Errors */}
        {panelA.error && <Alert type="error" message={panelA.error} closable onClose={() => resetAll()} showIcon />}
        {mode === 'compare' && panelB.error && (
          <Alert type="error" message={panelB.error} closable onClose={() => resetAll()} showIcon />
        )}

        {/* Responses */}
        {(hasRun || anyLoading) && (
          <div className="space-y-4">
            {mode === 'single' ? (
              <ResponsePanel
                title={t('playground.response')}
                accent={A_COLOR}
                panel={panelA}
                provider={aProvider}
                modelName={aModelName}
                loading={anyLoading}
                onCopy={(onCopied) => handleCopy(panelA.responseText, onCopied)}
                debugRequest={{
                  maxTokens,
                  streaming: useStreaming,
                  promptLength: effectivePrompt.length,
                  images: images.length,
                  genParams: computeGenParams(),
                  enableThinking,
                }}
              />
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <ResponsePanel
                  title={t('playground.responseA')}
                  accent={A_COLOR}
                  panel={panelA}
                  provider={aProvider}
                  modelName={aModelName}
                  loading={anyLoading}
                  onCopy={(onCopied) => handleCopy(panelA.responseText, onCopied)}
                  debugRequest={{
                    maxTokens,
                    streaming: useStreaming,
                    promptLength: effectivePrompt.length,
                    images: images.length,
                    genParams: computeGenParams(),
                    enableThinking,
                  }}
                />
                <ResponsePanel
                  title={t('playground.responseB')}
                  accent={B_COLOR}
                  panel={panelB}
                  provider={bProvider}
                  modelName={bModelName}
                  loading={anyLoading}
                  onCopy={(onCopied) => handleCopy(panelB.responseText, onCopied)}
                  debugRequest={{
                    maxTokens,
                    streaming: useStreaming,
                    promptLength: effectivePrompt.length,
                    images: images.length,
                    genParams: computeGenParams(),
                    enableThinking,
                  }}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {historyOpen && (
        <PlaygroundHistorySidebar
          items={enrichedHistoryItems}
          loading={historyLoading}
          onSelect={handleSelectHistory}
          onDelete={deleteEntry}
          onClearAll={clearAll}
          onClose={() => setHistoryOpen(false)}
          selectedId={selectedHistoryId}
        />
      )}
    </div>
  );
}

// ---------- Sub-components ----------

function ParamField({
  label,
  hint,
  full,
  children,
}: {
  label: string;
  hint?: string;
  full?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={full ? 'col-span-full' : ''}>
      <div className="flex items-center justify-between mb-1">
        <label className="text-[11px] text-text-tertiary uppercase tracking-wider">{label}</label>
        {hint && <span className="text-[10px] text-text-tertiary/70 font-mono">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

export function CombatantCard({
  side,
  title,
  accent,
  providers,
  providerId,
  modelName,
  onProvider,
  onModel,
}: {
  side: 'A' | 'B';
  title: string;
  accent: string;
  providers: ProviderConfigResponse[];
  providerId: string | null;
  modelName: string | null;
  onProvider: (v: string | null) => void;
  onModel: (v: string | null) => void;
}) {
  const { t } = useTranslation();
  const selectedProvider = useMemo(() => providers.find((p) => p.id === providerId), [providers, providerId]);
  const activeModels = useMemo(
    () => (selectedProvider?.models || []).filter((m) => m.isActive !== false),
    [selectedProvider],
  );
  const selectedModel = activeModels.find((m) => m.name === modelName);

  useEffect(() => {
    if (providerId && activeModels.length > 0 && !activeModels.find((m) => m.name === modelName)) {
      onModel(activeModels[0].name);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId, selectedProvider]);

  // A persisted providerId can outlive the provider it points at (provider deleted,
  // database re-seeded, or a bookmarked `?provider=` link). Drop such selections so
  // the Select falls back to its placeholder instead of rendering the raw UUID.
  useEffect(() => {
    if (providers.length === 0 || !providerId) return;
    if (!providers.some((p) => p.id === providerId)) {
      onProvider(null);
      onModel(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers, providerId]);

  // Only forward values that still resolve to a known option — antd renders the raw
  // value when nothing matches, which would flash the UUID before the effect above runs.
  const safeProviderId = providerId && providers.some((p) => p.id === providerId) ? providerId : undefined;
  const safeModelName = modelName && activeModels.some((m) => m.name === modelName) ? modelName : undefined;

  return (
    <div
      className="arena-card"
      style={safeProviderId ? { borderColor: `${accent}40`, background: `${accent}08` } : undefined}
    >
      <div className="flex items-center gap-3 mb-3.5">
        <div className="arena-avatar" style={{ background: `linear-gradient(135deg, ${accent}, ${accent}cc)` }}>
          {side}
        </div>
        <div className="min-w-0">
          <div className="text-[13.5px] font-semibold text-text-primary leading-tight">{title}</div>
          <div className="text-[11px] text-text-tertiary">{t('playground.selectChallenger')}</div>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-2.5">
        <div className="flex-1">
          <Select
            className="w-full"
            placeholder={t('playground.selectProvider')}
            value={providers.length > 0 ? safeProviderId : undefined}
            onChange={(val) => {
              onProvider(val);
              onModel(null);
            }}
            options={providers.map((p) => ({
              value: p.id,
              label: (
                <span className="flex items-center gap-2">
                  <span>{p.name}</span>
                  <span className="text-[11px] px-1.5 py-0.5 rounded bg-black/8 text-text-tertiary font-mono">
                    {p.format}
                  </span>
                </span>
              ),
            }))}
          />
        </div>
        <div className="flex-1">
          <Select
            className="w-full"
            placeholder={safeProviderId ? t('playground.selectModel') : t('playground.selectProviderFirst')}
            disabled={!safeProviderId}
            value={activeModels.length > 0 ? safeModelName : undefined}
            onChange={onModel}
            options={activeModels.map((m) => ({
              value: m.name,
              label: (
                <span className="flex items-center gap-2">
                  <span className="font-mono text-[13px]">{m.displayName || m.name}</span>
                  <span className="text-[11px] text-text-tertiary">{Math.round(m.contextSize / 1000)}K</span>
                  {m.supportsVision && (
                    <span className="text-[10px] px-1 rounded bg-accent-teal/15 text-accent-teal">V</span>
                  )}
                  {m.supportsTools && (
                    <span className="text-[10px] px-1 rounded bg-accent-blue/15 text-accent-blue">T</span>
                  )}
                </span>
              ),
            }))}
          />
        </div>
      </div>

      {selectedProvider && selectedModel && (
        <div className="flex items-center gap-1.5 mt-3 flex-wrap">
          <span className="arena-tag">{selectedProvider.format}</span>
          <span className="arena-tag">{`${Math.round(selectedModel.contextSize / 1000)}K`}</span>
          {selectedModel.supportsVision && <span className="arena-tag arena-tag--teal">Vision</span>}
          {selectedModel.supportsTools && <span className="arena-tag arena-tag--blue">Tools</span>}
        </div>
      )}
    </div>
  );
}

function ResponsePanel({
  title,
  accent,
  panel,
  provider,
  modelName,
  loading,
  onCopy,
  debugRequest,
}: {
  title: string;
  accent: string;
  panel: {
    loading: boolean;
    streaming: boolean;
    responseText: string;
    reasoningText: string;
    metrics: PlaygroundMetrics | null;
    error: string | null;
  };
  provider?: ProviderConfigResponse;
  modelName?: string | null;
  loading: boolean;
  onCopy: (onCopied: () => void) => void;
  debugRequest?: {
    maxTokens?: number;
    streaming?: boolean;
    promptLength?: number;
    images?: number;
    genParams?: GenerationParams | undefined;
    enableThinking?: boolean;
  };
}) {
  const [copied, setCopied] = useState(false);
  const { t } = useTranslation();
  const copy = () => onCopy(() => {
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  });

  return (
    <div className="glass-card p-5 space-y-4">
      <MetricsRow metrics={panel.metrics} loading={loading} />
      {panel.reasoningText && (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <BulbOutlined className="text-accent-violet text-[13px]" />
            <span className="text-[12px] text-text-tertiary uppercase tracking-wider">{t('playground.reasoning')}</span>
          </div>
          <div className="rounded border border-accent-violet/20 bg-accent-violet/5 p-4 overflow-auto max-h-[300px]">
            <pre className="whitespace-pre-wrap text-[13px] leading-relaxed font-mono text-text-secondary m-0">
              {panel.reasoningText}
              {panel.streaming && !panel.metrics && <span className="animate-pulse text-accent-violet">|</span>}
            </pre>
          </div>
        </div>
      )}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <CodeOutlined className="text-accent-teal text-[13px]" />
          <span className="text-[12px] text-text-tertiary uppercase tracking-wider">{title}</span>
          {provider && modelName && (
            <span
              className="text-[11px] px-1.5 py-0.5 rounded font-mono ml-auto"
              style={{ backgroundColor: `${accent}0a`, color: accent, border: `1px solid ${accent}20` }}
            >
              {provider.name} / {modelName}
            </span>
          )}
          {panel.responseText && !loading && (
            <button
              onClick={copy}
              className="text-[12px] text-text-tertiary hover:text-text-primary transition-colors ml-1"
              title={t('playground.copyResponse')}
            >
              {copied ? <CheckOutlined className="text-accent-teal" /> : <CopyOutlined />}
            </button>
          )}
        </div>
        <div className="rounded border border-border bg-[#f8f9fb] p-4 overflow-auto max-h-[600px] min-h-[100px]">
          {panel.responseText ? (
            <pre className="whitespace-pre-wrap text-[13px] leading-relaxed font-mono text-text-primary m-0">
              {panel.responseText}
              {panel.streaming && !panel.metrics && <span className="animate-pulse text-accent-blue">|</span>}
            </pre>
          ) : loading ? (
            <div className="flex items-center gap-2 text-text-tertiary text-[13px]">
              <span className="animate-pulse">
                {panel.streaming ? t('playground.streamingEllipsis') : t('playground.waitingForResponse')}
              </span>
            </div>
          ) : (
            <span className="text-text-tertiary text-[13px] italic">
              {panel.metrics ? t('playground.noResponseText') : t('playground.noResponseYet')}
            </span>
          )}
        </div>
      </div>

      {panel.metrics && (
        <Collapse
          ghost
          items={[
            {
              key: 'debug',
              label: <span className="text-[12px] text-text-secondary">{t('playground.debugDetails')}</span>,
              children: (
                <pre className="whitespace-pre-wrap text-[11px] font-mono text-text-secondary bg-[#f8f9fb] p-3 rounded overflow-auto max-h-[300px] m-0">
                  {JSON.stringify(
                    {
                      request: {
                        provider: provider?.name,
                        format: provider?.format,
                        endpoint: provider?.endpoint,
                        model: modelName,
                        maxTokens: debugRequest?.maxTokens,
                        streaming: debugRequest?.streaming,
                        thinking: debugRequest?.enableThinking,
                        promptLength: debugRequest?.promptLength,
                        images: debugRequest?.images,
                        genParams: debugRequest?.genParams,
                      },
                      response: {
                        ...panel.metrics,
                        textLength: panel.responseText.length,
                        reasoningTextLength: panel.reasoningText.length,
                      },
                    },
                    null,
                    2,
                  )}
                </pre>
              ),
            },
          ]}
        />
      )}
    </div>
  );
}

function CompareSummary({ a, b }: { a: PlaygroundMetrics; b: PlaygroundMetrics }) {
  const { t } = useTranslation();
  const rows = [
    {
      label: t('playground.responseTime'),
      av: a.responseTime,
      bv: b.responseTime,
      lowerBetter: true,
      unit: 'ms',
    },
    {
      label: t('playground.firstToken'),
      av: a.firstTokenLatency,
      bv: b.firstTokenLatency,
      lowerBetter: true,
      unit: 'ms',
    },
    {
      label: t('playground.tps'),
      av: a.tokensPerSecond,
      bv: b.tokensPerSecond,
      lowerBetter: false,
      unit: '',
    },
    {
      label: t('playground.tokenOut'),
      av: a.outputTokens,
      bv: b.outputTokens,
      lowerBetter: false,
      unit: '',
    },
  ];
  return (
    <div className="glass-card p-4">
      <div className="flex items-center gap-2 mb-3">
        <SwapOutlined className="text-text-tertiary text-[13px]" />
        <span className="text-[12px] text-text-secondary uppercase tracking-wider">{t('playground.compareSummary')}</span>
      </div>
      <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-4 gap-y-2 items-center text-[12px]">
        <div />
        <div className="text-center font-mono font-semibold" style={{ color: A_COLOR }}>A</div>
        <div className="text-center font-mono font-semibold" style={{ color: B_COLOR }}>B</div>
        <div />
        {rows.map((r) => {
          const aWins = r.lowerBetter ? r.av < r.bv : r.av > r.bv;
          const bWins = r.lowerBetter ? r.bv < r.av : r.bv > r.av;
          return (
            <FragmentRow key={r.label} label={r.label}>
              <span className={`text-center font-mono ${aWins ? 'font-semibold text-accent-teal' : 'text-text-secondary'}`}>
                {r.av != null ? `${r.av.toLocaleString()}${r.unit}` : '--'}
              </span>
              <span className={`text-center font-mono ${bWins ? 'font-semibold text-accent-teal' : 'text-text-secondary'}`}>
                {r.bv != null ? `${r.bv.toLocaleString()}${r.unit}` : '--'}
              </span>
              <span className="text-[10px] text-text-tertiary flex items-center justify-center gap-0.5">
                {aWins ? (
                  <>
                    <CrownOutlined className="text-accent-amber" />
                    {t('playground.winnerA')}
                  </>
                ) : bWins ? (
                  <>
                    <CrownOutlined className="text-accent-amber" />
                    {t('playground.winnerB')}
                  </>
                ) : (
                  t('playground.tie')
                )}
              </span>
            </FragmentRow>
          );
        })}
      </div>
    </div>
  );
}

function FragmentRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <div className="text-text-tertiary">{label}</div>
      {children}
    </>
  );
}

function MetricsRow({ metrics, loading }: { metrics: PlaygroundMetrics | null; loading: boolean }) {
  const { t } = useTranslation();
  const colorMap: Record<string, string> = {
    'text-accent-blue': '#4096ff',
    'text-accent-amber': '#ff9830',
    'text-accent-teal': '#73bf69',
    'text-accent-rose': '#f2495c',
    'text-accent-violet': '#8a6dff',
    'text-text-primary': '#111827',
  };

  const cards = [
    {
      label: t('playground.responseTime'),
      tooltip: t('playground.responseTimeTooltip'),
      value: metrics?.responseTime != null ? `${metrics.responseTime.toLocaleString()} ms` : '--',
      icon: <ClockCircleOutlined />,
      cls: 'text-accent-blue',
    },
    {
      label: t('playground.firstToken'),
      tooltip: t('playground.firstTokenTooltip'),
      value:
        metrics?.firstTokenLatency != null && metrics.firstTokenLatency > 0
          ? `${metrics.firstTokenLatency.toLocaleString()} ms`
          : metrics
            ? t('common.status.na')
            : '--',
      icon: <ThunderboltOutlined />,
      cls: 'text-accent-amber',
    },
    {
      label: t('playground.tps'),
      tooltip: t('playground.tpsTooltip'),
      value: metrics?.tokensPerSecond != null ? `${metrics.tokensPerSecond}` : '--',
      icon: <DashboardOutlined />,
      cls: metrics?.tokensPerSecond === 0 && metrics?.outputTokens === 0 ? 'text-accent-rose' : 'text-accent-teal',
      warn: metrics?.tokensPerSecond === 0 && metrics?.outputTokens === 0,
    },
    {
      label: t('playground.tokensLabel'),
      tooltip: t('playground.tokensTooltip'),
      value:
        metrics?.inputTokens != null
          ? `${metrics.inputTokens} ${t('playground.tokenIn')} / ${metrics.outputTokens ?? 0} ${t('playground.tokenOut')}`
          : '--',
      icon: metrics?.outputTokens === 0 ? <WarningOutlined /> : null,
      cls: metrics?.outputTokens === 0 ? 'text-accent-rose' : 'text-accent-violet',
      warn: metrics?.outputTokens === 0,
      sublabel: (() => {
        const parts: string[] = [];
        if (metrics?.reasoningTokens)
          parts.push(`${metrics.reasoningTokens} ${t('playground.reasoningLabel').toLowerCase()}`);
        if (metrics?.cacheCreationTokens)
          parts.push(`${metrics.cacheCreationTokens} ${t('playground.cacheWriteLabel')}`);
        if (metrics?.cacheReadTokens) parts.push(`${metrics.cacheReadTokens} ${t('playground.cacheReadLabel')}`);
        return parts.length > 0 ? `(${parts.join(', ')})` : undefined;
      })(),
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {cards.map((card) => {
        const c = colorMap[card.cls] || '#73bf69';
        return (
          <div
            key={card.label}
            className="stat-card"
            style={card.warn ? { borderColor: 'rgba(242,73,92,0.3)', background: 'rgba(242,73,92,0.05)' } : undefined}
          >
            <Tooltip title={card.tooltip}>
              <div className="flex items-center gap-1.5 cursor-help">
                {card.icon && (
                  <span className="text-[12px]" style={{ color: c }}>
                    {card.icon}
                  </span>
                )}
                <span className="stat-label">{card.label}</span>
              </div>
            </Tooltip>
            <div className="stat-value" style={{ color: c, fontSize: 16, minHeight: 22 }}>
              {loading && !metrics ? <span className="animate-pulse">{card.value}</span> : card.value}
            </div>
            {card.sublabel && <div className="text-[11px] text-text-tertiary mt-0.5">{card.sublabel}</div>}
            {card.warn && (
              <div className="text-[11px] text-accent-rose mt-1 flex items-center gap-1">
                <WarningOutlined className="text-[11px]" />
                {t('common.noTokenData')}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
