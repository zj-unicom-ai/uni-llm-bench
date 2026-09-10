import { ErrorCategory } from '../types';

/**
 * Structured, provider-agnostic error for failed upstream LLM calls.
 *
 * Providers must throw this (via `errorFromResponse`) instead of a bare
 * `Error` so that retry decisions and error categorisation are driven by
 * the HTTP status / provider error code rather than by substring guessing.
 */
export class ProviderHttpError extends Error {
  readonly status: number;
  readonly providerCode?: string;
  readonly category: ErrorCategory;
  readonly retryable: boolean;

  constructor(message: string, opts: { status: number; providerCode?: string; retryable?: boolean }) {
    super(message);
    this.name = 'ProviderHttpError';
    this.status = opts.status;
    this.providerCode = opts.providerCode;
    this.category = categoryFromStatus(opts.status);
    this.retryable = opts.retryable ?? isRetryableStatus(opts.status);
  }
}

/** Statuses worth retrying: explicit backpressure, overload, and transient gateway errors. */
const RETRYABLE_STATUSES = new Set([
  408, // Request Timeout
  425, // Too Early
  429, // Too Many Requests
  500, // Internal Server Error (often transient on LLM gateways)
  502, // Bad Gateway
  503, // Service Unavailable
  504, // Gateway Timeout
  522, // Cloudflare connection timed out
  524, // Cloudflare timeout
  529, // Anthropic overloaded
]);

/** Node/undici error codes that mean "the clock ran out", not "the wire broke". */
const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ABORT_ERR',
]);

/** Node/undici error codes that mean "we never got a usable connection". */
const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTCONN',
  'UND_ERR_SOCKET',
  'UND_ERR_INVALID_URL',
  'ERR_INVALID_URL',
]);

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status);
}

export function categoryFromStatus(status: number): ErrorCategory {
  if (status === 408 || status === 429 || status === 529) return 'rate_limit';
  if (status >= 400) return 'api_error';
  return 'unknown';
}

/** Retry budget: rate limits, network blips, and transient 5xx. Never retry 4xx validation errors. */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof ProviderHttpError) return error.retryable;
  const category = classifyError(error);
  if (category === 'rate_limit' || category === 'network') return true;
  // Transient gateway failures hide behind a generic status in some SDKs.
  const status = extractStatus(error);
  return status !== null && isRetryableStatus(status);
}

function extractStatus(value: unknown): number | null {
  if (value && typeof value === 'object') {
    const candidate = (value as { status?: unknown; statusCode?: unknown }).status;
    const fallback = (value as { status?: unknown; statusCode?: unknown }).statusCode;
    const raw = typeof candidate === 'number' ? candidate : typeof fallback === 'number' ? fallback : null;
    if (raw !== null && Number.isInteger(raw)) return raw;
  }
  return null;
}

function extractCode(value: unknown): string | null {
  if (value && typeof value === 'object') {
    const code = (value as { code?: unknown }).code;
    if (typeof code === 'string') return code.toUpperCase();
  }
  return null;
}

function statusFromMessage(message: string): number | null {
  // Match a standalone 3-digit HTTP status so "HTTP 429" maps to rate_limit
  // while "I waited 500 ms" does not match at all.
  const match = message.match(/\b([1-5]\d{2})\b/);
  if (!match) return null;
  const status = Number(match[1]);
  return status >= 400 && status <= 599 ? status : null;
}

/**
 * Classify an error into a coarse category.
 *
 * Resolution order matters — structured signals always win over text:
 *   1. explicit category on a ProviderHttpError
 *   2. numeric HTTP status carried on the error object
 *   3. Node/undici error code
 *   4. AbortError / TimeoutError (fetch timeouts)
 *   5. HTTP status embedded in the message text
 *   6. narrow, well-known substrings (last resort)
 */
export function classifyError(error: unknown): ErrorCategory {
  if (error instanceof ProviderHttpError) return error.category;

  const status = extractStatus(error);
  if (status !== null) return categoryFromStatus(status);

  const code = extractCode(error);
  if (code) {
    if (TIMEOUT_CODES.has(code)) return 'timeout';
    if (NETWORK_CODES.has(code)) return 'network';
  }

  if (error && typeof error === 'object') {
    const name = (error as { name?: unknown }).name;
    if (name === 'AbortError' || name === 'TimeoutError' || name === 'DOMException') return 'timeout';
  }

  const message = error instanceof Error ? error.message.toLowerCase() : typeof error === 'string' ? error.toLowerCase() : '';
  if (!message && error !== null && error !== undefined && typeof error === 'object') {
    // Nothing usable to classify from.
    return 'unknown';
  }
  if (!message) return 'unknown';

  const messageStatus = statusFromMessage(message);
  if (messageStatus !== null) return categoryFromStatus(messageStatus);

  if (
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('aborted') ||
    message.includes('abort')
  ) {
    return 'timeout';
  }
  if (message.includes('rate limit') || message.includes('too many requests') || message.includes('overloaded')) {
    return 'rate_limit';
  }
  if (
    message.includes('fetch') ||
    message.includes('network') ||
    message.includes('econnrefused') ||
    message.includes('econnreset') ||
    message.includes('socket') ||
    message.includes('dns')
  ) {
    return 'network';
  }
  if (message.includes('unauthorized') || message.includes('forbidden') || message.includes('invalid api key')) {
    return 'api_error';
  }

  return 'unknown';
}

/**
 * Build a structured error from a non-2xx response.
 * Best-effort parses the provider's error body for a machine-readable code;
 * never throws if the body is empty or malformed.
 */
export async function errorFromResponse(response: Response, provider: string): Promise<ProviderHttpError> {
  let detail = '';
  let providerCode: string | undefined;

  try {
    const text = await response.text();
    if (text) {
      detail = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text) as {
          error?: { message?: string; code?: string; type?: string; status?: number };
          message?: string;
          code?: string;
        };
        providerCode = parsed.error?.code ?? parsed.error?.type ?? parsed.code;
        if (parsed.error?.message) detail = parsed.error.message.slice(0, 300);
        else if (parsed.message) detail = parsed.message.slice(0, 300);
      } catch {
        // Body is not JSON — keep the raw snippet.
      }
    }
  } catch {
    // Body already consumed or unreadable — status alone is enough.
  }

  const suffix = detail ? `: ${detail}` : '';
  return new ProviderHttpError(`${provider} API error ${response.status}${suffix}`, {
    status: response.status,
    providerCode,
  });
}
