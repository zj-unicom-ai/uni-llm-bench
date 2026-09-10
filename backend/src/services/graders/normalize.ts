import { GraderConfig } from '../../types';

/**
 * Shared text normalization for the L1 graders.
 *
 * Every text comparison in the quality module funnels through `normalizeText`
 * so that "wrong" always means the same thing. Defaults are deliberately
 * forgiving (case-insensitive, whitespace collapsed) because trailing
 * whitespace and capitalisation are not model quality signals.
 */

/** ASCII punctuation plus the CJK marks a Chinese answer is likely to use. */
const PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~。，、；：？！「」『』（）【】《》〈〉…—～·]/g;

export function normalizeText(input: string, config: GraderConfig = {}): string {
  let text = input;
  if (config.trimWhitespace !== false) {
    text = text.replace(/\s+/g, ' ').trim();
  }
  if (config.stripPunctuation) {
    text = text.replace(PUNCTUATION, '');
  }
  if (!config.caseSensitive) {
    text = text.toLowerCase();
  }
  return text;
}

/**
 * Normalize something that may be missing. Returns null instead of the string
 * "undefined" so callers can distinguish "absent" from "literally empty".
 */
export function normalizeOptional(input: string | undefined, config: GraderConfig = {}): string | null {
  if (input === undefined || input === null) return null;
  return normalizeText(input, config);
}

/** Strip a ```json ... ``` fence if the model wrapped its answer in one. */
export function stripCodeFence(input: string): string {
  const trimmed = input.trim();
  const fenced = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

/**
 * Pull the first or last number out of free text.
 *
 * Handles thousands separators (`1,234.5`) and a leading sign. Returns null when
 * the text holds no number at all — the caller must report that as a grader
 * error, not as a wrong answer.
 */
export function extractNumber(input: string, pick: 'first' | 'last' = 'first'): number | null {
  const matches = input.match(/-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?/g);
  if (!matches || matches.length === 0) return null;
  const raw = pick === 'last' ? matches[matches.length - 1] : matches[0];
  const value = Number(raw.replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}
