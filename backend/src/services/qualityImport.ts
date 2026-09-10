import { GraderType, QualitySample } from '../types';
import { isGraderType, preflightSample } from './graders';

/**
 * Dataset import: JSONL / JSON array / CSV → validated samples.
 *
 * Returns a *report* alongside the parsed rows rather than throwing on the first
 * bad line. A user uploading 200 questions needs to know that rows 7, 44 and 190
 * will not grade as expected — silently importing them would produce a report
 * with a handful of mysterious errors and no explanation.
 */

export type ImportFormat = 'jsonl' | 'csv';

export interface ImportIssue {
  /** 1-based row number in the uploaded file (header excluded for CSV). */
  row: number;
  level: 'error' | 'warning';
  message: string;
}

export interface ImportPreview {
  format: ImportFormat;
  totalRows: number;
  accepted: number;
  rejected: number;
  /** Only the rows that passed validation, in file order. */
  samples: QualitySample[];
  issues: ImportIssue[];
}

/** Refuse anything that would make the import endpoint a memory hazard. */
const MAX_ROWS = 2000;
const MAX_FIELD_LENGTH = 20_000;

export class ImportError extends Error {}

/* -------------------------------------------------------------------------- */
/* CSV — minimal RFC 4180 reader                                              */
/* -------------------------------------------------------------------------- */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let index = 0;

  while (index < text.length) {
    const ch = text[index];

    if (inQuotes) {
      if (ch === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += ch;
      index += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      index += 1;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      index += 1;
      continue;
    }
    if (ch === '\r') {
      index += 1;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      index += 1;
      continue;
    }
    field += ch;
    index += 1;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim().length > 0));
}

const HEADER_ALIASES: Record<string, string> = {
  input: 'input',
  prompt: 'input',
  question: 'input',
  query: 'input',
  expected: 'expected',
  answer: 'expected',
  target: 'expected',
  label: 'expected',
  grader: 'grader',
  gradertype: 'grader',
  category: 'category',
  systemprompt: 'systemPrompt',
  graderconfig: 'graderConfig',
  config: 'graderConfig',
};

/* -------------------------------------------------------------------------- */
/* Row → sample                                                               */
/* -------------------------------------------------------------------------- */

interface RawRow {
  input?: unknown;
  expected?: unknown;
  systemPrompt?: unknown;
  grader?: unknown;
  graderConfig?: unknown;
  category?: unknown;
}

function asString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function buildSample(raw: RawRow, id: string, issues: ImportIssue[], row: number): QualitySample | null {
  const input = asString(raw.input);
  if (!input || input.trim().length === 0) {
    issues.push({ row, level: 'error', message: 'missing "input"' });
    return null;
  }
  if (input.length > MAX_FIELD_LENGTH) {
    issues.push({ row, level: 'error', message: `"input" exceeds ${MAX_FIELD_LENGTH} characters` });
    return null;
  }

  const graderRaw = asString(raw.grader) ?? 'exact';
  if (!isGraderType(graderRaw)) {
    issues.push({ row, level: 'error', message: `unknown grader "${graderRaw}"` });
    return null;
  }

  let graderConfig: QualitySample['graderConfig'];
  if (raw.graderConfig !== undefined && raw.graderConfig !== null && raw.graderConfig !== '') {
    if (typeof raw.graderConfig === 'string') {
      try {
        graderConfig = JSON.parse(raw.graderConfig) as QualitySample['graderConfig'];
      } catch (err) {
        issues.push({
          row,
          level: 'error',
          message: `"graderConfig" is not valid JSON — ${err instanceof Error ? err.message : 'parse error'}`,
        });
        return null;
      }
    } else if (typeof raw.graderConfig === 'object' && !Array.isArray(raw.graderConfig)) {
      graderConfig = raw.graderConfig as QualitySample['graderConfig'];
    } else {
      issues.push({ row, level: 'error', message: '"graderConfig" must be a JSON object' });
      return null;
    }
  }

  const sample: QualitySample = {
    id,
    input,
    grader: graderRaw as GraderType,
  };
  const expected = asString(raw.expected);
  if (expected !== undefined) sample.expected = expected;
  const systemPrompt = asString(raw.systemPrompt);
  if (systemPrompt !== undefined) sample.systemPrompt = systemPrompt;
  const category = asString(raw.category);
  if (category !== undefined) sample.category = category;
  if (graderConfig !== undefined) sample.graderConfig = graderConfig;

  // Static validity check — catches an unparsable reference answer or a broken
  // regex before it costs a single token.
  const problems = preflightSample(sample);
  if (problems.length > 0) {
    issues.push({ row, level: 'error', message: problems.join('; ') });
    return null;
  }

  return sample;
}

/* -------------------------------------------------------------------------- */
/* Entry points                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Detect the format from the payload: an array literal or one JSON object per
 * line is JSON; anything else goes through the CSV reader.
 */
export function detectFormat(text: string): ImportFormat {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    // A single JSON object starting with `{` on its own line is still JSONL.
    return 'jsonl';
  }
  return 'csv';
}

export function importDataset(text: string, source: string, formatHint?: ImportFormat): ImportPreview {
  const format = formatHint ?? detectFormat(text);
  const issues: ImportIssue[] = [];
  const samples: QualitySample[] = [];
  // Assigned in both branches below; declared without a placeholder so the
  // type-checker can prove every path sets it.
  let totalRows: number;

  if (format === 'jsonl') {
    const trimmed = text.trim();
    let rows: unknown[];

    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (!Array.isArray(parsed)) throw new ImportError('top-level JSON value must be an array');
        rows = parsed;
      } catch (err) {
        throw new ImportError(`invalid JSON array — ${err instanceof Error ? err.message : 'parse error'}`);
      }
    } else {
      rows = [];
      for (const line of trimmed.split(/\r?\n/)) {
        if (line.trim().length === 0) continue;
        try {
          rows.push(JSON.parse(line));
        } catch (err) {
          issues.push({
            row: rows.length + 1,
            level: 'error',
            message: `not valid JSON — ${err instanceof Error ? err.message : 'parse error'}`,
          });
          rows.push(null);
        }
      }
    }

    totalRows = rows.length;
    if (totalRows > MAX_ROWS) {
      throw new ImportError(`too many rows (${totalRows}); the limit is ${MAX_ROWS}`);
    }

    rows.forEach((row, index) => {
      const rowNumber = index + 1;
      if (row === null || row === undefined) return;
      if (typeof row !== 'object' || Array.isArray(row)) {
        issues.push({ row: rowNumber, level: 'error', message: 'each row must be a JSON object' });
        return;
      }
      const sample = buildSample(row as RawRow, `${source}#${rowNumber}`, issues, rowNumber);
      if (sample) samples.push(sample);
    });
  } else {
    const rows = parseCsv(text);
    if (rows.length === 0) throw new ImportError('the uploaded file is empty');

    const header = rows[0].map((cell) => HEADER_ALIASES[cell.trim().toLowerCase().replace(/[\s_-]/g, '')] ?? '');
    if (!header.includes('input')) {
      throw new ImportError('the header row must contain an "input" column (aliases: prompt, question, query)');
    }

    const dataRows = rows.slice(1);
    totalRows = dataRows.length;
    if (totalRows > MAX_ROWS) {
      throw new ImportError(`too many rows (${totalRows}); the limit is ${MAX_ROWS}`);
    }

    dataRows.forEach((cells, index) => {
      const rowNumber = index + 2; // +1 for the header, +1 for 1-based numbering
      const raw: RawRow = {};
      header.forEach((column, columnIndex) => {
        if (!column) return;
        const value = cells[columnIndex];
        if (value !== undefined && value !== '') (raw as Record<string, unknown>)[column] = value;
      });
      const sample = buildSample(raw, `${source}#${index + 1}`, issues, rowNumber);
      if (sample) samples.push(sample);
    });
  }

  // Grader coverage is useful context even when nothing failed validation.
  const graderTally = new Map<string, number>();
  for (const sample of samples) graderTally.set(sample.grader, (graderTally.get(sample.grader) ?? 0) + 1);
  if (samples.length > 0) {
    const spread = [...graderTally.entries()].map(([grader, count]) => `${grader}×${count}`).join(', ');
    issues.push({ row: 0, level: 'warning', message: `graders in use: ${spread}` });
  }

  // Rows are discovered in two passes (JSON parse failures while reading, schema
  // failures while validating), so sort into file order. A report that lists line
  // 3 before line 2 is needlessly confusing. The row-0 summary note goes last.
  issues.sort((a, b) => {
    if (a.row === 0) return 1;
    if (b.row === 0) return -1;
    return a.row - b.row;
  });

  return {
    format,
    totalRows,
    accepted: samples.length,
    rejected: totalRows - samples.length,
    samples,
    issues,
  };
}
