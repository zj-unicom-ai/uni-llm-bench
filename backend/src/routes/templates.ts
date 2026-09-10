import { Router, Request, Response } from 'express';
import { workflowTemplateStore } from '../services/workflowTemplateStore';
import { validate } from '../validation/middleware';
import { WorkflowTemplateSchema, UpdateWorkflowTemplateSchema } from '../validation/schemas';

const router = Router();

/**
 * GET /api/templates
 * Returns all templates (built-in seeded into the DB, then user-defined) — the database is the single source of truth.
 */
router.get('/', (_req: Request, res: Response) => {
  res.json(workflowTemplateStore.getAll());
});

/**
 * POST /api/templates
 * Create a user-defined template.
 */
router.post('/', validate(WorkflowTemplateSchema), (req: Request, res: Response) => {
  const { name, description, tasks, options } = req.body as {
    name: string;
    description?: string;
    tasks: Parameters<typeof workflowTemplateStore.create>[0]['tasks'];
    options?: { stopOnFailure: boolean; cooldownBetweenTasks: number };
  };

  const created = workflowTemplateStore.create({
    name,
    description: description || '',
    tasks,
    options: options ?? { stopOnFailure: true, cooldownBetweenTasks: 0 },
  });

  res.status(201).json(created);
});

/**
 * PUT /api/templates/:id
 * Update a user-defined template.
 */
router.put('/:id', validate(UpdateWorkflowTemplateSchema), (req: Request, res: Response) => {
  if (workflowTemplateStore.get(req.params.id)?.builtin) {
    res.status(403).json({ error: 'Built-in templates cannot be modified' });
    return;
  }
  const updated = workflowTemplateStore.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Template not found' });
    return;
  }
  res.json(updated);
});

/**
 * DELETE /api/templates/:id
 * Delete a user-defined template.
 */
router.delete('/:id', (req: Request, res: Response) => {
  if (workflowTemplateStore.get(req.params.id)?.builtin) {
    res.status(403).json({ error: 'Built-in templates cannot be deleted' });
    return;
  }
  const removed = workflowTemplateStore.delete(req.params.id);
  if (!removed) {
    res.status(404).json({ error: 'Template not found' });
    return;
  }
  res.json({ success: true });
});

export default router;
