import { describe, it, expect } from 'vitest';
import en from './en.json';
import zh from './zh.json';

function flattenKeys(obj: Record<string, any>, prefix = ''): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'object' && value !== null) {
      keys.push(...flattenKeys(value, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}

describe('i18n translation files', () => {
  it('en.json and zh.json have identical keys', () => {
    const enKeys = new Set(flattenKeys(en));
    const zhKeys = new Set(flattenKeys(zh));

    const missingInZh = [...enKeys].filter((k) => !zhKeys.has(k));
    const missingInEn = [...zhKeys].filter((k) => !enKeys.has(k));

    expect(missingInZh, 'Keys missing in zh.json').toEqual([]);
    expect(missingInEn, 'Keys missing in en.json').toEqual([]);
  });

  it('has no empty values in en.json', () => {
    const enKeys = flattenKeys(en);
    for (const key of enKeys) {
      const parts = key.split('.');
      let val: Record<string, unknown> = en;
      for (const p of parts) val = val[p] as Record<string, unknown>;
      expect(val, `en.json key "${key}" should not be empty`).toBeTruthy();
    }
  });

  it('has no empty values in zh.json', () => {
    const zhKeys = flattenKeys(zh);
    for (const key of zhKeys) {
      const parts = key.split('.');
      let val: Record<string, unknown> = zh;
      for (const p of parts) val = val[p] as Record<string, unknown>;
      expect(val, `zh.json key "${key}" should not be empty`).toBeTruthy();
    }
  });
});
