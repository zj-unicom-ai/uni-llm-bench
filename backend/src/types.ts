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

export type ErrorCategory = 'timeout' | 'rate_limit' | 'api_error' | 'network' | 'unknown';

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
