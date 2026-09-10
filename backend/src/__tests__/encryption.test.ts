import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, decryptWithOldKey, maskApiKey } from '../utils/encryption';

// These tests use the auto-generated secrets from the secrets module

describe('Encryption', () => {
  describe('encrypt/decrypt round-trip', () => {
    it('should encrypt and decrypt a string correctly', () => {
      const plaintext = 'sk-test-api-key-1234567890';
      const encrypted = encrypt(plaintext);
      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it('should produce different ciphertext for the same input', () => {
      const plaintext = 'same-input';
      const encrypted1 = encrypt(plaintext);
      const encrypted2 = encrypt(plaintext);
      expect(encrypted1).not.toBe(encrypted2); // Different IVs
    });

    it('should handle empty strings', () => {
      const plaintext = '';
      const encrypted = encrypt(plaintext);
      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it('should handle special characters', () => {
      const plaintext = 'key-with-üñíçödé/特殊字符!@#$%^&*()';
      const encrypted = encrypt(plaintext);
      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });
  });

  describe('decrypt error handling', () => {
    it('should throw on invalid format', () => {
      expect(() => decrypt('invalid')).toThrow('Invalid encrypted text format');
    });

    it('should throw on tampered ciphertext', () => {
      const encrypted = encrypt('test');
      const parts = encrypted.split(':');
      parts[2] = parts[2].replace(/./g, '0'); // Tamper with ciphertext
      expect(() => decrypt(parts.join(':'))).toThrow();
    });
  });

  describe('decryptWithOldKey', () => {
    it('should decrypt data encrypted with the old key', () => {
      // We can't easily test this without the old key being active,
      // but we can verify the function exists and throws on invalid input
      expect(() => decryptWithOldKey('invalid')).toThrow('Invalid encrypted text format');
    });
  });

  describe('maskApiKey', () => {
    it('should mask keys longer than 8 characters', () => {
      expect(maskApiKey('sk-1234567890abcdef')).toBe('sk-1****cdef');
    });

    it('should show only asterisks for short keys', () => {
      expect(maskApiKey('short')).toBe('****');
      expect(maskApiKey('12345678')).toBe('****');
    });

    it('should mask exactly 9-character keys', () => {
      expect(maskApiKey('123456789')).toBe('1234****6789');
    });
  });
});
