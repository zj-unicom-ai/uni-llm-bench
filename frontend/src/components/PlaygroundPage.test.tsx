import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CombatantCard } from './PlaygroundPage';
import type { ProviderConfigResponse } from '../types';

// Stub antd Select so we can assert exactly which `value` reaches the component.
// antd renders the raw value when no option matches, which is how a stale
// providerId used to leak a bare UUID into the UI.
vi.mock('../antdImports', () => ({
  // PlaygroundPage destructures Input.TextArea at module scope.
  Input: { TextArea: () => null },
  Select: ({ value, options = [], placeholder, disabled }: any) => {
    const match = options.find((o: any) => o.value === value);
    return (
      <div
        data-testid="select"
        data-value={value === undefined ? '__undefined__' : String(value)}
        data-placeholder={placeholder ?? ''}
        data-disabled={String(!!disabled)}
      >
        {match ? match.label : null}
      </div>
    );
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        'playground.selectProvider': 'Select provider',
        'playground.selectModel': 'Select model',
        'playground.selectProviderFirst': 'Select provider first',
        'playground.selectChallenger': 'Pick a provider and model',
      };
      return map[key] ?? key;
    },
  }),
}));

const STALE_ID = 'c2fa5b0f-83df-4d34-a354-29c67c53667d';

function makeProvider(): ProviderConfigResponse {
  return {
    id: 'p1',
    name: 'unirouter',
    endpoint: 'https://api.example.com/v1',
    apiKeyMasked: 'sk-****',
    format: 'openai',
    models: [
      {
        id: 'm1',
        name: 'deepseek-v3-Flash',
        contextSize: 64000,
        supportsVision: false,
        supportsTools: false,
        supportsStreaming: true,
        isActive: true,
      },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function renderCard(props: Partial<Parameters<typeof CombatantCard>[0]> = {}) {
  const onProvider = vi.fn();
  const onModel = vi.fn();
  render(
    <CombatantCard
      side="A"
      title="选手"
      accent="#4096ff"
      providers={[makeProvider()]}
      providerId={null}
      modelName={null}
      onProvider={onProvider}
      onModel={onModel}
      {...props}
    />,
  );
  return { onProvider, onModel };
}

describe('CombatantCard', () => {
  it('never renders a persisted providerId that no longer exists', () => {
    const { onProvider, onModel } = renderCard({ providerId: STALE_ID, modelName: null });

    // The stale id must not reach the Select value...
    const [providerSelect] = screen.getAllByTestId('select');
    expect(providerSelect.getAttribute('data-value')).toBe('__undefined__');
    // ...nor leak into the rendered output.
    expect(screen.queryByText(STALE_ID)).toBeNull();

    // And it must be dropped from state so it stops being reused.
    expect(onProvider).toHaveBeenCalledWith(null);
    expect(onModel).toHaveBeenCalledWith(null);
  });

  it('keeps a providerId that still resolves', () => {
    const { onProvider } = renderCard({ providerId: 'p1', modelName: 'deepseek-v3-Flash' });

    const [providerSelect, modelSelect] = screen.getAllByTestId('select');
    expect(providerSelect.getAttribute('data-value')).toBe('p1');
    expect(modelSelect.getAttribute('data-value')).toBe('deepseek-v3-Flash');
    expect(screen.getByText('unirouter')).toBeInTheDocument();
    expect(onProvider).not.toHaveBeenCalled();
  });

  it('does not render a stale model name even when the provider is valid', () => {
    const { onModel } = renderCard({ providerId: 'p1', modelName: 'removed-model' });

    const [, modelSelect] = screen.getAllByTestId('select');
    expect(modelSelect.getAttribute('data-value')).toBe('__undefined__');
    expect(screen.queryByText('removed-model')).toBeNull();
    // Falls back to the first active model of the provider.
    expect(onModel).toHaveBeenCalledWith('deepseek-v3-Flash');
  });

  it('leaves the model select disabled until a provider resolves', () => {
    renderCard({ providerId: STALE_ID, modelName: null });

    const [providerSelect, modelSelect] = screen.getAllByTestId('select');
    expect(providerSelect.getAttribute('data-placeholder')).toBe('Select provider');
    expect(modelSelect.getAttribute('data-disabled')).toBe('true');
    expect(modelSelect.getAttribute('data-placeholder')).toBe('Select provider first');
  });
});
