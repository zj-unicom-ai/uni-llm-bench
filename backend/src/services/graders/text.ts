import { GraderConfig } from '../../types';
import { normalizeText } from './normalize';
import { Grader, GraderInput, abbreviate, collectCandidates, errorResult, failResult, passResult } from './types';

/**
 * Text graders: `exact`, `contains`, `regex`.
 *
 * All three compare the raw output against the sample's reference answer (or
 * explicit `patterns`). `exact` and `contains` compare normalized text — case
 * and incidental whitespace are not quality signals. `regex` runs against the
 * untouched output, because a pattern author is writing against the real bytes.
 */

export const exactGrader: Grader = ({ output, expected, config }: GraderInput) => {
  const candidates = collectCandidates(expected, config);
  if (candidates.length === 0) {
    return errorResult('quality.grade.missingExpected', 'exact: no reference answer and no accepted alternatives');
  }

  const normalized = normalizeText(output, config);
  if (normalized.length === 0) {
    return failResult('quality.grade.emptyOutput', `exact: output is empty, expected "${abbreviate(candidates[0])}"`, {
      expected: abbreviate(candidates[0]),
    });
  }

  const hit = candidates.find((candidate) => normalizeText(candidate, config) === normalized);
  if (hit !== undefined) {
    return passResult('quality.grade.exact.match', `exact: matched "${abbreviate(hit)}"`, {
      expected: abbreviate(hit),
      output: abbreviate(output),
    });
  }

  return failResult(
    'quality.grade.exact.mismatch',
    `exact: output "${abbreviate(output)}" != expected "${abbreviate(candidates[0])}"`,
    { output: abbreviate(output), expected: abbreviate(candidates[0]) },
  );
};

export const containsGrader: Grader = ({ output, expected, config }: GraderInput) => {
  const candidates = collectCandidates(expected, config);
  const needles = candidates.map((candidate) => normalizeText(candidate, config)).filter((n) => n.length > 0);
  if (needles.length === 0) {
    return errorResult('quality.grade.missingPatterns', 'contains: no non-empty pattern to look for');
  }

  const haystack = normalizeText(output, config);
  const missing = needles.filter((needle) => !haystack.includes(needle));
  const mode = config.mode ?? 'all';

  if (mode === 'any') {
    if (missing.length < needles.length) {
      const hit = needles.find((needle) => haystack.includes(needle))!;
      return passResult('quality.grade.contains.hit', `contains: found "${abbreviate(hit)}" (any-of mode)`, {
        matched: 1,
        total: needles.length,
      });
    }
    return failResult(
      'quality.grade.contains.miss',
      `contains: none of ${needles.length} patterns matched; output "${abbreviate(output)}"`,
      { missing: abbreviate(missing.join(' | ')), total: needles.length },
    );
  }

  if (missing.length === 0) {
    return passResult('quality.grade.contains.hit', `contains: all ${needles.length} patterns matched`, {
      matched: needles.length,
      total: needles.length,
    });
  }

  return failResult(
    'quality.grade.contains.miss',
    `contains: missing ${missing.length}/${needles.length} — "${abbreviate(missing.join(' | '))}"`,
    { missing: abbreviate(missing.join(' | ')), total: needles.length },
  );
};

export const regexGrader: Grader = ({ output, expected, config }: GraderInput) => {
  const sources = collectCandidates(expected, config);
  if (sources.length === 0) {
    return errorResult('quality.grade.missingPatterns', 'regex: no pattern to match');
  }

  const flags = config.caseSensitive ? '' : 'i';
  const compiled: RegExp[] = [];
  for (const source of sources) {
    try {
      compiled.push(new RegExp(source, flags));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'invalid pattern';
      return errorResult('quality.grade.invalidRegex', `regex: /${source}/ is not a valid pattern — ${message}`, {
        pattern: abbreviate(source, 40),
        error: message,
      });
    }
  }

  const missed = compiled.filter((re) => !re.test(output));
  const mode = config.mode ?? 'all';

  if (mode === 'any') {
    if (missed.length < compiled.length) {
      return passResult('quality.grade.regex.hit', `regex: 1 of ${compiled.length} patterns matched (any-of mode)`, {
        matched: compiled.length - missed.length,
        total: compiled.length,
      });
    }
    return failResult('quality.grade.regex.miss', `regex: none of ${compiled.length} patterns matched`, {
      total: compiled.length,
      output: abbreviate(output),
    });
  }

  if (missed.length === 0) {
    return passResult('quality.grade.regex.hit', `regex: all ${compiled.length} patterns matched`, {
      matched: compiled.length,
      total: compiled.length,
    });
  }

  return failResult(
    'quality.grade.regex.miss',
    `regex: ${missed.length}/${compiled.length} patterns missed`,
    { missing: missed.length, total: compiled.length, output: abbreviate(output) },
  );
};

/** Convenience for tests and the registry. */
export const TEXT_GRADERS = {
  exact: exactGrader,
  contains: containsGrader,
  regex: regexGrader,
} satisfies Record<string, Grader>;

export type TextGraderConfig = GraderConfig;
