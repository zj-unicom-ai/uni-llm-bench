import * as bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from './database';

export interface UserRecord {
  id: string;
  username: string;
  password_hash: string;
  password_change_required: number;
  created_at: string;
  updated_at: string;
}

class UserStore {
  private db = getDb();

  constructor() {
    this.initDatabase();
    this.ensureAdminUser();
  }

  private initDatabase() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        password_change_required INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    // Migration: add password_change_required column if missing
    const cols = (this.db.pragma('table_info(users)') as Array<{ name: string }>).map((c) => c.name);
    if (!cols.includes('password_change_required')) {
      this.db.exec('ALTER TABLE users ADD COLUMN password_change_required INTEGER DEFAULT 0');
      console.log('Migrated: added password_change_required column to users');
    }

    console.log('User store initialized');
  }

  private ensureAdminUser() {
    try {
      const existing = this.db.prepare('SELECT id FROM users LIMIT 1').get();
      if (!existing) {
        const username = process.env.AUTH_USERNAME || 'admin';
        const password = process.env.AUTH_PASSWORD || 'changeme';
        const isDefaultPassword = !process.env.AUTH_PASSWORD;
        const hash = bcrypt.hashSync(password, 10);
        const now = new Date().toISOString();
        const id = uuidv4();

        this.db
          .prepare(
            `
          INSERT INTO users (id, username, password_hash, password_change_required, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `,
          )
          .run(id, username, hash, isDefaultPassword ? 1 : 0, now, now);

        if (isDefaultPassword) {
          console.warn(`WARNING: Admin user created with default password. Please change it after first login.`);
        }
        console.log(`Admin user created: ${username}`);
      }
    } catch (err) {
      console.error('Failed to ensure admin user:', err);
    }
  }

  findByUsername(username: string): UserRecord | undefined {
    try {
      return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRecord | undefined;
    } catch {
      return undefined;
    }
  }

  findById(id: string): UserRecord | undefined {
    try {
      return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRecord | undefined;
    } catch {
      return undefined;
    }
  }

  async verifyPassword(username: string, password: string): Promise<UserRecord | null> {
    const user = this.findByUsername(username);
    if (!user) return null;

    const match = await bcrypt.compare(password, user.password_hash);
    return match ? user : null;
  }

  async updatePassword(username: string, newPassword: string): Promise<boolean> {
    const user = this.findByUsername(username);
    if (!user) return false;

    try {
      const hash = bcrypt.hashSync(newPassword, 10);
      const now = new Date().toISOString();
      this.db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE username = ?').run(hash, now, username);
      return true;
    } catch {
      return false;
    }
  }

  isPasswordChangeRequired(userId: string): boolean {
    try {
      const user = this.db.prepare('SELECT password_change_required FROM users WHERE id = ?').get(userId) as
        | { password_change_required: number }
        | undefined;
      return user ? user.password_change_required === 1 : false;
    } catch {
      return false;
    }
  }

  clearPasswordChangeRequired(userId: string): void {
    try {
      this.db
        .prepare('UPDATE users SET password_change_required = 0, updated_at = ? WHERE id = ?')
        .run(new Date().toISOString(), userId);
    } catch (err) {
      console.error('Failed to clear password_change_required:', err);
    }
  }
}

export const userStore = new UserStore();
