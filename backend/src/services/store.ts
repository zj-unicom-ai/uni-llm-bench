import { BenchmarkRun } from '../types';
import { getDb } from './database';

class BenchmarkStore {
  private runs: Map<string, BenchmarkRun> = new Map();
  private db = getDb();

  constructor() {
    this.initDatabase();
    this.load();
  }

  private initDatabase() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS benchmarks (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        providers TEXT NOT NULL,
        config TEXT NOT NULL,
        results TEXT NOT NULL,
        capability_tests TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      )
    `);

    this.db.exec('CREATE INDEX IF NOT EXISTS idx_benchmarks_created_at ON benchmarks(created_at DESC)');
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_benchmarks_status ON benchmarks(status)");

    console.log('Benchmark store initialized');
  }

  /**
   * Runs left in `running` by a previous process can never finish — their
   * in-memory workers, cancel flags, and token buckets died with it. Mark them
   * interrupted so the UI stops waiting on a run that will never update.
   *
   * Call once at startup before serving traffic.
   */
  reconcileOrphans(): number {
    try {
      const completedAt = new Date().toISOString();
      const info = this.db
        .prepare("UPDATE benchmarks SET status = 'interrupted', completed_at = ? WHERE status = 'running'")
        .run(completedAt);
      const count = info.changes;

      if (count > 0) {
        for (const run of this.runs.values()) {
          if (run.status === 'running') {
            run.status = 'interrupted';
            run.completedAt = completedAt;
          }
        }
        console.log(`[Store] Marked ${count} orphaned run(s) as interrupted`);
      }
      return count;
    } catch (err) {
      console.error('Failed to reconcile orphaned runs:', err);
      return 0;
    }
  }

  /** Mark a single in-flight run as interrupted (used on graceful shutdown). */
  markInterrupted(id: string): void {
    const run = this.runs.get(id);
    if (!run || run.status !== 'running') return;
    this.update(id, { status: 'interrupted', completedAt: new Date().toISOString() });
  }

  /** Ids of runs still in flight. */
  runningIds(): string[] {
    return Array.from(this.runs.values())
      .filter((r) => r.status === 'running')
      .map((r) => r.id);
  }

  private load() {
    try {
      const rows = this.db.prepare('SELECT * FROM benchmarks ORDER BY created_at DESC').all() as Array<{
        id: string;
        status: string;
        providers: string;
        config: string;
        results: string;
        capability_tests: string | null;
        created_at: string;
        completed_at: string | null;
      }>;
      for (const row of rows) {
        this.runs.set(row.id, {
          id: row.id,
          status: row.status as BenchmarkRun['status'],
          providers: JSON.parse(row.providers),
          config: JSON.parse(row.config),
          results: JSON.parse(row.results),
          capabilityTests: row.capability_tests ? JSON.parse(row.capability_tests) : undefined,
          createdAt: row.created_at,
          completedAt: row.completed_at || undefined,
        });
      }
      console.log(`Loaded ${this.runs.size} benchmark(s) from SQLite`);
    } catch (err) {
      console.error('Failed to load from SQLite:', err);
    }
  }

  create(run: BenchmarkRun): BenchmarkRun {
    this.db
      .prepare(
        `
        INSERT INTO benchmarks (id, status, providers, config, results, capability_tests, created_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        run.id,
        run.status,
        JSON.stringify(run.providers),
        JSON.stringify(run.config),
        JSON.stringify(run.results),
        run.capabilityTests ? JSON.stringify(run.capabilityTests) : null,
        run.createdAt,
        run.completedAt || null,
      );

    this.runs.set(run.id, run);
    return run;
  }

  get(id: string): BenchmarkRun | undefined {
    return this.runs.get(id);
  }

  getAll(): BenchmarkRun[] {
    return Array.from(this.runs.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  /**
   * Bounded slice of history. The unbounded `getAll()` forces every run —
   * including all per-iteration results — into a single JSON response.
   */
  getPage(limit = 200, offset = 0): { items: BenchmarkRun[]; total: number } {
    const all = this.getAll();
    return { items: all.slice(offset, offset + limit), total: all.length };
  }

  update(id: string, updates: Partial<BenchmarkRun>): BenchmarkRun | undefined {
    const run = this.runs.get(id);
    if (!run) return undefined;
    const updated = { ...run, ...updates };

    this.db
      .prepare(
        `
        UPDATE benchmarks
        SET status = ?, results = ?, capability_tests = ?, completed_at = ?
        WHERE id = ?
      `,
      )
      .run(
        updated.status,
        JSON.stringify(updated.results),
        updated.capabilityTests ? JSON.stringify(updated.capabilityTests) : null,
        updated.completedAt || null,
        id,
      );

    this.runs.set(id, updated);
    return updated;
  }

  delete(id: string): boolean {
    // SQLite-first: delete from DB first, then Map on success
    this.db.prepare('DELETE FROM benchmarks WHERE id = ?').run(id);
    const result = this.runs.delete(id);
    return result;
  }
}

export const store = new BenchmarkStore();
