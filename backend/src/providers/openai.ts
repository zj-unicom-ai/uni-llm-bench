import { LLMResponse } from '../types';
import { BaseLLMProvider } from './base';
import { estimateCost } from '../utils/modelPricing';

export const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';

/** Current default. Previously hardcoded to `gpt-4` with no way to override. */
export const DEFAULT_OPENAI_MODEL = 'gpt-4o';

export class OpenAIProvider extends BaseLLMProvider {
  name = 'openai';
  private readonly model: string;

  constructor(model: string = DEFAULT_OPENAI_MODEL) {
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
    // No silent fallback: a missing or malformed key is a hard error. Reporting
    // synthetic numbers here would make a broken setup look healthy.
    if (!apiKey || apiKey.length < 10) {
      throw new Error('OpenAI API key is missing or malformed');
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
    const messages: Array<{ role: string; content: string }> = [];

    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const response = await this.fetchWithTimeout(
      OPENAI_ENDPOINT,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'User-Agent': 'uni-llm-bench',
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          max_tokens: maxTokens,
          stream: true,
          stream_options: { include_usage: true },
        }),
      },
      180000,
    );

    if (!response.ok) {
      throw await this.httpError(response, 'OpenAI');
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body for streaming');
    }

    const decoder = new TextDecoder();
    let firstTokenTime: number | null = null;
    let buffer = '';
    let usageData: {
      prompt_tokens?: number;
      completion_tokens?: number;
      completion_tokens_details?: { reasoning_tokens?: number };
    } | null = null;

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
          const parsed = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string } }>;
            usage?: {
              prompt_tokens?: number;
              completion_tokens?: number;
              completion_tokens_details?: { reasoning_tokens?: number };
            };
          };

          if (parsed.choices?.[0]?.delta?.content && firstTokenTime === null) {
            firstTokenTime = Date.now();
          }

          if (parsed.usage) {
            usageData = parsed.usage;
          }
        } catch {
          // Skip malformed SSE chunks
        }
      }
    }

    const responseTime = Date.now() - startTime;
    const inputTokens = usageData?.prompt_tokens ?? Math.ceil((systemPrompt?.length ?? 0) + prompt.length) / 4;
    let outputTokens = usageData?.completion_tokens ?? 0;
    const reasoningTokens = usageData?.completion_tokens_details?.reasoning_tokens ?? 0;

    // Without a usage block we genuinely do not know the output length.
    // Report 0 and flag it rather than inventing a plausible-looking number.
    const usageEstimated = !usageData;
    if (usageEstimated) {
      outputTokens = 0;
    }

    const { cost } = estimateCost(this.model, { inputTokens, outputTokens });

    return {
      text: '',
      inputTokens: Math.round(inputTokens),
      outputTokens,
      reasoningTokens,
      totalTokens: Math.round(inputTokens) + outputTokens,
      responseTime,
      // Real TTFT only exists for streaming.
      firstTokenLatency: firstTokenTime ? firstTokenTime - startTime : null,
      estimatedCost: cost,
      model: this.model,
      usageEstimated,
      completionTokensDetails: reasoningTokens > 0 ? { reasoningTokens } : undefined,
    };
  }

  private async callRealAPI(
    prompt: string,
    systemPrompt: string | undefined,
    maxTokens: number,
    apiKey: string,
  ): Promise<LLMResponse> {
    const startTime = Date.now();
    const messages: Array<{ role: string; content: string }> = [];

    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const response = await this.fetchWithTimeout(
      OPENAI_ENDPOINT,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'User-Agent': 'uni-llm-bench',
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          max_tokens: maxTokens,
        }),
      },
      180000,
    );

    if (!response.ok) {
      throw await this.httpError(response, 'OpenAI');
    }

    const data = (await response.json()) as Record<string, any>;
    const responseTime = Date.now() - startTime;
    const inputTokens = data.usage?.prompt_tokens || 0;
    const outputTokens = data.usage?.completion_tokens || 0;
    // OpenAI: completion_tokens already includes reasoning_tokens
    const reasoningTokens = data.usage?.completion_tokens_details?.reasoning_tokens || 0;

    const { cost } = estimateCost(this.model, { inputTokens, outputTokens });

    return {
      text: data.choices?.[0]?.message?.content || '',
      inputTokens,
      outputTokens,
      reasoningTokens,
      totalTokens: inputTokens + outputTokens,
      responseTime,
      // Non-streaming responses expose no first-token timing. Returning an
      // estimate here would fabricate a headline metric.
      firstTokenLatency: null,
      estimatedCost: cost,
      model: this.model,
      completionTokensDetails: reasoningTokens > 0 ? { reasoningTokens } : undefined,
    };
  }
}
