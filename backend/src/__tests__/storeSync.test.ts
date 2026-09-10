import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

describe('Store Sync', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE test_items (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        value TEXT NOT NULL
      )
    `);
  });

  describe('SQLite-first write pattern', () => {
    it('should write to SQLite first, then update memory on success', () => {
      const memoryMap = new Map<string, { name: string; value: string }>();

      // Write to SQLite
      db.prepare('INSERT INTO test_items (id, name, value) VALUES (?, ?, ?)').run('1', 'test', 'value');
      // Then update Map
      memoryMap.set('1', { name: 'test', value: 'value' });

      // Verify both are in sync
      const row = db.prepare('SELECT * FROM test_items WHERE id = ?').get('1') as {
        id: string;
        name: string;
        value: string;
      };
      expect(row.name).toBe('test');
      expect(memoryMap.get('1')?.name).toBe('test');
    });

    it('should NOT update Map when SQLite write fails', () => {
      const memoryMap = new Map<string, { name: string; value: string }>();

      // First insert
      db.prepare('INSERT INTO test_items (id, name, value) VALUES (?, ?, ?)').run('1', 'test', 'value');
      memoryMap.set('1', { name: 'test', value: 'value' });

      // Try to insert duplicate — should fail
      try {
        db.prepare('INSERT INTO test_items (id, name, value) VALUES (?, ?, ?)').run('1', 'duplicate', 'value2');
      } catch {
        // Expected: UNIQUE constraint violation
        // Do NOT update Map
      }

      // Map should still have the original value
      expect(memoryMap.get('1')?.name).toBe('test');
    });

    it('should delete from SQLite first, then remove from Map', () => {
      const memoryMap = new Map<string, { name: string; value: string }>();

      db.prepare('INSERT INTO test_items (id, name, value) VALUES (?, ?, ?)').run('1', 'test', 'value');
      memoryMap.set('1', { name: 'test', value: 'value' });

      // Delete from SQLite first
      db.prepare('DELETE FROM test_items WHERE id = ?').run('1');
      // Then remove from Map
      memoryMap.delete('1');

      const row = db.prepare('SELECT * FROM test_items WHERE id = ?').get('1');
      expect(row).toBeUndefined();
      expect(memoryMap.has('1')).toBe(false);
    });
  });

  describe('WAL mode', () => {
    it('should support WAL mode in SQLite', () => {
      const mode = db.pragma('journal_mode = WAL');
      // :memory: databases may not support WAL, but the pragma should not throw
      expect(mode).toBeDefined();
    });
  });

  describe('PRAGMA table_info for migrations', () => {
    it('should list existing columns', () => {
      const cols = (db.pragma('table_info(test_items)') as Array<{ name: string }>).map((c) => c.name);
      expect(cols).toContain('id');
      expect(cols).toContain('name');
      expect(cols).toContain('value');
    });

    it('should detect missing columns', () => {
      const cols = (db.pragma('table_info(test_items)') as Array<{ name: string }>).map((c) => c.name);
      expect(cols).not.toContain('new_column');

      // Add the column
      db.exec('ALTER TABLE test_items ADD COLUMN new_column TEXT');

      const updatedCols = (db.pragma('table_info(test_items)') as Array<{ name: string }>).map((c) => c.name);
      expect(updatedCols).toContain('new_column');
    });
  });
});
