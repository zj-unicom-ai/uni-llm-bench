import { randomUUID } from 'node:crypto';
import { getDb } from './database';
import { QualityDataset, QualityDatasetSummary, QualitySample } from '../types';
import { SEED_QUALITY_DATASETS } from './qualitySeed';

/**
 * Quality datasets (built-in + user-authored) live in SQLite.
 *
 * Follows the same shape as `workflowTemplateStore`: the database is the single
 * source of truth, built-ins are seeded on boot under a `builtin:<slug>` id, and
 * the `builtin` flag protects them from user-side edits so a seed can never be
 * silently polluted.
 */

interface DatasetRow {
  id: string;
  name: string;
  description: string | null;
  source: string;
  samples: string;
  sample_count: number;
  tags: string | null;
  note: string | null;
  builtin: number;
  created_at: string;
  updated_at: string;
}

export interface CreateDatasetInput {
  name: string;
  description?: string;
  source?: QualityDataset['source'];
  samples: QualitySample[];
  tags?: string[];
  note?: string;
}

export type UpdateDatasetInput = Partial<Omit<CreateDatasetInput, 'source'>>;

const MAX_NAME_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 500;

/** Give every sample a stable id — later edits to `samples` must not renumber results. */
function withSampleIds(samples: QualitySample[], prefix: string): QualitySample[] {
  const seen = new Set<string>();
  return samples.map((sample, index) => {
    let id = sample.id && sample.id.length > 0 ? sample.id : `${prefix}#${index + 1}`;
    while (seen.has(id)) id = `${id}_`;
    seen.add(id);
    return { ...sample, id };
  });
}

class QualityDatasetStore {
  private datasets: Map<string, QualityDataset> = new Map();
  private db = getDb();

  constructor() {
    this.initDatabase();
    this.load();
    this.seedBuiltins();
  }

  private initDatabase() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS quality_datasets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        source TEXT NOT NULL DEFAULT 'manual',
        samples TEXT NOT NULL,
        sample_count INTEGER NOT NULL DEFAULT 0,
        tags TEXT,
        note TEXT,
        builtin INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_quality_datasets_created
      ON quality_datasets(created_at DESC)
    `);

    // New table, but keep the migration path identical to the other stores so a
    // future column can be added without a bespoke upgrade script.
    const columns = this.db.prepare('PRAGMA table_info(quality_datasets)').all() as { name: string }[];
    const ensure = (name: string, ddl: string) => {
      if (!columns.some((c) => c.name === name)) this.db.exec(`ALTER TABLE quality_datasets ADD COLUMN ${ddl}`);
    };
    ensure('tags', "tags TEXT");
    ensure('note', 'note TEXT');
    ensure('builtin', 'builtin INTEGER NOT NULL DEFAULT 0');

    console.log('Quality dataset store initialized');
  }

  private load() {
    const rows = this.db.prepare('SELECT * FROM quality_datasets').all() as DatasetRow[];
    for (const row of rows) {
      this.datasets.set(row.id, {
        id: row.id,
        name: row.name,
        description: row.description ?? '',
        source: row.source as QualityDataset['source'],
        samples: JSON.parse(row.samples) as QualitySample[],
        sampleCount: row.sample_count,
        tags: row.tags ? (JSON.parse(row.tags) as string[]) : [],
        note: row.note ?? undefined,
        builtin: !!row.builtin,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
    }
  }

  /** Idempotent seed: skip anything whose id or name is already present. */
  private seedBuiltins() {
    const existingIds = new Set(this.datasets.keys());
    const existingNames = new Set([...this.datasets.values()].map((d) => d.name));
    let seeded = 0;
    for (const seed of SEED_QUALITY_DATASETS) {
      const id = `builtin:${seed.slug}`;
      if (existingIds.has(id) || existingNames.has(seed.name)) continue;
      const now = new Date().toISOString();
      const record: QualityDataset = {
        id,
        name: seed.name,
        description: seed.description,
        source: 'builtin',
        samples: withSampleIds(seed.samples, seed.slug),
        sampleCount: seed.samples.length,
        tags: seed.tags,
        note: seed.note,
        builtin: true,
        createdAt: now,
        updatedAt: now,
      };
      this.write(record);
      this.datasets.set(id, record);
      existingIds.add(id);
      existingNames.add(record.name);
      seeded += 1;
    }
    if (seeded > 0) console.log(`Seeded ${seeded} built-in quality dataset(s)`);
  }

  private write(record: QualityDataset) {
    this.db
      .prepare(
        `INSERT INTO quality_datasets
           (id, name, description, source, samples, sample_count, tags, note, builtin, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.name,
        record.description || null,
        record.source,
        JSON.stringify(record.samples),
        record.sampleCount,
        JSON.stringify(record.tags),
        record.note ?? null,
        record.builtin ? 1 : 0,
        record.createdAt,
        record.updatedAt,
      );
  }

  /** List payload without the samples — a 500-question dataset would otherwise dominate the response. */
  list(): QualityDatasetSummary[] {
    const all = [...this.datasets.values()];
    const builtins = SEED_QUALITY_DATASETS.map((seed) => all.find((d) => d.id === `builtin:${seed.slug}`)).filter(
      (d): d is QualityDataset => !!d,
    );
    const builtinIds = new Set(builtins.map((d) => d.id));
    const rest = all
      .filter((d) => !builtinIds.has(d.id))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    return [...builtins, ...rest].map(({ samples: _samples, ...summary }) => summary);
  }

  get(id: string): QualityDataset | undefined {
    return this.datasets.get(id);
  }

  create(input: CreateDatasetInput): QualityDataset {
    const now = new Date().toISOString();
    const id = `ds_${randomUUID().slice(0, 8)}`;
    const samples = withSampleIds(input.samples, id);
    const record: QualityDataset = {
      id,
      name: input.name.slice(0, MAX_NAME_LENGTH),
      description: (input.description ?? '').slice(0, MAX_DESCRIPTION_LENGTH),
      source: input.source ?? 'manual',
      samples,
      sampleCount: samples.length,
      tags: input.tags ?? [],
      note: input.note,
      builtin: false,
      createdAt: now,
      updatedAt: now,
    };
    this.write(record);
    this.datasets.set(id, record);
    return record;
  }

  update(id: string, input: UpdateDatasetInput): QualityDataset | null {
    const existing = this.datasets.get(id);
    if (!existing) return null;
    if (existing.builtin) return null; // built-ins are immutable

    const samples =
      input.samples !== undefined ? withSampleIds(input.samples, id) : existing.samples;
    const updated: QualityDataset = {
      ...existing,
      name: input.name !== undefined ? input.name.slice(0, MAX_NAME_LENGTH) : existing.name,
      description:
        input.description !== undefined ? input.description.slice(0, MAX_DESCRIPTION_LENGTH) : existing.description,
      samples,
      sampleCount: samples.length,
      tags: input.tags ?? existing.tags,
      note: input.note !== undefined ? input.note : existing.note,
      updatedAt: new Date().toISOString(),
    };

    this.db
      .prepare(
        `UPDATE quality_datasets
           SET name = ?, description = ?, samples = ?, sample_count = ?, tags = ?, note = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        updated.name,
        updated.description || null,
        JSON.stringify(updated.samples),
        updated.sampleCount,
        JSON.stringify(updated.tags),
        updated.note ?? null,
        updated.updatedAt,
        id,
      );
    this.datasets.set(id, updated);
    return updated;
  }

  delete(id: string): boolean {
    const existing = this.datasets.get(id);
    if (!existing || existing.builtin) return false;
    this.db.prepare('DELETE FROM quality_datasets WHERE id = ?').run(id);
    this.datasets.delete(id);
    return true;
  }
}

export const qualityDatasetStore = new QualityDatasetStore();
