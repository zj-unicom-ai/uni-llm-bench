import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { IdentityPage } from './IdentityPage';

const state = vi.hoisted(() => ({
  providers: [] as Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>,
  baselines: [] as Array<{ id: string; providerName: string; modelName: string; capturedAt: string }>,
  runs: [] as Array<{
    id: string;
    targetLabel: string;
    verdict: string;
    score: number;
    hardGates: string[];
    baselineLabel?: string;
    probes: Array<{ id: string; status: string; detailKey: string; tier: string; params?: Record<string, string | number> }>;
  }>,
  probes: [] as Array<{ id: string; tier: string; cost: string }>,
  loading: false,
  busy: false,
  verify: vi.fn(),
}));

vi.mock('../hooks/useIdentity', () => ({
  useIdentity: () => ({
    providers: state.providers,
    baselines: state.baselines,
    runs: state.runs,
    probes: state.probes,
    loading: state.loading,
    busy: state.busy,
    error: null,
    refresh: vi.fn(),
    captureBaseline: vi.fn(),
    verify: state.verify,
    deleteBaseline: vi.fn(),
  }),
}));

vi.mock('../antdImports', () => ({
  Alert: ({ message, description }: any) => (
    <div data-testid="alert">
      {message}
      {description}
    </div>
  ),
  Button: ({ children, onClick, disabled, block, danger, loading }: any) => (
    <button onClick={onClick} disabled={disabled} data-block={block} data-danger={danger} data-loading={loading}>
      {children}
    </button>
  ),
  Card: ({ title, children, ...rest }: any) => (
    <div data-testid="card" data-tour={rest['data-tour']}>
      {title}
      {children}
    </div>
  ),
  Collapse: ({ items }: any) => <div data-testid="collapse">{items?.[0]?.label}</div>,
  Empty: ({ description }: any) => <div data-testid="empty">{description}</div>,
  Select: ({ placeholder, value, onChange, options }: any) => (
    <select
      data-testid="select"
      aria-label={placeholder}
      value={value ?? ''}
      onChange={(e) => onChange?.(e.target.value)}
    >
      {(options ?? []).flatMap((group: any) =>
        (group.options ?? []).map((opt: any) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        )),
      )}
    </select>
  ),
  Space: ({ children }: any) => <div>{children}</div>,
  Spin: () => <div data-testid="spin" />,
  Steps: ({ items }: any) => (
    <ol data-testid="steps">
      {items.map((i: any) => (
        <li key={i.title}>{i.title}</li>
      ))}
    </ol>
  ),
  Table: ({ dataSource, columns }: any) => (
    <table data-testid="evidence">
      <tbody>
        {(dataSource ?? []).map((row: any) => (
          <tr key={row.id}>
            {columns.map((col: any) => (
              <td key={col.key}>{col.render ? col.render(row[col.dataIndex], row) : row[col.dataIndex]}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  ),
  Tag: ({ children }: any) => <span data-testid="tag">{children}</span>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

beforeEach(() => {
  state.providers = [{ id: 'p1', name: 'OpenAI', models: [{ id: 'm1', name: 'gpt-4' }] }];
  state.baselines = [];
  state.runs = [];
  state.probes = [];
  state.loading = false;
  state.busy = false;
  state.verify.mockReset();
});

describe('IdentityPage onboarding', () => {
  it('exposes a guide button that starts the tour', () => {
    const onStartTour = vi.fn();
    render(<IdentityPage onStartTour={onStartTour} />);
    fireEvent.click(screen.getByText('identity.showGuide'));
    expect(onStartTour).toHaveBeenCalledTimes(1);
  });

  it('shows the three setup steps while no baseline exists', () => {
    render(<IdentityPage />);
    const steps = screen.getByTestId('steps');
    expect(steps.textContent).toContain('identity.empty.step1');
    expect(steps.textContent).toContain('identity.empty.step2');
    expect(steps.textContent).toContain('identity.empty.step3');
  });

  it('hides the onboarding banner once a baseline has been captured', () => {
    state.baselines = [{ id: 'b1', providerName: 'OpenAI', modelName: 'gpt-4', capturedAt: new Date().toISOString() }];
    render(<IdentityPage />);
    expect(screen.queryByTestId('steps')).toBeNull();
  });

  it('marks the page regions used by the guided tour', () => {
    render(<IdentityPage />);
    expect(document.querySelector('[data-tour="identity-target"]')).not.toBeNull();
    expect(document.querySelector('[data-tour="identity-baseline"]')).not.toBeNull();
    expect(document.querySelector('[data-tour="identity-run"]')).not.toBeNull();
    expect(document.querySelector('[data-tour="identity-evidence"]')).not.toBeNull();
  });
});

describe('IdentityPage verification', () => {
  beforeEach(() => {
    state.runs = [
      {
        id: 'r1',
        targetLabel: 'Relay / glm-5.3',
        verdict: 'mismatch',
        score: 20,
        hardGates: ['tokenizer'],
        baselineLabel: 'Official / glm-5.3',
        probes: [
          {
            id: 'tokenizer.zh',
            status: 'fail',
            tier: 'T1',
            detailKey: 'compare.tokenizerFail',
            params: { observed: 31, expected: 24 },
          },
        ],
      },
    ];
  });

  it('renders the verdict, score and triggered hard gate', () => {
    render(<IdentityPage />);
    expect(screen.getByText('identity.verdict.mismatch')).toBeTruthy();
    expect(screen.getByText('20/100')).toBeTruthy();
    expect(screen.getByText('tokenizer')).toBeTruthy();
  });

  it('renders one evidence row per probe', () => {
    render(<IdentityPage />);
    const rows = screen.getByTestId('evidence').querySelectorAll('tbody tr');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('identity.probe.tokenizer.zh.name');
    expect(rows[0].textContent).toContain('identity.detail.compare.tokenizerFail');
  });

  it('disables the run button until a target is selected', () => {
    render(<IdentityPage />);
    const runButton = screen.getByText('identity.setup.run').closest('button');
    expect(runButton?.disabled).toBe(true);
  });

  it('runs verification with the selected target and baseline', () => {
    state.baselines = [{ id: 'b1', providerName: 'Official', modelName: 'glm-5.3', capturedAt: new Date().toISOString() }];
    render(<IdentityPage />);

    const selects = screen.getAllByTestId('select');
    act(() => {
      fireEvent.change(selects[0], { target: { value: 'p1:gpt-4' } });
    });

    const runButton = screen.getByText('identity.setup.run').closest('button');
    expect(runButton?.disabled).toBe(false);
    act(() => {
      fireEvent.click(runButton!);
    });
    expect(state.verify).toHaveBeenCalled();
  });
});
