import { describe, it, expect } from 'vitest';
import { escapeCsvField, toCsvRow } from './csv';

describe('escapeCsvField — basic coercion', () => {
  it('returns empty string for null', () => {
    expect(escapeCsvField(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(escapeCsvField(undefined)).toBe('');
  });

  it('returns empty string for empty string', () => {
    expect(escapeCsvField('')).toBe('');
  });

  it('coerces number to string', () => {
    expect(escapeCsvField(42)).toBe('42');
    expect(escapeCsvField(0)).toBe('0');
    expect(escapeCsvField(-1)).toBe('-1');
    expect(escapeCsvField(3.14)).toBe('3.14');
    expect(escapeCsvField(Number.NaN)).toBe('NaN');
    expect(escapeCsvField(Number.POSITIVE_INFINITY)).toBe('Infinity');
  });

  it('coerces boolean to string', () => {
    expect(escapeCsvField(true)).toBe('true');
    expect(escapeCsvField(false)).toBe('false');
  });

  it('coerces objects to "[object Object]"', () => {
    expect(escapeCsvField({})).toBe('[object Object]');
  });

  it('coerces arrays via String() (comma-separated → triggers quoting)', () => {
    // String([1,2,3]) === '1,2,3' which contains commas and must be quoted
    expect(escapeCsvField([1, 2, 3])).toBe('"1,2,3"');
  });

  it('passes through plain text unchanged', () => {
    expect(escapeCsvField('hello')).toBe('hello');
    expect(escapeCsvField('hello world')).toBe('hello world');
  });
});

describe('escapeCsvField — RFC 4180 special characters', () => {
  it('quotes a string containing a comma', () => {
    expect(escapeCsvField('a,b')).toBe('"a,b"');
  });

  it('quotes a string containing a double quote and escapes it by doubling', () => {
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
  });

  it('quotes a string containing a newline', () => {
    expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"');
  });

  it('quotes a string containing a carriage return', () => {
    expect(escapeCsvField('line1\rline2')).toBe('"line1\rline2"');
  });

  it('quotes a string containing CRLF', () => {
    expect(escapeCsvField('a\r\nb')).toBe('"a\r\nb"');
  });

  it('quotes a string containing all four special chars at once', () => {
    expect(escapeCsvField('a,"b"\nc\r')).toBe('"a,""b""\nc\r"');
  });

  it('handles a string that is only a single double quote', () => {
    expect(escapeCsvField('"')).toBe('""""');
  });

  it('handles a string that is only a single comma', () => {
    expect(escapeCsvField(',')).toBe('","');
  });

  it('handles consecutive double quotes', () => {
    expect(escapeCsvField('""')).toBe('""""""');
  });

  it('does not quote leading/trailing whitespace (no special char trigger)', () => {
    // RFC 4180 allows leading/trailing whitespace; this implementation does not quote them.
    expect(escapeCsvField('  spaced  ')).toBe('  spaced  ');
  });

  it('does not quote a string with a tab character (tab is not a special char)', () => {
    expect(escapeCsvField('a\tb')).toBe('a\tb');
  });

  it('preserves Unicode characters unchanged', () => {
    expect(escapeCsvField('café')).toBe('café');
    expect(escapeCsvField('中文')).toBe('中文');
    expect(escapeCsvField('🚀')).toBe('🚀');
  });

  it('quotes Unicode string containing a comma', () => {
    expect(escapeCsvField('中,文')).toBe('"中,文"');
  });
});

describe('toCsvRow', () => {
  it('joins simple fields with commas', () => {
    expect(toCsvRow(['a', 'b', 'c'])).toBe('a,b,c');
  });

  it('returns empty string for empty array', () => {
    expect(toCsvRow([])).toBe('');
  });

  it('preserves a single field', () => {
    expect(toCsvRow(['only'])).toBe('only');
  });

  it('treats consecutive empty fields as empty', () => {
    expect(toCsvRow(['', '', ''])).toBe(',,');
  });

  it('quotes fields containing commas inside a row', () => {
    expect(toCsvRow(['a', 'b,c', 'd'])).toBe('a,"b,c",d');
  });

  it('mixes coerced and escaped fields', () => {
    expect(toCsvRow([1, 'with,comma', null, true, '"quoted"'])).toBe('1,"with,comma",,true,"""quoted"""');
  });

  it('handles a row whose every cell needs escaping', () => {
    expect(toCsvRow([',', '"', '\n', '\r'])).toBe('",","""","\n","\r"');
  });

  it('coerces undefined to empty cell', () => {
    expect(toCsvRow(['a', undefined, 'b'])).toBe('a,,b');
  });

  it('does not interpret existing quotes in non-special fields as escapes', () => {
    // 'a"b' contains a quote — the whole cell gets quoted, internal quote doubled
    expect(toCsvRow(['a"b'])).toBe('"a""b"');
  });

  it('produces a parseable row when concatenated with \\n (smoke check)', () => {
    const row1 = toCsvRow(['name', 'note']);
    const row2 = toCsvRow(['alice', 'has, comma']);
    const row3 = toCsvRow(['bob', 'has "quote"']);
    const csv = [row1, row2, row3].join('\n');
    // Spot-check structure
    expect(csv.split('\n').length).toBe(3);
    expect(csv).toContain('"has, comma"');
    expect(csv).toContain('"has ""quote"""');
  });
});
