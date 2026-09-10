import { GraderConfig, GradeResult } from '../../types';

/**
 * Contract every L1 grader implements.
 *
 * A grader must never throw and must never guess. When it cannot reach a
 * verdict it returns `error`, which is reported separately from `fail` all the
 * way up to the report. A grader that swallows its own failure and returns
 * `fail` would silently turn "we could not measure this" into "the model got it
 * wrong" — exactly the failure mode this project exists to avoid.
 */
export interface GraderInput {
  /** Raw model output, exactly as returned by the provider. */
  output: string;
  /** Reference answer from the dataset, when one is required. */
  expected?: string;
  config: GraderConfig;
}

export type Grader = (input: GraderInput) => GradeResult;

export const passResult = (detailKey: string, detail: string, params?: GradeResult['params']): GradeResult => ({
  status: 'pass',
  score: 1,
  detailKey,
  params,
  detail,
});

export const failResult = (detailKey: string, detail: string, params?: GradeResult['params']): GradeResult => ({
  status: 'fail',
  score: 0,
  detailKey,
  params,
  detail,
});

export const errorResult = (detailKey: string, detail: string, params?: GradeResult['params']): GradeResult => ({
  status: 'error',
  score: null,
  detailKey,
  params,
  detail,
});

/** Shorten an arbitrary string for inclusion in a justification line. */
export function abbreviate(value: string, max = 80): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/**
 * The list of strings a text grader should match against: explicit `patterns`
 * when present, otherwise the sample's reference answer plus any `accepted`
 * alternatives. Order matters only for reporting.
 */
export function collectCandidates(expected: string | undefined, config: GraderConfig): string[] {
  if (config.patterns && config.patterns.length > 0) return config.patterns;
  const list: string[] = [];
  if (expected !== undefined && expected.length > 0) list.push(expected);
  if (config.accepted) list.push(...config.accepted);
  return list;
}
