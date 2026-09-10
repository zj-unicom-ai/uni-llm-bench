import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * secrets.ts owns three sources of truth (env > file > generate) and caches each
 * value in a module-level singleton. Tests reset module state between cases so
 * cached values don't leak across scenarios. The filesystem is fully mocked.
 */

// In-memory "filesystem" backing the fs mock (must live inside vi.hoisted so the
// mock factory below can reference it before any module imports run)
const h = vi.hoisted(() => ({ files: {} as Record<string, string>, dirs: new Set<string>() }));
const files = h.files;
const dirs = h.dirs;

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: (p: fs.PathLike) => String(p) in h.files || h.dirs.has(String(p)),
    readFileSync: (p: fs.PathLike, _enc?: BufferEncoding | { encoding?: BufferEncoding }) => {
      const v = h.files[String(p)];
      if (v === undefined) throw new Error(`ENOENT (mock): ${String(p)}`);
      return v;
    },
    writeFileSync: (p: fs.PathLike, data: string | Buffer, _opts?: unknown) => {
      h.files[String(p)] = typeof data === 'string' ? data : data.toString('utf8');
    },
    mkdirSync: (p: fs.PathLike, _opts?: unknown) => {
      h.dirs.add(String(p));
      return undefined;
    },
  };
});

// Type-only import after the mock declaration
import type * as fs from 'fs';

const ENV_KEYS = ['JWT_SECRET', 'ENCRYPTION_SECRET', 'ENCRYPTION_SALT'] as const;

let mod: typeof import('./secrets');

async function fresh() {
  // wipe in-memory fs
  for (const k of Object.keys(files)) delete files[k];
  dirs.clear();
  // wipe env
  for (const k of ENV_KEYS) delete process.env[k];
  vi.resetModules();
  mod = await import('./secrets');
}

beforeEach(async () => {
  await fresh();
});

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  vi.restoreAllMocks();
});

describe('getJwtSecret', () => {
  it('returns env var when set and not the old default', async () => {
    process.env.JWT_SECRET = 'a-fresh-secret';
    await fresh();
    process.env.JWT_SECRET = 'a-fresh-secret';
    expect(mod.getJwtSecret()).toBe('a-fresh-secret');
  });

  it('ignores the old hardcoded default when env passes it (falls back to file/generate)', async () => {
    process.env.JWT_SECRET = 'llm-benchmark-jwt-default-secret-key';
    await fresh();
    process.env.JWT_SECRET = 'llm-benchmark-jwt-default-secret-key';
    const secret = mod.getJwtSecret();
    expect(secret).not.toBe('llm-benchmark-jwt-default-secret-key');
    expect(secret).toMatch(/^[a-f0-9]{128}$/); // 64-byte hex = 128 chars
  });

  it('reads from file when env is unset and file exists', async () => {
    // Pre-populate the fake file. DATA_DIR resolves to path.join(__dirname, '../../data').
    // We discover the path the module would use by inspecting one generation cycle.
    const generated = mod.getJwtSecret();
    // Find the file the module wrote
    const filePath = Object.keys(files).find((p) => p.endsWith('.jwt_secret'));
    expect(filePath).toBeDefined();
    expect(files[filePath!]).toBe(generated);

    // Reset and re-import; the file should now be read
    await fresh();
    files[filePath!] = 'pre-existing-secret-from-disk';
    expect(mod.getJwtSecret()).toBe('pre-existing-secret-from-disk');
  });

  it('generates a 64-byte hex secret when env and file are both absent', () => {
    const secret = mod.getJwtSecret();
    expect(secret).toMatch(/^[a-f0-9]{128}$/);
  });

  it('persists the generated secret to disk (next call reads cached value)', () => {
    const first = mod.getJwtSecret();
    const second = mod.getJwtSecret();
    expect(first).toBe(second);
    const filePath = Object.keys(files).find((p) => p.endsWith('.jwt_secret'));
    expect(files[filePath!]).toBe(first);
  });

  it('caches across calls (single module-level singleton)', () => {
    const first = mod.getJwtSecret();
    delete files[Object.keys(files).find((p) => p.endsWith('.jwt_secret'))!];
    // Even after wiping the file, the cached value persists for the lifetime of the module
    expect(mod.getJwtSecret()).toBe(first);
  });
});

describe('getEncryptionSecret', () => {
  it('returns env var when set and not the old default', async () => {
    process.env.ENCRYPTION_SECRET = 'a-fresh-enc-secret';
    await fresh();
    process.env.ENCRYPTION_SECRET = 'a-fresh-enc-secret';
    expect(mod.getEncryptionSecret()).toBe('a-fresh-enc-secret');
  });

  it('ignores the old hardcoded default (falls back to file/generate)', async () => {
    process.env.ENCRYPTION_SECRET = 'llm-benchmark-default-secret-key-v1';
    await fresh();
    process.env.ENCRYPTION_SECRET = 'llm-benchmark-default-secret-key-v1';
    const secret = mod.getEncryptionSecret();
    expect(secret).not.toBe('llm-benchmark-default-secret-key-v1');
  });

  it('generates 128-char hex when env/file missing', () => {
    const secret = mod.getEncryptionSecret();
    expect(secret).toMatch(/^[a-f0-9]{128}$/);
  });
});

describe('getEncryptionSalt', () => {
  it('returns env var when set and not the old default', async () => {
    process.env.ENCRYPTION_SALT = 'a-fresh-salt';
    await fresh();
    process.env.ENCRYPTION_SALT = 'a-fresh-salt';
    expect(mod.getEncryptionSalt()).toBe('a-fresh-salt');
  });

  it('ignores the old hardcoded "llm-bench-salt"', async () => {
    process.env.ENCRYPTION_SALT = 'llm-bench-salt';
    await fresh();
    process.env.ENCRYPTION_SALT = 'llm-bench-salt';
    expect(mod.getEncryptionSalt()).not.toBe('llm-bench-salt');
  });
});

describe('getEncryptionKey — deterministic key derivation', () => {
  it('returns a 32-byte Buffer (AES-256 key length)', async () => {
    process.env.ENCRYPTION_SECRET = 'secret-x';
    process.env.ENCRYPTION_SALT = 'salt-y';
    await fresh();
    process.env.ENCRYPTION_SECRET = 'secret-x';
    process.env.ENCRYPTION_SALT = 'salt-y';
    const key = mod.getEncryptionKey();
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(key.length).toBe(32);
  });

  it('is deterministic for the same secret+salt', async () => {
    process.env.ENCRYPTION_SECRET = 'secret-x';
    process.env.ENCRYPTION_SALT = 'salt-y';
    await fresh();
    process.env.ENCRYPTION_SECRET = 'secret-x';
    process.env.ENCRYPTION_SALT = 'salt-y';
    const k1 = mod.getEncryptionKey();
    const k2 = mod.getEncryptionKey();
    expect(k1.equals(k2)).toBe(true);
  });

  it('changes when salt changes (scrypt is salt-sensitive)', async () => {
    process.env.ENCRYPTION_SECRET = 'shared-secret';
    process.env.ENCRYPTION_SALT = 'salt-A';
    await fresh();
    process.env.ENCRYPTION_SECRET = 'shared-secret';
    process.env.ENCRYPTION_SALT = 'salt-A';
    const kA = mod.getEncryptionKey();

    await fresh();
    process.env.ENCRYPTION_SECRET = 'shared-secret';
    process.env.ENCRYPTION_SALT = 'salt-B';
    const kB = mod.getEncryptionKey();
    expect(kA.equals(kB)).toBe(false);
  });

  it('changes when secret changes', async () => {
    process.env.ENCRYPTION_SECRET = 'secret-A';
    process.env.ENCRYPTION_SALT = 'shared-salt';
    await fresh();
    process.env.ENCRYPTION_SECRET = 'secret-A';
    process.env.ENCRYPTION_SALT = 'shared-salt';
    const kA = mod.getEncryptionKey();

    await fresh();
    process.env.ENCRYPTION_SECRET = 'secret-B';
    process.env.ENCRYPTION_SALT = 'shared-salt';
    const kB = mod.getEncryptionKey();
    expect(kA.equals(kB)).toBe(false);
  });
});

describe('getOldEncryptionKey', () => {
  it('returns a deterministic 32-byte key from the OLD hardcoded values', () => {
    const k1 = mod.getOldEncryptionKey();
    const k2 = mod.getOldEncryptionKey();
    expect(k1.length).toBe(32);
    expect(k1.equals(k2)).toBe(true);
  });

  it('is different from the current encryption key when fresh secrets are used', () => {
    process.env.ENCRYPTION_SECRET = 'fresh';
    process.env.ENCRYPTION_SALT = 'fresh';
    const newKey = mod.getEncryptionKey();
    const oldKey = mod.getOldEncryptionKey();
    expect(newKey.equals(oldKey)).toBe(false);
  });
});

describe('needsEncryptionMigration', () => {
  it('returns false on a fresh install with no secret file', () => {
    expect(mod.needsEncryptionMigration()).toBe(false);
  });

  it('returns true when a generated secret file exists and migration marker absent', () => {
    // Generating a secret writes the file
    mod.getEncryptionSecret();
    expect(mod.needsEncryptionMigration()).toBe(true);
  });

  it('returns false once markEncryptionMigrated has been called', () => {
    mod.getEncryptionSecret();
    mod.markEncryptionMigrated();
    expect(mod.needsEncryptionMigration()).toBe(false);
  });

  it('returns true when env var is set to a non-default value (and not yet migrated)', async () => {
    process.env.ENCRYPTION_SECRET = 'something-new';
    await fresh();
    process.env.ENCRYPTION_SECRET = 'something-new';
    expect(mod.needsEncryptionMigration()).toBe(true);
  });

  it('returns false when env var is set to the OLD default (no migration needed yet)', async () => {
    process.env.ENCRYPTION_SECRET = 'llm-benchmark-default-secret-key-v1';
    await fresh();
    process.env.ENCRYPTION_SECRET = 'llm-benchmark-default-secret-key-v1';
    expect(mod.needsEncryptionMigration()).toBe(false);
  });
});

describe('markEncryptionMigrated', () => {
  it('writes a marker file containing an ISO timestamp', () => {
    mod.markEncryptionMigrated();
    const markerPath = Object.keys(files).find((p) => p.endsWith('.encryption_migrated'));
    expect(markerPath).toBeDefined();
    expect(files[markerPath!]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('is idempotent (calling twice overwrites with newer timestamp, no throw)', () => {
    expect(() => {
      mod.markEncryptionMigrated();
      mod.markEncryptionMigrated();
    }).not.toThrow();
  });
});

describe('isOldDefaultJwtSecret', () => {
  it('returns true when env unset AND no jwt_secret file exists', () => {
    expect(mod.isOldDefaultJwtSecret()).toBe(true);
  });

  it('returns false when env JWT_SECRET is set (any value)', async () => {
    process.env.JWT_SECRET = 'anything';
    await fresh();
    process.env.JWT_SECRET = 'anything';
    expect(mod.isOldDefaultJwtSecret()).toBe(false);
  });

  it('returns false once a jwt_secret file has been generated', () => {
    mod.getJwtSecret(); // generates and writes file
    expect(mod.isOldDefaultJwtSecret()).toBe(false);
  });
});
