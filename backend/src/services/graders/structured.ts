import { GraderConfig } from '../../types';
import { extractNumber, normalizeText, stripCodeFence } from './normalize';
import { Grader, GraderInput, abbreviate, errorResult, failResult, passResult } from './types';

/**
 * Structured-output graders: `numeric_tolerance`, `json_schema`,
 * `multiple_choice`, `set_match`.
 *
 * These are the graders that make objective evaluation worth having: they turn
 * "did the model produce something plausible" into a checkable yes/no.
 */

const MAX_VIOLATIONS_REPORTED = 5;
const MAX_SCHEMA_DEPTH = 24;

/* -------------------------------------------------------------------------- */
/* numeric_tolerance                                                          */
/* -------------------------------------------------------------------------- */

export const numericToleranceGrader: Grader = ({ output, expected, config }: GraderInput) => {
  if (expected === undefined || expected.trim().length === 0) {
    return errorResult('quality.grade.missingExpected', 'numeric_tolerance: no reference answer');
  }

  const expectedValue = extractNumber(expected, 'first');
  if (expectedValue === null) {
    return errorResult(
      'quality.grade.numeric.expectedUnparsed',
      `numeric_tolerance: reference answer "${abbreviate(expected)}" holds no number`,
      { expected: abbreviate(expected) },
    );
  }

  const pick = config.pick ?? 'first';
  const actualValue = extractNumber(stripCodeFence(output), pick);
  if (actualValue === null) {
    return failResult('quality.grade.numeric.unparsed', `numeric_tolerance: no number found in "${abbreviate(output)}"`, {
      expected: String(expectedValue),
    });
  }

  const tolerance = Math.abs(config.tolerance ?? 0);
  const diff = Math.abs(actualValue - expectedValue);
  const params = { value: actualValue, expected: expectedValue, tolerance, diff };

  if (diff <= tolerance) {
    return passResult(
      'quality.grade.numeric.match',
      `numeric_tolerance: ${actualValue} within ${tolerance} of ${expectedValue}`,
      params,
    );
  }

  return failResult(
    'quality.grade.numeric.mismatch',
    `numeric_tolerance: ${actualValue} differs from ${expectedValue} by ${diff} (tolerance ${tolerance})`,
    params,
  );
};

/* -------------------------------------------------------------------------- */
/* json_schema — minimal JSON Schema subset                                   */
/* -------------------------------------------------------------------------- */

const KNOWN_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

interface SchemaCheck {
  ok: boolean;
  reason?: string;
}

/** Structural sanity check so a broken schema is reported, not silently obeyed. */
function inspectSchema(schema: unknown, depth = 0): SchemaCheck {
  if (depth > MAX_SCHEMA_DEPTH) return { ok: false, reason: 'schema is nested too deeply' };
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return { ok: false, reason: 'schema must be a JSON object' };
  }
  const node = schema as Record<string, unknown>;

  if (node.type !== undefined) {
    const types = Array.isArray(node.type) ? node.type : [node.type];
    for (const t of types) {
      if (typeof t !== 'string' || !KNOWN_TYPES.has(t)) return { ok: false, reason: `unknown type "${String(t)}"` };
    }
  }
  if (node.properties !== undefined) {
    if (typeof node.properties !== 'object' || node.properties === null || Array.isArray(node.properties)) {
      return { ok: false, reason: '"properties" must be an object' };
    }
    for (const [key, child] of Object.entries(node.properties as Record<string, unknown>)) {
      const sub = inspectSchema(child, depth + 1);
      if (!sub.ok) return { ok: false, reason: `properties.${key}: ${sub.reason}` };
    }
  }
  if (node.items !== undefined) {
    const sub = inspectSchema(node.items, depth + 1);
    if (!sub.ok) return { ok: false, reason: `items: ${sub.reason}` };
  }
  if (node.enum !== undefined && !Array.isArray(node.enum)) return { ok: false, reason: '"enum" must be an array' };
  if (node.required !== undefined && !Array.isArray(node.required)) {
    return { ok: false, reason: '"required" must be an array' };
  }
  return { ok: true };
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(value: unknown, wanted: string): boolean {
  switch (wanted) {
    case 'object':
      return typeOf(value) === 'object';
    case 'array':
      return Array.isArray(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'string':
    case 'boolean':
    case 'null':
      return typeOf(value) === wanted;
    default:
      return false;
  }
}

function collectViolations(value: unknown, schema: Record<string, unknown>, path: string, out: string[], depth = 0): void {
  if (out.length >= MAX_VIOLATIONS_REPORTED || depth > MAX_SCHEMA_DEPTH) return;

  if (schema.type !== undefined) {
    const wanted = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    if (!wanted.some((w) => matchesType(value, w))) {
      out.push(`${path || '(root)'}: expected ${wanted.join('|')}, got ${typeOf(value)}`);
      return;
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) {
    out.push(`${path || '(root)'}: value not in enum`);
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      out.push(`${path}: string shorter than minLength ${schema.minLength}`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      out.push(`${path}: string longer than maxLength ${schema.maxLength}`);
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) out.push(`${path}: below minimum ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) out.push(`${path}: above maximum ${schema.maximum}`);
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      out.push(`${path}: fewer than minItems ${schema.minItems}`);
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      out.push(`${path}: more than maxItems ${schema.maxItems}`);
    }
    if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
      value.forEach((item, index) => {
        collectViolations(item, schema.items as Record<string, unknown>, `${path}[${index}]`, out, depth + 1);
      });
    }
  }

  if (typeOf(value) === 'object') {
    const record = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    for (const key of required) {
      if (!(key in record)) out.push(`${path || '(root)'}: missing required property "${key}"`);
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (key in record) collectViolations(record[key], childSchema, path ? `${path}.${key}` : key, out, depth + 1);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(key in properties)) out.push(`${path || '(root)'}: unexpected property "${key}"`);
      }
    }
  }
}

export const jsonSchemaGrader: Grader = ({ output, config }: GraderInput) => {
  if (!config.schema) {
    return errorResult('quality.grade.missingSchema', 'json_schema: sample carries no schema');
  }

  const inspected = inspectSchema(config.schema);
  if (!inspected.ok) {
    return errorResult('quality.grade.invalidSchema', `json_schema: malformed schema — ${inspected.reason}`, {
      error: inspected.reason ?? 'unknown',
    });
  }

  const body = stripCodeFence(output);
  if (body.length === 0) {
    return failResult('quality.grade.emptyOutput', 'json_schema: output is empty');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid JSON';
    // The model failed the task — this is a wrong answer, not a measurement error.
    return failResult('quality.grade.json.invalid', `json_schema: output is not valid JSON — ${message}`, {
      error: message,
      output: abbreviate(output),
    });
  }

  const violations: string[] = [];
  collectViolations(parsed, config.schema as Record<string, unknown>, '', violations);

  if (violations.length === 0) {
    return passResult('quality.grade.json.valid', 'json_schema: output satisfies every constraint', {
      bytes: body.length,
    });
  }

  return failResult(
    'quality.grade.json.violations',
    `json_schema: ${violations.length} violation(s) — ${violations.join('; ')}`,
    { count: violations.length, violations: abbreviate(violations.join('; '), 140) },
  );
};

/* -------------------------------------------------------------------------- */
/* multiple_choice                                                            */
/* -------------------------------------------------------------------------- */

const DEFAULT_CHOICES = ['A', 'B', 'C', 'D'];

/** Read the option letter a model settled on, or null when it never committed. */
export function extractChoice(output: string, choices: string[]): string | null {
  const pool = choices.map((c) => c.toUpperCase()).filter((c) => c.length === 1);
  if (pool.length === 0) return null;
  const cls = pool.join('');

  // A bare letter is the whole answer.
  const bare = output.trim().toUpperCase().replace(/[.。、)）\]】]$/, '');
  if (bare.length === 1 && pool.includes(bare)) return bare;

  const labelled = new RegExp(
    `(?:答案|答案选|选择|正确选项|answer|correct answer|option|choice)\\s*(?:is|是|为)?\\s*[:：]?\\s*[(（\\[]?([${cls}])[)）\\]]?`,
    'i',
  );
  const bracketed = new RegExp(`[(（\\[]([${cls}])[)）\\]]`, 'i');
  const leading = new RegExp(`^\\s*([${cls}])\\s*[.、:：)）\\]]`);
  const standalone = new RegExp(`\\b([${cls}])\\b`);

  for (const re of [labelled, bracketed, leading, standalone]) {
    const match = re.exec(output);
    if (match) return match[1].toUpperCase();
  }
  return null;
}

export const multipleChoiceGrader: Grader = ({ output, expected, config }: GraderInput) => {
  const choices = (config.choices && config.choices.length > 0 ? config.choices : DEFAULT_CHOICES).map((c) =>
    c.trim().toUpperCase(),
  );

  const expectedChoice = expected?.trim().toUpperCase().replace(/[.。、)）\]]$/, '');
  if (!expectedChoice) {
    return errorResult('quality.grade.missingExpected', 'multiple_choice: no reference answer');
  }
  if (!choices.includes(expectedChoice)) {
    return errorResult(
      'quality.grade.choice.expectedNotOption',
      `multiple_choice: reference "${abbreviate(expected!)}" is not one of ${choices.join('/')} — use the "exact" grader for free-text answers`,
      { expected: abbreviate(expected!), choices: choices.join('/') },
    );
  }

  const actual = extractChoice(output, choices);
  if (actual === null) {
    return failResult(
      'quality.grade.choice.notFound',
      `multiple_choice: no option letter found in "${abbreviate(output)}"`,
      { expected: expectedChoice, output: abbreviate(output) },
    );
  }

  if (actual === expectedChoice) {
    return passResult('quality.grade.choice.match', `multiple_choice: chose ${actual}`, {
      choice: actual,
      expected: expectedChoice,
    });
  }

  return failResult('quality.grade.choice.mismatch', `multiple_choice: chose ${actual}, expected ${expectedChoice}`, {
    choice: actual,
    expected: expectedChoice,
  });
};

/* -------------------------------------------------------------------------- */
/* set_match                                                                  */
/* -------------------------------------------------------------------------- */

function toItemSet(text: string, config: GraderConfig): Set<string> {
  const source = config.delimiter ? new RegExp(config.delimiter) : /[,，;；\n]/;
  return new Set(
    text
      .split(source)
      .map((item) => normalizeText(item, config))
      .filter((item) => item.length > 0),
  );
}

export const setMatchGrader: Grader = ({ output, expected, config }: GraderInput) => {
  if (expected === undefined || expected.trim().length === 0) {
    return errorResult('quality.grade.missingExpected', 'set_match: no reference answer');
  }

  const expectedSet = toItemSet(expected, config);
  if (expectedSet.size === 0) {
    return errorResult('quality.grade.missingExpected', 'set_match: reference answer splits into no items');
  }

  const actualSet = toItemSet(output, config);
  const missing = [...expectedSet].filter((item) => !actualSet.has(item));
  const extra = [...actualSet].filter((item) => !expectedSet.has(item));
  const setMode = config.setMode ?? 'exact';

  const params = {
    missing: missing.length,
    extra: extra.length,
    expectedCount: expectedSet.size,
    actualCount: actualSet.size,
  };
  const evidence = `${missing.length} missing, ${extra.length} extra of ${expectedSet.size}`;

  const satisfied =
    setMode === 'exact'
      ? missing.length === 0 && extra.length === 0
      : setMode === 'subset'
        ? extra.length === 0
        : missing.length === 0;

  if (satisfied) {
    return passResult('quality.grade.set.match', `set_match (${setMode}): ${evidence}`, params);
  }

  return failResult(
    'quality.grade.set.mismatch',
    `set_match (${setMode}): ${evidence}${
      missing.length ? ` — missing "${abbreviate(missing.join(', '), 60)}"` : ''
    }${extra.length ? ` — unexpected "${abbreviate(extra.join(', '), 60)}"` : ''}`,
    params,
  );
};

export const STRUCTURED_GRADERS = {
  numeric_tolerance: numericToleranceGrader,
  json_schema: jsonSchemaGrader,
  multiple_choice: multipleChoiceGrader,
  set_match: setMatchGrader,
} satisfies Record<string, Grader>;
