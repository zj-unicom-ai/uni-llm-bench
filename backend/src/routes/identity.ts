import { randomUUID } from 'crypto';
import { Router, Request, Response } from 'express';
import { FingerprintBaseline, IdentityRun } from '../types';
import { identityStore } from '../services/identityStore';
import { buildRunRecord, runAllProbes, toFingerprint } from '../services/identityEngine';
import { PROBE_DESCRIPTORS } from '../services/identityProbes';
import { resolveProbeTarget } from '../services/probeClient';
import { validate } from '../validation/middleware';
import { IdentityBaselineSchema, IdentityVerifySchema } from '../validation/schemas';

const router = Router();

// GET /api/identity/probes — Catalog served to the UI for the onboarding guide.
router.get('/probes', (_req: Request, res: Response) => {
  res.json(PROBE_DESCRIPTORS);
});

// GET /api/identity/baselines — Stored fingerprints.
router.get('/baselines', (_req: Request, res: Response) => {
  res.json(identityStore.listBaselines());
});

// POST /api/identity/baselines — Capture a fingerprint as the reference.
router.post('/baselines', validate(IdentityBaselineSchema), async (req: Request, res: Response) => {
  const { providerKey, note } = req.body as { providerKey: string; note?: string };

  const target = resolveProbeTarget(providerKey);
  if (!target) {
    return res.status(404).json({ message: `Unknown provider or model: ${providerKey}` });
  }

  try {
    const probes = await runAllProbes(providerKey);
    const baseline: FingerprintBaseline = {
      id: randomUUID(),
      providerKey,
      providerName: target.providerName,
      modelName: target.modelName,
      fingerprint: toFingerprint(probes),
      note,
      capturedAt: new Date().toISOString(),
    };
    identityStore.saveBaseline(baseline);
    res.status(201).json({ baseline, probes });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to capture baseline';
    res.status(500).json({ message });
  }
});

// DELETE /api/identity/baselines/:id — Drop a stored fingerprint.
router.delete('/baselines/:id', (req: Request, res: Response) => {
  const removed = identityStore.deleteBaseline(req.params.id);
  if (!removed) {
    return res.status(404).json({ message: 'Baseline not found' });
  }
  res.json({ success: true });
});

// POST /api/identity/verify — Probe a target and compare it with a baseline.
router.post('/verify', validate(IdentityVerifySchema), async (req: Request, res: Response) => {
  const { target, baselineId } = req.body as { target: string; baselineId?: string };

  const resolved = resolveProbeTarget(target);
  if (!resolved) {
    return res.status(404).json({ message: `Unknown provider or model: ${target}` });
  }

  const baseline = baselineId ? identityStore.getBaseline(baselineId) : undefined;
  if (baselineId && !baseline) {
    return res.status(404).json({ message: `Baseline not found: ${baselineId}` });
  }

  try {
    const partial = await buildRunRecord(target, `${resolved.providerName} / ${resolved.modelName}`, baseline);
    const run: IdentityRun = {
      ...partial,
      status: 'completed',
      completedAt: new Date().toISOString(),
    };
    identityStore.saveRun(run);
    res.status(201).json(run);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Identity verification failed';
    res.status(500).json({ message });
  }
});

// GET /api/identity/runs?limit=20 — Recent verification runs.
router.get('/runs', (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 20;
  res.json(identityStore.listRuns(limit));
});

// GET /api/identity/runs/:id — A single run.
router.get('/runs/:id', (req: Request, res: Response) => {
  const run = identityStore.getRun(req.params.id);
  if (!run) {
    return res.status(404).json({ message: 'Run not found' });
  }
  res.json(run);
});

// DELETE /api/identity/runs/:id — Remove a run from the history.
router.delete('/runs/:id', (req: Request, res: Response) => {
  const removed = identityStore.deleteRun(req.params.id);
  if (!removed) {
    return res.status(404).json({ message: 'Run not found' });
  }
  res.json({ success: true });
});

export default router;
