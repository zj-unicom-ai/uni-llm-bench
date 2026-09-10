export const LEGACY_PROVIDER_IDS = ['openai', 'claude', 'gemini', 'zai'] as const;

export interface ImageInput {
  type: 'url' | 'base64';
  url?: string;
  mediaType?: string;
  data?: string;
}

export interface BenchmarkConfig {
  prompt: string;
  systemPrompt?: string;
  /** Model identifier for legacy providers. Dynamic providers take the model from `configId:model`. */
  model?: string;
  maxTokens: number;
  concurrency: number;
  iterations: number;
  streaming?: boolean;
  warmupRuns?: number;
  requestInterval?: number;
  randomizeInterval?: boolean;
  maxQps?: number;
  images?: ImageInput[];
  targetCacheHitRate?: number; // 0.0–1.0; injects UUID prefix per request to control prefix-cache hit rate
}

export interface CapabilityTest {
  type: 'vision' | 'function_calling' | 'json_mode' | 'streaming' | 'non_streaming';
  name: string;
  description: string;
  passed: boolean;
  details?: string;
  latencyMs?: number;
}

/**
 * Why a request failed. `empty_response` means the provider answered 200 but
 * returned no visible content — almost always a reasoning model that burned its
 * whole output budget thinking and never emitted an answer. It is a distinct
 * class of failure from an API error, and it is not a wrong answer.
 */
export type ErrorCategory = 'timeout' | 'rate_limit' | 'api_error' | 'network' | 'empty_response' | 'unknown';

export interface IterationResult {
  iteration: number;
  responseTime: number;
  /** Null for non-streaming requests — there is no first-token event to measure. */
  firstTokenLatency: number | null;
  tokensPerSecond: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  estimatedCost: number;
  success: boolean;
  error?: string;
  errorCategory?: ErrorCategory;
  /** Retries consumed before this result was produced. */
  retries?: number;
  /**
   * Wall-clock time from request start to final result, including retry backoff.
   * `responseTime` covers only the final attempt and therefore understates what
   * the caller actually waited — use this for tail-latency reporting.
   */
  e2eTime?: number;
}

export interface ProviderSummary {
  avgResponseTime: number;
  p50ResponseTime: number;
  p95ResponseTime: number;
  p99ResponseTime: number;
  /** Aggregate throughput: total output tokens / total response time. Not a mean of per-request ratios. */
  avgTokensPerSecond: number;
  /** Null when no sample carried a real TTFT measurement (e.g. non-streaming). */
  avgFirstTokenLatency: number | null;
  p50FirstTokenLatency: number | null;
  p95FirstTokenLatency: number | null;
  p99FirstTokenLatency: number | null;
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCost: number;
  successRate: number;
  errorCount: number;
  systemThroughput?: number;
  errorBreakdown?: Record<ErrorCategory, number>;
  totalTestDuration?: number;

  // ---- Measurement honesty diagnostics (optional for backwards compatibility) ----
  /** Number of iterations this summary was computed from. */
  sampleSize?: number;
  /** Population standard deviation of latency, in ms. */
  stdDevResponseTime?: number;
  /** Coefficient of variation (stdDev / mean). High values mean unstable results. */
  cvResponseTime?: number;
  /** Total retries across all iterations. */
  retryCount?: number;
  /** retryCount / sampleSize. Above ~0.05 means tail latency is likely optimistic. */
  retryRate?: number;
  /** How many samples carried a real TTFT measurement. */
  ttftSampleCount?: number;
  /** True when at least one request was retried. */
  hasRetries?: boolean;
}

export interface ProviderResult {
  provider: string;
  model: string;
  iterations: IterationResult[];
  summary: ProviderSummary;
}

/** `interrupted` means the process stopped mid-run (crash, restart, SIGTERM). */
export type BenchmarkStatus = 'pending' | 'running' | 'completed' | 'failed' | 'interrupted';

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

export interface StartBenchmarkRequest {
  providers: string[];
  config: BenchmarkConfig;
  apiKeys: Record<string, string>;
}

export interface SSEEvent {
  type: 'progress' | 'complete' | 'error' | 'done';
  data: unknown;
}

export interface LLMProvider {
  name: string;
  execute(
    prompt: string,
    systemPrompt: string | undefined,
    maxTokens: number,
    apiKey: string,
    streaming?: boolean,
    images?: ImageInput[],
  ): Promise<LLMResponse>;
}

export interface CompletionTokensDetails {
  reasoningTokens: number;
}

export interface LLMResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  responseTime: number;
  /** Null for non-streaming responses — never estimate this. */
  firstTokenLatency: number | null;
  estimatedCost: number;
  model: string;
  completionTokensDetails?: CompletionTokensDetails;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  /** True when the provider returned no usage block and token counts were inferred. */
  usageEstimated?: boolean;
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
  apiKeys?: Record<string, string>;
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
  /** Null when the run never produced a real TTFT measurement. */
  avgFirstTokenLatency: number | null;
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
  /** Null when no real TTFT was measured for this task. */
  avgFirstTokenLatency: number | null;
  avgTokensPerSecond: number;
  systemThroughput: number;
  inputThroughput: number;
  outputThroughput: number;
  totalThroughput: number;
  successRate: number;
  estimatedCost: number;
}

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

export interface ProviderConfig {
  id: string;
  name: string;
  endpoint: string;
  apiKey: string; // encrypted at rest
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
  models: ModelConfig[];
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

/* -------------------------------------------------------------------------- */
/* Model identity verification (fingerprinting)                                */
/* -------------------------------------------------------------------------- */

/** Which fingerprinting tier a probe belongs to. */
export type ProbeTier = 'T0' | 'T1';

/** Outcome of a single probe. `skipped` means "not comparable without a baseline". */
export type ProbeStatus = 'pass' | 'warn' | 'fail' | 'skipped' | 'error';

export interface IdentityProbeResult {
  /** Stable probe id, e.g. `tokenizer.zh` or `protocol.modelEcho`. */
  id: string;
  tier: ProbeTier;
  /** Logical grouping used by the UI. */
  group: 'protocol' | 'tokenizer';
  status: ProbeStatus;
  /** i18n key (under `identity.detail`) resolved by the frontend with `params`. */
  detailKey: string;
  /** Values interpolated into the localized detail template. */
  params?: Record<string, string | number>;
  baseline?: string | number | null;
  observed?: string | number | null;
}

/** Static description of a probe, served to the UI for the onboarding guide. */
export interface IdentityProbeDescriptor {
  id: string;
  tier: ProbeTier;
  group: 'protocol' | 'tokenizer';
  /** Approximate cost of running it; resolved via `identity.cost.<cost>` in the UI. */
  cost: 'free' | 'one-token' | 'two-requests';
  /** Whether a baseline is required to make this probe meaningful. */
  requiresBaseline: boolean;
}

/** A captured fingerprint used as the reference to compare against. */
export interface FingerprintBaseline {
  id: string;
  /** `configId:modelName`. */
  providerKey: string;
  providerName: string;
  modelName: string;
  /** probeId -> observed value (token counts for T1, strings for T0). */
  fingerprint: Record<string, string | number>;
  note?: string;
  capturedAt: string;
}

export type IdentityVerdict = 'consistent' | 'suspicious' | 'mismatch' | 'inconclusive' | 'error';

export interface IdentityRunSummary {
  pass: number;
  warn: number;
  fail: number;
  error: number;
  skipped: number;
}

export interface IdentityRun {
  id: string;
  /** `configId:modelName` of the endpoint under test. */
  target: string;
  targetLabel: string;
  /** Baseline used for comparison, if any. */
  baselineId?: string;
  baselineLabel?: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  probes: IdentityProbeResult[];
  verdict: IdentityVerdict;
  /** 0-100. Reported separately from the verdict on purpose. */
  score: number;
  /** Hard gate ids that fired; any one of them drives the verdict. */
  hardGates: string[];
  summary: IdentityRunSummary;
  createdAt: string;
  completedAt?: string;
  error?: string;
}

/* -------------------------------------------------------------------------- */
/* Model quality evaluation                                                    */
/* -------------------------------------------------------------------------- */

/**
 * L1 deterministic graders. Every one of them is pure local computation: no
 * network call, no external judge. A question that can be graded by a rule MUST
 * NOT be sent to a judge model — the judge is both an expense and a bias source.
 */
export type GraderType =
  | 'exact'
  | 'contains'
  | 'regex'
  | 'numeric_tolerance'
  | 'json_schema'
  | 'multiple_choice'
  | 'set_match';

/** Config fields a grader understands. All optional; each grader reads its own. */
export interface GraderConfig {
  /**
   * Whole-string equality / containment / regex: any of these also counts as
   * correct, in addition to `expected`.
   */
  accepted?: string[];
  /** `contains` and `regex` operate on these; falls back to `[expected]`. */
  patterns?: string[];
  /** `contains` / `regex`: `all` (default) requires every pattern, `any` requires one. */
  mode?: 'all' | 'any';
  /** `numeric_tolerance`: allowed absolute deviation. Default 0 (exact numeric match). */
  tolerance?: number;
  /** `numeric_tolerance`: which number to read out of the output. Default `first`. */
  pick?: 'first' | 'last';
  /** `json_schema`: a minimal JSON-schema subset (see services/graders/structured.ts). */
  schema?: Record<string, unknown>;
  /** `multiple_choice`: the option letters in play. Default ['A','B','C','D']. */
  choices?: string[];
  /** `set_match`: item delimiter. Default `,` and newline. */
  delimiter?: string;
  /** `set_match`: `exact` (default) requires equal sets, `subset` requires no extras. */
  setMode?: 'exact' | 'subset' | 'superset';
  /* ---- text comparison strictness, shared by exact / contains / regex ---- */
  /** Default false — comparison is case-insensitive. */
  caseSensitive?: boolean;
  /** Default true — collapse runs of whitespace and trim. */
  trimWhitespace?: boolean;
  /** Default false — drop punctuation before comparing. */
  stripPunctuation?: boolean;
}

/** One question in a dataset. */
export interface QualitySample {
  id: string;
  input: string;
  systemPrompt?: string;
  images?: ImageInput[];
  /** Reference answer. Required by every L1 grader except `json_schema`. */
  expected?: string;
  grader: GraderType;
  graderConfig?: GraderConfig;
  /** Free-form bucket used for the per-category breakdown. */
  category?: string;
  meta?: Record<string, unknown>;
}

export interface QualityDataset {
  id: string;
  name: string;
  description: string;
  source: 'builtin' | 'import' | 'manual';
  samples: QualitySample[];
  /** Denormalized so the list endpoint never has to parse `samples`. */
  sampleCount: number;
  tags: string[];
  /** Provenance / licence note. Shown verbatim in the UI. */
  note?: string;
  /** Built-in datasets are seeded on boot and cannot be edited or deleted. */
  builtin: boolean;
  createdAt: string;
  updatedAt: string;
}

/** List payload — samples stripped, count kept. */
export type QualityDatasetSummary = Omit<QualityDataset, 'samples'>;

/**
 * `pass` / `fail` are verdicts about the model. `error` means we could not
 * reach a verdict at all — it must never be folded into `fail`.
 */
export type GraderStatus = 'pass' | 'fail' | 'error';

export interface GradeResult {
  status: GraderStatus;
  /** 1 for pass, 0 for fail, null when no verdict was reached. */
  score: number | null;
  /** i18n key under `quality.grade.`, resolved by the frontend with `params`. */
  detailKey: string;
  /** Evidence interpolated into the localized detail template. */
  params?: Record<string, string | number>;
  /** Raw English rendering of the same information. Used by exports and logs. */
  detail: string;
}

/** Static description of a grader, served to the UI to render its config form. */
export interface GraderDescriptor {
  type: GraderType;
  /** i18n key under `quality.grader.`, resolved by the frontend. */
  labelKey: string;
  /** Whether the sample must carry `expected`. */
  requiresExpected: boolean;
  configFields: Array<
    | 'accepted'
    | 'patterns'
    | 'mode'
    | 'tolerance'
    | 'pick'
    | 'schema'
    | 'choices'
    | 'delimiter'
    | 'setMode'
    | 'caseSensitive'
    | 'trimWhitespace'
    | 'stripPunctuation'
  >;
}

export interface QualitySampleResult {
  sampleId: string;
  index: number;
  category: string;
  grader: GraderType;
  status: GraderStatus;
  score: number | null;
  /** i18n key under `quality.grade.`, resolved by the frontend. */
  detailKey: string;
  params?: Record<string, string | number>;
  /** Raw English rendering — survives translation changes and CSV export. */
  detail: string;
  input: string;
  expected?: string;
  output: string;
  inputTokens: number;
  outputTokens: number;
  /**
   * Reasoning tokens the provider reported. Kept separate from `outputTokens`
   * diagnostics because a reasoning model can spend its entire budget here and
   * return an empty answer — the report needs to be able to say so.
   */
  reasoningTokens: number;
  responseTime: number;
  estimatedCost: number;
  /** Set only when status is `error`. */
  error?: string;
  errorCategory?: ErrorCategory;
  /** True when the provider returned no usage block and tokens were inferred. */
  usageEstimated?: boolean;
}

export interface QualityCategoryBreakdown {
  category: string;
  sampleCount: number;
  passCount: number;
  failCount: number;
  errorCount: number;
  /** null when no sample in this category produced a verdict. */
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
  /**
   * passCount / (sampleCount - errorCount). Null when every sample errored —
   * reporting 0% there would claim the model answered every question wrong.
   */
  passRate: number | null;
  /** Mean of the per-sample scores that actually exist. Null if none do. */
  avgScore: number | null;
  byCategory: QualityCategoryBreakdown[];
  avgResponseTime: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  errorBreakdown: Record<ErrorCategory, number>;
  /** Fraction of samples whose token counts were inferred rather than reported. */
  usageEstimatedRatio: number;
  samples: QualitySampleResult[];
}

export interface QualityRunParams {
  /** Pinned for reproducibility. Default 0. */
  temperature: number;
  topP?: number;
  seed?: number;
  maxTokens: number;
  concurrency: number;
  /**
   * Repeat each sample this many times to expose instability. Frozen at 1 for
   * the objective-grading milestone; the field exists so runs stay comparable
   * once repeats land.
   */
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
  /**
   * Frozen copy of the samples as they were at run time. Editing the dataset
   * afterwards must not silently rewrite a historical report.
   */
  datasetSnapshot: QualitySample[];
  /** `configId:modelName` list. */
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

/**
 * History-list payload: per-target summaries without the per-sample rows, and
 * without the frozen dataset. A 500-question run would otherwise ship megabytes
 * of drill-down data the list view never renders.
 */
export interface QualityRunListItem extends Omit<QualityRun, 'results' | 'datasetSnapshot'> {
  sampleCount: number;
  results: Record<string, Omit<QualityTargetSummary, 'samples'>>;
}
