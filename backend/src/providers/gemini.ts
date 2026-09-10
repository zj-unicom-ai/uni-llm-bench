import { LLMResponse } from '../types';
import { BaseLLMProvider } from './base';
import { estimateCost } from '../utils/modelPricing';

export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Current default. The previous default (`gemini-pro`) has been retired by
 * Google and now fails for every request.
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

export class GeminiProvider extends BaseLLMProvider {
  name = 'gemini';
  private readonly model: string;

  constructor(model: string = DEFAULT_GEMINI_MODEL) {
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
      throw new Error('Gemini API key is missing or malformed');
    }

    if (streaming) {
      return this.callStreamingAPI(prompt, systemPrompt, maxTokens, apiKey);
    }
    return this.callRealAPI(prompt, systemPrompt, maxTokens, apiKey);
  }

  /** API key travels in a header, never in the URL where it leaks into logs. */
  private headers(apiKey: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
      'User-Agent': 'uni-llm-bench',
    };
  }

  private async callStreamingAPI(
    prompt: string,
    systemPrompt: string | undefined,
    maxTokens: number,
    apiKey: string,
  ): Promise<LLMResponse> {
    const startTime = Date.now();
    const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;

    const response = await this.fetchWithTimeout(
      `${GEMINI_BASE_URL}/${this.model}:streamGenerateContent?alt=sse`,
      {
        method: 'POST',
        headers: this.headers(apiKey),
        body: JSON.stringify({
          contents: [{ parts: [{ text: fullPrompt }] }],
          generationConfig: { maxOutputTokens: maxTokens },
        }),
      },
      180000,
    );

    if (!response.ok) {
      throw await this.httpError(response, 'Gemini');
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body for streaming');
    }

    const decoder = new TextDecoder();
    let firstTokenTime: number | null = null;
    let buffer = '';
    let inputTokens = Math.ceil(fullPrompt.length / 4);
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
            candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
            usageMetadata?: {
              promptTokenCount?: number;
              candidatesTokenCount?: number;
            };
          };

          const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text && firstTokenTime === null) {
            firstTokenTime = Date.now();
          }

          if (parsed.usageMetadata) {
            inputTokens = parsed.usageMetadata.promptTokenCount || inputTokens;
            outputTokens = parsed.usageMetadata.candidatesTokenCount || outputTokens;
            sawUsage = true;
          }
        } catch {
          // Skip malformed SSE chunks
        }
      }
    }

    const responseTime = Date.now() - startTime;
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
    const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;

    const response = await this.fetchWithTimeout(
      `${GEMINI_BASE_URL}/${this.model}:generateContent`,
      {
        method: 'POST',
        headers: this.headers(apiKey),
        body: JSON.stringify({
          contents: [{ parts: [{ text: fullPrompt }] }],
          generationConfig: { maxOutputTokens: maxTokens },
        }),
      },
      180000,
    );

    if (!response.ok) {
      throw await this.httpError(response, 'Gemini');
    }

    const data = (await response.json()) as Record<string, any>;
    const responseTime = Date.now() - startTime;
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    const usageMetadata = data.usageMetadata;
    const inputTokens = usageMetadata?.promptTokenCount || Math.ceil(fullPrompt.length / 4);
    const outputTokens = usageMetadata?.candidatesTokenCount || Math.ceil(text.length / 4);
    const { cost } = estimateCost(this.model, { inputTokens, outputTokens });

    return {
      text,
      inputTokens,
      outputTokens,
      reasoningTokens: 0,
      totalTokens: inputTokens + outputTokens,
      responseTime,
      firstTokenLatency: null,
      estimatedCost: cost,
      model: this.model,
      usageEstimated: !usageMetadata,
    };
  }
}
