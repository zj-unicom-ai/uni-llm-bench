import { BenchmarkWorkflow } from '../types';
import { getDb } from './database';

class WorkflowStore {
  private workflows: Map<string, BenchmarkWorkflow> = new Map();
  private db = getDb();

  constructor() {
    this.initDatabase();
    this.load();
  }

  private initDatabase() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL,
        providers TEXT NOT NULL,
        provider_labels TEXT,
        tasks TEXT NOT NULL,
        options TEXT NOT NULL,
        task_results TEXT NOT NULL DEFAULT '[]',
        summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      )
    `);

    // Migrate: add provider_labels column if missing
    const cols = (this.db.pragma('table_info(workflows)') as Array<{ name: string }>).map((c) => c.name);
    if (!cols.includes('provider_labels')) {
      this.db.exec('ALTER TABLE workflows ADD COLUMN provider_labels TEXT');
      console.log('Migrated: added provider_labels column');
    }

    // Create indexes if they don't exist
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_workflows_status ON workflows(status);
      CREATE INDEX IF NOT EXISTS idx_workflows_created_at ON workflows(created_at DESC);
    `);

    console.log('Workflow store initialized');
  }

  private load() {
    try {
      const rows = this.db.prepare('SELECT * FROM workflows ORDER BY created_at DESC').all() as Array<{
        id: string;
        name: string;
        description: string | null;
        status: string;
        providers: string;
        provider_labels: string | null;
        tasks: string;
        options: string;
        task_results: string;
        summary: string | null;
        created_at: string;
        updated_at: string;
        started_at: string | null;
        completed_at: string | null;
      }>;
      for (const row of rows) {
        this.workflows.set(row.id, {
          id: row.id,
          name: row.name,
          description: row.description || undefined,
          status: row.status as BenchmarkWorkflow['status'],
          providers: JSON.parse(row.providers),
          providerLabels: row.provider_labels ? JSON.parse(row.provider_labels) : undefined,
          tasks: JSON.parse(row.tasks),
          options: JSON.parse(row.options),
          taskResults: JSON.parse(row.task_results),
          summary: row.summary ? JSON.parse(row.summary) : undefined,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          startedAt: row.started_at || undefined,
          completedAt: row.completed_at || undefined,
        });
      }
      console.log(`Loaded ${this.workflows.size} workflow(s) from SQLite`);

      // Mark stale running workflows as failed (backend was restarted mid-execution)
      let staleCount = 0;
      for (const [id, wf] of this.workflows) {
        if (wf.status === 'running') {
          const fixedTaskResults = wf.taskResults.map((tr) =>
            tr.status === 'running' || tr.status === 'pending' ? { ...tr, status: 'failed' as const } : tr,
          );
          this.update(id, {
            status: 'failed',
            taskResults: fixedTaskResults,
            completedAt: new Date().toISOString(),
          });
          staleCount++;
        }
      }
      if (staleCount > 0) {
        console.log(`Marked ${staleCount} stale running workflow(s) as failed`);
      }
    } catch (err) {
      console.error('Failed to load workflows:', err);
    }
  }

  create(workflow: BenchmarkWorkflow): BenchmarkWorkflow {
    // Write to SQLite first, then update Map on success
    this.db
      .prepare(
        `
        INSERT INTO workflows (id, name, description, status, providers, provider_labels, tasks, options, task_results, summary, created_at, updated_at, started_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        workflow.id,
        workflow.name,
        workflow.description || null,
        workflow.status,
        JSON.stringify(workflow.providers),
        workflow.providerLabels ? JSON.stringify(workflow.providerLabels) : null,
        JSON.stringify(workflow.tasks),
        JSON.stringify(workflow.options),
        JSON.stringify(workflow.taskResults),
        workflow.summary ? JSON.stringify(workflow.summary) : null,
        workflow.createdAt,
        workflow.updatedAt,
        workflow.startedAt || null,
        workflow.completedAt || null,
      );

    this.workflows.set(workflow.id, workflow);
    return workflow;
  }

  get(id: string): BenchmarkWorkflow | undefined {
    return this.workflows.get(id);
  }

  getAll(): BenchmarkWorkflow[] {
    return Array.from(this.workflows.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  update(id: string, updates: Partial<BenchmarkWorkflow>): BenchmarkWorkflow | undefined {
    const workflow = this.workflows.get(id);
    if (!workflow) return undefined;

    const updated = { ...workflow, ...updates, updatedAt: new Date().toISOString() };

    // Write to SQLite first, then update Map on success
    this.db
      .prepare(
        `
        UPDATE workflows
        SET name = ?, description = ?, status = ?, providers = ?, provider_labels = ?,
            tasks = ?, options = ?, task_results = ?, summary = ?, updated_at = ?,
            started_at = ?, completed_at = ?
        WHERE id = ?
      `,
      )
      .run(
        updated.name,
        updated.description || null,
        updated.status,
        JSON.stringify(updated.providers),
        updated.providerLabels ? JSON.stringify(updated.providerLabels) : null,
        JSON.stringify(updated.tasks),
        JSON.stringify(updated.options),
        JSON.stringify(updated.taskResults),
        updated.summary ? JSON.stringify(updated.summary) : null,
        updated.updatedAt,
        updated.startedAt || null,
        updated.completedAt || null,
        id,
      );

    this.workflows.set(id, updated);
    return updated;
  }

  delete(id: string): boolean {
    const exists = this.workflows.has(id);
    if (!exists) return false;

    // Delete from SQLite first, then remove from Map
    this.db.prepare('DELETE FROM workflows WHERE id = ?').run(id);
    this.workflows.delete(id);
    return true;
  }
}

export const workflowStore = new WorkflowStore();
