import { describe, it, expect } from 'vitest';
import { ImportError, detectFormat, importDataset, parseCsv } from './qualityImport';

/**
 * The import path is where a user's dataset either becomes trustworthy or
 * silently produces a report full of mystery errors. These tests pin the
 * behaviour that matters: bad rows are reported with their line number, and
 * nothing that will not grade correctly gets through as "accepted".
 */

describe('detectFormat', () => {
  it('recognises JSON payloads and falls back to CSV', () => {
    expect(detectFormat('{"input":"a"}')).toBe('jsonl');
    expect(detectFormat('  [ {"input":"a"} ]')).toBe('jsonl');
    expect(detectFormat('input,expected\na,b')).toBe('csv');
    expect(detectFormat('"input","expected"\n"a","b"')).toBe('csv');
  });
});

describe('parseCsv', () => {
  it('handles quoted fields, embedded commas, newlines and escaped quotes', () => {
    const rows = parseCsv('a,b,c\n"x,1","line\nbreak","say ""hi"""\n');
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['x,1', 'line\nbreak', 'say "hi"'],
    ]);
  });

  it('drops blank lines and tolerates CRLF', () => {
    expect(parseCsv('a,b\r\n1,2\r\n\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});

describe('importDataset — JSONL', () => {
  it('accepts one JSON object per line', () => {
    const text = [
      '{"input":"What is 2+2?","expected":"4","grader":"numeric_tolerance"}',
      '{"input":"Capital of France?","expected":"Paris"}',
    ].join('\n');

    const preview = importDataset(text, 'import');
    expect(preview.format).toBe('jsonl');
    expect(preview.totalRows).toBe(2);
    expect(preview.accepted).toBe(2);
    expect(preview.rejected).toBe(0);
    // `grader` defaults to exact when omitted.
    expect(preview.samples[1].grader).toBe('exact');
  });

  it('accepts a JSON array as well', () => {
    const preview = importDataset('[{"input":"a","expected":"a"},{"input":"b","expected":"b"}]', 'import');
    expect(preview.accepted).toBe(2);
  });

  it('reports the offending line number and keeps the good rows', () => {
    const text = [
      '{"input":"good one","expected":"x"}',
      '{"expected":"missing input"}',
      'not json at all',
      '{"input":"good two","expected":"y"}',
    ].join('\n');

    const preview = importDataset(text, 'import');
    expect(preview.totalRows).toBe(4);
    expect(preview.accepted).toBe(2);
    expect(preview.rejected).toBe(2);

    const errors = preview.issues.filter((i) => i.level === 'error');
    expect(errors.map((i) => i.row)).toEqual([2, 3]);
    expect(errors[0].message).toContain('missing "input"');
    expect(errors[1].message).toContain('not valid JSON');
  });

  it('rejects an unknown grader', () => {
    const preview = importDataset('{"input":"a","expected":"b","grader":"vibes"}', 'import');
    expect(preview.accepted).toBe(0);
    expect(preview.issues[0].message).toContain('unknown grader');
  });

  it('runs the static preflight so an ungradable row never reaches the database', () => {
    const preview = importDataset('{"input":"a","expected":"eighteen","grader":"numeric_tolerance"}', 'import');
    expect(preview.accepted).toBe(0);
    expect(preview.issues[0].message).toContain('contains no number');
  });

  it('rejects rows whose grader has no reference answer', () => {
    const preview = importDataset('{"input":"a","grader":"exact"}', 'import');
    expect(preview.accepted).toBe(0);
    expect(preview.issues[0].message).toContain('requires an expected answer');
  });

  it('rejects a malformed graderConfig', () => {
    const preview = importDataset('{"input":"a","grader":"regex","graderConfig":"{oops"}', 'import');
    expect(preview.accepted).toBe(0);
    expect(preview.issues[0].message).toContain('not valid JSON');
  });

  it('refuses a payload above the row cap', () => {
    const rows = Array.from({ length: 2001 }, (_, i) => `{"input":"q${i}","expected":"a"}`).join('\n');
    expect(() => importDataset(rows, 'import')).toThrow(ImportError);
  });
});

describe('importDataset — CSV', () => {
  it('maps header aliases and parses a quoted field', () => {
    const csv = [
      'question,answer,grader,category',
      'What is 2+2?,4,numeric_tolerance,math',
      '"List the cities: Hangzhou, Nanjing","杭州,南京",set_match,geo',
    ].join('\n');

    const preview = importDataset(csv, 'import');
    expect(preview.format).toBe('csv');
    expect(preview.accepted).toBe(2);
    expect(preview.samples[0].input).toBe('What is 2+2?');
    expect(preview.samples[0].expected).toBe('4');
    expect(preview.samples[0].category).toBe('math');
    // The quoted input keeps its embedded comma.
    expect(preview.samples[1].input).toContain('Hangzhou, Nanjing');
  });

  it('parses graderConfig supplied as a JSON string', () => {
    const csv = ['input,expected,grader,graderConfig', 'Q,18,numeric_tolerance,"{""tolerance"":0,""pick"":""last""}"'].join('\n');
    const preview = importDataset(csv, 'import');
    expect(preview.accepted).toBe(1);
    expect(preview.samples[0].graderConfig).toEqual({ tolerance: 0, pick: 'last' });
  });

  it('reports data rows with header-adjusted line numbers', () => {
    const csv = ['input,expected', 'ok,ok', ',missing input'].join('\n');
    const preview = importDataset(csv, 'import');
    expect(preview.accepted).toBe(1);
    // Row 2 is the first data row, so the bad one is row 3 in the file.
    expect(preview.issues.find((i) => i.level === 'error')?.row).toBe(3);
  });

  it('requires an input column and rejects an empty file', () => {
    expect(() => importDataset('foo,bar\n1,2', 'import')).toThrow(/must contain an "input" column/);
    expect(() => importDataset('   ', 'import')).toThrow(ImportError);
  });
});

describe('importDataset — report shape', () => {
  it('summarises the graders in use so the user can sanity-check coverage', () => {
    const text = [
      '{"input":"a","expected":"1","grader":"numeric_tolerance"}',
      '{"input":"b","expected":"b","grader":"exact"}',
      '{"input":"c","expected":"c","grader":"exact"}',
    ].join('\n');

    const preview = importDataset(text, 'import');
    const note = preview.issues.find((i) => i.level === 'warning');
    expect(note?.message).toContain('exact×2');
    expect(note?.message).toContain('numeric_tolerance×1');
  });

  it('numbers imported samples from the source slug', () => {
    const preview = importDataset('{"input":"a","expected":"a"}\n{"input":"b","expected":"b"}', 'import');
    expect(preview.samples.map((s) => s.id)).toEqual(['import#1', 'import#2']);
  });
});
