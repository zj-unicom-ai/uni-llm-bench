import { useState, useCallback } from 'react';
import { apiFetch, setToken } from '../services/api';

export function useAuth() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const login = useCallback(
    async (username: string, password: string): Promise<{ success: boolean; passwordChangeRequired?: boolean }> => {
      setLoading(true);
      setError(null);
      try {
        const res = await apiFetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        });

        if (!res.ok) {
          const data = await res.json();
          setError(data.error || 'Login failed');
          return { success: false };
        }

        const data = await res.json();
        setToken(data.token);
        return { success: true, passwordChangeRequired: data.passwordChangeRequired };
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Login failed');
        return { success: false };
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const changePassword = useCallback(async (currentPassword: string, newPassword: string): Promise<boolean> => {
    try {
      const res = await apiFetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Failed to change password');
        return false;
      }
      return true;
    } catch {
      setError('Failed to change password');
      return false;
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { loading, error, login, changePassword, clearError };
}
