import { useState, useEffect, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import {
  WorkflowTemplate,
  BenchmarkConfig,
  BenchmarkWorkflow,
  ProviderConfigResponse,
  FORMAT_COLORS,
} from '../types';
import { getStoredMaxTokens } from '../constants';
import { CreateWorkflowData } from '../hooks/useWorkflow';
import { useProviders } from '../hooks/useProviders';
import { Button, App as AntApp, Tooltip } from '../antdImports';
import {
  PlusOutlined,
  UpOutlined,
  DownOutlined,
  CloseOutlined,
  CopyOutlined,
  LoadingOutlined,
  RightOutlined,
} from '@ant-design/icons';
import { WorkflowBasics } from './WorkflowBasics';
import { ProviderPicker } from './ProviderPicker';
import { TemplateGallery } from './TemplateGallery';
import { TaskEditor } from './TaskEditor';
import { consumePendingTemplate } from '../workflowTemplateBridge';
import { estimateInputTokens, estimateModelCost, hasPricing, formatCost } from '../utils/costEstimate';

export interface TaskConfig {
  name: string;
  description: string;
  config: BenchmarkConfig;
  providers?: string[];
  tags: Record<string, string>;
  _outputScope?: number; // UI-only: long-context output scope (0=all, N=first N docs)
  _isLongContext?: boolean; // UI-only: whether a long-context preset is active
  _activePreset?: string; // UI-only: label of the currently selected preset
}

interface SelectedModel {
  providerId: string;
  modelName: string;
  providerName: string;
  displayLabel: string;
  color: string;
}

interface WorkflowConfigPanelProps {
  onStart: (data: CreateWorkflowData) => void;
  isRunning: boolean;
  templates: WorkflowTemplate[];
  fetchTemplates: () => void;
  onCancel?: () => void;
  initialWorkflow?: BenchmarkWorkflow | null;
  /** How the initial workflow was sourced. 'duplicate' prefixes the name with "(copy)"; 'rerun' echoes the original name. */
  initialWorkflowMode?: 'duplicate' | 'rerun';
  onInitialWorkflowConsumed?: () => void;
}

const DEFAULT_TASK: () => TaskConfig = () => ({
  name: 'Task 1', // translated dynamically via t() in addTask()
  description: '',
  config: {
    prompt: 'Explain quantum computing in simple terms.',
    systemPrompt: '',
    maxTokens: getStoredMaxTokens(),
    concurrency: 1,
    iterations: 10,
    streaming: true,
    warmupRuns: 0,
    requestInterval: 0,
    randomizeInterval: false,
    maxQps: 0,
  },
  tags: {},
});

export function WorkflowConfigPanel({
  onStart,
  isRunning,
  templates,
  fetchTemplates,
  onCancel,
  initialWorkflow,
  initialWorkflowMode = 'duplicate',
  onInitialWorkflowConsumed,
}: WorkflowConfigPanelProps) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const { providers: configuredProviders, loading: providersLoading, fetchProviders } = useProviders();

  // Refresh the template list whenever this panel mounts — custom templates created
  // in the Module Library won't show up otherwise, since templates are only fetched
  // once on login.
  useEffect(() => {
    fetchTemplates();
  }, [fetchTemplates]);

  /** Map backend template names to i18n keys for translation */
  const templateNameKeyMap: Record<string, { name: string; desc: string }> = {
    'Quick Benchmark': { name: 'templates.quickBenchmark', desc: 'templates.quickBenchmarkDesc' },
    'Latency Profile': { name: 'templates.latencyProfile', desc: 'templates.latencyProfileDesc' },
    'Concurrency Ladder': { name: 'templates.concurrencyLadder', desc: 'templates.concurrencyLadderDesc' },
    'Streaming vs Batch': { name: 'templates.streamingVsBatch', desc: 'templates.streamingVsBatchDesc' },
    'Token Length Gradient': { name: 'templates.tokenLengthGradient', desc: 'templates.tokenLengthGradientDesc' },
    'Provider Showdown': { name: 'templates.providerShowdown', desc: 'templates.providerShowdownDesc' },
    'Cost Efficiency Audit': { name: 'templates.costEfficiencyAudit', desc: 'templates.costEfficiencyAuditDesc' },
    'API Reliability Test': { name: 'templates.apiReliabilityTest', desc: 'templates.apiReliabilityTestDesc' },
    'Real-World Simulation': { name: 'templates.realWorldSimulation', desc: 'templates.realWorldSimulationDesc' },
    'Tool Calling & Structured Output': {
      name: 'templates.toolCallingStructuredOutput',
      desc: 'templates.toolCallingStructuredOutputDesc',
    },
    'Vision Benchmark': { name: 'templates.visionBenchmark', desc: 'templates.visionBenchmarkDesc' },
  };

  const getTemplateName = (name: string): string => {
    const keys = templateNameKeyMap[name];
    return keys ? t(keys.name) : name;
  };

  const getTemplateDesc = (name: string, fallback: string): string => {
    const keys = templateNameKeyMap[name];
    return keys ? t(keys.desc) : fallback;
  };

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selectedModels, setSelectedModels] = useState<SelectedModel[]>([]);
  const [tasks, setTasks] = useState<TaskConfig[]>([DEFAULT_TASK()]);
  const [stopOnFailure, setStopOnFailure] = useState(true);
  const [cooldown, setCooldown] = useState(3000);
  const heavyPromptsRef = useRef<Map<number, string>>(new Map());
  const [heavyTaskIndexes, setHeavyTaskIndexes] = useState<Set<number>>(new Set());

  useEffect(() => {
    fetchProviders();
  }, [fetchProviders]);

  // Load initial workflow data when provided
  useEffect(() => {
    if (!initialWorkflow || !configuredProviders.length) return;

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setName(
      initialWorkflowMode === 'rerun'
        ? initialWorkflow.name
        : initialWorkflow.name
          ? t('workflow.copy', { name: initialWorkflow.name })
          : '',
    );

    if (initialWorkflowMode === 'rerun') {
      // The config is echoed back for review; the user must click Start manually.
      message.info(t('workflow.rerunLoaded'));
    }
    setDescription(initialWorkflow.description || '');
    setStopOnFailure(initialWorkflow.options?.stopOnFailure ?? true);
    setCooldown(initialWorkflow.options?.cooldownBetweenTasks ?? 3000);

    // Restore selected models from providers list
    const models: SelectedModel[] = [];
    for (const p of initialWorkflow.providers) {
      if (!p.includes(':')) continue;
      const [configId, modelName] = p.split(':', 2);
      const provider = configuredProviders.find((cp) => cp.id === configId);
      if (provider) {
        const color = FORMAT_COLORS[provider.format] || '#999';
        models.push({
          providerId: configId,
          modelName,
          providerName: provider.name,
          displayLabel: `${provider.name} / ${modelName}`,
          color,
        });
      }
    }
    setSelectedModels(models);

    // Restore tasks
    if (initialWorkflow.tasks?.length) {
      setTasks(
        initialWorkflow.tasks.map((t) => ({
          name: t.name,
          description: t.description || '',
          config: {
            prompt: t.config.prompt,
            systemPrompt: t.config.systemPrompt || '',
            maxTokens: t.config.maxTokens || getStoredMaxTokens(),
            concurrency: t.config.concurrency || 1,
            iterations: t.config.iterations || 10,
            streaming: t.config.streaming ?? true,
            warmupRuns: t.config.warmupRuns ?? 0,
            requestInterval: t.config.requestInterval ?? 0,
            randomizeInterval: t.config.randomizeInterval ?? false,
            maxQps: t.config.maxQps ?? 0,
            targetCacheHitRate: t.config.targetCacheHitRate,
          },
          providers: t.providers,
          tags: t.tags || {},
        })),
      );
    }

    onInitialWorkflowConsumed?.();
  }, [initialWorkflow, configuredProviders]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleModel = (provider: ProviderConfigResponse, modelName: string) => {
    const key = `${provider.id}:${modelName}`;
    setSelectedModels((prev) => {
      const exists = prev.find((m) => `${m.providerId}:${m.modelName}` === key);
      if (exists) {
        return prev.filter((m) => `${m.providerId}:${m.modelName}` !== key);
      }
      return [
        ...prev,
        {
          providerId: provider.id,
          modelName,
          providerName: provider.name,
          displayLabel: `${provider.name} / ${modelName}`,
          color: FORMAT_COLORS[provider.format] || '#999',
        },
      ];
    });
  };

  const isModelSelected = (providerId: string, modelName: string) =>
    selectedModels.some((m) => m.providerId === providerId && m.modelName === modelName);

  const addTask = () => {
    const lastTask = tasks[tasks.length - 1];
    const newTask: TaskConfig = {
      name: t('workflow.taskName_default', { number: tasks.length + 1 }),
      description: '',
      config: { ...lastTask.config },
      providers: lastTask.providers ? [...lastTask.providers] : undefined,
      tags: {},
    };
    setTasks([...tasks, newTask]);
  };

  const removeTask = (index: number) => {
    if (tasks.length <= 1) return;
    const newTasks = tasks.filter((_, i) => i !== index);
    setTasks(newTasks);

    // Re-index heavy prompt entries after removal
    const newHeavy = new Map<number, string>();
    for (const [k, v] of heavyPromptsRef.current) {
      if (k === index) continue;
      newHeavy.set(k > index ? k - 1 : k, v);
    }
    heavyPromptsRef.current = newHeavy;

    setHeavyTaskIndexes((prev) => {
      const shifted = new Set<number>();
      for (const k of prev) {
        if (k === index) continue;
        shifted.add(k > index ? k - 1 : k);
      }
      return shifted;
    });
  };

  const duplicateTask = (index: number) => {
    const source = tasks[index];
    const cloned: TaskConfig = {
      ...source,
      name: t('workflow.copy', { name: source.name }),
      config: { ...source.config },
      tags: { ...source.tags },
      providers: source.providers ? [...source.providers] : undefined,
    };
    const newTasks = [...tasks];
    newTasks.splice(index + 1, 0, cloned);
    setTasks(newTasks);

    // Shift heavy prompt entries for indexes after the insertion point
    const newHeavy = new Map<number, string>();
    for (const [k, v] of heavyPromptsRef.current) {
      newHeavy.set(k > index ? k + 1 : k, v);
    }
    // Copy heavy prompt for the duplicated task
    const sourceHeavy = heavyPromptsRef.current.get(index);
    if (sourceHeavy) {
      newHeavy.set(index + 1, sourceHeavy);
    }
    heavyPromptsRef.current = newHeavy;

    setHeavyTaskIndexes((prev) => {
      const shifted = new Set<number>();
      for (const k of prev) {
        shifted.add(k > index ? k + 1 : k);
      }
      if (prev.has(index)) {
        shifted.add(index + 1);
      }
      return shifted;
    });
  };

  const moveTask = (index: number, direction: -1 | 1) => {
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= tasks.length) return;
    const newTasks = [...tasks];
    [newTasks[index], newTasks[newIndex]] = [newTasks[newIndex], newTasks[index]];
    setTasks(newTasks);

    // Swap heavy prompt entries for the two indexes
    const aHeavy = heavyPromptsRef.current.get(index);
    const bHeavy = heavyPromptsRef.current.get(newIndex);
    heavyPromptsRef.current.delete(index);
    heavyPromptsRef.current.delete(newIndex);
    if (aHeavy) heavyPromptsRef.current.set(newIndex, aHeavy);
    if (bHeavy) heavyPromptsRef.current.set(index, bHeavy);

    setHeavyTaskIndexes((prev) => {
      const hasA = prev.has(index);
      const hasB = prev.has(newIndex);
      if (hasA === hasB) return prev;
      const next = new Set(prev);
      next.delete(index);
      next.delete(newIndex);
      if (hasA) next.add(newIndex);
      if (hasB) next.add(index);
      return next;
    });
  };

  const updateTask = (index: number, updates: Partial<TaskConfig>) => {
    const newTasks = [...tasks];
    newTasks[index] = { ...newTasks[index], ...updates };
    setTasks(newTasks);
  };

  const updateTaskConfig = (index: number, configUpdates: Partial<BenchmarkConfig>) => {
    const newTasks = [...tasks];
    newTasks[index] = {
      ...newTasks[index],
      config: { ...newTasks[index].config, ...configUpdates },
    };
    setTasks(newTasks);
  };

  const loadTemplate = (template: WorkflowTemplate) => {
    setName(getTemplateName(template.name));
    setDescription(getTemplateDesc(template.name, template.description));
    setStopOnFailure(template.options.stopOnFailure);
    setCooldown(template.options.cooldownBetweenTasks);
    setTasks(
      template.tasks.map((t) => ({
        name: t.name,
        description: t.description || '',
        config: {
          prompt: t.config.prompt,
          systemPrompt: t.config.systemPrompt || '',
          maxTokens: t.config.maxTokens || 500,
          concurrency: t.config.concurrency || 1,
          iterations: t.config.iterations || 10,
          streaming: t.config.streaming ?? true,
          warmupRuns: t.config.warmupRuns ?? 0,
          requestInterval: t.config.requestInterval ?? 0,
          randomizeInterval: t.config.randomizeInterval ?? false,
          maxQps: t.config.maxQps ?? 0,
          images: t.config.images,
          targetCacheHitRate: t.config.targetCacheHitRate,
        },
        tags: t.tags || {},
      })),
    );
  };

  // Apply a template pushed from the module library ("应用" action).
  // Runs once on mount; consumePendingTemplate clears the flag after reading.
  useEffect(() => {
    const pending = consumePendingTemplate();
    if (pending) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      loadTemplate(pending);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleStart = () => {
    if (!name.trim()) {
      message.error(t('config.nameRequired'));
      return;
    }
    if (selectedModels.length === 0) {
      message.error(t('config.modelRequired'));
      return;
    }
    if (tasks.length === 0) {
      message.error(t('config.taskRequired'));
      return;
    }
    const providerKeys = selectedModels.map((m) => `${m.providerId}:${m.modelName}`);
    onStart({
      name,
      description: description || undefined,
      providers: providerKeys,
      apiKeys: {},
      tasks: tasks.map((t, i) => ({
        name: t.name,
        description: t.description || undefined,
        config: {
          ...t.config,
          prompt: heavyPromptsRef.current.get(i) ?? t.config.prompt,
        },
        tags: Object.keys(t.tags).length > 0 ? t.tags : undefined,
      })),
      options: { stopOnFailure, cooldownBetweenTasks: cooldown },
    });
  };

  const estimatedRequests = tasks.reduce(
    (acc, tk) => acc + (tk.config.iterations || 0) * (tk.config.concurrency || 1),
    0,
  );

  // Cost estimate — driven by the (optional) prices configured in the model library.
  const costEstimate = useMemo(() => {
    const entries = selectedModels.map((sm) => {
      const model = configuredProviders
        .find((p) => p.id === sm.providerId)
        ?.models.find((m) => m.name === sm.modelName);
      return { sm, model, priced: hasPricing(model) };
    });

    // Tokenizing every prompt is only worth it when at least one price is set.
    if (!entries.some((e) => e.priced)) {
      return {
        total: 0,
        perModel: entries.map((e) => ({ label: e.sm.displayLabel, cost: 0, priced: false })),
        anyPriced: false,
        allPriced: false,
      };
    }

    // Tokenize once, then reuse for every priced model.
    const taskCostInputs = tasks.map((tk) => ({
      inputTokens: estimateInputTokens(tk.config.prompt, tk.config.systemPrompt),
      outputTokens: tk.config.maxTokens || 0,
      requests: (tk.config.iterations || 0) * (tk.config.concurrency || 1),
      cacheHitRate: tk.config.targetCacheHitRate ?? 0,
    }));

    let total = 0;
    const perModel = entries.map((e) => {
      const cost = e.priced && e.model ? estimateModelCost(e.model, taskCostInputs) : 0;
      if (e.priced) total += cost;
      return { label: e.sm.displayLabel, cost, priced: e.priced };
    });

    return { total, perModel, anyPriced: true, allPriced: entries.every((e) => e.priced) };
  }, [selectedModels, configuredProviders, tasks]);

  return (
    <motion.div
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      className="glass-card p-0 overflow-hidden"
      data-tour="config-panel"
    >
      <div className="wf-layout">
        {/* ===== Left rail: meta + providers + templates ===== */}
        <aside className="wf-rail p-5 border-b lg:border-b-0 lg:border-r border-border">
          <WorkflowBasics
            name={name}
            description={description}
            stopOnFailure={stopOnFailure}
            cooldown={cooldown}
            selectedModelsCount={selectedModels.length}
            onNameChange={setName}
            onDescriptionChange={setDescription}
            onStopOnFailureChange={setStopOnFailure}
            onCooldownChange={setCooldown}
          />
          <ProviderPicker
            providers={configuredProviders}
            loading={providersLoading}
            selectedModels={selectedModels}
            isSelected={isModelSelected}
            onToggle={toggleModel}
            onClearAll={() => setSelectedModels([])}
          />
          <TemplateGallery
            templates={templates}
            getName={getTemplateName}
            getDesc={getTemplateDesc}
            onLoad={loadTemplate}
          />
        </aside>

        {/* ===== Main: task builder ===== */}
        <section className="p-5 space-y-5">
          <div className="tasks-head">
            <span className="wf-step-badge">4</span>
            <h3>{tasks.length === 1 ? t('workflow.taskConfig') : t('workflow.tasks', { count: tasks.length })}</h3>
            <div className="spacer" />
            <Button
              type="primary"
              ghost
              size="small"
              icon={<PlusOutlined />}
              onClick={addTask}
            >
              {tasks.length === 1 ? t('workflow.addAnotherTask') : t('workflow.addTask')}
            </Button>
          </div>

          <div className="space-y-4">
            {tasks.map((task, index) => (
              <TaskCard
                key={index}
                task={task}
                index={index}
                total={tasks.length}
                tasks={tasks}
                configuredProviders={configuredProviders}
                heavyPromptsRef={heavyPromptsRef}
                heavyTaskIndexes={heavyTaskIndexes}
                setHeavyTaskIndexes={setHeavyTaskIndexes}
                setTasks={setTasks}
                updateTask={updateTask}
                updateTaskConfig={updateTaskConfig}
                onMove={moveTask}
                onDuplicate={duplicateTask}
                onDelete={removeTask}
              />
            ))}
          </div>
        </section>
      </div>

      {/* Sticky action bar */}
      <div className="config-action-bar" data-tour="config-start">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="summary-stat">
            <span className="summary-label">{t('workflow.summaryTasks')}</span>
            <span className="summary-value">{tasks.length}</span>
          </div>
          <div className="summary-divider" />
          <div className="summary-stat">
            <span className="summary-label">{t('workflow.summaryModels')}</span>
            <span className="summary-value">{selectedModels.length}</span>
          </div>
          <div className="summary-divider" />
          <div className="summary-stat">
            <span className="summary-label">{t('workflow.summaryRequests')}</span>
            <span className="summary-value">{estimatedRequests.toLocaleString()}</span>
          </div>
          <div className="summary-divider" />
          <Tooltip
            title={
              costEstimate.anyPriced ? (
                <div className="space-y-0.5">
                  {costEstimate.perModel.map((m) => (
                    <div key={m.label}>
                      {m.label}: {m.priced ? formatCost(m.cost) : t('workflow.costNotConfigured')}
                    </div>
                  ))}
                  {!costEstimate.allPriced && (
                    <div className="text-accent-amber">{t('workflow.costPartialHint')}</div>
                  )}
                </div>
              ) : (
                t('workflow.costHintNone')
              )
            }
          >
            <div className="summary-stat" style={{ cursor: 'help' }}>
              <span className="summary-label">{t('workflow.summaryCost')}</span>
              <span className="summary-value">
                {costEstimate.anyPriced ? (
                  <span className="font-mono">
                    ≈{formatCost(costEstimate.total)}
                    {!costEstimate.allPriced && <span className="text-accent-amber">*</span>}
                  </span>
                ) : (
                  <span className="text-text-tertiary">—</span>
                )}
              </span>
            </div>
          </Tooltip>
        </div>
        <div className="flex items-center gap-3">
          {!name.trim() && <span className="action-hint">{t('workflow.enterName')}</span>}
          <Button
            type="primary"
            className="start-btn"
            onClick={handleStart}
            disabled={isRunning || selectedModels.length === 0 || !name.trim() || tasks.length === 0}
            loading={isRunning ? { icon: <LoadingOutlined /> } : false}
            size="large"
          >
            {isRunning
              ? t('common.status.running')
              : t('workflow.startWorkflow', { taskCount: tasks.length, modelCount: selectedModels.length })}
          </Button>
          {isRunning && onCancel && (
            <motion.div initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }}>
              <Button danger size="large" onClick={onCancel} style={{ fontWeight: 500 }}>
                ✕
              </Button>
            </motion.div>
          )}
        </div>
      </div>
    </motion.div>
  );
}

interface TaskCardProps {
  task: TaskConfig;
  index: number;
  total: number;
  tasks: TaskConfig[];
  configuredProviders: ProviderConfigResponse[];
  heavyPromptsRef: React.MutableRefObject<Map<number, string>>;
  heavyTaskIndexes: Set<number>;
  setHeavyTaskIndexes: React.Dispatch<React.SetStateAction<Set<number>>>;
  setTasks: React.Dispatch<React.SetStateAction<TaskConfig[]>>;
  updateTask: (index: number, updates: Partial<TaskConfig>) => void;
  updateTaskConfig: (index: number, configUpdates: Partial<BenchmarkConfig>) => void;
  onMove: (index: number, direction: -1 | 1) => void;
  onDuplicate: (index: number) => void;
  onDelete: (index: number) => void;
}

function TaskCard({
  task,
  index,
  total,
  tasks,
  configuredProviders,
  heavyPromptsRef,
  heavyTaskIndexes,
  setHeavyTaskIndexes,
  setTasks,
  updateTask,
  updateTaskConfig,
  onMove,
  onDuplicate,
  onDelete,
}: TaskCardProps) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className={`task-card${collapsed ? '' : ' is-active'}`}>
      <div className="task-card-header">
        <button
          type="button"
          className="icon-btn"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? t('workflow.expandTask') : t('workflow.collapseTask')}
          title={collapsed ? t('workflow.expandTask') : t('workflow.collapseTask')}
        >
          {collapsed ? <RightOutlined /> : <DownOutlined />}
        </button>
        <span className="task-order">{index + 1}</span>
        <input
          className="task-title-input"
          value={task.name}
          onChange={(e) => updateTask(index, { name: e.target.value })}
          placeholder={t('workflow.taskName')}
        />
        <div className="task-summary">
          <span>{task.config.concurrency}c</span>
          <span>×</span>
          <span>{task.config.iterations}i</span>
          <span>·</span>
          <span>{task.config.maxTokens}t</span>
        </div>
        <div className="task-actions">
          <button
            type="button"
            className="icon-btn"
            disabled={index === 0}
            onClick={() => onMove(index, -1)}
            aria-label={t('workflow.moveUp')}
          >
            <UpOutlined />
          </button>
          <button
            type="button"
            className="icon-btn"
            disabled={index === total - 1}
            onClick={() => onMove(index, 1)}
            aria-label={t('workflow.moveDown')}
          >
            <DownOutlined />
          </button>
          <Tooltip title={t('workflow.duplicateTask')}>
            <button type="button" className="icon-btn" onClick={() => onDuplicate(index)} aria-label={t('workflow.duplicateTask')}>
              <CopyOutlined />
            </button>
          </Tooltip>
          <button
            type="button"
            className="icon-btn danger"
            disabled={total <= 1}
            onClick={() => onDelete(index)}
            aria-label={t('workflow.deleteTask')}
          >
            <CloseOutlined />
          </button>
        </div>
      </div>
      {!collapsed && (
        <div className="task-card-body">
          <TaskEditor
            task={task}
            index={index}
            tasks={tasks}
            configuredProviders={configuredProviders}
            heavyPromptsRef={heavyPromptsRef}
            heavyTaskIndexes={heavyTaskIndexes}
            setHeavyTaskIndexes={setHeavyTaskIndexes}
            setTasks={setTasks}
            updateTask={updateTask}
            updateTaskConfig={updateTaskConfig}
          />
        </div>
      )}
    </div>
  );
}
