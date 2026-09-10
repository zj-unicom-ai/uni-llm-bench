import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import i18n from '../i18n';
import en from '../i18n/en.json';
import { QualityRun, QualitySampleResult, QualityTargetSummary } from '../types';
import { QualityReport } from './quality/QualityReport';
import { QualitySampleTable } from './quality/QualitySampleTable';
import { QualityRunForm } from './quality/QualityRunForm';
import { QualityHistory } from './quality/QualityHistory';
import { QualityPage } from './QualityPage';
import { formatCost, formatMs, formatPercent, gradeDetailText } from './quality/gradeDetail';

/**
 * Frontend mirror of the engine's contract: a null pass rate must render as
 * "not judgeable", never as 0%. A report that quietly shows 0% for a run that
 * never got an answer out of the endpoint is the single most damaging thing this
 * page could do.
 */

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

/**
 * Only the page-level tests need the hook mocked; the component tests below take
 * plain props. The mock mirrors the real hook's shape so the page renders as it
 * does in production.
 */
const hook = vi.hoisted(() => ({
  loadRun: vi.fn(),
  deleteRun: vi.fn(),
  refresh: vi.fn(),
  reset: vi.fn(),
  startReport: vi.fn(),
  cancel: vi.fn(),
  estimate: vi.fn(),
  setError: vi.fn(),
  history: [] as unknown[],
}));

vi.mock('../hooks/useQuality', () => ({
  useQuality: () => ({
    providers: [{ id: 'cfg', name: 'Test Provider', models: [{ id: 'm1', name: 'model-x', displayName: 'Model X' }] }],
    datasets: [],
    graders: [],
    history: hook.history,
    loading: false,
    error: null,
    setError: hook.setError,
    phase: 'idle',
    active: null,
    tally: { pass: 0, fail: 0, error: 0 },
    report: [],
    refresh: hook.refresh,
    estimate: hook.estimate,
    startReport: hook.startReport,
    cancel: hook.cancel,
    loadRun: hook.loadRun,
    deleteRun: hook.deleteRun,
    reset: hook.reset,
  }),
}));

const T = en.quality;

function sample(overrides: Partial<QualitySampleResult> = {}): QualitySampleResult {
  return {
    sampleId: 's1',
    index: 0,
    category: 'cat',
    grader: 'exact',
    status: 'pass',
    score: 1,
    detailKey: 'quality.grade.exact.match',
    params: { expected: 'ok' },
    detail: 'exact: matched "ok"',
    input: 'question',
    expected: 'ok',
    output: 'ok',
    inputTokens: 10,
    outputTokens: 2,
    reasoningTokens: 0,
    responseTime: 120,
    estimatedCost: 0.0001,
    ...overrides,
  };
}

function summary(overrides: Partial<QualityTargetSummary> = {}): QualityTargetSummary {
  return {
    target: 'cfg:model-x',
    targetLabel: 'Test Provider / model-x',
    model: 'model-x',
    sampleCount: 3,
    passCount: 1,
    failCount: 1,
    errorCount: 1,
    passRate: 0.5,
    avgScore: 0.5,
    byCategory: [],
    avgResponseTime: 120,
    totalInputTokens: 30,
    totalOutputTokens: 6,
    totalCost: 0.0003,
    errorBreakdown: { timeout: 0, rate_limit: 0, api_error: 1, network: 0, empty_response: 0, unknown: 0 },
    usageEstimatedRatio: 0,
    samples: [sample(), sample({ sampleId: 's2', index: 1, status: 'fail', score: 0 }), sample({ sampleId: 's3', index: 2, status: 'error', score: null })],
    ...overrides,
  };
}

function run(overrides: Partial<QualityRun> = {}): QualityRun {
  const target = summary();
  return {
    id: 'qr_1',
    name: 'Health check',
    status: 'completed',
    datasetId: 'ds_1',
    datasetName: 'GSM8K — Math word problems',
    datasetSnapshot: [{ id: 's1', input: 'q', expected: 'a', grader: 'exact' }],
    targets: ['cfg:model-x'],
    targetLabels: { 'cfg:model-x': 'Test Provider / model-x' },
    params: { temperature: 0, maxTokens: 1024, concurrency: 4, repeats: 1 },
    results: { 'cfg:model-x': target },
    progress: { completed: 3, total: 3 },
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('truncated reasoning responses', () => {
  /**
   * A real run against a reasoning model produced three samples with an empty
   * `content` and an output-token count exactly equal to maxTokens. They must
   * read as "we could not judge this", never as three wrong answers.
   */
  const truncated = sample({
    status: 'error',
    score: null,
    output: '',
    detailKey: 'quality.grade.truncatedResponse',
    params: { outputTokens: 1024, maxTokens: 1024, reasoningTokens: 1024 },
    detail: 'raw english fallback',
  });

  it('interpolates the truncation evidence into the localized justification', () => {
    const text = gradeDetailText(i18n.t.bind(i18n), truncated);
    expect(text).toContain('1024-token output budget');
    expect(text).toContain('1024 of them were reasoning tokens');
  });

  it('falls back to the raw justification when a translation key is missing', () => {
    const text = gradeDetailText(
      i18n.t.bind(i18n),
      sample({ detailKey: 'quality.grade.notAKey', detail: 'raw english fallback', params: {} }),
    );
    expect(text).toBe('raw english fallback');
  });

  it('reports the run as not judgeable rather than as a 0% score', () => {
    const allTruncated = summary({
      passCount: 0,
      failCount: 0,
      errorCount: 3,
      passRate: null,
      avgScore: null,
      samples: [truncated],
    });

    render(<QualityReport runs={[run({ results: { 'cfg:model-x': allTruncated } })]} />);

    expect(screen.getAllByText(T.report.notJudgeable).length).toBeGreaterThan(0);
    expect(screen.queryByText('0.0%')).not.toBeInTheDocument();
  });
});

describe('QualityPage — opening a past run from history', () => {
  /**
   * Regression cover for a real report: clicking "Open report" looked like a dead
   * button. The run *was* loaded, but the report rendered above the config form
   * while the button sits at the bottom of the page — so the feedback landed
   * outside the viewport. It now opens in a drawer next to the row that was
   * clicked, and these tests assert visible feedback rather than just a call.
   */
  const historyItem = {
    id: 'qr_old',
    name: 'HellaSwag · deepseek-v4-flash',
    status: 'completed' as const,
    datasetId: 'builtin:hellaswag-commonsense',
    datasetName: 'HellaSwag — Commonsense continuation',
    targets: ['cfg:model-x'],
    targetLabels: { 'cfg:model-x': 'Test Provider / model-x' },
    params: { temperature: 0, maxTokens: 4096, concurrency: 4, repeats: 1 },
    results: {},
    progress: { completed: 16, total: 16 },
    sampleCount: 16,
    createdAt: '2026-09-10T09:05:43.123Z',
  };

  beforeEach(() => {
    hook.loadRun.mockReset();
    hook.history.length = 0;
  });

  it('opens the report in place so the click has a visible result', async () => {
    hook.history.push(historyItem);
    hook.loadRun.mockResolvedValue(run({ id: 'qr_old', name: 'HellaSwag · deepseek-v4-flash' }));

    render(<QualityPage />);
    fireEvent.click(screen.getByText(T.history.open));

    await waitFor(() => expect(hook.loadRun).toHaveBeenCalledWith('qr_old'));
    expect(await screen.findByText(T.history.drawerTitle)).toBeInTheDocument();
    expect(await screen.findByText(T.history.frozenHint)).toBeInTheDocument();
  });

  it('shows the row spinner while the run is being fetched', async () => {
    hook.history.push(historyItem);
    let resolveLoad: (value: QualityRun | null) => void = () => {};
    hook.loadRun.mockReturnValue(
      new Promise<QualityRun | null>((resolve) => {
        resolveLoad = resolve;
      }),
    );

    render(<QualityPage />);
    const button = screen.getByText(T.history.open).closest('button') as HTMLButtonElement;
    fireEvent.click(button);

    // Immediate feedback, before the request resolves.
    await waitFor(() => expect(button.className).toContain('ant-btn-loading'));
    expect(screen.queryByText(T.history.drawerTitle)).not.toBeInTheDocument();

    resolveLoad(run({ id: 'qr_old' }));
    await waitFor(() => expect(screen.getByText(T.history.drawerTitle)).toBeInTheDocument());
  });

  it('does not open an empty drawer when the run cannot be loaded', async () => {
    hook.history.push(historyItem);
    // Mirror the real hook: a failure sets the error and returns null.
    hook.loadRun.mockImplementation(async () => {
      hook.setError('Run not found');
      return null;
    });

    render(<QualityPage />);
    fireEvent.click(screen.getByText(T.history.open));

    await waitFor(() => expect(hook.setError).toHaveBeenCalled());
    expect(screen.queryByText(T.history.drawerTitle)).not.toBeInTheDocument();
  });
});

describe('runs that produced nothing', () => {
  /**
   * An interrupted run has a record but no samples. The history list used to label
   * it "not judgeable" and the report rendered a scorecard of zeros — both describe
   * a measurement that never happened.
   */
  it('shows a dash, not a verdict, for a run with no results', () => {
    render(
      <QualityHistory
        history={[
          {
            id: 'qr_interrupted',
            name: 'HellaSwag — interrupted',
            status: 'interrupted',
            datasetId: 'ds',
            datasetName: 'HellaSwag — Commonsense continuation',
            targets: ['cfg:model-x'],
            targetLabels: { 'cfg:model-x': 'Test Provider / model-x' },
            params: { temperature: 0, maxTokens: 4096, concurrency: 4, repeats: 1 },
            results: {},
            progress: { completed: 0, total: 16 },
            sampleCount: 16,
            createdAt: '2026-09-10T09:09:04.703Z',
          },
        ]}
        onOpen={vi.fn()}
        onDelete={vi.fn()}
        onExport={vi.fn()}
      />,
    );

    expect(screen.queryByText(T.report.notJudgeable)).not.toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('explains that a report with no samples has nothing to show', () => {
    render(<QualityReport runs={[run({ id: 'qr_interrupted', status: 'interrupted', results: {} })]} />);
    expect(screen.getByText(T.report.noResults)).toBeInTheDocument();
    // No scorecard of zeros, and no implied verdict.
    expect(screen.queryByText(T.report.notJudgeable)).not.toBeInTheDocument();
  });
});

describe('formatting helpers', () => {
  it('renders a null rate as the caller-supplied fallback, never as a number', () => {
    expect(formatPercent(null, 'NOT_JUDGEABLE')).toBe('NOT_JUDGEABLE');
    expect(formatPercent(0, 'NOT_JUDGEABLE')).toBe('0.0%');
    expect(formatPercent(0.5, 'NOT_JUDGEABLE')).toBe('50.0%');
  });

  it('does not print a misleading zero for missing cost or latency', () => {
    expect(formatCost(0)).toBe('—');
    expect(formatMs(0)).toBe('—');
    expect(formatCost(0.000123)).toBe('$0.000123');
    expect(formatMs(1234.6)).toBe('1235 ms');
  });
});

describe('QualityReport', () => {
  it('says a run was not judgeable instead of reporting 0%', () => {
    const allErrors = summary({
      passCount: 0,
      failCount: 0,
      errorCount: 3,
      passRate: null,
      avgScore: null,
      samples: [sample({ status: 'error', score: null }), sample({ status: 'error', score: null })],
    });

    render(<QualityReport runs={[run({ results: { 'cfg:model-x': allErrors } })]} />);

    expect(screen.getAllByText(T.report.notJudgeable).length).toBeGreaterThan(0);
    expect(screen.queryByText('0.0%')).not.toBeInTheDocument();
  });

  it('surfaces the unjudgeable count in a warning banner', () => {
    render(<QualityReport runs={[run()]} />);
    // 1 unjudgeable sample in the fixture.
    expect(screen.getByText(T.report.errorBanner.replace('{{count}}', '1'))).toBeInTheDocument();
  });

  it('shows a real percentage when there is a verdict to report', () => {
    const mixed = summary({ passCount: 2, failCount: 2, errorCount: 0, passRate: 0.5, samples: [] });
    render(<QualityReport runs={[run({ results: { 'cfg:model-x': mixed } })]} />);
    expect(screen.getAllByText('50.0%').length).toBeGreaterThan(0);
    expect(screen.queryByText(T.report.errorBanner.replace('{{count}}', '0'))).not.toBeInTheDocument();
  });

  it('discloses the measurement conditions so the number can be reproduced', () => {
    render(<QualityReport runs={[run()]} />);
    expect(screen.getByText(T.report.conditions.temperature.replace('{{value}}', '0'))).toBeInTheDocument();
    expect(screen.getByText(T.report.conditions.maxTokens.replace('{{value}}', '1024'))).toBeInTheDocument();
    expect(screen.getByText(T.report.conditions.frozen)).toBeInTheDocument();
  });

  it('marks a partially completed report as in progress', () => {
    render(<QualityReport runs={[run({ status: 'running' })]} partial />);
    expect(screen.getByText(T.report.partial)).toBeInTheDocument();
  });

  it('renders an empty state when no dataset finished', () => {
    render(<QualityReport runs={[]} />);
    expect(screen.getByText(T.report.empty)).toBeInTheDocument();
  });

  it('shows the model under test and the total cost', () => {
    render(<QualityReport runs={[run()]} />);
    expect(screen.getByText('Test Provider / model-x')).toBeInTheDocument();
    expect(screen.getByText(T.report.totalCost)).toBeInTheDocument();
  });

  it('aggregates several datasets into one scorecard', () => {
    render(
      <QualityReport
        runs={[
          run(),
          run({ id: 'qr_2', datasetName: 'HellaSwag — Commonsense continuation' }),
        ]}
      />,
    );
    expect(screen.getByText('GSM8K — Math word problems')).toBeInTheDocument();
    expect(screen.getByText('HellaSwag — Commonsense continuation')).toBeInTheDocument();
  });
});

describe('QualitySampleTable', () => {
  it('counts each verdict and can filter down to failures', () => {
    render(<QualitySampleTable samples={[sample(), sample({ sampleId: 's2', status: 'fail', output: 'wrong-answer' }), sample({ sampleId: 's3', status: 'error', output: '' })]} />);

    expect(screen.getByText(T.detail.filter.all.replace('{{count}}', '3'))).toBeInTheDocument();
    expect(screen.getByText(T.detail.filter.failed.replace('{{count}}', '1'))).toBeInTheDocument();
    expect(screen.getByText(T.detail.filter.error.replace('{{count}}', '1'))).toBeInTheDocument();

    fireEvent.click(screen.getByText(T.detail.filter.failed.replace('{{count}}', '1')));
    expect(screen.getByText(/wrong-answer/)).toBeInTheDocument();
    expect(screen.queryByText(/wrong-answer/)).toBeInTheDocument();
  });

  it('renders an empty state when the dataset produced nothing', () => {
    render(<QualitySampleTable samples={[]} />);
    expect(screen.getByText(T.report.empty)).toBeInTheDocument();
  });
});

describe('QualityRunForm', () => {
  const baseProps = {
    providers: [{ id: 'cfg', name: 'Test Provider', models: [{ id: 'm1', name: 'model-x', displayName: 'Model X' }] }],
    datasets: [
      {
        id: 'ds_1',
        name: 'Dataset one',
        description: 'desc',
        source: 'builtin' as const,
        sampleCount: 20,
        tags: ['math'],
        builtin: true,
        createdAt: '',
        updatedAt: '',
      },
    ],
    running: false,
    onTargetChange: vi.fn(),
    onSelectedChange: vi.fn(),
    onParamsChange: vi.fn(),
    estimate: null,
    estimating: false,
    onStart: vi.fn(),
    onCancel: vi.fn(),
  };

  it('refuses to start without a model and a dataset', () => {
    render(<QualityRunForm {...baseProps} target={null} selected={[]} params={{ temperature: 0, maxTokens: 1024, concurrency: 4 }} />);
    const start = screen.getByRole('button', { name: T.form.start });
    expect(start).toBeDisabled();
    expect(screen.getByText(T.form.noneSelected)).toBeInTheDocument();
  });

  it('enables start and shows the cost once a model and dataset are chosen', () => {
    render(
      <QualityRunForm
        {...baseProps}
        target="cfg:model-x"
        selected={['ds_1']}
        params={{ temperature: 0, maxTokens: 1024, concurrency: 4 }}
        estimate={[
          {
            datasetId: 'ds_1',
            datasetName: 'Dataset one',
            sampleCount: 20,
            targetCount: 1,
            totalRequests: 20,
            perTarget: [],
            totalTypicalCost: 0.0123,
            totalUpperBoundCost: 0.05,
            assumptions: [],
          },
        ]}
      />,
    );
    const start = screen.getByRole('button', { name: T.form.startCount.replace('{{count}}', '1') });
    expect(start).toBeEnabled();
    expect(screen.getByText(T.form.totalRequests.replace('{{count}}', '20'))).toBeInTheDocument();
    expect(screen.getByText(T.form.estimatedCost.replace('{{cost}}', '$0.0123'))).toBeInTheDocument();
  });

  it('explains when no pricing is configured instead of showing $0', () => {
    render(
      <QualityRunForm
        {...baseProps}
        target="cfg:model-x"
        selected={['ds_1']}
        params={{ temperature: 0, maxTokens: 1024, concurrency: 4 }}
        estimate={[
          {
            datasetId: 'ds_1',
            datasetName: 'Dataset one',
            sampleCount: 20,
            targetCount: 1,
            totalRequests: 20,
            perTarget: [],
            totalTypicalCost: null,
            totalUpperBoundCost: null,
            assumptions: [],
          },
        ]}
      />,
    );
    expect(screen.getByText(T.form.estimateUnavailable)).toBeInTheDocument();
  });
});
