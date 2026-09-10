import { describe, it, expect } from 'vitest';
import { GraderType, QualitySample } from '../../types';
import { gradeSample, GRADERS, GRADER_DESCRIPTORS, preflightSample } from './index';
import { extractChoice, jsonSchemaGrader, setMatchGrader } from './structured';

/**
 * The graders are the only place where a model output becomes a number, so this
 * file is deliberately exhaustive about boundaries. The recurring theme: a
 * grader that cannot reach a verdict must say `error`, never `fail`.
 */

const grade = (grader: GraderType, output: string, expected?: string, graderConfig?: QualitySample['graderConfig']) =>
  gradeSample({ id: 's', input: 'q', expected, grader, graderConfig }, output);

describe('grader registry', () => {
  it('exposes a descriptor for every registered grader', () => {
    for (const type of Object.keys(GRADERS) as GraderType[]) {
      expect(GRADER_DESCRIPTORS.some((d) => d.type === type)).toBe(true);
    }
    expect(GRADER_DESCRIPTORS).toHaveLength(Object.keys(GRADERS).length);
  });

  it('reports an unknown grader as error rather than throwing', () => {
    const result = gradeSample({ id: 's', input: 'q', grader: 'nope' as GraderType, expected: 'x' }, 'x');
    expect(result.status).toBe('error');
    expect(result.score).toBeNull();
    expect(result.detailKey).toBe('quality.grade.unknownGrader');
  });
});

describe('exact grader', () => {
  it('passes on an exact match and fails otherwise', () => {
    expect(grade('exact', 'Paris', 'Paris').status).toBe('pass');
    expect(grade('exact', 'London', 'Paris').status).toBe('fail');
  });

  it('is case-insensitive and whitespace-tolerant by default', () => {
    expect(grade('exact', '  paris  ', 'Paris').status).toBe('pass');
    expect(grade('exact', 'New   York', 'New York').status).toBe('pass');
  });

  it('honours caseSensitive and stripPunctuation', () => {
    expect(grade('exact', 'paris', 'Paris', { caseSensitive: true }).status).toBe('fail');
    expect(grade('exact', 'Paris.', 'Paris', { stripPunctuation: true }).status).toBe('pass');
    expect(grade('exact', 'Paris.', 'Paris').status).toBe('fail');
  });

  it('accepts any of the declared alternatives', () => {
    const config = { accepted: ['Beijing', '北京'] };
    expect(grade('exact', '北京', '北京', config).status).toBe('pass');
    expect(grade('exact', 'BeiJing', '北京', config).status).toBe('pass');
    expect(grade('exact', 'Shanghai', '北京', config).status).toBe('fail');
  });

  it('treats a missing reference answer as an error, not a failure', () => {
    const result = grade('exact', 'anything', undefined);
    expect(result.status).toBe('error');
    expect(result.detailKey).toBe('quality.grade.missingExpected');
  });

  it('treats an empty response as a wrong answer', () => {
    const result = grade('exact', '   ', 'Paris');
    expect(result.status).toBe('fail');
    expect(result.detailKey).toBe('quality.grade.emptyOutput');
  });
});

describe('contains grader', () => {
  it('requires every pattern by default', () => {
    expect(grade('contains', 'the capital is Paris, in France', 'Paris\nFrance', { patterns: ['Paris', 'France'] }).status).toBe('pass');
    const miss = grade('contains', 'the capital is Paris', 'Paris\nFrance', { patterns: ['Paris', 'France'] });
    expect(miss.status).toBe('fail');
    expect(miss.detailKey).toBe('quality.grade.contains.miss');
    // Evidence is normalized — the grader compares lowercased text, and the
    // justification reports exactly what it compared.
    expect(miss.params?.missing).toBe('france');
  });

  it('passes on one match in any-of mode', () => {
    expect(grade('contains', 'Paris', 'Paris\nFrance', { patterns: ['Paris', 'France'], mode: 'any' }).status).toBe('pass');
    expect(grade('contains', 'Berlin', 'Paris\nFrance', { patterns: ['Paris', 'France'], mode: 'any' }).status).toBe('fail');
  });

  it('errors when there is nothing to search for', () => {
    expect(grade('contains', 'text', undefined).status).toBe('error');
    expect(grade('contains', 'text', '', { patterns: [''] }).status).toBe('error');
  });
});

describe('regex grader', () => {
  it('matches against the raw output, honouring the case flag', () => {
    expect(grade('regex', 'HELLO WORLD', undefined, { patterns: ['^[A-Z ]+$'], caseSensitive: true }).status).toBe('pass');
    expect(grade('regex', 'hello', undefined, { patterns: ['^[A-Z ]+$'], caseSensitive: true }).status).toBe('fail');
    expect(grade('regex', 'hello', undefined, { patterns: ['^[A-Z ]+$'] }).status).toBe('pass');
  });

  it('reports an invalid pattern as an error with the pattern in the evidence', () => {
    const result = grade('regex', 'anything', undefined, { patterns: ['([unclosed'] });
    expect(result.status).toBe('error');
    expect(result.detailKey).toBe('quality.grade.invalidRegex');
    expect(result.params?.pattern).toBe('([unclosed');
  });

  it('supports any-of mode across several patterns', () => {
    expect(grade('regex', 'cat', undefined, { patterns: ['^dog$', '^cat$'], mode: 'any' }).status).toBe('pass');
    expect(grade('regex', 'bird', undefined, { patterns: ['^dog$', '^cat$'], mode: 'any' }).status).toBe('fail');
  });
});

describe('numeric_tolerance grader', () => {
  it('matches exact integers', () => {
    expect(grade('numeric_tolerance', 'The answer is 18.', '18').status).toBe('pass');
  });

  it('respects the tolerance window', () => {
    expect(grade('numeric_tolerance', '3.14', '3', { tolerance: 0.2 }).status).toBe('pass');
    expect(grade('numeric_tolerance', '3.5', '3', { tolerance: 0.2 }).status).toBe('fail');
    expect(grade('numeric_tolerance', '3.5', '3', { tolerance: 0 }).status).toBe('fail');
  });

  it('reads the first number by default and the last when asked', () => {
    expect(grade('numeric_tolerance', 'first 7 then 99', '7').status).toBe('pass');
    expect(grade('numeric_tolerance', 'work 16 - 3 - 4 = 9\n#### 18', '18', { pick: 'last' }).status).toBe('pass');
  });

  it('handles thousands separators, negatives and decimals', () => {
    expect(grade('numeric_tolerance', '1,234.5', '1234.5').status).toBe('pass');
    expect(grade('numeric_tolerance', '-42', '-42').status).toBe('pass');
    expect(grade('numeric_tolerance', '-42', '42').status).toBe('fail');
  });

  it('treats an unparsable response as a wrong answer', () => {
    const result = grade('numeric_tolerance', 'I cannot solve this', '18');
    expect(result.status).toBe('fail');
    expect(result.detailKey).toBe('quality.grade.numeric.unparsed');
  });

  it('treats an unparsable reference answer as an error', () => {
    const result = grade('numeric_tolerance', '18', 'eighteen');
    expect(result.status).toBe('error');
    expect(result.detailKey).toBe('quality.grade.numeric.expectedUnparsed');
  });
});

describe('json_schema grader', () => {
  const schema = {
    type: 'object',
    required: ['order_id', 'item_count'],
    properties: { order_id: { type: 'string' }, item_count: { type: 'integer', minimum: 1 } },
    additionalProperties: false,
  };

  it('passes a conforming object', () => {
    expect(grade('json_schema', '{"order_id":"A1","item_count":3}', undefined, { schema }).status).toBe('pass');
  });

  it('strips a markdown fence before parsing', () => {
    const fenced = '```json\n{"order_id":"A1","item_count":3}\n```';
    expect(grade('json_schema', fenced, undefined, { schema }).status).toBe('pass');
  });

  it('fails on a missing required property, a wrong type and a constraint violation', () => {
    const missing = grade('json_schema', '{"order_id":"A1"}', undefined, { schema });
    expect(missing.status).toBe('fail');
    expect(missing.detail).toContain('missing required property "item_count"');

    const wrongType = grade('json_schema', '{"order_id":"A1","item_count":"three"}', undefined, { schema });
    expect(wrongType.status).toBe('fail');

    const tooSmall = grade('json_schema', '{"order_id":"A1","item_count":0}', undefined, { schema });
    expect(tooSmall.detail).toContain('minimum 1');
  });

  it('rejects unexpected properties when additionalProperties is false', () => {
    const result = grade('json_schema', '{"order_id":"A1","item_count":3,"extra":true}', undefined, { schema });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('unexpected property "extra"');
  });

  it('treats invalid JSON in the response as a wrong answer, not an error', () => {
    const result = grade('json_schema', '{"order_id": "A1",,}', undefined, { schema });
    expect(result.status).toBe('fail');
    expect(result.score).toBe(0);
    expect(result.detailKey).toBe('quality.grade.json.invalid');
  });

  it('treats a malformed schema as an error, not a failure', () => {
    const result = grade('json_schema', '{}', undefined, { schema: { type: 'nonsense' } });
    expect(result.status).toBe('error');
    expect(result.detailKey).toBe('quality.grade.invalidSchema');
  });

  it('errors when no schema was supplied at all', () => {
    expect(grade('json_schema', '{}').status).toBe('error');
  });

  it('validates enum, nested arrays and item shapes', () => {
    const listSchema = {
      type: 'object',
      required: ['items'],
      properties: {
        items: { type: 'array', minItems: 2, items: { type: 'object', required: ['k'], properties: { k: { type: 'string', enum: ['a', 'b'] } } } },
      },
    };
    expect(grade('json_schema', '{"items":[{"k":"a"},{"k":"b"}]}', undefined, { schema: listSchema }).status).toBe('pass');
    expect(grade('json_schema', '{"items":[{"k":"a"}]}', undefined, { schema: listSchema }).detail).toContain('minItems');
    expect(grade('json_schema', '{"items":[{"k":"a"},{"k":"z"}]}', undefined, { schema: listSchema }).detail).toContain('enum');
  });

  it('is reachable through the registry', () => {
    expect(jsonSchemaGrader).toBe(GRADERS.json_schema);
  });
});

describe('multiple_choice grader', () => {
  const config = { choices: ['A', 'B', 'C', 'D'] };

  it('reads the option from common answer phrasings', () => {
    const samples: Array<[string, string]> = [
      ['答案：B', 'B'],
      ['答案是 C', 'C'],
      ['Answer: d', 'D'],
      ['The correct answer is A.', 'A'],
      ['选项 B', 'B'],
      ['(C)', 'C'],
      ['A', 'A'],
      ['A. Paris', 'A'],
      ['I think it is B because ...', 'B'],
    ];
    for (const [output, expected] of samples) {
      expect(extractChoice(output, ['A', 'B', 'C', 'D']), output).toBe(expected);
    }
  });

  it('passes when the chosen letter is correct and fails when it is not', () => {
    expect(grade('multiple_choice', '答案：B', 'B', config).status).toBe('pass');
    expect(grade('multiple_choice', '答案：B', 'C', config).status).toBe('fail');
  });

  it('fails when the model never commits to an option', () => {
    const result = grade('multiple_choice', 'I am not sure about this one.', 'B', config);
    expect(result.status).toBe('fail');
    expect(result.detailKey).toBe('quality.grade.choice.notFound');
  });

  it('errors when the reference answer is not one of the options', () => {
    const result = grade('multiple_choice', 'Paris', 'Paris', config);
    expect(result.status).toBe('error');
    expect(result.detailKey).toBe('quality.grade.choice.expectedNotOption');
    expect(result.detail).toContain('exact');
  });

  it('honours a custom option set', () => {
    expect(grade('multiple_choice', '答案：甲', '甲', { choices: ['甲', '乙', '丙'] }).status).toBe('pass');
  });
});

describe('set_match grader', () => {
  const config = { delimiter: ',', setMode: 'exact' as const };

  it('passes on an identical set regardless of order or spacing', () => {
    expect(grade('set_match', '杭州, 南京, 成都', '成都,杭州,南京', config).status).toBe('pass');
  });

  it('reports both missing and extra items', () => {
    const result = grade('set_match', '杭州, 苏州', '杭州, 南京', config);
    expect(result.status).toBe('fail');
    expect(result.params).toMatchObject({ missing: 1, extra: 1 });
  });

  it('honours subset and superset modes', () => {
    expect(grade('set_match', '杭州', '杭州,南京', { delimiter: ',', setMode: 'subset' }).status).toBe('pass');
    expect(grade('set_match', '杭州,苏州', '杭州,南京', { delimiter: ',', setMode: 'subset' }).status).toBe('fail');
    expect(grade('set_match', '杭州,南京,成都', '杭州,南京', { delimiter: ',', setMode: 'superset' }).status).toBe('pass');
    expect(grade('set_match', '杭州', '杭州,南京', { delimiter: ',', setMode: 'superset' }).status).toBe('fail');
  });

  it('errors on a missing reference answer', () => {
    expect(grade('set_match', 'a,b', undefined, config).status).toBe('error');
  });

  it('is reachable through the registry', () => {
    expect(setMatchGrader).toBe(GRADERS.set_match);
  });
});

describe('preflightSample', () => {
  const base = { id: 's', input: 'q', grader: 'exact' as GraderType };

  it('accepts a well-formed sample', () => {
    expect(preflightSample({ ...base, expected: 'x' })).toEqual([]);
  });

  it('flags a missing expected answer for graders that need one', () => {
    expect(preflightSample(base).join()).toContain('requires an expected answer');
  });

  it('does not require expected for json_schema', () => {
    const problems = preflightSample({ ...base, grader: 'json_schema', graderConfig: { schema: { type: 'object' } } });
    expect(problems).toEqual([]);
  });

  it('flags an invalid regex and a non-numeric reference', () => {
    expect(preflightSample({ ...base, grader: 'regex', graderConfig: { patterns: ['(['] } }).join()).toContain('invalid regex');
    expect(preflightSample({ ...base, grader: 'regex' }).join()).toContain('no pattern to match');
    expect(preflightSample({ ...base, expected: 'eighteen', grader: 'numeric_tolerance' }).join()).toContain('no number');
  });

  it('accepts patterns as a substitute for expected on contains and regex', () => {
    expect(preflightSample({ ...base, grader: 'contains', graderConfig: { patterns: ['Paris'] } })).toEqual([]);
    expect(preflightSample({ ...base, grader: 'regex', graderConfig: { patterns: ['^\\d+$'] } })).toEqual([]);
  });

  it('flags a multiple-choice answer that is not an option', () => {
    const problems = preflightSample({ ...base, expected: 'Paris', grader: 'multiple_choice' });
    expect(problems.join()).toContain('is not one of the options');
  });

  it('flags an empty input', () => {
    expect(preflightSample({ ...base, input: '  ', expected: 'x' }).join()).toContain('input is empty');
  });
});
