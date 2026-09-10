import { describe, it, expect } from 'vitest';
import { maskProviderName, maskEndpoint, maskApiKey, maskProviderConfig, maskModelName, DEMO_MODE } from './demo';

describe('demo utilities (passthrough when DEMO_MODE is off)', () => {
  it('DEMO_MODE flag reflects env', () => {
    expect(DEMO_MODE).toBe(import.meta.env.VITE_DEMO_MODE === 'true');
  });

  it('returns originals when demo mode is disabled', () => {
    if (DEMO_MODE) return; // skip in demo runs
    expect(maskProviderName('OpenAI Production', 'id-1')).toBe('OpenAI Production');
    expect(maskEndpoint('https://api.openai.com/v1', 'id-1')).toBe('https://api.openai.com/v1');
    expect(maskApiKey('sk-abc***xyz')).toBe('sk-abc***xyz');
  });

  it('maskModelName is identity when disabled or no vendor prefix', () => {
    if (DEMO_MODE) return;
    expect(maskModelName('z-ai/glm-4.7')).toBe('z-ai/glm-4.7');
    expect(maskModelName('glm-4.7')).toBe('glm-4.7');
    expect(maskModelName('')).toBe('');
  });

  it('maskProviderConfig is a no-op shallow copy when disabled', () => {
    if (DEMO_MODE) return;
    const p = {
      id: 'id-1',
      name: 'Real Name',
      endpoint: 'https://real.example.com/v1',
      apiKeyMasked: 'sk-***real***',
      extra: 'preserved',
    };
    const masked = maskProviderConfig(p);
    expect(masked).toEqual(p);
  });
});
