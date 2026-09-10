import { randomUUID } from 'crypto';
import { LLMResponse, ProviderConfig, ProviderFormat, ImageInput } from '../types';
import { BaseLLMProvider } from './base';
import { providerStore } from '../services/providerStore';
import { decrypt } from '../utils/encryption';
import { estimateCost } from '../utils/modelPricing';

/** Generation / sampling parameters exposed by the Playground UI. All optional. */
export interface GenerationParams {
  temperature?: number;
  topP?: number;
  topK?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stop?: string[];
  seed?: number;
  responseFormat?: 'text' | 'json_object';
}

/** Map GenerationParams to OpenAI-style request fields. */
export function openAIGenerationFields(gp: GenerationParams): Record<string, unknown> {
  const f: Record<string, unknown> = {};
  if (gp.temperature !== undefined) f.temperature = gp.temperature;
  if (gp.topP !== undefined) f.top_p = gp.topP;
  if (gp.topK !== undefined) f.top_k = gp.topK;
  if (gp.frequencyPenalty !== undefined) f.frequency_penalty = gp.frequencyPenalty;
  if (gp.presencePenalty !== undefined) f.presence_penalty = gp.presencePenalty;
  if (gp.stop && gp.stop.length > 0) f.stop = gp.stop;
  if (gp.seed !== undefined) f.seed = gp.seed;
  if (gp.responseFormat === 'json_object') f.response_format = { type: 'json_object' };
  return f;
}

/** Anthropic supports temperature / top_p / top_k / stop_sequences (no frequency/presence penalty). */
export function anthropicGenerationFields(gp: GenerationParams): Record<string, unknown> {
  const f: Record<string, unknown> = {};
  if (gp.temperature !== undefined) f.temperature = gp.temperature;
  if (gp.topP !== undefined) f.top_p = gp.topP;
  if (gp.topK !== undefined) f.top_k = gp.topK;
  if (gp.stop && gp.stop.length > 0) f.stop_sequences = gp.stop;
  return f;
}

/** Gemini generationConfig supports temperature / topP / topK / stopSequences / seed / frequency & presence penalty. */
export function geminiGenerationFields(gp: GenerationParams, maxTokens: number): Record<string, unknown> {
  const f: Record<string, unknown> = { maxOutputTokens: maxTokens };
  if (gp.temperature !== undefined) f.temperature = gp.temperature;
  if (gp.topP !== undefined) f.topP = gp.topP;
  if (gp.topK !== undefined) f.topK = gp.topK;
  if (gp.frequencyPenalty !== undefined) f.frequencyPenalty = gp.frequencyPenalty;
  if (gp.presencePenalty !== undefined) f.presencePenalty = gp.presencePenalty;
  if (gp.stop && gp.stop.length > 0) f.stopSequences = gp.stop;
  if (gp.seed !== undefined) f.seed = gp.seed;
  return f;
}

// Session ID: generated once per process lifetime, shared across all Anthropic requests
const anthropicSessionId = randomUUID();

function buildAnthropicHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'x-app': 'cli',
    'User-Agent': 'uni-llm-bench',
    'X-Claude-Code-Session-Id': anthropicSessionId,
    'x-client-request-id': randomUUID(),
  };
}

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

function buildOpenAIContent(prompt: string, images?: ImageInput[]): string | ContentPart[] {
  if (!images || images.length === 0) return prompt;
  const parts: ContentPart[] = [{ type: 'text', text: prompt }];
  for (const img of images) {
    if (img.type === 'url' && img.url) {
      parts.push({ type: 'image_url', image_url: { url: img.url } });
    } else if (img.type === 'base64' && img.data && img.mediaType) {
      parts.push({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.data}` } });
    }
  }
  return parts;
}

function buildAnthropicContent(prompt: string, images?: ImageInput[]): string | ContentPart[] {
  if (!images || images.length === 0) return prompt;
  const parts: ContentPart[] = [];
  for (const img of images) {
    if (img.type === 'base64' && img.data && img.mediaType) {
      parts.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
    }
    // URL images not supported for Anthropic format — skip
  }
  parts.push({ type: 'text', text: prompt });
  return parts;
}

function buildGeminiParts(prompt: string, images?: ImageInput[]): any[] {
  const parts: any[] = [];
  for (const img of images || []) {
    if (img.type === 'base64' && img.data && img.mediaType) {
      parts.push({ inline_data: { mime_type: img.mediaType, data: img.data } });
    }
  }
  parts.push({ text: prompt });
  return parts;
}

export class DynamicProvider extends BaseLLMProvider {
  name: string;
  private config: ProviderConfig;
  private modelName: string;
  private plainApiKey?: string; // for test mode (skip decryption)
  private requestTimeoutMs?: number; // optional override for fetch timeouts (used by health checks)

  constructor(config: ProviderConfig, modelName: string, plainApiKey?: string, requestTimeoutMs?: number) {
    super();
    this.config = config;
    this.modelName = modelName;
    this.name = `${config.name}/${modelName}`;
    this.plainApiKey = plainApiKey;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  /** Pick the timeout to use, falling back to the per-method default for normal requests. */
  private pickTimeout(defaultMs: number): number {
    return this.requestTimeoutMs ?? defaultMs;
  }

  async execute(
    prompt: string,
    systemPrompt: string | undefined,
    maxTokens: number,
    _apiKey: string,
    streaming?: boolean,
    images?: ImageInput[],
    genParams?: GenerationParams,
  ): Promise<LLMResponse> {
    const apiKey = this.plainApiKey || decrypt(this.config.apiKey);

    switch (this.config.format) {
      case 'openai':
        return streaming
          ? this.callOpenAIStreaming(prompt, systemPrompt, maxTokens, apiKey, images, genParams)
          : this.callOpenAI(prompt, systemPrompt, maxTokens, apiKey, images, genParams);
      case 'anthropic':
        return streaming
          ? this.callAnthropicStreaming(prompt, systemPrompt, maxTokens, apiKey, images, genParams)
          : this.callAnthropic(prompt, systemPrompt, maxTokens, apiKey, images, genParams);
      case 'gemini':
        return streaming
          ? this.callGeminiStreaming(prompt, systemPrompt, maxTokens, apiKey, images, genParams)
          : this.callGemini(prompt, systemPrompt, maxTokens, apiKey, images, genParams);
      case 'custom':
        // Custom format defaults to OpenAI-compatible
        return streaming
          ? this.callOpenAIStreaming(prompt, systemPrompt, maxTokens, apiKey, images, genParams)
          : this.callOpenAI(prompt, systemPrompt, maxTokens, apiKey, images, genParams);
      default:
        throw new Error(`Unsupported format: ${this.config.format}`);
    }
  }

  // ---- OpenAI Compatible ----

  private async callOpenAI(
    prompt: string,
    systemPrompt: string | undefined,
    maxTokens: number,
    apiKey: string,
    images?: ImageInput[],
    genParams?: GenerationParams,
  ): Promise<LLMResponse> {
    const startTime = Date.now();
    const messages: Array<{ role: string; content: string | ContentPart[] }> = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: buildOpenAIContent(prompt, images) });

    const response = await this.fetchWithTimeout(
      `${this.config.endpoint}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: this.modelName,
          messages,
          max_tokens: maxTokens,
          ...openAIGenerationFields(genParams ?? {}),
        }),
      },
      this.pickTimeout(120000),
    );

    if (!response.ok) {
      throw await this.httpError(response, 'Provider');
    }

    const data = (await response.json()) as Record<string, any>;
    const responseTime = Date.now() - startTime;
    const inputTokens = data.usage?.prompt_tokens || 0;
    const completionTokens = data.usage?.completion_tokens || 0;
    const reasoningTokens = data.usage?.completion_tokens_details?.reasoning_tokens || 0;
    const cacheReadTokens = data.usage?.prompt_tokens_details?.cached_tokens || 0;

    return {
      text: data.choices?.[0]?.message?.content || '',
      inputTokens,
      outputTokens: completionTokens,
      reasoningTokens,
      totalTokens: inputTokens + completionTokens,
      responseTime,
      firstTokenLatency: null, // Non-streaming: no first-token event exists
      estimatedCost: estimateCost(this.modelName, { inputTokens, outputTokens: completionTokens }).cost,
      model: this.modelName,
      ...(cacheReadTokens > 0 && { cacheReadTokens }),
    };
  }

  private async callOpenAIStreaming(
    prompt: string,
    systemPrompt: string | undefined,
    maxTokens: number,
    apiKey: string,
    images?: ImageInput[],
    genParams?: GenerationParams,
  ): Promise<LLMResponse> {
    const startTime = Date.now();
    const messages: Array<{ role: string; content: string | ContentPart[] }> = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: buildOpenAIContent(prompt, images) });

    const response = await this.fetchWithTimeout(
      `${this.config.endpoint}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: this.modelName,
          messages,
          max_tokens: maxTokens,
          stream: true,
          stream_options: { include_usage: true },
          ...openAIGenerationFields(genParams ?? {}),
        }),
      },
      this.pickTimeout(180000),
    );

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body for streaming');

    const decoder = new TextDecoder();
    let firstTokenTime: number | null = null;
    let buffer = '';
    let usageData: any = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          if (firstTokenTime === null) {
            const delta = parsed.choices?.[0]?.delta;
            if (delta?.content || delta?.reasoning_content) {
              firstTokenTime = Date.now();
            }
          }
          if (parsed.usage) usageData = parsed.usage;
        } catch {
          /* skip */
        }
      }
    }

    const responseTime = Date.now() - startTime;
    const firstTokenLatency = firstTokenTime ? firstTokenTime - startTime : 0;
    const inputTokens = usageData?.prompt_tokens || 0;
    const completionTokens = usageData?.completion_tokens || 0;
    const reasoningTokens = usageData?.completion_tokens_details?.reasoning_tokens || 0;
    const cacheReadTokens = usageData?.prompt_tokens_details?.cached_tokens || 0;

    return {
      text: '',
      inputTokens,
      outputTokens: completionTokens,
      reasoningTokens,
      totalTokens: inputTokens + completionTokens,
      responseTime,
      firstTokenLatency,
      estimatedCost: estimateCost(this.modelName, { inputTokens, outputTokens: completionTokens }).cost,
      ...(cacheReadTokens > 0 && { cacheReadTokens }),
      model: this.modelName,
    };
  }

  // ---- Anthropic Compatible ----

  private async callAnthropic(
    prompt: string,
    systemPrompt: string | undefined,
    maxTokens: number,
    apiKey: string,
    images?: ImageInput[],
    genParams?: GenerationParams,
  ): Promise<LLMResponse> {
    const startTime = Date.now();

    const body: Record<string, any> = {
      model: this.modelName,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: buildAnthropicContent(prompt, images) }],
      ...anthropicGenerationFields(genParams ?? {}),
    };
    if (systemPrompt) body.system = systemPrompt;

    const response = await this.fetchWithTimeout(
      `${this.config.endpoint}/messages`,
      {
        method: 'POST',
        headers: buildAnthropicHeaders(apiKey),
        body: JSON.stringify(body),
      },
      this.pickTimeout(120000),
    );

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Anthropic API error ${response.status}: ${errText.slice(0, 200)}`);
    }

    const data = (await response.json()) as Record<string, any>;
    const responseTime = Date.now() - startTime;
    const inputTokens = data.usage?.input_tokens || 0;
    const outputTokens = data.usage?.output_tokens || 0;
    const cacheCreationTokens = data.usage?.cache_creation_input_tokens || 0;
    const cacheReadTokens = data.usage?.cache_read_input_tokens || 0;

    return {
      text: data.content?.[0]?.text || '',
      inputTokens,
      outputTokens,
      reasoningTokens: 0,
      totalTokens: inputTokens + outputTokens,
      responseTime,
      firstTokenLatency: null, // Non-streaming: no first-token event exists
      estimatedCost: estimateCost(this.modelName, { inputTokens, outputTokens }).cost,
      model: this.modelName,
      ...(cacheCreationTokens > 0 && { cacheCreationTokens }),
      ...(cacheReadTokens > 0 && { cacheReadTokens }),
    };
  }

  private async callAnthropicStreaming(
    prompt: string,
    systemPrompt: string | undefined,
    maxTokens: number,
    apiKey: string,
    images?: ImageInput[],
    genParams?: GenerationParams,
  ): Promise<LLMResponse> {
    const startTime = Date.now();

    const body: Record<string, any> = {
      model: this.modelName,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: buildAnthropicContent(prompt, images) }],
      stream: true,
      ...anthropicGenerationFields(genParams ?? {}),
    };
    if (systemPrompt) body.system = systemPrompt;

    const response = await this.fetchWithTimeout(
      `${this.config.endpoint}/messages`,
      {
        method: 'POST',
        headers: buildAnthropicHeaders(apiKey),
        body: JSON.stringify(body),
      },
      this.pickTimeout(180000),
    );

    if (!response.ok) throw new Error(`Anthropic API error: ${response.status}`);

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let firstTokenTime: number | null = null;
    let buffer = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheCreationTokens = 0;
    let cacheReadTokens = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        try {
          const parsed = JSON.parse(trimmed.slice(6));
          if (parsed.type === 'content_block_delta' && firstTokenTime === null) {
            firstTokenTime = Date.now();
          }
          if (parsed.type === 'message_start') {
            inputTokens = parsed.message?.usage?.input_tokens || 0;
            cacheCreationTokens = parsed.message?.usage?.cache_creation_input_tokens || 0;
            cacheReadTokens = parsed.message?.usage?.cache_read_input_tokens || 0;
          }
          if (parsed.type === 'message_delta') {
            outputTokens = parsed.usage?.output_tokens || outputTokens;
            // Some proxies (e.g. LiteLLM) return input_tokens in message_delta instead of message_start
            if (parsed.usage?.input_tokens) {
              inputTokens = parsed.usage.input_tokens;
            }
          }
        } catch {
          /* skip */
        }
      }
    }

    const responseTime = Date.now() - startTime;

    return {
      text: '',
      inputTokens,
      outputTokens,
      reasoningTokens: 0,
      totalTokens: inputTokens + outputTokens,
      responseTime,
      firstTokenLatency: firstTokenTime ? firstTokenTime - startTime : null,
      estimatedCost: estimateCost(this.modelName, { inputTokens, outputTokens }).cost,
      model: this.modelName,
      ...(cacheCreationTokens > 0 && { cacheCreationTokens }),
      ...(cacheReadTokens > 0 && { cacheReadTokens }),
    };
  }

  // ---- Gemini Compatible ----

  private async callGemini(
    prompt: string,
    systemPrompt: string | undefined,
    maxTokens: number,
    apiKey: string,
    images?: ImageInput[],
    genParams?: GenerationParams,
  ): Promise<LLMResponse> {
    const startTime = Date.now();

    const contents: any[] = [];
    if (systemPrompt) {
      contents.push({ role: 'user', parts: [{ text: systemPrompt }] });
      contents.push({ role: 'model', parts: [{ text: 'Understood.' }] });
    }
    contents.push({ role: 'user', parts: buildGeminiParts(prompt, images) });

    // API key travels in a header — putting it in the query string leaks it
    // into proxy logs, browser history, and Referer headers.
    const url = `${this.config.endpoint}/models/${this.modelName}:generateContent`;

    const response = await this.fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents,
          generationConfig: geminiGenerationFields(genParams ?? {}, maxTokens),
        }),
      },
      this.pickTimeout(120000),
    );

    if (!response.ok) {
      throw await this.httpError(response, 'Gemini');
    }

    const data = (await response.json()) as Record<string, any>;
    const responseTime = Date.now() - startTime;

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const inputTokens = data.usageMetadata?.promptTokenCount || Math.ceil(prompt.length / 4);
    const outputTokens = data.usageMetadata?.candidatesTokenCount || Math.ceil(text.length / 4);

    return {
      text,
      inputTokens,
      outputTokens,
      reasoningTokens: 0,
      totalTokens: inputTokens + outputTokens,
      responseTime,
      firstTokenLatency: null, // Non-streaming: no first-token event exists
      estimatedCost: estimateCost(this.modelName, { inputTokens, outputTokens }).cost,
      model: this.modelName,
    };
  }

  private async callGeminiStreaming(
    prompt: string,
    systemPrompt: string | undefined,
    maxTokens: number,
    apiKey: string,
    images?: ImageInput[],
    genParams?: GenerationParams,
  ): Promise<LLMResponse> {
    const startTime = Date.now();

    const contents: any[] = [];
    if (systemPrompt) {
      contents.push({ role: 'user', parts: [{ text: systemPrompt }] });
      contents.push({ role: 'model', parts: [{ text: 'Understood.' }] });
    }
    contents.push({ role: 'user', parts: buildGeminiParts(prompt, images) });

    const url = `${this.config.endpoint}/models/${this.modelName}:streamGenerateContent?alt=sse`;

    const response = await this.fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents,
          generationConfig: geminiGenerationFields(genParams ?? {}, maxTokens),
        }),
      },
      this.pickTimeout(180000),
    );

    if (!response.ok) {
      throw await this.httpError(response, 'Gemini');
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body for streaming');

    const decoder = new TextDecoder();
    let firstTokenTime: number | null = null;
    let buffer = '';
    let inputTokens = 0;
    let outputTokens = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        try {
          const parsed = JSON.parse(trimmed.slice(6));
          // Detect first content token
          if (firstTokenTime === null) {
            const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) {
              firstTokenTime = Date.now();
            }
          }
          // Capture usage metadata from the final chunk
          if (parsed.usageMetadata) {
            inputTokens = parsed.usageMetadata.promptTokenCount || inputTokens;
            outputTokens = parsed.usageMetadata.candidatesTokenCount || outputTokens;
          }
        } catch {
          /* skip */
        }
      }
    }

    const responseTime = Date.now() - startTime;
    if (!inputTokens) inputTokens = Math.ceil(prompt.length / 4);

    return {
      text: '',
      inputTokens,
      outputTokens,
      reasoningTokens: 0,
      totalTokens: inputTokens + outputTokens,
      responseTime,
      firstTokenLatency: firstTokenTime ? firstTokenTime - startTime : null,
      estimatedCost: estimateCost(this.modelName, { inputTokens, outputTokens }).cost,
      model: this.modelName,
    };
  }
}

// Factory: create a DynamicProvider from a stored provider config + model name
export function createDynamicProvider(providerId: string, modelName: string): DynamicProvider | null {
  const config = providerStore.get(providerId);
  if (!config) return null;

  const model = config.models.find((m) => m.name === modelName || m.id === modelName);
  if (!model) return null;

  // Skip inactive models
  if (model.isActive === false) return null;

  return new DynamicProvider(config, model.name);
}

/** Default timeout for connectivity / health-check probes. Shorter than playground/benchmark
 *  defaults (180 s streaming) because health checks should fail fast — a model that hasn't
 *  responded in 90 s is effectively down for users anyway. Override per call via `timeoutMs`. */
export const PROBE_TIMEOUT_MS = 90_000;

// Test connectivity for a provider config (used by the provider test-connection endpoint)
export async function testProviderConnection(config: {
  endpoint: string;
  apiKey: string;
  format: ProviderFormat;
  modelName: string;
  timeoutMs?: number;
}): Promise<{
  success: boolean;
  latencyMs: number;
  ttftMs: number;
  outputTokens: number;
  responseText: string;
  error?: string;
}> {
  const startTime = Date.now();
  const timeoutMs = config.timeoutMs ?? PROBE_TIMEOUT_MS;

  try {
    const tempConfig: ProviderConfig = {
      id: 'test',
      name: 'test',
      endpoint: config.endpoint,
      apiKey: config.apiKey, // already plaintext for testing
      format: config.format,
      models: [
        {
          id: 'test',
          name: config.modelName,
          contextSize: 4096,
          supportsVision: false,
          supportsTools: false,
          supportsStreaming: true,
          isActive: true,
        },
      ],
      createdAt: '',
      updatedAt: '',
    };

    const provider = new DynamicProvider(tempConfig, config.modelName, config.apiKey, timeoutMs);
    const result = await provider.execute(
      'Write a 200-word introduction to artificial intelligence covering its history, current applications, and future potential.',
      undefined,
      1024,
      '',
      true,
    );

    const latencyMs = result.responseTime;
    const outputTokens = result.outputTokens || 0;
    const responseText = result.text || '';

    // Validate response content
    if (outputTokens === 0 && responseText.trim() === '') {
      return {
        success: false,
        latencyMs,
        ttftMs: result.firstTokenLatency || 0,
        outputTokens,
        responseText,
        error: 'Empty response (0 output tokens)',
      };
    }

    return {
      success: true,
      latencyMs,
      ttftMs: result.firstTokenLatency || 0,
      outputTokens,
      responseText,
    };
  } catch (err: any) {
    return {
      success: false,
      latencyMs: Date.now() - startTime,
      ttftMs: 0,
      outputTokens: 0,
      responseText: '',
      error: err.message || 'Connection failed',
    };
  }
}
