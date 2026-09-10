import { LLMResponse } from '../types';
import { BaseLLMProvider } from './base';
import { estimateCost } from '../utils/modelPricing';

export const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';

/**
 * Current default. The previous default (`claude-3-sonnet-20240229`) has been
 * retired by Anthropic and now fails for every request.
 */
export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-20250514';

function buildClaudeHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'User-Agent': 'uni-llm-bench',
  };
}

export class ClaudeProvider extends BaseLLMProvider {
  name = 'claude';
  private readonly model: string;

  constructor(model: string = DEFAULT_CLAUDE_MODEL) {
    super();
    this.model = model;
  }

  async execute(
    prompt: string,
    systemPrompt: string | undefined,
    maxTokens: number,
    apiKey: string,
    streaming?: boolean,
    _images?: any[],
  ): Promise<LLMResponse> {
    if (!apiKey || apiKey.length < 10) {
      throw new Error('Anthropic API key is missing or malformed');
    }

    if (streaming) {
      return this.callStreamingAPI(prompt, systemPrompt, maxTokens, apiKey);
    }
    return this.callRealAPI(prompt, systemPrompt, maxTokens, apiKey);
  }

  private async callStreamingAPI(
    prompt: string,
    systemPrompt: string | undefined,
    maxTokens: number,
    apiKey: string,
  ): Promise<LLMResponse> {
    const startTime = Date.now();

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
    };

    if (systemPrompt) {
      body.system = systemPrompt;
    }

    const response = await this.fetchWithTimeout(
      ANTHROPIC_ENDPOINT,
      {
        method: 'POST',
        headers: buildClaudeHeaders(apiKey),
        body: JSON.stringify(body),
      },
      180000,
    );

    if (!response.ok) {
      throw await this.httpError(response, 'Anthropic');
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body for streaming');
    }

    const decoder = new TextDecoder();
    let firstTokenTime: number | null = null;
    let buffer = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let sawUsage = false;

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
        try {
          const parsed = JSON.parse(data) as {
            type?: string;
            content_block_delta?: { delta?: { text?: string } };
            message?: { usage?: { input_tokens?: number; output_tokens?: number } };
            usage?: { input_tokens?: number; output_tokens?: number };
          };

          if (parsed.type === 'content_block_delta' && parsed.content_block_delta?.delta?.text) {
            if (firstTokenTime === null) {
              firstTokenTime = Date.now();
            }
          }

          if (parsed.message?.usage) {
            inputTokens = parsed.message.usage.input_tokens || inputTokens;
            outputTokens = parsed.message.usage.output_tokens || outputTokens;
            sawUsage = true;
          }
          if (parsed.usage) {
            inputTokens = parsed.usage.input_tokens || inputTokens;
            outputTokens = parsed.usage.output_tokens || outputTokens;
            sawUsage = true;
          }
        } catch {
          // Skip malformed SSE chunks
        }
      }
    }

    const responseTime = Date.now() - startTime;
    if (!sawUsage) {
      inputTokens = Math.ceil(((systemPrompt?.length ?? 0) + prompt.length) / 4);
      outputTokens = 0;
    }

    const { cost } = estimateCost(this.model, { inputTokens, outputTokens });

    return {
      text: '',
      inputTokens,
      outputTokens,
      reasoningTokens: 0,
      totalTokens: inputTokens + outputTokens,
      responseTime,
      firstTokenLatency: firstTokenTime ? firstTokenTime - startTime : null,
      estimatedCost: cost,
      model: this.model,
      usageEstimated: !sawUsage,
    };
  }

  private async callRealAPI(
    prompt: string,
    systemPrompt: string | undefined,
    maxTokens: number,
    apiKey: string,
  ): Promise<LLMResponse> {
    const startTime = Date.now();

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    };

    if (systemPrompt) {
      body.system = systemPrompt;
    }

    const response = await this.fetchWithTimeout(
      ANTHROPIC_ENDPOINT,
      {
        method: 'POST',
        headers: buildClaudeHeaders(apiKey),
        body: JSON.stringify(body),
      },
      180000,
    );

    if (!response.ok) {
      throw await this.httpError(response, 'Anthropic');
    }

    const data = (await response.json()) as Record<string, any>;
    const responseTime = Date.now() - startTime;
    const inputTokens = data.usage?.input_tokens || 0;
    const outputTokens = data.usage?.output_tokens || 0;

    // Cached tokens are a subset of input_tokens and are billed differently.
    const cacheReadTokens = data.usage?.cache_read_input_tokens || 0;
    const cacheCreationTokens = data.usage?.cache_creation_input_tokens || 0;
    const { cost } = estimateCost(this.model, {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens: cacheCreationTokens,
    });

    return {
      text: data.content?.[0]?.text || '',
      inputTokens,
      outputTokens,
      reasoningTokens: 0,
      totalTokens: inputTokens + outputTokens,
      responseTime,
      firstTokenLatency: null,
      estimatedCost: cost,
      model: this.model,
      cacheCreationTokens,
      cacheReadTokens,
    };
  }
}
