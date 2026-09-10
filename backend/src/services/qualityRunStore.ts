import { getDb } from './database';
import { QualityRun, QualityRunListItem, QualityRunStatus, QualityTargetSummary } from '../types';

/**
 * Persistence for quality evaluation runs.
 *
 * Two things here are deliberate and worth not "simplifying" away:
 *
 *  - `dataset_snapshot` is written once, at creation, and never updated. A report
 *    must stay reproducible after the user edits the source dataset.
 *  - `reconcileOrphans()` exists for the same reason the benchmark store has one:
 *    a process killed mid-run leaves `running` rows that can never finish, and the
 *    UI would otherwise spin forever.
 */

interface RunRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  dataset_id: string;
  dataset_name: string;
  dataset_snapshot: string;
  targets: string;
  target_labels: string;
  params: string;
  results: string;
  progress: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
}

function mapRun(row: RunRow): QualityRun {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    status: row.status as QualityRunStatus,
    datasetId: row.dataset_id,
    datasetName: row.dataset_name,
    datasetSnapshot: JSON.parse(row.dataset_snapshot),
    targets: JSON.parse(row.targets) as string[],
    targetLabels: JSON.parse(row.target_labels) as Record<string, string>,
    params: JSON.parse(row.params),
    results: JSON.parse(row.results) as Record<string, QualityTargetSummary>,
    progress: JSON.parse(row.progress),
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    error: row.error ?? undefined,
  };
}

class QualityRunStore {
  private db = getDb();

  constructor() {
    this.initDatabase();
  }

  private initDatabase() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS quality_runs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL,
        dataset_id TEXT NOT NULL,
        dataset_name TEXT NOT NULL,
        dataset_snapshot TEXT NOT NULL,
        targets TEXT NOT NULL,
        target_labels TEXT NOT NULL,
        params TEXT NOT NULL,
        results TEXT NOT NULL DEFAULT '{}',
        progress TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        error TEXT
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_quality_runs_created
      ON quality_runs(created_at DESC)
    `);

    console.log('Quality run store initialized');
  }

  create(run: QualityRun): QualityRun {
    this.db
      .prepare(
        `INSERT INTO quality_runs
           (id, name, description, status, dataset_id, dataset_name, dataset_snapshot, targets, target_labels,
            params, results, progress, created_at, started_at, completed_at, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.name,
        run.description ?? null,
        run.status,
        run.datasetId,
        run.datasetName,
        JSON.stringify(run.datasetSnapshot),
        JSON.stringify(run.targets),
        JSON.stringify(run.targetLabels),
        JSON.stringify(run.params),
        JSON.stringify(run.results),
        JSON.stringify(run.progress),
        run.createdAt,
        run.startedAt ?? null,
        run.completedAt ?? null,
        run.error ?? null,
      );
    return run;
  }

  /**
   * Partial update. `datasetSnapshot` is intentionally not updatable — the whole
   * point of freezing it is that nothing can rewrite it after creation.
   */
  update(
    id: string,
    updates: Partial<
      Pick<QualityRun, 'name' | 'description' | 'status' | 'results' | 'progress' | 'completedAt' | 'error'>
    >,
  ): QualityRun | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;

    const merged: QualityRun = { ...existing, ...updates };
    this.db
      .prepare(
        `UPDATE quality_runs
           SET name = ?, description = ?, status = ?, results = ?, progress = ?,
               completed_at = ?, error = ?
         WHERE id = ?`,
      )
      .run(
        merged.name,
        merged.description ?? null,
        merged.status,
        JSON.stringify(merged.results),
        JSON.stringify(merged.progress),
        merged.completedAt ?? null,
        merged.error ?? null,
        id,
      );
    return merged;
  }

  get(id: string): QualityRun | undefined {
    const row = this.db.prepare('SELECT * FROM quality_runs WHERE id = ?').get(id) as RunRow | undefined;
    return row ? mapRun(row) : undefined;
  }

  /** Newest first, without per-sample rows or the frozen dataset. */
  list(limit = 100): QualityRunListItem[] {
    const capped = Math.min(Math.max(1, limit), 500);
    const rows = this.db
      .prepare('SELECT * FROM quality_runs ORDER BY created_at DESC LIMIT ?')
      .all(capped) as RunRow[];

    return rows.map((row) => {
      const run = mapRun(row);
      const { datasetSnapshot, ...rest } = run;
      const results: QualityRunListItem['results'] = {};
      for (const [target, summary] of Object.entries(run.results)) {
        const { samples: _samples, ...headline } = summary;
        results[target] = headline;
      }
      return { ...rest, sampleCount: datasetSnapshot.length, results };
    });
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM quality_runs WHERE id = ?').run(id);
    return result.changes > 0;
  }

  runningIds(): string[] {
    return (this.db.prepare(`SELECT id FROM quality_runs WHERE status IN ('running', 'pending')`).all() as { id: string }[]).map(
      (row) => row.id,
    );
  }

  markInterrupted(id: string): void {
    this.db
      .prepare(`UPDATE quality_runs SET status = 'interrupted', error = ? WHERE id = ?`)
      .run('Process stopped before the run finished', id);
  }

  /**
   * Called on boot: any run still marked running belongs to a dead process and
   * can never complete. Saying `interrupted` is honest; leaving it `running`
   * makes the UI poll forever.
   */
  reconcileOrphans(): number {
    const ids = this.runningIds();
    for (const id of ids) this.markInterrupted(id);
    if (ids.length > 0) console.log(`[Quality] Marked ${ids.length} orphaned run(s) as interrupted`);
    return ids.length;
  }
}

export const qualityRunStore = new QualityRunStore();
