import { randomUUID } from 'node:crypto';
import { getDb } from './database';
import { WorkflowTemplate, SEED_TEMPLATES } from './templateSeed';

/**
 * 模板（内置 + 用户自定义）统一持久化到 SQLite。
 *
 * 设计要点：
 *  - 数据库是模板数据的「唯一来源」。内置模板在首次启动时由 seedBuiltins() 写入，
 *    运行时路由只从本 store 读取，不再依赖任何硬编码数组（已删除冗余来源）。
 *  - builtin 列区分内置（true）与用户自定义（false）模板；内置模板受保护，
 *    不可被用户侧接口修改或删除，避免种子被意外污染。
 */
export interface WorkflowTemplateRecord extends WorkflowTemplate {
  id: string;
  builtin: boolean;
  createdAt: string;
  updatedAt: string;
}

interface TemplateRow {
  id: string;
  name: string;
  description: string | null;
  tasks: string;
  options: string;
  builtin: number;
  created_at: string;
  updated_at: string;
}

class WorkflowTemplateStore {
  private templates: Map<string, WorkflowTemplateRecord> = new Map();
  private db = getDb();

  constructor() {
    this.initDatabase();
    this.load();
    this.seedBuiltins();
  }

  private initDatabase() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        tasks TEXT NOT NULL,
        options TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_wt_created_at ON workflow_templates(created_at DESC);
    `);

    // 兼容已存在的旧库：补加 builtin 列（默认 0 = 用户模板）
    const cols = this.db.prepare(`PRAGMA table_info(workflow_templates)`).all() as { name: string }[];
    if (!cols.some((c) => c.name === 'builtin')) {
      this.db.exec(`ALTER TABLE workflow_templates ADD COLUMN builtin INTEGER NOT NULL DEFAULT 0`);
    }

    console.log('Workflow template store initialized');
  }

  private load() {
    const rows = this.db
      .prepare('SELECT * FROM workflow_templates ORDER BY created_at DESC')
      .all() as TemplateRow[];
    for (const row of rows) {
      this.templates.set(row.id, {
        id: row.id,
        name: row.name,
        description: row.description || '',
        tasks: JSON.parse(row.tasks),
        options: JSON.parse(row.options),
        builtin: !!row.builtin,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
    }
  }

  /** 幂等地把内置种子模板写入数据库（按名称去重，已存在则跳过）。 */
  private seedBuiltins() {
    const existing = new Set(
      [...this.templates.values()].filter((t) => t.builtin).map((t) => t.name),
    );
    for (const tpl of SEED_TEMPLATES) {
      if (existing.has(tpl.name)) continue;
      this.insertBuiltin(tpl);
    }
  }

  private insertBuiltin(tpl: WorkflowTemplate) {
    const id = `builtin:${tpl.name}`;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO workflow_templates (id, name, description, tasks, options, builtin, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(id, tpl.name, tpl.description || '', JSON.stringify(tpl.tasks), JSON.stringify(tpl.options), now, now);
    this.templates.set(id, { ...tpl, id, builtin: true, createdAt: now, updatedAt: now });
  }

  /**
   * 返回全部模板：内置模板按种子顺序在前，用户模板按创建时间倒序在后。
   * 这是路由的唯一数据源。
   */
  getAll(): WorkflowTemplateRecord[] {
    const builtins = SEED_TEMPLATES.map((t) => this.templates.get(`builtin:${t.name}`)).filter(
      (t): t is WorkflowTemplateRecord => !!t,
    );
    const users = [...this.templates.values()]
      .filter((t) => !t.builtin)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return [...builtins, ...users];
  }

  get(id: string): WorkflowTemplateRecord | undefined {
    return this.templates.get(id);
  }

  create(
    input: Omit<WorkflowTemplateRecord, 'id' | 'builtin' | 'createdAt' | 'updatedAt'>,
  ): WorkflowTemplateRecord {
    const now = new Date().toISOString();
    const record: WorkflowTemplateRecord = {
      ...input,
      id: `tpl_${randomUUID().slice(0, 8)}`,
      builtin: false,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO workflow_templates (id, name, description, tasks, options, builtin, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        record.id,
        record.name,
        record.description || null,
        JSON.stringify(record.tasks),
        JSON.stringify(record.options),
        record.createdAt,
        record.updatedAt,
      );
    this.templates.set(record.id, record);
    return record;
  }

  update(
    id: string,
    input: Partial<Omit<WorkflowTemplateRecord, 'id' | 'builtin' | 'createdAt' | 'updatedAt'>>,
  ): WorkflowTemplateRecord | null {
    const existing = this.templates.get(id);
    if (!existing) return null;
    if (existing.builtin) return null; // 内置模板受保护，禁止修改

    const updated: WorkflowTemplateRecord = {
      ...existing,
      ...input,
      updatedAt: new Date().toISOString(),
    };

    this.db
      .prepare(
        `UPDATE workflow_templates
         SET name = ?, description = ?, tasks = ?, options = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        updated.name,
        updated.description || null,
        JSON.stringify(updated.tasks),
        JSON.stringify(updated.options),
        updated.updatedAt,
        id,
      );
    this.templates.set(id, updated);
    return updated;
  }

  delete(id: string): boolean {
    const existing = this.templates.get(id);
    if (!existing || existing.builtin) return false; // 内置模板受保护，禁止删除
    this.db.prepare('DELETE FROM workflow_templates WHERE id = ?').run(id);
    this.templates.delete(id);
    return true;
  }
}

export const workflowTemplateStore = new WorkflowTemplateStore();
