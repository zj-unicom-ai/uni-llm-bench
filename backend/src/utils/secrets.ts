import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const DATA_DIR = path.join(__dirname, '../../data');

const OLD_JWT_SECRET = 'llm-benchmark-jwt-default-secret-key';
const OLD_ENCRYPTION_SECRET = 'llm-benchmark-default-secret-key-v1';
const OLD_ENCRYPTION_SALT = 'llm-bench-salt';

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readOrGenerateSecret(filename: string, envVar: string | undefined): string {
  const filePath = path.join(DATA_DIR, filename);

  // 1. Environment variable takes highest priority
  if (envVar) {
    return envVar;
  }

  // 2. Read from persisted file
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, 'utf8').trim();
  }

  // 3. Generate new secret and persist
  ensureDataDir();
  const secret = crypto.randomBytes(64).toString('hex');
  fs.writeFileSync(filePath, secret, { mode: 0o600 });
  console.log(`Generated new secret: ${filename}`);
  return secret;
}

// JWT Secret
let _jwtSecret: string | null = null;

export function getJwtSecret(): string {
  if (!_jwtSecret) {
    const envSecret = process.env.JWT_SECRET;
    // Reject the old hardcoded default if passed via env
    if (envSecret && envSecret === OLD_JWT_SECRET) {
      console.warn('WARNING: JWT_SECRET is set to the old default value. Please change it to a secure random string.');
    }
    _jwtSecret = readOrGenerateSecret('.jwt_secret', envSecret && envSecret !== OLD_JWT_SECRET ? envSecret : undefined);
  }
  return _jwtSecret;
}

// Encryption Secret
let _encryptionSecret: string | null = null;

export function getEncryptionSecret(): string {
  if (!_encryptionSecret) {
    const envSecret = process.env.ENCRYPTION_SECRET;
    if (envSecret && envSecret === OLD_ENCRYPTION_SECRET) {
      console.warn(
        'WARNING: ENCRYPTION_SECRET is set to the old default value. Please change it to a secure random string.',
      );
    }
    _encryptionSecret = readOrGenerateSecret(
      '.encryption_secret',
      envSecret && envSecret !== OLD_ENCRYPTION_SECRET ? envSecret : undefined,
    );
  }
  return _encryptionSecret;
}

// Encryption Salt
let _encryptionSalt: string | null = null;

export function getEncryptionSalt(): string {
  if (!_encryptionSalt) {
    const envSalt = process.env.ENCRYPTION_SALT;
    if (envSalt && envSalt === OLD_ENCRYPTION_SALT) {
      console.warn(
        'WARNING: ENCRYPTION_SALT is set to the old default value. Please change it to a secure random string.',
      );
    }
    _encryptionSalt = readOrGenerateSecret(
      '.encryption_salt',
      envSalt && envSalt !== OLD_ENCRYPTION_SALT ? envSalt : undefined,
    );
  }
  return _encryptionSalt;
}

/**
 * Derive the AES-256 encryption key from the encryption secret and salt.
 * This replaces the old hardcoded key derivation in encryption.ts.
 */
export function getEncryptionKey(): Buffer {
  return crypto.scryptSync(getEncryptionSecret(), getEncryptionSalt(), 32);
}

/**
 * Derive the old AES-256 encryption key (for migration purposes).
 * Uses the old hardcoded secret and salt.
 */
export function getOldEncryptionKey(): Buffer {
  return crypto.scryptSync(OLD_ENCRYPTION_SECRET, OLD_ENCRYPTION_SALT, 32);
}

/**
 * Check if we need to migrate API keys from old encryption to new.
 * Returns true if the old default encryption was likely used.
 */
export function needsEncryptionMigration(): boolean {
  const secretFile = path.join(DATA_DIR, '.encryption_secret');
  const migratedFile = path.join(DATA_DIR, '.encryption_migrated');

  // If already migrated, no need
  if (fs.existsSync(migratedFile)) return false;

  // If a new secret was generated (file exists), we may need migration
  if (fs.existsSync(secretFile)) return true;

  // If env var is set and different from old default, may need migration
  if (process.env.ENCRYPTION_SECRET && process.env.ENCRYPTION_SECRET !== OLD_ENCRYPTION_SECRET) return true;

  return false;
}

/**
 * Mark encryption migration as complete.
 */
export function markEncryptionMigrated(): void {
  ensureDataDir();
  const migratedFile = path.join(DATA_DIR, '.encryption_migrated');
  fs.writeFileSync(migratedFile, new Date().toISOString(), { mode: 0o600 });
}

/**
 * Check if the old default JWT secret was used (for warning purposes).
 */
export function isOldDefaultJwtSecret(): boolean {
  const envSecret = process.env.JWT_SECRET;
  const secretFile = path.join(DATA_DIR, '.jwt_secret');
  // If env is set to old default and no file exists, the old default is in use
  return !envSecret && !fs.existsSync(secretFile);
}
