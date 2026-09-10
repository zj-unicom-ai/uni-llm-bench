/**
 * Shared naming validation rules — mirrors backend schemas.ts.
 * Used for real-time input feedback in the UI.
 */

import i18next from 'i18next';

// Provider name: alphanumeric, dash, underscore, NO spaces, 1-64 chars
const PROVIDER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

// Model ID: alphanumeric, dash, underscore, dot, slash (LiteLLM vendor/model), 1-64 chars
const MODEL_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,63}$/;

// Display name: alphanumeric, space, dash, underscore, dot, 1-64 chars
const DISPLAY_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,63}$/;

export function validateProviderName(value: string): string | null {
  if (!value) return i18next.t('validation.providerNameRequired');
  if (!PROVIDER_NAME_RE.test(value)) return i18next.t('validation.providerNamePattern');
  return null;
}

export function validateModelId(value: string): string | null {
  if (!value) return i18next.t('validation.modelIdRequired');
  if (!MODEL_ID_RE.test(value)) return i18next.t('validation.modelIdPattern');
  return null;
}

export function validateDisplayName(value: string): string | null {
  if (!value) return null; // optional
  if (!DISPLAY_NAME_RE.test(value)) return i18next.t('validation.displayNamePattern');
  return null;
}
