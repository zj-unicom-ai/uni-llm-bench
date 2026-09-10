import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// === Pure function tests ===
// These functions are not exported, so we re-implement them here exactly as in the source
// and test their logic. This mirrors the inline-reimplementation pattern used for UI unit tests.

function getStatusTagColor(status: string): string {
  switch (status) {
    case 'completed':
      return 'success';
    case 'running':
      return 'processing';
    case 'failed':
      return 'error';
    case 'skipped':
      return 'default';
    default:
      return 'default';
  }
}

function getTimelineItemColor(status: string): string {
  switch (status) {
    case 'completed':
      return 'green';
    case 'running':
      return 'blue';
    case 'failed':
      return 'red';
    case 'skipped':
      return 'gray';
    default:
      return 'gray';
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatRT(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

describe('WorkflowProgress helpers', () => {
  describe('getStatusTagColor', () => {
    it('maps all known statuses', () => {
      expect(getStatusTagColor('completed')).toBe('success');
      expect(getStatusTagColor('running')).toBe('processing');
      expect(getStatusTagColor('failed')).toBe('error');
      expect(getStatusTagColor('skipped')).toBe('default');
    });

    it('returns default for unknown status', () => {
      expect(getStatusTagColor('unknown')).toBe('default');
      expect(getStatusTagColor('')).toBe('default');
    });
  });

  describe('getTimelineItemColor', () => {
    it('maps all known statuses', () => {
      expect(getTimelineItemColor('completed')).toBe('green');
      expect(getTimelineItemColor('running')).toBe('blue');
      expect(getTimelineItemColor('failed')).toBe('red');
      expect(getTimelineItemColor('skipped')).toBe('gray');
    });

    it('returns gray for unknown status', () => {
      expect(getTimelineItemColor('pending')).toBe('gray');
    });
  });

  describe('formatDuration', () => {
    it('formats milliseconds', () => {
      expect(formatDuration(0)).toBe('0ms');
      expect(formatDuration(500)).toBe('500ms');
      expect(formatDuration(999)).toBe('999ms');
    });

    it('formats seconds', () => {
      expect(formatDuration(1000)).toBe('1s');
      expect(formatDuration(30000)).toBe('30s');
      expect(formatDuration(59999)).toBe('59s');
    });

    it('formats minutes and seconds', () => {
      expect(formatDuration(60000)).toBe('1m 0s');
      expect(formatDuration(90000)).toBe('1m 30s');
      expect(formatDuration(3599000)).toBe('59m 59s');
    });

    it('formats hours and minutes', () => {
      expect(formatDuration(3600000)).toBe('1h 0m');
      expect(formatDuration(5400000)).toBe('1h 30m');
      expect(formatDuration(7200000)).toBe('2h 0m');
    });
  });

  describe('formatDate', () => {
    it('formats ISO string to YYYY-MM-DD HH:MM:SS', () => {
      // Use a fixed timezone-independent test
      const result = formatDate('2026-01-15T00:00:00.000Z');
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });

    it('pads single-digit months and days', () => {
      const result = formatDate('2026-01-05T03:07:09.000Z');
      expect(result).toMatch(/\d{4}-01-05 \d{2}:\d{2}:\d{2}/);
    });
  });

  describe('formatRT', () => {
    it('formats ms for < 1000', () => {
      expect(formatRT(0)).toBe('0ms');
      expect(formatRT(500)).toBe('500ms');
      expect(formatRT(999)).toBe('999ms');
    });

    it('formats seconds for >= 1000', () => {
      expect(formatRT(1000)).toBe('1.0s');
      expect(formatRT(1500)).toBe('1.5s');
      expect(formatRT(2345)).toBe('2.3s');
    });
  });
});

// === REGRESSION TEST: antd Timeline API (QA bug #2) ===
describe('regression: Timeline uses v6 API', () => {
  it('source code uses icon/content, not deprecated dot/children', () => {
    const sourceFile = path.resolve(__dirname, 'WorkflowProgress.tsx');
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // The Timeline items builder should use v6 props
    // Look for the pattern inside the items mapping (not in comments)
    const lines = source.split('\n');
    const codeLines = lines.filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'));
    const code = codeLines.join('\n');

    // Should NOT have deprecated props in code (outside comments)
    // Match "dot:" as a property assignment in the items object
    const hasDotProp = /\bdot\s*:/.test(code);
    const hasChildrenProp = /\bchildren\s*:/.test(code);

    // Should have new props
    const hasIconProp = /\bicon\s*:/.test(code);
    const hasContentProp = /\bcontent\s*:/.test(code);

    expect(hasDotProp).toBe(false);
    expect(hasChildrenProp).toBe(false);
    expect(hasIconProp).toBe(true);
    expect(hasContentProp).toBe(true);
  });
});
