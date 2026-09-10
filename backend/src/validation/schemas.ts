import { z, ZodSchema } from 'zod';

// --- Shared naming rules ---
// Model ID: alphanumeric, dash, underscore, dot, slash (for LiteLLM vendor/model), 1-64 chars
const modelIdRegex = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,63}$/;
const modelIdRule = z.string().regex(modelIdRegex, 'Model ID: 1-64 chars, alphanumeric/dash/underscore/dot/slash');

// Provider name: alphanumeric, dash, underscore, NO spaces, 1-64 chars
const providerNameRegex = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const providerNameRule = z
  .string()
  .regex(providerNameRegex, 'Provider name: 1-64 chars, alphanumeric/dash/underscore, no spaces');

// Display name: alphanumeric, space, dash, underscore, dot, 1-64 chars
const displayNameRegex = /^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,63}$/;
const displayNameRule = z
  .string()
  .regex(displayNameRegex, 'Display name: 1-64 chars, alphanumeric/space/dash/underscore/dot');

// Auth schemas
export const LoginSchema = z.object({
  username: z.string().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
});

export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(6, 'New password must be at least 6 characters'),
});

// Benchmark schemas
export const StartBenchmarkSchema = z.object({
  providers: z.array(z.string().min(1)).min(1, 'At least one provider is required'),
  config: z.object({
    prompt: z.string().min(1, 'Prompt is required'),
    systemPrompt: z.string().optional(),
    maxTokens: z.number().int().min(1).max(1000000),
    concurrency: z.number().int().min(1).max(5000),
    iterations: z.number().int().min(1).max(10000000),
    streaming: z.boolean().optional(),
    warmupRuns: z.number().int().min(0).max(5).optional(),
    requestInterval: z.number().int().min(0).optional(),
    randomizeInterval: z.boolean().optional(),
    maxQps: z.number().min(0).max(1000).optional(),
    targetCacheHitRate: z.number().min(0).max(1).optional(),
    images: z
      .array(
        z.object({
          type: z.enum(['url', 'base64']),
          url: z.string().optional(),
          mediaType: z.string().optional(),
          data: z.string().optional(),
        }),
      )
      .optional(),
  }),
  apiKeys: z.record(z.string(), z.string()).optional().default({}),
});

// Provider schemas
const ModelConfigSchema = z.object({
  id: z.string().min(1).optional(),
  name: modelIdRule,
  displayName: displayNameRule.optional(),
  contextSize: z.number().int().min(1),
  supportsVision: z.boolean(),
  supportsTools: z.boolean(),
  supportsStreaming: z.boolean().optional(),
  isActive: z.boolean().optional(),
  inputPrice: z.number().min(0).optional(),
  outputPrice: z.number().min(0).optional(),
  cacheReadPrice: z.number().min(0).optional(),
  cacheWritePrice: z.number().min(0).optional(),
});

export const ProviderConfigInputSchema = z.object({
  name: providerNameRule,
  endpoint: z.string().min(1, 'Endpoint URL is required'),
  apiKey: z.string().min(1, 'API key is required'),
  format: z.enum(['openai', 'anthropic', 'gemini', 'custom']),
  models: z.array(ModelConfigSchema).min(1, 'At least one model is required'),
});

// Partial schema for updates — all fields optional except models (when provided must be non-empty)
export const ProviderConfigUpdateSchema = z.object({
  name: providerNameRule.optional(),
  endpoint: z.string().min(1, 'Endpoint URL is required').optional(),
  apiKey: z.string().min(1, 'API key is required').optional(),
  format: z.enum(['openai', 'anthropic', 'gemini', 'custom']).optional(),
  models: z.array(ModelConfigSchema).min(1, 'At least one model is required').optional(),
});

export const TestConnectionSchema = z.object({
  endpoint: z.string().min(1, 'Endpoint URL is required'),
  apiKey: z.string().min(1, 'API key is required'),
  format: z.enum(['openai', 'anthropic', 'gemini', 'custom']),
  modelName: modelIdRule,
});

// Workflow schemas
const WorkflowTaskSchema = z.object({
  name: z.string().min(1, 'Task name is required'),
  description: z.string().optional(),
  config: z.object({
    prompt: z.string().min(1, 'Prompt is required'),
    systemPrompt: z.string().optional(),
    maxTokens: z.number().int().min(1),
    concurrency: z.number().int().min(1).max(5000),
    iterations: z.number().int().min(1).max(10000000),
    streaming: z.boolean().optional(),
    warmupRuns: z.number().int().min(0).optional(),
    requestInterval: z.number().int().min(0).optional(),
    randomizeInterval: z.boolean().optional(),
    maxQps: z.number().min(0).max(1000).optional(),
    targetCacheHitRate: z.number().min(0).max(1).optional(),
  }),
  providers: z.array(z.string()).optional(),
  tags: z.record(z.string(), z.string()).optional(),
});

export const CreateWorkflowSchema = z.object({
  name: z.string().min(1, 'Workflow name is required'),
  description: z.string().optional(),
  providers: z.array(z.string().min(1)).min(1, 'At least one provider is required'),
  apiKeys: z.record(z.string(), z.string()).optional().default({}),
  tasks: z.array(WorkflowTaskSchema).min(1, 'At least one task is required'),
  options: z
    .object({
      stopOnFailure: z.boolean().optional(),
      cooldownBetweenTasks: z.number().int().min(0).optional(),
    })
    .optional(),
});

// Workflow template schemas (module library)
export const WorkflowTemplateSchema = z.object({
  name: z.string().min(1, 'Template name is required').max(80, 'Template name is too long'),
  description: z.string().max(500, 'Description is too long').optional(),
  tasks: z.array(WorkflowTaskSchema).min(1, 'At least one task is required'),
  options: z
    .object({
      stopOnFailure: z.boolean().optional(),
      cooldownBetweenTasks: z.number().int().min(0).optional(),
    })
    .optional(),
});

export const UpdateWorkflowTemplateSchema = WorkflowTemplateSchema.partial();

// Playground schemas
export const PlaygroundRunSchema = z.object({
  providerId: z.string().min(1, 'Provider ID is required'),
  modelName: modelIdRule,
  prompt: z.string().min(1, 'Prompt is required'),
  systemPrompt: z.string().optional(),
  maxTokens: z.number().int().min(1).max(1000000),
  enableThinking: z.boolean().optional(),
  images: z
    .array(
      z.object({
        type: z.enum(['url', 'base64']),
        url: z.string().optional(),
        mediaType: z.string().optional(),
        data: z.string().optional(),
      }),
    )
    .optional(),
});

export const PlaygroundStreamSchema = PlaygroundRunSchema.extend({
  useStreaming: z.boolean().optional().default(true),
});

// Model identity verification schemas
export const IdentityBaselineSchema = z.object({
  providerKey: z.string().min(1, 'Provider key is required'),
  note: z.string().max(500).optional(),
});

export const IdentityVerifySchema = z.object({
  target: z.string().min(1, 'Target provider key is required'),
  baselineId: z.string().min(1).optional(),
});

// ---------------------------------------------------------------------------
// Quality evaluation
// ---------------------------------------------------------------------------

const GraderTypeSchema = z.enum([
  'exact',
  'contains',
  'regex',
  'numeric_tolerance',
  'json_schema',
  'multiple_choice',
  'set_match',
]);

const GraderConfigSchema = z.object({
  accepted: z.array(z.string()).optional(),
  patterns: z.array(z.string()).optional(),
  mode: z.enum(['all', 'any']).optional(),
  tolerance: z.number().min(0).optional(),
  pick: z.enum(['first', 'last']).optional(),
  schema: z.record(z.string(), z.unknown()).optional(),
  choices: z.array(z.string()).optional(),
  delimiter: z.string().max(40).optional(),
  setMode: z.enum(['exact', 'subset', 'superset']).optional(),
  caseSensitive: z.boolean().optional(),
  trimWhitespace: z.boolean().optional(),
  stripPunctuation: z.boolean().optional(),
});

const ImageInputSchema = z.object({
  type: z.enum(['url', 'base64']),
  url: z.string().optional(),
  mediaType: z.string().optional(),
  data: z.string().optional(),
});

const QualitySampleSchema = z.object({
  id: z.string().max(120).optional(),
  input: z.string().min(1, 'Sample input is required').max(20000),
  systemPrompt: z.string().max(20000).optional(),
  expected: z.string().max(20000).optional(),
  grader: GraderTypeSchema,
  graderConfig: GraderConfigSchema.optional(),
  category: z.string().max(120).optional(),
  images: z.array(ImageInputSchema).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export const CreateQualityDatasetSchema = z.object({
  name: z.string().min(1, 'Dataset name is required').max(120, 'Dataset name is too long'),
  description: z.string().max(500, 'Description is too long').optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  note: z.string().max(4000).optional(),
  samples: z.array(QualitySampleSchema).min(1, 'At least one sample is required').max(2000),
});

export const UpdateQualityDatasetSchema = CreateQualityDatasetSchema.partial();

export const ImportQualityDatasetSchema = z.object({
  name: z.string().min(1, 'Dataset name is required').max(120),
  description: z.string().max(500).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  text: z.string().min(1, 'Nothing to import').max(8_000_000),
  format: z.enum(['jsonl', 'csv']).optional(),
  /** false = dry run: return the validation report without persisting. */
  persist: z.boolean().optional(),
});

const QualityRunParamsSchema = z.object({
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  seed: z.number().int().optional(),
  maxTokens: z.number().int().min(16).max(32000).optional(),
  concurrency: z.number().int().min(1).max(16).optional(),
});

export const StartQualityRunSchema = z.object({
  name: z.string().min(1, 'Run name is required').max(120),
  description: z.string().max(500).optional(),
  datasetId: z.string().min(1, 'Dataset is required'),
  targets: z.array(z.string().min(1)).min(1, 'At least one target model is required').max(20),
  params: QualityRunParamsSchema.optional(),
});

export const EstimateQualityRunSchema = z.object({
  datasetId: z.string().min(1, 'Dataset is required'),
  targets: z.array(z.string().min(1)).min(1).max(20),
  params: QualityRunParamsSchema.optional(),
});

// Export schema type for middleware
export type ValidationSchema = ZodSchema;
