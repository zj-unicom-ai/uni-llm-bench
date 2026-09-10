import { describe, it, expect } from 'vitest';
import { validateProviderName, validateModelId, validateDisplayName } from './validation';

describe('validateProviderName', () => {
  it('accepts valid names', () => {
    expect(validateProviderName('OpenAI')).toBeNull();
    expect(validateProviderName('ZAI-CN-OpenAI')).toBeNull();
    expect(validateProviderName('my_provider')).toBeNull();
    expect(validateProviderName('a')).toBeNull();
    expect(validateProviderName('A'.repeat(64))).toBeNull();
  });

  it('rejects empty', () => {
    expect(validateProviderName('')).not.toBeNull();
  });

  it('rejects spaces', () => {
    expect(validateProviderName('My Provider')).not.toBeNull();
  });

  it('rejects dots', () => {
    expect(validateProviderName('provider.name')).not.toBeNull();
  });

  it('rejects over 64 chars', () => {
    expect(validateProviderName('A'.repeat(65))).not.toBeNull();
  });

  it('rejects starting with non-alphanumeric', () => {
    expect(validateProviderName('-provider')).not.toBeNull();
    expect(validateProviderName('_provider')).not.toBeNull();
  });
});

describe('validateModelId', () => {
  it('accepts valid IDs', () => {
    expect(validateModelId('gpt-4o')).toBeNull();
    expect(validateModelId('glm-5.1')).toBeNull();
    expect(validateModelId('z-ai/glm-4.7')).toBeNull();
    expect(validateModelId('claude-3.5-sonnet')).toBeNull();
    expect(validateModelId('a'.repeat(64))).toBeNull();
  });

  it('rejects empty', () => {
    expect(validateModelId('')).not.toBeNull();
  });

  it('rejects spaces', () => {
    expect(validateModelId('gpt 4o')).not.toBeNull();
  });

  it('rejects over 64 chars', () => {
    expect(validateModelId('a'.repeat(65))).not.toBeNull();
  });

  it('rejects starting with non-alphanumeric', () => {
    expect(validateModelId('/vendor/model')).not.toBeNull();
    expect(validateModelId('.hidden')).not.toBeNull();
  });
});

describe('validateDisplayName', () => {
  it('returns null for empty (optional)', () => {
    expect(validateDisplayName('')).toBeNull();
  });

  it('accepts valid display names', () => {
    expect(validateDisplayName('GLM 5.1')).toBeNull();
    expect(validateDisplayName('Gemini 2.5 Flash-Lite')).toBeNull();
    expect(validateDisplayName('DeepSeek-V3.2')).toBeNull();
    expect(validateDisplayName('A'.repeat(64))).toBeNull();
  });

  it('rejects special characters', () => {
    expect(validateDisplayName('name@test')).not.toBeNull();
    expect(validateDisplayName('name<script>')).not.toBeNull();
  });

  it('rejects over 64 chars', () => {
    expect(validateDisplayName('A'.repeat(65))).not.toBeNull();
  });

  it('rejects starting with non-alphanumeric', () => {
    expect(validateDisplayName(' GLM 5')).not.toBeNull();
    expect(validateDisplayName('-Model')).not.toBeNull();
  });
});
