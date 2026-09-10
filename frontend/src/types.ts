export interface ImageInput {
  type: 'url' | 'base64';
  url?: string;
  mediaType?: string;
  data?: string;
}

export interface BenchmarkConfig {
  prompt: string;
  systemPrompt?: string;
  maxTokens: number;
  concurrency: number;
  iterations: number;
  streaming?: boolean;
  warmupRuns?: number;
  requestInterval?: number;
  randomizeInterval?: boolean;
  maxQps?: number;
  images?: ImageInput[];
  targetCacheHitRate?: number; // 0.0–1.0
}

export type ErrorCategory =
  | 'timeout'
  | 'rate_limit'
  | 'api_error'
  | 'network'
  /** Provider answered 200 with no visible content — usually an exhausted output budget. */
  | 'empty_response'
  | 'unknown';

export interface IterationResult {
  iteration: number;
  responseTime: number;
  firstTokenLatency: number;
  tokensPerSecond: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  estimatedCost: number;
  success: boolean;
  error?: string;
  errorCategory?: ErrorCategory;
}

export interface ProviderSummary {
  avgResponseTime: number;
  p50ResponseTime: number;
  p95ResponseTime: number;
  p99ResponseTime: number;
  avgTokensPerSecond: number;
  avgFirstTokenLatency: number;
  p50FirstTokenLatency: number;
  p95FirstTokenLatency: number;
  p99FirstTokenLatency: number;
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCost: number;
  successRate: number;
  errorCount: number;
  systemThroughput?: number;
  errorBreakdown?: Record<ErrorCategory, number>;
  totalTestDuration?: number;
}

export interface ProviderResult {
  provider: string;
  model: string;
  iterations: IterationResult[];
  summary: ProviderSummary;
}

export type BenchmarkStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface CapabilityTest {
  type: 'vision' | 'function_calling' | 'json_mode' | 'streaming' | 'non_streaming';
  name: string;
  description: string;
  passed: boolean;
  details?: string;
  latencyMs?: number;
}

export interface BenchmarkRun {
  id: string;
  status: BenchmarkStatus;
  providers: string[];
  config: BenchmarkConfig;
  results: Record<string, ProviderResult>;
  capabilityTests?: CapabilityTest[];
  createdAt: string;
  completedAt?: string;
}

export interface ProviderOption {
  id: string;
  name: string;
  color: string;
  icon: string;
}

export const PROVIDERS: ProviderOption[] = [
  { id: 'openai', name: 'OpenAI GPT-4', color: '#5b8def', icon: '🤖' },
  { id: 'claude', name: 'Claude 3', color: '#a78bfa', icon: '🧠' },
  { id: 'gemini', name: 'Gemini Pro', color: '#00d4aa', icon: '💎' },
  { id: 'zai', name: 'Zai GLM-4.7', color: '#ffb224', icon: '⚡' },
];

export const PROVIDER_COLORS: Record<string, string> = {
  openai: '#5b8def',
  claude: '#a78bfa',
  gemini: '#00d4aa',
  zai: '#ffb224',
};

// Dynamic color palette for providers not in the static map
const DYNAMIC_PALETTE = [
  '#5b8def',
  '#a78bfa',
  '#00d4aa',
  '#ffb224',
  '#f97066',
  '#73bf69',
  '#ff9830',
  '#36a2eb',
  '#ff6384',
  '#4bc0c0',
  '#9966ff',
  '#ffcd56',
  '#c9cbcf',
  '#ff6b6b',
  '#48dbfb',
];
const dynamicColorCache: Record<string, string> = {};
let nextColorIdx = 0;

export function getProviderColor(providerKey: string): string {
  // Normalize: use only the configId part (before ':') so same provider shares one color
  const colorKey = providerKey.includes(':') ? providerKey.split(':', 2)[0] : providerKey;
  // Check static map first
  if (PROVIDER_COLORS[colorKey]) return PROVIDER_COLORS[colorKey];
  // Check cache
  if (dynamicColorCache[colorKey]) return dynamicColorCache[colorKey];
  // Assign from palette
  const color = DYNAMIC_PALETTE[nextColorIdx % DYNAMIC_PALETTE.length];
  nextColorIdx++;
  dynamicColorCache[colorKey] = color;
  return color;
}

// Get a display-friendly name for a provider key (e.g., "configId:modelName" -> "modelName")
export function getProviderDisplayName(providerKey: string): string {
  if (providerKey.includes(':')) {
    return providerKey.split(':', 2)[1];
  }
  // Legacy provider names
  const legacy: Record<string, string> = {
    openai: 'OpenAI GPT-4',
    claude: 'Claude 3',
    gemini: 'Gemini Pro',
    zai: 'Zai GLM-4.7',
  };
  return legacy[providerKey] || providerKey;
}

// ==================== Workflow Types ====================

export type WorkflowStatus = 'draft' | 'running' | 'completed' | 'failed' | 'cancelled';
export type WorkflowTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface WorkflowTask {
  id: string;
  name: string;
  description?: string;
  order: number;
  config: BenchmarkConfig;
  providers?: string[];
  tags?: Record<string, string>;
}

export interface WorkflowTaskResult {
  taskId: string;
  taskName: string;
  benchmarkRunId: string;
  status: WorkflowTaskStatus;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface BenchmarkWorkflow {
  id: string;
  name: string;
  description?: string;
  status: WorkflowStatus;
  providers: string[];
  providerLabels?: Record<string, string>;
  tasks: WorkflowTask[];
  options: WorkflowOptions;
  taskResults: WorkflowTaskResult[];
  summary?: WorkflowSummary;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface WorkflowOptions {
  executionMode: 'sequential';
  stopOnFailure: boolean;
  cooldownBetweenTasks: number;
}

export interface WorkflowSummary {
  totalDuration: number;
  totalCost: number;
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  taskCount: number;
  completedTaskCount: number;
  failedTaskCount: number;
  providerSummaries: Record<string, WorkflowProviderSummary>;
}

export interface WorkflowProviderSummary {
  provider: string;
  model: string;
  avgResponseTime: number;
  avgFirstTokenLatency: number;
  avgTokensPerSecond: number;
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  overallSuccessRate: number;
  inputThroughput: number;
  outputThroughput: number;
  totalThroughput: number;
  perTaskMetrics: TaskMetricPoint[];
}

export interface TaskMetricPoint {
  taskId: string;
  taskName: string;
  taskOrder: number;
  concurrency: number;
  promptTokens: number;
  inputTokens: number;
  outputTokens: number;
  avgResponseTime: number;
  p95ResponseTime: number;
  avgFirstTokenLatency: number;
  avgTokensPerSecond: number;
  systemThroughput: number;
  inputThroughput: number;
  outputThroughput: number;
  totalThroughput: number;
  successRate: number;
  estimatedCost: number;
}

// ==================== Provider Format Colors ====================

export const FORMAT_COLORS: Record<string, string> = {
  openai: '#5b8def',
  anthropic: '#a78bfa',
  gemini: '#73bf69',
  custom: '#ff9830',
};

// ==================== Provider Config Types ====================

export type ProviderFormat = 'openai' | 'anthropic' | 'gemini' | 'custom';

export interface ModelConfig {
  id: string;
  name: string;
  displayName?: string;
  contextSize: number;
  supportsVision: boolean;
  supportsTools: boolean;
  supportsStreaming: boolean;
  isActive: boolean;
  /** Optional pricing in currency units per 1,000,000 tokens. Used only for cost estimates. */
  inputPrice?: number;
  outputPrice?: number;
  cacheReadPrice?: number;
  cacheWritePrice?: number;
}

export interface ProviderConfigResponse {
  id: string;
  name: string;
  endpoint: string;
  apiKeyMasked: string;
  format: ProviderFormat;
  models: ModelConfig[];
  createdAt: string;
  updatedAt: string;
}

export interface ProviderConfigInput {
  name: string;
  endpoint: string;
  apiKey: string;
  format: ProviderFormat;
  models: Omit<ModelConfig, 'id'>[];
}

export interface TestConnectionResult {
  success: boolean;
  latencyMs: number;
  error?: string;
}

export interface WorkflowTemplate {
  name: string;
  description: string;
  tasks: Array<{
    name: string;
    description?: string;
    config: Partial<BenchmarkConfig> & { prompt: string; images?: ImageInput[] };
    tags?: Record<string, string>;
  }>;
  options: {
    stopOnFailure: boolean;
    cooldownBetweenTasks: number;
  };
  /** Present on items returned by the API (built-in templates are tagged `true`). */
  id?: string;
  builtin?: boolean;
}

/** A workflow template as stored/persisted in the module library (user-defined or built-in). */
export interface WorkflowTemplateRecord extends WorkflowTemplate {
  id: string;
  builtin: boolean;
  createdAt: string;
  updatedAt: string;
}

// ==================== Quality Evaluation Types ====================

export type GraderType =
  | 'exact'
  | 'contains'
  | 'regex'
  | 'numeric_tolerance'
  | 'json_schema'
  | 'multiple_choice'
  | 'set_match';

export interface GraderConfig {
  accepted?: string[];
  patterns?: string[];
  mode?: 'all' | 'any';
  tolerance?: number;
  pick?: 'first' | 'last';
  schema?: Record<string, unknown>;
  choices?: string[];
  delimiter?: string;
  setMode?: 'exact' | 'subset' | 'superset';
  caseSensitive?: boolean;
  trimWhitespace?: boolean;
  stripPunctuation?: boolean;
}

export interface QualitySample {
  id: string;
  input: string;
  systemPrompt?: string;
  expected?: string;
  grader: GraderType;
  graderConfig?: GraderConfig;
  category?: string;
  meta?: Record<string, unknown>;
}

export interface QualityDatasetSummary {
  id: string;
  name: string;
  description: string;
  source: 'builtin' | 'import' | 'manual';
  sampleCount: number;
  tags: string[];
  /** Provenance / licence notice for bundled benchmarks. */
  note?: string;
  builtin: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface QualityDataset extends QualityDatasetSummary {
  samples: QualitySample[];
}

export type GraderStatus = 'pass' | 'fail' | 'error';

export interface GraderDescriptor {
  type: GraderType;
  /** i18n key under `quality.grader.`. */
  labelKey: string;
  requiresExpected: boolean;
  configFields: string[];
}

export interface QualitySampleResult {
  sampleId: string;
  index: number;
  category: string;
  grader: GraderType;
  status: GraderStatus;
  /** 1 / 0, or null when no verdict was reached. */
  score: number | null;
  /** i18n key under `quality.grade.`. */
  detailKey: string;
  params?: Record<string, string | number>;
  /** Raw English justification, used as the translation fallback. */
  detail: string;
  input: string;
  expected?: string;
  output: string;
  inputTokens: number;
  outputTokens: number;
  /** Reasoning tokens the provider reported, kept apart from the visible answer. */
  reasoningTokens: number;
  responseTime: number;
  estimatedCost: number;
  error?: string;
  errorCategory?: ErrorCategory;
  usageEstimated?: boolean;
}

export interface QualityCategoryBreakdown {
  category: string;
  sampleCount: number;
  passCount: number;
  failCount: number;
  errorCount: number;
  passRate: number | null;
}

export interface QualityTargetSummary {
  target: string;
  targetLabel: string;
  model: string;
  sampleCount: number;
  passCount: number;
  failCount: number;
  errorCount: number;
  /** null when every sample errored — never rendered as 0%. */
  passRate: number | null;
  avgScore: number | null;
  byCategory: QualityCategoryBreakdown[];
  avgResponseTime: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  errorBreakdown: Record<ErrorCategory, number>;
  usageEstimatedRatio: number;
  samples: QualitySampleResult[];
}

export interface QualityRunParams {
  temperature: number;
  topP?: number;
  seed?: number;
  maxTokens: number;
  concurrency: number;
  repeats: number;
}

export interface QualityRunProgress {
  completed: number;
  total: number;
  currentTarget?: string;
}

export type QualityRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface QualityRun {
  id: string;
  name: string;
  description?: string;
  status: QualityRunStatus;
  datasetId: string;
  datasetName: string;
  datasetSnapshot: QualitySample[];
  targets: string[];
  targetLabels: Record<string, string>;
  params: QualityRunParams;
  results: Record<string, QualityTargetSummary>;
  progress: QualityRunProgress;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface QualityRunListItem extends Omit<QualityRun, 'results' | 'datasetSnapshot'> {
  sampleCount: number;
  results: Record<string, Omit<QualityTargetSummary, 'samples'>>;
}

export interface QualityEstimateTarget {
  target: string;
  targetLabel: string;
  resolvable: boolean;
  inputTokensPerSample: number;
  typicalCost: number | null;
  upperBoundCost: number | null;
  pricingKnown: boolean;
}

export interface QualityEstimate {
  datasetId: string;
  datasetName: string;
  sampleCount: number;
  targetCount: number;
  totalRequests: number;
  perTarget: QualityEstimateTarget[];
  totalTypicalCost: number | null;
  totalUpperBoundCost: number | null;
  assumptions: string[];
}

export interface QualityImportIssue {
  row: number;
  level: 'error' | 'warning';
  message: string;
}

export interface QualityImportPreview {
  format: 'jsonl' | 'csv';
  totalRows: number;
  accepted: number;
  rejected: number;
  issues: QualityImportIssue[];
}

/** Live counters accumulated from the SSE stream during a health check. */
export interface QualityLiveTally {
  pass: number;
  fail: number;
  error: number;
}

/** What the page knows about the dataset currently being evaluated. */
export interface QualityActiveStep {
  index: number;
  total: number;
  datasetId: string;
  datasetName: string;
  completed: number;
  samples: number;
}
