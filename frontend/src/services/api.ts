const TOKEN_KEY = 'llm_bench_token';

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

export function isAuthenticated(): boolean {
  return !!getToken();
}

/**
 * Wrapper around fetch that injects the Authorization header.
 * If the response is 401, clears the token and redirects to /login.
 */
export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const token = getToken();
  const headers = new Headers(init?.headers);

  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetch(input, { ...init, headers });

  if (response.status === 401) {
    clearToken();
    // Dispatch event so App can react to it
    window.dispatchEvent(new CustomEvent('auth-expired'));
  }

  return response;
}

/**
 * Fetch a short-lived one-time token for SSE/download authentication.
 */
async function fetchOneTimeToken(): Promise<string | null> {
  try {
    const response = await apiFetch('/api/auth/sse-token', { method: 'POST' });
    if (response.ok) {
      const data = await response.json();
      return data.token;
    }
  } catch {
    // One-time token unavailable — SSE/download will fail with 401
  }
  return null;
}

/**
 * Build an SSE URL with a one-time token as a query parameter.
 * EventSource does not support custom headers.
 */
export async function sseUrl(urlPath: string): Promise<string> {
  const token = await fetchOneTimeToken();
  const separator = urlPath.includes('?') ? '&' : '?';
  return token ? `${urlPath}${separator}token=${token}` : urlPath;
}

/**
 * Build a download URL with a one-time token as a query parameter.
 * window.open() cannot set headers.
 */
export async function downloadUrl(urlPath: string): Promise<string> {
  const token = await fetchOneTimeToken();
  const separator = urlPath.includes('?') ? '&' : '?';
  return token ? `${urlPath}${separator}token=${token}` : urlPath;
}
