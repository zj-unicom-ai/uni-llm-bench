import { GradeResult, GraderDescriptor, GraderType, QualitySample } from '../../types';
import { extractNumber } from './normalize';
import { Grader, GraderInput, errorResult, collectCandidates } from './types';
import { containsGrader, exactGrader, regexGrader } from './text';
import { jsonSchemaGrader, multipleChoiceGrader, numericToleranceGrader, setMatchGrader } from './structured';

/**
 * The grader registry. Adding a grader means adding a file and one line here —
 * the engine never learns about individual graders.
 */

export const GRADERS: Record<GraderType, Grader> = {
  exact: exactGrader,
  contains: containsGrader,
  regex: regexGrader,
  numeric_tolerance: numericToleranceGrader,
  json_schema: jsonSchemaGrader,
  multiple_choice: multipleChoiceGrader,
  set_match: setMatchGrader,
};

/** Served to the UI so it can render the right config form per grader. */
export const GRADER_DESCRIPTORS: GraderDescriptor[] = [
  {
    type: 'exact',
    labelKey: 'quality.grader.exact',
    requiresExpected: true,
    configFields: ['accepted', 'caseSensitive', 'trimWhitespace', 'stripPunctuation'],
  },
  {
    type: 'contains',
    // `patterns` is a legitimate substitute for `expected`, so the reference
    // answer is optional here — the switch below checks that one of them exists.
    labelKey: 'quality.grader.contains',
    requiresExpected: false,
    configFields: ['patterns', 'mode', 'caseSensitive', 'trimWhitespace', 'stripPunctuation'],
  },
  {
    type: 'regex',
    labelKey: 'quality.grader.regex',
    requiresExpected: false,
    configFields: ['patterns', 'mode', 'caseSensitive'],
  },
  {
    type: 'numeric_tolerance',
    labelKey: 'quality.grader.numericTolerance',
    requiresExpected: true,
    configFields: ['tolerance', 'pick'],
  },
  {
    type: 'json_schema',
    labelKey: 'quality.grader.jsonSchema',
    requiresExpected: false,
    configFields: ['schema'],
  },
  {
    type: 'multiple_choice',
    labelKey: 'quality.grader.multipleChoice',
    requiresExpected: true,
    configFields: ['choices', 'caseSensitive'],
  },
  {
    type: 'set_match',
    labelKey: 'quality.grader.setMatch',
    requiresExpected: true,
    configFields: ['delimiter', 'setMode', 'caseSensitive'],
  },
];

const GRADER_TYPES = new Set<string>(GRADER_DESCRIPTORS.map((d) => d.type));

export function isGraderType(value: unknown): value is GraderType {
  return typeof value === 'string' && GRADER_TYPES.has(value);
}

/**
 * Grade one sample. Never throws: an unknown grader or a grader that blows up
 * becomes an `error` result, which is counted separately from `fail`.
 */
export function gradeSample(sample: QualitySample, output: string): GradeResult {
  const grader = GRADERS[sample.grader];
  if (!grader) {
    return errorResult('quality.grade.unknownGrader', `unknown grader "${String(sample.grader)}"`, {
      grader: String(sample.grader),
    });
  }
  const input: GraderInput = { output, expected: sample.expected, config: sample.graderConfig ?? {} };
  try {
    return grader(input);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return errorResult('quality.grade.crashed', `grader "${sample.grader}" threw: ${message}`, { error: message });
  }
}

/**
 * Static check of a sample's configuration, with no model output involved.
 * Used by the dataset import path so a broken row is flagged before it burns
 * any tokens. Returns human-readable problems (empty array = fine).
 */
export function preflightSample(sample: QualitySample): string[] {
  const problems: string[] = [];
  const config = sample.graderConfig ?? {};

  if (!isGraderType(sample.grader)) {
    return [`unknown grader "${String(sample.grader)}"`];
  }
  if (!sample.input || sample.input.trim().length === 0) {
    problems.push('input is empty');
  }

  const descriptor = GRADER_DESCRIPTORS.find((d) => d.type === sample.grader)!;
  if (descriptor.requiresExpected && (!sample.expected || sample.expected.trim().length === 0)) {
    problems.push(`grader "${sample.grader}" requires an expected answer`);
    return problems; // everything below depends on `expected`
  }

  switch (sample.grader) {
    case 'regex': {
      const sources = collectCandidates(sample.expected, config);
      if (sources.length === 0) problems.push('no pattern to match');
      const flags = config.caseSensitive ? '' : 'i';
      for (const source of sources) {
        try {
          new RegExp(source, flags);
        } catch (err) {
          problems.push(`invalid regex /${source}/ — ${err instanceof Error ? err.message : 'unknown'}`);
        }
      }
      break;
    }
    case 'contains': {
      const needles = collectCandidates(sample.expected, config).filter((n) => n.trim().length > 0);
      if (needles.length === 0) problems.push('no non-empty pattern to search for');
      break;
    }
    case 'numeric_tolerance': {
      if (extractNumber(sample.expected!, 'first') === null) {
        problems.push(`expected answer "${sample.expected}" contains no number`);
      }
      break;
    }
    case 'json_schema': {
      if (!config.schema) problems.push('json_schema grader has no schema');
      else if (typeof config.schema !== 'object' || Array.isArray(config.schema)) {
        problems.push('schema must be a JSON object');
      }
      break;
    }
    case 'multiple_choice': {
      const choices = (config.choices && config.choices.length > 0 ? config.choices : ['A', 'B', 'C', 'D']).map((c) =>
        c.trim().toUpperCase(),
      );
      const answer = sample.expected!.trim().toUpperCase().replace(/[.。、)）\]]$/, '');
      if (answer.length !== 1 || !choices.includes(answer)) {
        problems.push(`expected "${sample.expected}" is not one of the options ${choices.join('/')}`);
      }
      break;
    }
    case 'set_match': {
      const source = config.delimiter ? new RegExp(config.delimiter) : /[,，;；\n]/;
      if (sample.expected!.split(source).filter((i) => i.trim().length > 0).length === 0) {
        problems.push('expected answer splits into no items');
      }
      break;
    }
    default:
      break;
  }

  return problems;
}

export { GRADERS as graders };
export type { Grader, GraderInput };
