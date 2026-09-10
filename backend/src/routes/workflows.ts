import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { BenchmarkWorkflow, WorkflowTask, LEGACY_PROVIDER_IDS } from '../types';
import { workflowStore } from '../services/workflowStore';
import { executeWorkflow, subscribeWorkflow, cancelWorkflow, backfillTokenStats } from '../services/workflowEngine';
import { workflowTemplateStore } from '../services/workflowTemplateStore';
import { store } from '../services/store';
import { providerStore } from '../services/providerStore';
import { validate } from '../validation/middleware';
import { CreateWorkflowSchema } from '../validation/schemas';
import { toCsvRow } from '../utils/csv';

const router = Router();

// Create and start a workflow
router.post('/', validate(CreateWorkflowSchema), async (req: Request, res: Response) => {
  try {
    const { name, description, providers, apiKeys, tasks, options } = req.body;

    // Validate providers: accept both legacy IDs and configId:modelName format
    for (const p of providers) {
      if (LEGACY_PROVIDER_IDS.includes(p)) continue;
      if (p.includes(':')) continue;
      const providerConfig = providerStore.get(p);
      if (providerConfig) continue;
      res.status(400).json({ error: `Invalid provider: ${p}` });
      return;
    }

    // Build provider labels (snapshot at creation time)
    const providerLabels: Record<string, string> = {};
    for (const p of providers) {
      if (p.includes(':')) {
        const [configId, modelName] = p.split(':', 2);
        const config = providerStore.get(configId);
        if (config) {
          const modelCfg = config.models.find((m) => m.name === modelName || m.id === modelName);
          providerLabels[p] = `${config.name}/${modelCfg?.displayName || modelCfg?.name || modelName}`;
        } else {
          providerLabels[p] = modelName;
        }
      } else {
        providerLabels[p] = p;
      }
    }

    // Build workflow tasks with IDs
    const workflowTasks: WorkflowTask[] = tasks.map(
      (
        t: {
          name?: string;
          description?: string;
          config: Record<string, unknown>;
          providers?: string[];
          tags?: Record<string, string>;
        },
        index: number,
      ) => ({
        id: `task_${uuidv4().slice(0, 8)}`,
        name: t.name || `Task ${index + 1}`,
        description: t.description,
        order: index,
        config: {
          prompt: (t.config.prompt as string) || '',
          systemPrompt: t.config.systemPrompt as string | undefined,
          maxTokens: Math.min((t.config.maxTokens as number) || 500, 32000),
          concurrency: Math.min((t.config.concurrency as number) || 1, 5000),
          iterations: Math.min((t.config.iterations as number) || 5, 10000000),
          streaming: (t.config.streaming as boolean) ?? true,
          warmupRuns: Math.min((t.config.warmupRuns as number) || 0, 5),
          requestInterval: Math.min((t.config.requestInterval as number) || 0, 10000),
          randomizeInterval: (t.config.randomizeInterval as boolean) ?? false,
          maxQps:
            (t.config.maxQps as number) != null ? Math.min(Math.max(t.config.maxQps as number, 0), 1000) : undefined,
          targetCacheHitRate: t.config.targetCacheHitRate as number | undefined,
        },
        providers: t.providers,
        tags: t.tags,
      }),
    );

    const workflow: BenchmarkWorkflow = {
      id: `wf_${uuidv4().slice(0, 8)}`,
      name,
      description,
      status: 'draft',
      providers,
      providerLabels,
      tasks: workflowTasks,
      options: {
        executionMode: 'sequential',
        stopOnFailure: options?.stopOnFailure ?? true,
        cooldownBetweenTasks: options?.cooldownBetweenTasks ?? 3000,
      },
      taskResults: workflowTasks.map((t) => ({
        taskId: t.id,
        taskName: t.name,
        benchmarkRunId: '',
        status: 'pending' as const,
      })),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    workflowStore.create(workflow);

    // Start execution asynchronously
    executeWorkflow(workflow, apiKeys || {}).catch((err) => {
      console.error('Workflow execution error:', err);
      // Re-read current state to avoid overwriting a cancellation
      const current = workflowStore.get(workflow.id);
      if (current && current.status === 'running') {
        workflowStore.update(workflow.id, { status: 'failed', completedAt: new Date().toISOString() });
      }
    });

    res.status(201).json({
      id: workflow.id,
      status: 'running',
      taskCount: workflow.tasks.length,
      createdAt: workflow.createdAt,
    });
  } catch (error) {
    console.error('Error creating workflow:', error);
    res.status(500).json({ error: 'Failed to create workflow' });
  }
});

// List all workflows
router.get('/', (_req: Request, res: Response) => {
  const workflows = workflowStore.getAll();
  // Return without apiKeys
  const safe = workflows.map(({ apiKeys: _apiKeys, ...rest }) => rest);
  res.json(safe);
});

// Get the currently running workflow (if any)
router.get('/active', (_req: Request, res: Response) => {
  const running = workflowStore.getAll().find((w) => w.status === 'running');
  if (!running) {
    res.json(null);
    return;
  }
  const { apiKeys: _apiKeys, ...safe } = running;
  res.json(safe);
});

// Get workflow templates (built-in ones seeded into the DB, then user-defined) — DB is the single source of truth
router.get('/templates', (_req: Request, res: Response) => {
  res.json(workflowTemplateStore.getAll());
});

// Get workflow by ID
router.get('/:id', (req: Request, res: Response) => {
  const workflow = workflowStore.get(req.params.id);
  if (!workflow) {
    res.status(404).json({ error: 'Workflow not found' });
    return;
  }
  backfillTokenStats(workflow);
  const { apiKeys: _apiKeys, ...safe } = workflow;
  res.json(safe);
});

// SSE stream for workflow progress
router.get('/:id/stream', (req: Request, res: Response) => {
  const workflow = workflowStore.get(req.params.id);
  if (!workflow) {
    res.status(404).json({ error: 'Workflow not found' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  // Send initial state
  const { apiKeys: _apiKeys, ...safe } = workflow;
  res.write(`data: ${JSON.stringify({ type: 'workflow:init', data: safe })}\n\n`);

  if (workflow.status === 'completed' || workflow.status === 'failed' || workflow.status === 'cancelled') {
    res.write(
      `data: ${JSON.stringify({ type: 'workflow:complete', data: { workflowId: workflow.id, summary: workflow.summary, status: workflow.status } })}\n\n`,
    );
    res.end();
    return;
  }

  const unsubscribe = subscribeWorkflow(workflow.id, (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);

    if (event.type === 'workflow:complete') {
      setTimeout(() => res.end(), 100);
    }
  });

  req.on('close', () => {
    unsubscribe();
  });
});

// Update workflow metadata (name, description)
router.patch('/:id', (req: Request, res: Response) => {
  const workflow = workflowStore.get(req.params.id);
  if (!workflow) {
    res.status(404).json({ error: 'Workflow not found' });
    return;
  }
  const { name, description } = req.body;
  const updates: Partial<BenchmarkWorkflow> = {};
  if (typeof name === 'string') updates.name = name;
  if (typeof description === 'string') updates.description = description;
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: 'No valid fields to update' });
    return;
  }
  const updated = workflowStore.update(workflow.id, updates);
  const { apiKeys: _apiKeys, ...safe } = updated!;
  res.json(safe);
});

// Cancel a workflow
router.post('/:id/cancel', (req: Request, res: Response) => {
  const workflow = workflowStore.get(req.params.id);
  if (!workflow) {
    res.status(404).json({ error: 'Workflow not found' });
    return;
  }

  if (workflow.status !== 'running') {
    res.status(400).json({ error: 'Workflow is not running' });
    return;
  }

  const cancelled = cancelWorkflow(workflow.id);
  res.json({ success: cancelled, message: cancelled ? 'Workflow cancelled' : 'Already cancelled' });
});

// Export workflow results
router.get('/:id/export', (req: Request, res: Response) => {
  const workflow = workflowStore.get(req.params.id);
  if (!workflow) {
    res.status(404).json({ error: 'Workflow not found' });
    return;
  }

  const format = req.query.format || 'json';

  if (format === 'csv') {
    const csvLines: string[] = [
      'TaskName,TaskOrder,Provider,Model,Iteration,ResponseTime(ms),FirstTokenLatency(ms),TokensPerSecond,InputTokens,OutputTokens,TotalTokens,EstimatedCost($),Success,Error',
    ];

    for (const taskResult of workflow.taskResults) {
      if (taskResult.status !== 'completed' || !taskResult.benchmarkRunId) continue;
      const run = store.get(taskResult.benchmarkRunId);
      if (!run) continue;

      const task = workflow.tasks.find((t) => t.id === taskResult.taskId);

      Object.values(run.results).forEach((providerResult) => {
        providerResult.iterations.forEach((iter) => {
          csvLines.push(
            toCsvRow([
              task?.name || '',
              task?.order ?? '',
              providerResult.provider,
              providerResult.model,
              iter.iteration,
              iter.responseTime,
              iter.firstTokenLatency,
              iter.tokensPerSecond,
              iter.inputTokens,
              iter.outputTokens,
              iter.totalTokens,
              iter.estimatedCost,
              iter.success,
              iter.error || '',
            ]),
          );
        });
      });
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=workflow-${workflow.id}.csv`);
    res.send(csvLines.join('\n'));
  } else {
    // JSON: include workflow + all related benchmark runs
    const runs: Record<string, unknown> = {};
    for (const taskResult of workflow.taskResults) {
      if (taskResult.benchmarkRunId) {
        const run = store.get(taskResult.benchmarkRunId);
        if (run) runs[taskResult.benchmarkRunId] = run;
      }
    }

    const { apiKeys: _apiKeys, ...safe } = workflow;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename=workflow-${workflow.id}.json`);
    res.json({ workflow: safe, benchmarkRuns: runs });
  }
});

// Duplicate a workflow (config only, no results)
router.post('/:id/duplicate', (req: Request, res: Response) => {
  const workflow = workflowStore.get(req.params.id);
  if (!workflow) {
    res.status(404).json({ error: 'Workflow not found' });
    return;
  }

  const dup: BenchmarkWorkflow = {
    id: `wf_${uuidv4().slice(0, 8)}`,
    name: `${workflow.name} (copy)`,
    description: workflow.description,
    status: 'draft',
    providers: workflow.providers,
    tasks: workflow.tasks.map((t, i) => ({
      ...t,
      id: `task_${uuidv4().slice(0, 8)}`,
      order: i,
    })),
    options: workflow.options
      ? { ...workflow.options }
      : { executionMode: 'sequential', stopOnFailure: true, cooldownBetweenTasks: 3000 },
    taskResults: workflow.tasks.map((t) => ({
      taskId: t.id,
      taskName: t.name,
      benchmarkRunId: '',
      status: 'pending' as const,
    })),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  workflowStore.create(dup);
  res.status(201).json({ id: dup.id, name: dup.name });
});

// Delete a workflow
router.delete('/:id', (req: Request, res: Response) => {
  const workflow = workflowStore.get(req.params.id);
  if (!workflow) {
    res.status(404).json({ error: 'Workflow not found' });
    return;
  }

  if (workflow.status === 'running') {
    res.status(400).json({ error: 'Cannot delete a running workflow' });
    return;
  }

  workflowStore.delete(req.params.id);
  res.json({ success: true });
});

export default router;
