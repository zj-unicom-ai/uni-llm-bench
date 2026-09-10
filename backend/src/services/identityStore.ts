import { getDb } from './database';
import { FingerprintBaseline, IdentityProbeResult, IdentityRun } from '../types';

interface BaselineRow {
  id: string;
  provider_key: string;
  provider_name: string;
  model_name: string;
  fingerprint: string;
  note: string | null;
  captured_at: string;
}

interface RunRow {
  id: string;
  target: string;
  target_label: string;
  baseline_id: string | null;
  baseline_label: string | null;
  status: string;
  probes: string;
  verdict: string;
  score: number;
  hard_gates: string;
  summary: string;
  created_at: string;
  completed_at: string | null;
  error: string | null;
}

function mapBaseline(row: BaselineRow): FingerprintBaseline {
  return {
    id: row.id,
    providerKey: row.provider_key,
    providerName: row.provider_name,
    modelName: row.model_name,
    fingerprint: JSON.parse(row.fingerprint) as Record<string, string | number>,
    note: row.note ?? undefined,
    capturedAt: row.captured_at,
  };
}

function mapRun(row: RunRow): IdentityRun {
  return {
    id: row.id,
    target: row.target,
    targetLabel: row.target_label,
    baselineId: row.baseline_id ?? undefined,
    baselineLabel: row.baseline_label ?? undefined,
    status: row.status as IdentityRun['status'],
    probes: JSON.parse(row.probes) as IdentityProbeResult[],
    verdict: row.verdict as IdentityRun['verdict'],
    score: row.score,
    hardGates: JSON.parse(row.hard_gates) as string[],
    summary: JSON.parse(row.summary) as IdentityRun['summary'],
    createdAt: row.created_at,
    completedAt: row.completed_at ?? undefined,
    error: row.error ?? undefined,
  };
}

class IdentityStore {
  private db = getDb();

  constructor() {
    this.initDatabase();
  }

  private initDatabase() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS fingerprint_baselines (
        id TEXT PRIMARY KEY,
        provider_key TEXT NOT NULL,
        provider_name TEXT NOT NULL,
        model_name TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        note TEXT,
        captured_at TEXT NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS identity_runs (
        id TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        target_label TEXT NOT NULL,
        baseline_id TEXT,
        baseline_label TEXT,
        status TEXT NOT NULL,
        probes TEXT NOT NULL,
        verdict TEXT NOT NULL,
        score INTEGER NOT NULL DEFAULT 0,
        hard_gates TEXT NOT NULL DEFAULT '[]',
        summary TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        completed_at TEXT,
        error TEXT
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_identity_runs_created
      ON identity_runs(created_at DESC)
    `);

    console.log('Identity store initialized');
  }

  listBaselines(): FingerprintBaseline[] {
    const rows = this.db
      .prepare('SELECT * FROM fingerprint_baselines ORDER BY captured_at DESC')
      .all() as BaselineRow[];
    return rows.map(mapBaseline);
  }

  getBaseline(id: string): FingerprintBaseline | undefined {
    const row = this.db.prepare('SELECT * FROM fingerprint_baselines WHERE id = ?').get(id) as
      | BaselineRow
      | undefined;
    return row ? mapBaseline(row) : undefined;
  }

  saveBaseline(baseline: FingerprintBaseline): FingerprintBaseline {
    this.db
      .prepare(
        `
        INSERT INTO fingerprint_baselines (id, provider_key, provider_name, model_name, fingerprint, note, captured_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        baseline.id,
        baseline.providerKey,
        baseline.providerName,
        baseline.modelName,
        JSON.stringify(baseline.fingerprint),
        baseline.note ?? null,
        baseline.capturedAt,
      );
    return baseline;
  }

  deleteBaseline(id: string): boolean {
    const result = this.db.prepare('DELETE FROM fingerprint_baselines WHERE id = ?').run(id);
    return result.changes > 0;
  }

  saveRun(run: IdentityRun): IdentityRun {
    this.db
      .prepare(
        `
        INSERT INTO identity_runs (id, target, target_label, baseline_id, baseline_label, status, probes, verdict, score, hard_gates, summary, created_at, completed_at, error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        run.id,
        run.target,
        run.targetLabel,
        run.baselineId ?? null,
        run.baselineLabel ?? null,
        run.status,
        JSON.stringify(run.probes),
        run.verdict,
        run.score,
        JSON.stringify(run.hardGates),
        JSON.stringify(run.summary),
        run.createdAt,
        run.completedAt ?? null,
        run.error ?? null,
      );
    return run;
  }

  listRuns(limit = 20): IdentityRun[] {
    const rows = this.db
      .prepare('SELECT * FROM identity_runs ORDER BY created_at DESC LIMIT ?')
      .all(Math.min(Math.max(1, limit), 100)) as RunRow[];
    return rows.map(mapRun);
  }

  getRun(id: string): IdentityRun | undefined {
    const row = this.db.prepare('SELECT * FROM identity_runs WHERE id = ?').get(id) as RunRow | undefined;
    return row ? mapRun(row) : undefined;
  }

  deleteRun(id: string): boolean {
    const result = this.db.prepare('DELETE FROM identity_runs WHERE id = ?').run(id);
    return result.changes > 0;
  }
}

export const identityStore = new IdentityStore();
