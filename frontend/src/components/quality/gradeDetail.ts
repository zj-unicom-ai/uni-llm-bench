import type { TFunction } from 'i18next';
import { GraderType, QualitySampleResult } from '../../types';

/**
 * Render a grader's justification in the active language.
 *
 * The backend ships a fixed `detailKey` plus the evidence values that were
 * actually compared, and a raw English `detail` string. Translation is used when
 * the key exists; otherwise the raw line is shown rather than a blank cell.
 * Exports always carry the raw string, so a translated UI never changes what the
 * artifact says.
 */
export function gradeDetailText(t: TFunction, result: QualitySampleResult): string {
  const translated = t(result.detailKey, { ...(result.params ?? {}), defaultValue: '' });
  return translated && translated !== result.detailKey ? translated : result.detail;
}

export function graderLabel(t: TFunction, grader: GraderType): string {
  return t(`quality.grader.${grader}`, { defaultValue: grader });
}

export const STATUS_TAG_COLOR: Record<QualitySampleResult['status'], string> = {
  pass: 'green',
  fail: 'red',
  error: 'orange',
};

export function formatPercent(value: number | null, fallback: string): string {
  return value === null ? fallback : `${(value * 100).toFixed(1)}%`;
}

export function formatCost(value: number): string {
  if (value === 0) return '—';
  return value < 0.01 ? `$${value.toFixed(6)}` : `$${value.toFixed(4)}`;
}

export function formatMs(value: number): string {
  return value === 0 ? '—' : `${Math.round(value)} ms`;
}

/**
 * Local timestamp for a stored ISO string.
 *
 * Shared by the history table and the historical-report drawer so a run is
 * labelled identically in both places.
 */
export function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}
