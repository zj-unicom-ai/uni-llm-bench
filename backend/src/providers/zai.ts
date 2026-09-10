import { BaseLLMProvider } from './base';
import { LLMResponse } from '../types';
import { estimateCost } from '../utils/modelPricing';

export const DEFAULT_ZAI_MODEL = 'z-ai/glm-4.7';

export class ZaiProvider extends BaseLLMProvider {
  name = 'zai';

  private readonly baseUrl: string;
  private readonly model: string;

  /**
   * Endpoint must come from configuration. The value previously committed here
   * was an internal placeholder host that can never resolve for end users,
   * which made every request fail.
   */
  constructor(model: string = DEFAULT_ZAI_MODEL, baseUrl: string = process.env.ZAI_BASE_URL ?? '') {
    super();
    this.model = model;
    this.baseUrl = baseUrl;
  }

  async execute(
    prompt: string,
    systemPrompt: string | undefined,
    maxTokens: number,
    apiKey: string,
    streaming: boolean = false,
    _images?: any[],
  ): Promise<LLMResponse> {
    if (!this.baseUrl) {
      throw new Error('Zai endpoint is not configured — set ZAI_BASE_URL to your OpenAI-compatible endpoint');
    }
    if (!apiKey || apiKey.length < 5) {
      throw new Error('Zai API key is missing or malformed');
    }
    const key = apiKey;
    const startTime = Date.now();

    try {
      const messages: Array<{ role: string; content: string }> = [];

      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }
      messages.push({ role: 'user', content: prompt });

      if (streaming) {
        return await this.executeStreaming(messages, maxTokens, key, startTime);
      }

      // Non-streaming mode
      const response = await this.fetchWithTimeout(
        `${this.baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({
            model: this.model,
            messages,
            max_tokens: maxTokens,
            stream: false,
          }),
        },
        180000,
      );

      if (!response.ok) {
        throw await this.httpError(response, 'Zai');
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
          completion_tokens_details?: { reasoning_tokens?: number };
        };
      };

      return this.buildResponse(data, startTime);
    } catch (error) {
      console.error('Zai API error:', error);
      throw error;
    }
  }

  private async executeStreaming(
    messages: Array<{ role: string; content: string }>,
    maxTokens: number,
    apiKey: string,
    startTime: number,
  ): Promise<LLMResponse> {
    const response = await this.fetchWithTimeout(
      `${this.baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          max_tokens: maxTokens,
          stream: true,
          stream_options: { include_usage: true }, // Request usage data in response
        }),
      },
      180000,
    );

    if (!response.ok) {
      throw await this.httpError(response, 'Zai');
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
      total_tokens?: number;
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
            choices?: Array<{
              delta?: {
                content?: string;
                reasoning_content?: string;
              };
            }>;
            usage?: {
              prompt_tokens?: number;
              completion_tokens?: number;
              total_tokens?: number;
              completion_tokens_details?: { reasoning_tokens?: number };
            };
          };

          // Detect first token time (including reasoning_content)
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.content || delta?.reasoning_content) {
            if (firstTokenTime === null) {
              firstTokenTime = Date.now();
            }
          }

          // Read usage data (returned at the end of the stream)
          if (parsed.usage) {
            usageData = parsed.usage;
          }
        } catch {
          // Skip malformed SSE chunks
        }
      }
    }

    const endTime = Date.now();
    const responseTime = endTime - startTime;
    const firstTokenLatency = firstTokenTime ? firstTokenTime - startTime : null;

    // Build response from usage data
    if (usageData) {
      const inputTokens = usageData.prompt_tokens || 0;
      const completionTokens = usageData.completion_tokens || 0;
      // GLM-4.7: completion_tokens already includes reasoning_tokens (consistent with OpenAI)
      const reasoningTokens = usageData.completion_tokens_details?.reasoning_tokens || 0;

      const totalTokens = inputTokens + completionTokens;
      const { cost } = estimateCost(this.model, { inputTokens, outputTokens: completionTokens });

      return {
        text: '',
        inputTokens,
        outputTokens: completionTokens,
        reasoningTokens,
        totalTokens,
        responseTime,
        firstTokenLatency,
        estimatedCost: cost,
        model: this.model,
        completionTokensDetails: reasoningTokens > 0 ? { reasoningTokens } : undefined,
      };
    }

    // No usage block: the output length is genuinely unknown. Report 0 and flag
    // it rather than fabricating a plausible-looking token count.
    const inputTokens = Math.ceil(messages.map((m) => m.content).join('').length / 4);
    const { cost } = estimateCost(this.model, { inputTokens, outputTokens: 0 });

    return {
      text: '',
      inputTokens,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: inputTokens,
      responseTime,
      firstTokenLatency,
      estimatedCost: cost,
      model: this.model,
      usageEstimated: true,
    };
  }

  private buildResponse(
    data: {
      choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        completion_tokens_details?: { reasoning_tokens?: number };
      };
    },
    startTime: number,
  ): LLMResponse {
    const endTime = Date.now();
    const responseTime = endTime - startTime;

    const usage = data.usage || {};
    const inputTokens = usage.prompt_tokens || 0;
    const completionTokens = usage.completion_tokens || 0;

    // GLM-4.7: completion_tokens already includes reasoning_tokens (consistent with OpenAI)
    // total_tokens = prompt_tokens + completion_tokens
    // reasoning_tokens inferred from the presence of reasoning_content field
    const reasoningContent = data.choices?.[0]?.message?.reasoning_content;
    const reasoningTokens =
      usage.completion_tokens_details?.reasoning_tokens ||
      (reasoningContent ? Math.ceil(reasoningContent.length / 4) : 0);

    const totalTokens = inputTokens + completionTokens;

    const { cost } = estimateCost(this.model, { inputTokens, outputTokens: completionTokens });

    // Non-streaming responses expose no first-token timing. Reporting an
    // estimate would fabricate a headline metric.
    const firstTokenLatency = null;

    return {
      text: data.choices?.[0]?.message?.content || '',
      inputTokens,
      outputTokens: completionTokens,
      reasoningTokens,
      totalTokens,
      responseTime,
      firstTokenLatency,
      estimatedCost: cost,
      model: this.model,
      completionTokensDetails: reasoningTokens > 0 ? { reasoningTokens } : undefined,
    };
  }
}
