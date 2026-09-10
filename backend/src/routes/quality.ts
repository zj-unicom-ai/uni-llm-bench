import { Router, Request, Response } from 'express';
import { QualitySample, QualityRunListItem, QualityTargetSummary } from '../types';
import { GRADER_DESCRIPTORS } from '../services/graders';
import { qualityDatasetStore } from '../services/qualityDatasetStore';
import { qualityRunStore } from '../services/qualityRunStore';
import {
  cancelQualityRun,
  createQualityRun,
  executeQualityRun,
  subscribeQualityRun,
} from '../services/qualityEngine';
import { ImportError, importDataset } from '../services/qualityImport';
import { providerStore } from '../services/providerStore';
import { validate } from '../validation/middleware';
import {
  CreateQualityDatasetSchema,
  EstimateQualityRunSchema,
  ImportQualityDatasetSchema,
  StartQualityRunSchema,
  UpdateQualityDatasetSchema,
} from '../validation/schemas';
import { estimateCost } from '../utils/modelPricing';
import { toCsvRow } from '../utils/csv';

const router = Router();

/* -------------------------------------------------------------------------- */
/* Grader catalog                                                             */
/* -------------------------------------------------------------------------- */

// GET /api/quality/graders — drives the per-grader config form in the UI.
router.get('/graders', (_req: Request, res: Response) => {
  res.json(GRADER_DESCRIPTORS);
});

/* -------------------------------------------------------------------------- */
/* Datasets                                                                   */
/* -------------------------------------------------------------------------- */

router.get('/datasets', (_req: Request, res: Response) => {
  res.json(qualityDatasetStore.list());
});

// Registered before `/datasets/:id` so the literal path always wins.
router.post('/datasets/import', validate(ImportQualityDatasetSchema), (req: Request, res: Response) => {
  const { name, description, tags, text, format, persist } = req.body as {
    name: string;
    description?: string;
    tags?: string[];
    text: string;
    format?: 'jsonl' | 'csv';
    persist?: boolean;
  };

  try {
    const preview = importDataset(text, 'import', format);

    if (persist === false) {
      return res.json({ preview, dataset: null });
    }
    if (preview.samples.length === 0) {
      return res.status(400).json({ message: 'No valid samples to import', preview });
    }

    const dataset = qualityDatasetStore.create({
      name,
      description,
      tags,
      samples: preview.samples,
      source: 'import',
      note: `Imported from a ${preview.format.toUpperCase()} file — ${preview.accepted} of ${preview.totalRows} rows accepted.`,
    });
    res.status(201).json({ preview, dataset });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Import failed';
    const status = err instanceof ImportError ? 400 : 500;
    res.status(status).json({ message });
  }
});

router.get('/datasets/:id', (req: Request, res: Response) => {
  const dataset = qualityDatasetStore.get(req.params.id);
  if (!dataset) return res.status(404).json({ message: 'Dataset not found' });
  res.json(dataset);
});

router.post('/datasets', validate(CreateQualityDatasetSchema), (req: Request, res: Response) => {
  const { name, description, tags, note, samples } = req.body as {
    name: string;
    description?: string;
    tags?: string[];
    note?: string;
    samples: QualitySample[];
  };
  try {
    const dataset = qualityDatasetStore.create({ name, description, tags, note, samples, source: 'manual' });
    res.status(201).json(dataset);
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Failed to create dataset' });
  }
});

router.put('/datasets/:id', validate(UpdateQualityDatasetSchema), (req: Request, res: Response) => {
  const existing = qualityDatasetStore.get(req.params.id);
  if (!existing) return res.status(404).json({ message: 'Dataset not found' });
  if (existing.builtin) return res.status(403).json({ message: 'Built-in datasets cannot be modified' });

  const updated = qualityDatasetStore.update(req.params.id, req.body);
  if (!updated) return res.status(403).json({ message: 'Built-in datasets cannot be modified' });
  res.json(updated);
});

router.delete('/datasets/:id', (req: Request, res: Response) => {
  const existing = qualityDatasetStore.get(req.params.id);
  if (!existing) return res.status(404).json({ message: 'Dataset not found' });
  if (existing.builtin) return res.status(403).json({ message: 'Built-in datasets cannot be deleted' });
  qualityDatasetStore.delete(req.params.id);
  res.json({ success: true });
});

/* -------------------------------------------------------------------------- */
/* Cost estimate                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Rough token count: CJK characters are close to one token each, everything else
 * lands near four characters per token. Explicitly an approximation — the
 * response says so rather than implying precision we do not have.
 */
function approximateTokens(text: string): number {
  const cjk = (text.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]/g) ?? []).length;
  return Math.ceil(cjk + (text.length - cjk) / 4);
}

const TYPICAL_OUTPUT_TOKENS = 256;

router.post('/estimate', validate(EstimateQualityRunSchema), (req: Request, res: Response) => {
  const { datasetId, targets, params } = req.body as {
    datasetId: string;
    targets: string[];
    params?: { maxTokens?: number };
  };

  const dataset = qualityDatasetStore.get(datasetId);
  if (!dataset) return res.status(404).json({ message: 'Dataset not found' });

  // Matches the engine's default. A reasoning model needs a generous ceiling,
  // and unused tokens are not billed.
  const maxTokens = params?.maxTokens ?? 4096;
  const perTarget = targets.map((target) => {
    const [configId, modelName] = target.includes(':') ? target.split(':', 2) : [target, ''];
    const config = providerStore.get(configId);
    const model = config?.models.find((m) => m.name === modelName || m.id === modelName);

    let inputTokensPerSample = 0;
    for (const sample of dataset.samples) {
      inputTokensPerSample += approximateTokens(sample.input) + approximateTokens(sample.systemPrompt ?? '');
    }
    inputTokensPerSample = Math.ceil(inputTokensPerSample / Math.max(1, dataset.samples.length));

    if (!model) {
      return { target, targetLabel: target, resolvable: false, inputTokensPerSample, typicalCost: null, upperBoundCost: null, pricingKnown: false };
    }

    const typical = estimateCost(model.name, {
      inputTokens: inputTokensPerSample,
      outputTokens: TYPICAL_OUTPUT_TOKENS,
    });
    const upper = estimateCost(model.name, { inputTokens: inputTokensPerSample, outputTokens: maxTokens });

    return {
      target,
      targetLabel: `${config!.name} / ${model.displayName || model.name}`,
      resolvable: true,
      inputTokensPerSample,
      typicalCost: Number((typical.cost * dataset.samples.length).toFixed(6)),
      upperBoundCost: Number((upper.cost * dataset.samples.length).toFixed(6)),
      pricingKnown: typical.exact,
    };
  });

  const priced = perTarget.filter((t) => t.typicalCost !== null);
  res.json({
    datasetId,
    datasetName: dataset.name,
    sampleCount: dataset.samples.length,
    targetCount: targets.length,
    totalRequests: dataset.samples.length * targets.length,
    perTarget,
    totalTypicalCost: priced.length > 0 ? Number(priced.reduce((sum, t) => sum + (t.typicalCost ?? 0), 0).toFixed(6)) : null,
    totalUpperBoundCost:
      priced.length > 0 ? Number(priced.reduce((sum, t) => sum + (t.upperBoundCost ?? 0), 0).toFixed(6)) : null,
    assumptions: [
      `Output length is assumed to be ${TYPICAL_OUTPUT_TOKENS} tokens for the typical figure and maxTokens (${maxTokens}) for the upper bound.`,
      'Input tokens are approximated from character counts, not from the provider tokenizer.',
      'Prices come from the local pricing table; configure per-model pricing in the model library for exact figures.',
    ],
  });
});

/* -------------------------------------------------------------------------- */
/* Runs                                                                       */
/* -------------------------------------------------------------------------- */

function buildTargetLabels(targets: string[]): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const target of targets) {
    if (!target.includes(':')) {
      labels[target] = target;
      continue;
    }
    const [configId, modelName] = target.split(':', 2);
    const config = providerStore.get(configId);
    const model = config?.models.find((m) => m.name === modelName || m.id === modelName);
    labels[target] = config ? `${config.name} / ${model?.displayName || model?.name || modelName}` : modelName;
  }
  return labels;
}

router.post('/runs', validate(StartQualityRunSchema), (req: Request, res: Response) => {
  const { name, description, datasetId, targets, params } = req.body as {
    name: string;
    description?: string;
    datasetId: string;
    targets: string[];
    params?: Record<string, number>;
  };

  const dataset = qualityDatasetStore.get(datasetId);
  if (!dataset) return res.status(404).json({ message: 'Dataset not found' });
  if (dataset.samples.length === 0) return res.status(400).json({ message: 'Dataset has no samples' });

  // Fail fast on targets we cannot resolve, instead of burning a whole run to
  // discover it sample by sample.
  const unresolved = targets.filter((t) => {
    const [configId, modelName] = t.includes(':') ? t.split(':', 2) : [t, ''];
    const config = providerStore.get(configId);
    if (!config) return true;
    return !config.models.some((m) => m.name === modelName || m.id === modelName);
  });
  if (unresolved.length > 0) {
    return res.status(400).json({ message: `Unknown provider or model: ${unresolved.join(', ')}` });
  }

  const run = createQualityRun({
    name,
    description,
    datasetId,
    datasetName: dataset.name,
    // Frozen here, once. Later edits to the dataset must not rewrite this report.
    datasetSnapshot: dataset.samples,
    targets,
    targetLabels: buildTargetLabels(targets),
    params: params ?? {},
  });

  executeQualityRun(run).catch((err) => {
    console.error('[Quality] Run execution error:', err);
  });

  res.status(201).json({ id: run.id, status: 'running', sampleCount: dataset.samples.length, total: run.progress.total });
});

router.get('/runs', (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string, 10) || 100;
  res.json(qualityRunStore.list(limit));
});

router.get('/runs/:id', (req: Request, res: Response) => {
  const run = qualityRunStore.get(req.params.id);
  if (!run) return res.status(404).json({ message: 'Run not found' });
  res.json(run);
});

// SSE progress. Mirrors the workflow stream: initial state, then live events,
// then a terminal event and close.
router.get('/runs/:id/stream', (req: Request, res: Response) => {
  const run = qualityRunStore.get(req.params.id);
  if (!run) return res.status(404).json({ message: 'Run not found' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  res.write(
    `data: ${JSON.stringify({
      type: 'quality:init',
      data: { runId: run.id, status: run.status, progress: run.progress, total: run.progress.total },
    })}\n\n`,
  );

  if (run.status !== 'running' && run.status !== 'pending') {
    res.write(
      `data: ${JSON.stringify({
        type: 'quality:complete',
        data: {
          runId: run.id,
          status: run.status,
          results: Object.fromEntries(
            Object.entries(run.results).map(([key, summary]) => {
              const { samples: _samples, ...headline } = summary;
              return [key, headline];
            }),
          ),
        },
      })}\n\n`,
    );
    res.end();
    return;
  }

  const unsubscribe = subscribeQualityRun(run.id, (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (event.type === 'quality:complete' || event.type === 'quality:error') {
      setTimeout(() => res.end(), 100);
    }
  });

  req.on('close', () => unsubscribe());
});

router.post('/runs/:id/cancel', (req: Request, res: Response) => {
  const run = qualityRunStore.get(req.params.id);
  if (!run) return res.status(404).json({ message: 'Run not found' });
  if (run.status !== 'running') return res.status(400).json({ message: 'Run is not running' });

  const cancelled = cancelQualityRun(run.id);
  res.json({ success: cancelled, message: cancelled ? 'Run cancelled' : 'Could not cancel run' });
});

router.delete('/runs/:id', (req: Request, res: Response) => {
  const run = qualityRunStore.get(req.params.id);
  if (!run) return res.status(404).json({ message: 'Run not found' });
  if (run.status === 'running') return res.status(400).json({ message: 'Cannot delete a running run' });
  qualityRunStore.delete(run.id);
  res.json({ success: true });
});

router.get('/runs/:id/export', (req: Request, res: Response) => {
  const run = qualityRunStore.get(req.params.id);
  if (!run) return res.status(404).json({ message: 'Run not found' });

  if ((req.query.format as string) === 'csv') {
    const lines: string[] = [
      toCsvRow([
        'Target',
        'Model',
        'Index',
        'SampleId',
        'Category',
        'Grader',
        'Status',
        'Score',
        'Expected',
        'Output',
        'Justification',
        'InputTokens',
        'OutputTokens',
        'ReasoningTokens',
        'ResponseTime(ms)',
        'EstimatedCost($)',
        'Error',
        'ErrorCategory',
      ]),
    ];

    for (const summary of Object.values(run.results) as QualityTargetSummary[]) {
      for (const sample of summary.samples) {
        lines.push(
          toCsvRow([
            summary.targetLabel,
            summary.model,
            sample.index + 1,
            sample.sampleId,
            sample.category,
            sample.grader,
            sample.status,
            sample.score,
            sample.expected ?? '',
            sample.output,
            sample.detail,
            sample.inputTokens,
            sample.outputTokens,
            sample.reasoningTokens,
            sample.responseTime,
            sample.estimatedCost,
            sample.error ?? '',
            sample.errorCategory ?? '',
          ]),
        );
      }
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=quality-${run.id}.csv`);
    return res.send(lines.join('\n'));
  }

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename=quality-${run.id}.json`);
  res.json({
    run: {
      ...run,
      // Repeat the run's measurement conditions at the top of the artifact so an
      // exported report is self-describing.
      meta: {
        exportedAt: new Date().toISOString(),
        params: run.params,
        datasetSnapshotSize: run.datasetSnapshot.length,
        graders: [...new Set(run.datasetSnapshot.map((s) => s.grader))],
        note: 'Quality evaluation uses rule-based (L1) graders only. Every sample carries its own justification.',
      },
    },
  });
});

export type { QualityRunListItem };
export default router;
