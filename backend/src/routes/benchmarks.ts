import { Router, Request, Response } from 'express';
import { store } from '../services/store';
import { startBenchmark, subscribe, cancelRun } from '../services/benchmarkEngine';
import { providerStore } from '../services/providerStore';
import { LEGACY_PROVIDER_IDS } from '../types';
import { validate } from '../validation/middleware';
import { StartBenchmarkSchema } from '../validation/schemas';
import { toCsvRow } from '../utils/csv';

const router = Router();

// Start a new benchmark
router.post('/', validate(StartBenchmarkSchema), async (req: Request, res: Response) => {
  try {
    const { providers, config, apiKeys } = req.body;

    // Validate providers: accept both legacy IDs and configId:modelName format
    for (const p of providers) {
      if (LEGACY_PROVIDER_IDS.includes(p)) continue;
      if (p.includes(':')) continue;
      const providerConfig = providerStore.get(p);
      if (providerConfig) continue;
      res.status(400).json({ error: `Invalid provider: ${p}` });
      return;
    }

    const benchmarkConfig = {
      prompt: config.prompt,
      systemPrompt: config.systemPrompt,
      maxTokens: config.maxTokens || 500,
      concurrency: Math.min(config.concurrency || 1, 5000),
      iterations: Math.min(config.iterations || 5, 10000000),
      streaming: config.streaming ?? false,
      warmupRuns: Math.min(config.warmupRuns || 0, 5),
      requestInterval: Math.min(config.requestInterval || 0, 10000),
      randomizeInterval: config.randomizeInterval ?? false,
      maxQps: config.maxQps != null ? Math.min(Math.max(config.maxQps, 0), 1000) : undefined,
      targetCacheHitRate: config.targetCacheHitRate,
    };

    const run = await startBenchmark(providers, benchmarkConfig, apiKeys || {});

    res.status(201).json({
      id: run.id,
      status: run.status,
      createdAt: run.createdAt,
    });
  } catch (error) {
    console.error('Error starting benchmark:', error);
    res.status(500).json({ error: 'Failed to start benchmark' });
  }
});

// List benchmarks. Bounded by default: each run embeds every iteration result,
// so an unbounded list response grows without limit.
router.get('/', (req: Request, res: Response) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const { items, total } = store.getPage(limit, offset);
  // Response stays an array so existing clients keep working; the total is
  // carried in a header for callers that want to paginate.
  res.setHeader('X-Total-Count', String(total));
  res.json(items);
});

// Get benchmark by ID
router.get('/:id', (req: Request, res: Response) => {
  const run = store.get(req.params.id);
  if (!run) {
    res.status(404).json({ error: 'Benchmark not found' });
    return;
  }
  res.json(run);
});

// Cancel a running benchmark
router.post('/:id/cancel', (req: Request, res: Response) => {
  const run = store.get(req.params.id);
  if (!run) {
    res.status(404).json({ error: 'Benchmark not found' });
    return;
  }

  if (run.status !== 'running') {
    res.status(400).json({ error: 'Benchmark is not running' });
    return;
  }

  const cancelled = cancelRun(req.params.id);
  res.json({ success: cancelled, message: cancelled ? 'Benchmark cancelled' : 'Already cancelled' });
});

// SSE stream for benchmark progress
router.get('/:id/stream', (req: Request, res: Response) => {
  const run = store.get(req.params.id);
  if (!run) {
    res.status(404).json({ error: 'Benchmark not found' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  // Send initial state
  res.write(`data: ${JSON.stringify({ type: 'init', data: run })}\n\n`);

  if (run.status === 'completed') {
    res.write(`data: ${JSON.stringify({ type: 'done', data: { id: run.id } })}\n\n`);
    res.end();
    return;
  }

  const unsubscribe = subscribe(run.id, (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);

    if (event.type === 'done') {
      setTimeout(() => res.end(), 100);
    }
  });

  req.on('close', () => {
    unsubscribe();
  });
});

// Export benchmark results
router.get('/:id/export', (req: Request, res: Response) => {
  const run = store.get(req.params.id);
  if (!run) {
    res.status(404).json({ error: 'Benchmark not found' });
    return;
  }

  const format = req.query.format || 'json';

  if (format === 'csv') {
    const csvLines: string[] = [
      'Provider,Model,Iteration,ResponseTime(ms),FirstTokenLatency(ms),TokensPerSecond,InputTokens,OutputTokens,ReasoningTokens,TotalTokens,EstimatedCost($),Success,Error,ErrorCategory',
    ];

    Object.values(run.results).forEach((providerResult) => {
      providerResult.iterations.forEach((iter) => {
        csvLines.push(
          toCsvRow([
            providerResult.provider,
            providerResult.model,
            iter.iteration,
            iter.responseTime,
            iter.firstTokenLatency,
            iter.tokensPerSecond,
            iter.inputTokens,
            iter.outputTokens,
            iter.reasoningTokens || 0,
            iter.totalTokens,
            iter.estimatedCost,
            iter.success,
            iter.error || '',
            iter.errorCategory || '',
          ]),
        );
      });
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=benchmark-${run.id}.csv`);
    res.send(csvLines.join('\n'));
  } else {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename=benchmark-${run.id}.json`);
    res.json(run);
  }
});

export default router;
