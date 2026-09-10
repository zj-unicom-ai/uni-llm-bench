import { LLMProvider, LLMResponse, ImageInput } from '../types';
import { errorFromResponse, ProviderHttpError } from '../utils/providerError';

/**
 * Identify ourselves honestly. Previously this spoofed an official vendor CLI,
 * which is both a compliance risk and a trap when vendors change behaviour
 * based on client identity.
 */
export const USER_AGENT = 'uni-llm-bench';

export abstract class BaseLLMProvider implements LLMProvider {
  abstract name: string;

  abstract execute(
    prompt: string,
    systemPrompt: string | undefined,
    maxTokens: number,
    apiKey: string,
    streaming?: boolean,
    images?: ImageInput[],
  ): Promise<LLMResponse>;

  protected fetchWithTimeout(url: string, options: RequestInit, timeoutMs = 120000): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...options, signal: controller.signal })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === 'AbortError') {
          const timeout = new Error(`Request timed out after ${timeoutMs}ms`);
          timeout.name = 'AbortError';
          throw timeout;
        }
        throw err;
      })
      .finally(() => clearTimeout(timer));
  }

  /**
   * Turn a non-2xx response into a structured error.
   * Providers MUST throw this instead of falling back to fabricated data.
   */
  protected httpError(response: Response, provider: string): Promise<ProviderHttpError> {
    return errorFromResponse(response, provider);
  }
}
