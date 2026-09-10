import { describe, it, expect } from 'vitest';
import { SEED_QUALITY_DATASETS } from './index';
import { preflightSample, gradeSample } from '../graders';
import { QualitySample } from '../../types';

/**
 * Self-consistency checks over the 66 bundled questions.
 *
 * Hand-written graders are the highest-risk part of this module: a mistyped regex
 * or a schema that disagrees with its prompt makes a question unpassable, and
 * every model then scores 0 on it for reasons that have nothing to do with
 * quality. Nothing about a real run would surface that — the report would just
 * look like the model is bad. These tests catch it offline instead.
 */

const ALL_SAMPLES: Array<{ dataset: string; sample: QualitySample }> = SEED_QUALITY_DATASETS.flatMap((dataset) =>
  dataset.samples.map((sample) => ({ dataset: dataset.slug, sample })),
);

/** Answers that satisfy each authored regex sample, so the pattern is exercised. */
const REGEX_COMPLIANT_ANSWERS: Record<string, string> = {
  'format#1': 'HELLO WORLD FROM UNI LLM BENCH',
  'format#2': '- 第一行\n- 第二行\n- 第三行',
  'format#3': '["alpha", "beta", "gamma"]',
  'format#4': 'ANSWER: 42',
  'format#5': '晴',
  'format#6': '2025-06-01',
  'format#7': '12345',
  'format#8': 'a,b\nc,d',
};

/** Answers that must not satisfy anything. */
const GARBAGE = '@@@ definitely not the answer ###';

describe('bundled dataset integrity', () => {
  it('ships the expected datasets and question counts', () => {
    expect(SEED_QUALITY_DATASETS.map((d) => d.slug)).toEqual([
      'gsm8k-math',
      'hellaswag-commonsense',
      'structured-extraction',
      'instruction-format',
      'field-normalization',
      'set-enumeration',
    ]);
    expect(ALL_SAMPLES).toHaveLength(66);
  });

  it('gives every sample a unique id within its dataset', () => {
    for (const dataset of SEED_QUALITY_DATASETS) {
      const ids = dataset.samples.map((s) => s.id);
      expect(new Set(ids).size, `${dataset.slug} has duplicate sample ids`).toBe(ids.length);
    }
  });

  it('attributes every dataset to a source', () => {
    for (const dataset of SEED_QUALITY_DATASETS) {
      expect(dataset.note, `${dataset.slug} has no provenance note`).toBeTruthy();
      expect(dataset.name).toBeTruthy();
      expect(dataset.description).toBeTruthy();
    }
  });
});

describe('every bundled question is gradable', () => {
  it('passes static preflight — no broken regex, missing reference or bad option set', () => {
    const problems = ALL_SAMPLES.flatMap(({ dataset, sample }) =>
      preflightSample(sample).map((problem) => `${dataset}/${sample.id}: ${problem}`),
    );
    expect(problems).toEqual([]);
  });

  it('never reports a wrong answer as a grader error', () => {
    // An `error` here means the question cannot produce a verdict at all — it
    // would silently inflate the "unjudgeable" count on every single run.
    const broken = ALL_SAMPLES.filter(({ sample }) => {
      const result = gradeSample(sample, GARBAGE);
      return result.status === 'error';
    }).map(({ dataset, sample }) => `${dataset}/${sample.id}: ${gradeSample(sample, GARBAGE).detail}`);

    expect(broken).toEqual([]);
  });

  it('marks the garbage answer as wrong, not as a pass', () => {
    const surprising = ALL_SAMPLES.filter(({ sample }) => gradeSample(sample, GARBAGE).status === 'pass').map(
      ({ dataset, sample }) => `${dataset}/${sample.id}`,
    );
    expect(surprising).toEqual([]);
  });

  it('accepts the reference answer for every mechanically-checkable grader', () => {
    const skipped = new Set(['regex', 'json_schema']);
    const failures = ALL_SAMPLES.filter(({ sample }) => {
      if (skipped.has(sample.grader)) return false;
      return gradeSample(sample, sample.expected ?? '').status !== 'pass';
    }).map(({ dataset, sample }) => `${dataset}/${sample.id} (${sample.grader})`);

    expect(failures).toEqual([]);
  });

  it('accepts a conforming answer for every authored regex question', () => {
    const regexSamples = ALL_SAMPLES.filter(({ sample }) => sample.grader === 'regex');
    expect(regexSamples).toHaveLength(8);

    const failures = regexSamples
      .filter(({ sample }) => {
        const answer = REGEX_COMPLIANT_ANSWERS[sample.id];
        return !answer || gradeSample(sample, answer).status !== 'pass';
      })
      .map(({ sample }) => {
        const answer = REGEX_COMPLIANT_ANSWERS[sample.id] ?? '(no fixture)';
        return `${sample.id}: ${JSON.stringify(answer)} → ${JSON.stringify(gradeSample(sample, REGEX_COMPLIANT_ANSWERS[sample.id] ?? '').detail)}`;
      });

    expect(failures).toEqual([]);
  });

  it('gives every structured-extraction question a schema with required fields', () => {
    const extraction = ALL_SAMPLES.filter(({ sample }) => sample.grader === 'json_schema');
    expect(extraction.length).toBe(8);
    for (const { sample } of extraction) {
      const schema = sample.graderConfig?.schema as { required?: unknown } | undefined;
      expect(schema, `${sample.id} has no schema`).toBeTruthy();
      expect(Array.isArray(schema?.required), `${sample.id} schema has no required list`).toBe(true);
      expect((schema?.required as string[]).length).toBeGreaterThan(0);
    }
  });

  it('names every required schema field somewhere in the prompt', () => {
    // The prompt tells the model what to produce; the schema is what actually gets
    // checked. If the two drift apart, correct answers are marked wrong.
    const mismatches = ALL_SAMPLES.filter(({ sample }) => sample.grader === 'json_schema')
      .flatMap(({ sample }) => {
        const schema = sample.graderConfig?.schema as { required?: string[] } | undefined;
        return (schema?.required ?? [])
          .filter((field) => !sample.input.includes(field))
          .map((field) => `${sample.id}: prompt never mentions required field "${field}"`);
      });
    expect(mismatches).toEqual([]);
  });
});

describe('public benchmark subsets', () => {
  it('grades GSM8K against the final number, tolerating a shown working', () => {
    const sample = ALL_SAMPLES.find(({ sample }) => sample.id === 'gsm8k#1')!.sample;
    const withWorking =
      'Janet sells 16 - 3 - 4 = 9 duck eggs a day.\nShe makes 9 * 2 = $18.\n#### 18';
    expect(gradeSample(sample, withWorking).status).toBe('pass');
    expect(gradeSample(sample, '18').status).toBe('pass');
    expect(gradeSample(sample, '#### 19').status).toBe('fail');
  });

  it('grades HellaSwag on the option letter', () => {
    const sample = ALL_SAMPLES.find(({ sample }) => sample.id === 'hellaswag#1')!.sample;
    expect(gradeSample(sample, sample.expected!).status).toBe('pass');
    expect(gradeSample(sample, `Answer: ${sample.expected}`).status).toBe('pass');
    const wrong = sample.expected === 'A' ? 'B' : 'A';
    expect(gradeSample(sample, `Answer: ${wrong}`).status).toBe('fail');
  });

  it('keeps the HellaSwag caveat in the dataset note', () => {
    const hellaswag = SEED_QUALITY_DATASETS.find((d) => d.slug === 'hellaswag-commonsense')!;
    // A reader must be warned that adversarial distractors make some items
    // ambiguous without the source video.
    expect(hellaswag.note).toContain('adversarially');
    expect(hellaswag.note).toContain('ambiguous');
  });

  it('keeps the licence references in the dataset notes', () => {
    const gsm8k = SEED_QUALITY_DATASETS.find((d) => d.slug === 'gsm8k-math')!;
    expect(gsm8k.note).toContain('MIT License');
    expect(gsm8k.note).toContain('openai/grade-school-math');
  });
});
