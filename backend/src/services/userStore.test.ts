import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

const h = vi.hoisted(() => ({ db: null as Database.Database | null }));

vi.mock('./database', () => ({
  getDb: () => h.db!,
}));

let mod: typeof import('./userStore');
const ORIGINAL_ENV = { ...process.env };

async function freshStore() {
  h.db = new Database(':memory:');
  vi.resetModules();
  mod = await import('./userStore');
  return mod.userStore;
}

beforeEach(() => {
  delete process.env.AUTH_USERNAME;
  delete process.env.AUTH_PASSWORD;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('UserStore — admin seeding on first init', () => {
  it('creates an admin user with default username/password when env unset', async () => {
    await freshStore();
    const user = mod.userStore.findByUsername('admin');
    expect(user).toBeDefined();
    expect(user!.username).toBe('admin');
    expect(user!.password_change_required).toBe(1); // default password → must change
  });

  it('respects AUTH_USERNAME env for the seeded admin', async () => {
    process.env.AUTH_USERNAME = 'custom-admin';
    await freshStore();
    expect(mod.userStore.findByUsername('custom-admin')).toBeDefined();
    expect(mod.userStore.findByUsername('admin')).toBeUndefined();
  });

  it('marks password_change_required=0 when AUTH_PASSWORD is explicitly set', async () => {
    process.env.AUTH_PASSWORD = 'a-custom-password';
    await freshStore();
    const user = mod.userStore.findByUsername('admin')!;
    expect(user.password_change_required).toBe(0);
  });

  it('does NOT create another admin if any user already exists', async () => {
    await freshStore();
    const before = h.db!.prepare('SELECT COUNT(*) as cnt FROM users').get() as { cnt: number };
    expect(before.cnt).toBe(1);

    // Re-initialize the singleton — should not insert a second admin
    vi.resetModules();
    mod = await import('./userStore');
    const after = h.db!.prepare('SELECT COUNT(*) as cnt FROM users').get() as { cnt: number };
    expect(after.cnt).toBe(1);
  });

  it('hashes the password (does not store plaintext)', async () => {
    await freshStore();
    const user = mod.userStore.findByUsername('admin')!;
    expect(user.password_hash).not.toBe('changeme');
    expect(user.password_hash).toMatch(/^\$2[aby]\$/); // bcrypt prefix
  });

  it('sets createdAt and updatedAt to ISO timestamps on seed', async () => {
    await freshStore();
    const user = mod.userStore.findByUsername('admin')!;
    expect(user.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(user.updated_at).toBe(user.created_at);
  });
});

describe('UserStore.findByUsername / findById', () => {
  beforeEach(async () => {
    await freshStore();
  });

  it('findByUsername returns undefined for unknown username', () => {
    expect(mod.userStore.findByUsername('ghost')).toBeUndefined();
  });

  it('findById returns undefined for unknown id', () => {
    expect(mod.userStore.findById('ghost')).toBeUndefined();
  });

  it('findById returns the admin record', () => {
    const admin = mod.userStore.findByUsername('admin')!;
    expect(mod.userStore.findById(admin.id)).toEqual(admin);
  });

  it('username lookup is case-sensitive', () => {
    expect(mod.userStore.findByUsername('ADMIN')).toBeUndefined();
  });

  it('returns undefined gracefully on a prepared-statement error (does not throw)', () => {
    h.db!.close(); // closing the db will make subsequent queries throw inside try/catch
    expect(() => mod.userStore.findByUsername('admin')).not.toThrow();
    expect(mod.userStore.findByUsername('admin')).toBeUndefined();
  });
});

describe('UserStore.verifyPassword', () => {
  beforeEach(async () => {
    await freshStore();
  });

  it('returns null for unknown username', async () => {
    expect(await mod.userStore.verifyPassword('ghost', 'any')).toBeNull();
  });

  it('returns null for wrong password', async () => {
    expect(await mod.userStore.verifyPassword('admin', 'wrong-password')).toBeNull();
  });

  it('returns the user record for the correct default password', async () => {
    const user = await mod.userStore.verifyPassword('admin', 'changeme');
    expect(user).not.toBeNull();
    expect(user!.username).toBe('admin');
  });

  it('returns null for an empty password (bcrypt rejects mismatched empty)', async () => {
    expect(await mod.userStore.verifyPassword('admin', '')).toBeNull();
  });
});

describe('UserStore.updatePassword', () => {
  beforeEach(async () => {
    await freshStore();
  });

  it('returns false for unknown username', async () => {
    expect(await mod.userStore.updatePassword('ghost', 'new-pass')).toBe(false);
  });

  it('returns true and persists the new password hash', async () => {
    const ok = await mod.userStore.updatePassword('admin', 'new-pass-1');
    expect(ok).toBe(true);
    // Old password no longer works
    expect(await mod.userStore.verifyPassword('admin', 'changeme')).toBeNull();
    // New password works
    expect(await mod.userStore.verifyPassword('admin', 'new-pass-1')).not.toBeNull();
  });

  it('updates updated_at on a password change', async () => {
    const before = mod.userStore.findByUsername('admin')!.updated_at;
    await new Promise((r) => setTimeout(r, 5));
    await mod.userStore.updatePassword('admin', 'new-pass');
    const after = mod.userStore.findByUsername('admin')!.updated_at;
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
  });

  it('survives round-trips: change → verify → change again → verify', async () => {
    await mod.userStore.updatePassword('admin', 'p1');
    expect(await mod.userStore.verifyPassword('admin', 'p1')).not.toBeNull();
    await mod.userStore.updatePassword('admin', 'p2');
    expect(await mod.userStore.verifyPassword('admin', 'p1')).toBeNull();
    expect(await mod.userStore.verifyPassword('admin', 'p2')).not.toBeNull();
  });
});

describe('UserStore.isPasswordChangeRequired / clearPasswordChangeRequired', () => {
  beforeEach(async () => {
    await freshStore();
  });

  it('returns true for the default-password admin', () => {
    const admin = mod.userStore.findByUsername('admin')!;
    expect(mod.userStore.isPasswordChangeRequired(admin.id)).toBe(true);
  });

  it('returns false for unknown user id', () => {
    expect(mod.userStore.isPasswordChangeRequired('ghost')).toBe(false);
  });

  it('clearPasswordChangeRequired flips the flag to false', () => {
    const admin = mod.userStore.findByUsername('admin')!;
    mod.userStore.clearPasswordChangeRequired(admin.id);
    expect(mod.userStore.isPasswordChangeRequired(admin.id)).toBe(false);
  });

  it('clearPasswordChangeRequired updates updated_at', async () => {
    const admin = mod.userStore.findByUsername('admin')!;
    const before = admin.updated_at;
    await new Promise((r) => setTimeout(r, 5));
    mod.userStore.clearPasswordChangeRequired(admin.id);
    const after = mod.userStore.findById(admin.id)!.updated_at;
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
  });

  it('clearPasswordChangeRequired on unknown id is a no-op (does not throw)', () => {
    expect(() => mod.userStore.clearPasswordChangeRequired('ghost')).not.toThrow();
  });

  it('returns false after admin created with non-default password', async () => {
    process.env.AUTH_PASSWORD = 'preset-strong-password';
    await freshStore();
    const admin = mod.userStore.findByUsername('admin')!;
    expect(mod.userStore.isPasswordChangeRequired(admin.id)).toBe(false);
  });
});

describe('UserStore — schema migrations', () => {
  it('adds password_change_required column when missing from legacy schema', async () => {
    // Set up a "v0" users table without the migration column
    h.db = new Database(':memory:');
    h.db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    h.db
      .prepare('INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?,?,?,?,?)')
      .run('legacy-id', 'legacy', 'fakehash', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');

    vi.resetModules();
    mod = await import('./userStore');

    const cols = (h.db.pragma('table_info(users)') as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('password_change_required');

    // Existing row still readable
    const legacy = mod.userStore.findByUsername('legacy');
    expect(legacy).toBeDefined();
    expect(legacy!.password_change_required).toBe(0); // default
  });
});
