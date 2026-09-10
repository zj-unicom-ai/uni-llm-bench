#!/usr/bin/env python3
"""Regenerate backend/src/services/qualitySeed/publicBenchmarks.ts from upstream data.

Usage:
    python3 scripts/generate-quality-seed.py

Downloads the upstream files into a temp directory (jsdelivr mirror of GitHub,
since raw.githubusercontent.com is not reachable from every network), extracts a
deterministic subset of each benchmark, and rewrites the TypeScript seed file.

Selection is deterministic — first N rows passing the length filters — so the
generated file is byte-stable across runs. Re-run this only when you intend to
change the bundled subset, and review the resulting diff.

Benchmarks and licences:
    GSM8K      openai/grade-school-math   MIT
    HellaSwag  rowanz/hellaswag           MIT
See backend/src/services/qualitySeed/ATTRIBUTION.md for the full notices.

Only benchmarks whose task is objectively checkable by a rule belong in this
file. TruthfulQA-style generative benchmarks are intentionally excluded: string
matching produces false negatives on free-form answers, so they wait for the
LLM-judge milestone rather than shipping a misleading score.
"""

import json
import os
import subprocess
import sys
import tempfile

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(REPO_ROOT, 'backend/src/services/qualitySeed/publicBenchmarks.ts')

GSM8K_COUNT = 20
HELLASWAG_COUNT = 16

SOURCES = {
    'gsm8k.jsonl': 'https://cdn.jsdelivr.net/gh/openai/grade-school-math@master/grade_school_math/data/test.jsonl',
    'hellaswag_val.jsonl': 'https://cdn.jsdelivr.net/gh/rowanz/hellaswag@master/data/hellaswag_val.jsonl',
}

GSM8K_NOTE = (
    'Source: GSM8K (Grade School Math 8K) test split, openai/grade-school-math, MIT License. '
    'Benchmark: Cobbe et al., "Training Verifiers to Solve Math Word Problems" (2021), arXiv:2110.14168. '
    'A 20-question subset selected deterministically (first 20 questions whose final answer parses as a number). '
    'Samples are reproduced verbatim; the trailing "#### <answer>" instruction is added by this project. '
    'Graded by reading the last number in the response, so a model that shows its work is not penalised for it.'
)

HELLASWAG_NOTE = (
    'Source: HellaSwag validation split, rowanz/hellaswag, MIT License. '
    'Benchmark: Zellers et al., "HellaSwag: Can a Machine Really Finish Your Sentence?" (2019), ACL. '
    'A 16-question subset selected deterministically (first 16 rows with four short endings). '
    'The prompt scaffolding that labels the endings A-D is added by this project. '
    'Caveat worth reading before trusting the number: HellaSwag distractors were adversarially filtered against '
    'earlier models, and the gold answer is the caption of the source video. Without that video some items are '
    'genuinely ambiguous to a reader, so a low score here is a weaker signal than the other datasets in this list.'
)


def ts(value):
    return json.dumps(value, ensure_ascii=False)


def fetch(dest_dir):
    for name, url in SOURCES.items():
        path = os.path.join(dest_dir, name)
        if os.path.exists(path) and os.path.getsize(path) > 10_000:
            print(f'  reusing cached {name}')
            continue
        print(f'  downloading {name} …')
        subprocess.run(['curl', '-sSL', '--max-time', '90', '-o', path, url], check=True)
        if os.path.getsize(path) < 10_000:
            sys.exit(f'failed to download {url} (got {os.path.getsize(path)} bytes)')


def gsm8k_samples(src_dir):
    samples = []
    with open(os.path.join(src_dir, 'gsm8k.jsonl'), encoding='utf-8') as fh:
        for line_no, line in enumerate(fh, start=1):
            if len(samples) >= GSM8K_COUNT:
                break
            row = json.loads(line)
            answer = row['answer']
            if '####' not in answer:
                continue
            final = answer.rsplit('####', 1)[1].strip().replace(',', '')
            try:
                float(final)
            except ValueError:
                continue
            question = row['question'].strip()
            if len(question) > 600:
                continue
            prompt = (
                'Solve the following math problem. Show your reasoning, then finish with a final line of the '
                "form '#### <answer>' containing only the final number.\n\n" + question
            )
            samples.append(
                {
                    'id': f'gsm8k#{len(samples) + 1}',
                    'input': prompt,
                    'expected': final,
                    'grader': 'numeric_tolerance',
                    'graderConfig': {'tolerance': 0, 'pick': 'last'},
                    'category': 'math-reasoning',
                    'meta': {'split': 'test', 'upstream_line': line_no},
                }
            )
    return samples


def hellaswag_samples(src_dir):
    samples = []
    with open(os.path.join(src_dir, 'hellaswag_val.jsonl'), encoding='utf-8') as fh:
        for line in fh:
            if len(samples) >= HELLASWAG_COUNT:
                break
            row = json.loads(line)
            ctx = row['ctx'].strip()
            endings = [e.strip() for e in row['endings']]
            label = row['label']
            if len(endings) != 4 or not isinstance(label, int) or not (0 <= label <= 3):
                continue
            if len(ctx) > 280 or any(len(e) > 140 for e in endings):
                continue
            lines = [
                'Choose the most plausible continuation of the sentence below.',
                '',
                f'Sentence: {ctx}',
                '',
                'Options:',
            ]
            for idx, ending in enumerate(endings):
                lines.append(f'{chr(65 + idx)}. {ending}')
            lines += ['', 'Answer with the option letter only.']
            samples.append(
                {
                    'id': f'hellaswag#{len(samples) + 1}',
                    'input': '\n'.join(lines),
                    'expected': chr(65 + label),
                    'grader': 'multiple_choice',
                    'graderConfig': {'choices': ['A', 'B', 'C', 'D']},
                    'category': row.get('activity_label', 'commonsense'),
                    'meta': {'source_id': row.get('source_id', ''), 'split': 'validation', 'ind': row.get('ind')},
                }
            )
    return samples


def render_sample(sample, indent):
    pad = ' ' * indent
    inner = ' ' * (indent + 2)
    parts = [f'{pad}{{']
    parts.append(f"{inner}id: {ts(sample['id'])},")
    if sample.get('systemPrompt'):
        parts.append(f"{inner}systemPrompt: {ts(sample['systemPrompt'])},")
    parts.append(f"{inner}input: {ts(sample['input'])},")
    if 'expected' in sample:
        parts.append(f"{inner}expected: {ts(sample['expected'])},")
    parts.append(f"{inner}grader: {ts(sample['grader'])},")
    parts.append(f"{inner}graderConfig: {ts(sample['graderConfig'])},")
    if sample.get('category'):
        parts.append(f"{inner}category: {ts(sample['category'])},")
    if sample.get('meta'):
        parts.append(f"{inner}meta: {ts(sample['meta'])},")
    parts.append(f'{pad}}}')
    return '\n'.join(parts)


def render_dataset(var_name, dataset, header_comment):
    lines = [f'/** {header_comment} */', f'export const {var_name}: QualityDatasetSeed = {{']
    lines.append(f"  slug: {ts(dataset['slug'])},")
    lines.append(f"  name: {ts(dataset['name'])},")
    lines.append(f"  description: {ts(dataset['description'])},")
    lines.append(f"  tags: {ts(dataset['tags'])},")
    lines.append(f"  note: {ts(dataset['note'])},")
    lines.append('  samples: [')
    for sample in dataset['samples']:
        lines.append(render_sample(sample, 4) + ',')
    lines.append('  ],')
    lines.append('};')
    return '\n'.join(lines)


HEADER = '''import { QualityDatasetSeed } from './types';

/**
 * Real public-benchmark subsets, reproduced verbatim from upstream under their
 * original licences. See ./ATTRIBUTION.md for the full notices.
 *
 * Generated by scripts/generate-quality-seed.py — re-run that script rather than
 * hand-editing the literals below, and review the diff before committing.
 *
 * Only benchmarks whose task is objectively checkable by a rule are included.
 * TruthfulQA-style generative benchmarks are deliberately absent: grading them
 * with string matching produces false negatives, so they wait for the LLM-judge
 * milestone rather than shipping a misleading score.
 */

'''


def main():
    with tempfile.TemporaryDirectory() as src_dir:
        print('fetching upstream data …')
        fetch(src_dir)

        gsm8k = {
            'slug': 'gsm8k-math',
            'name': 'GSM8K — Math word problems',
            'description': 'Grade-school math word problems requiring multi-step arithmetic reasoning.',
            'tags': ['math', 'reasoning', 'en'],
            'note': GSM8K_NOTE,
            'samples': gsm8k_samples(src_dir),
        }
        hellaswag = {
            'slug': 'hellaswag-commonsense',
            'name': 'HellaSwag — Commonsense continuation',
            'description': 'Pick the plausible continuation of a short everyday scene description.',
            'tags': ['commonsense', 'reasoning', 'en'],
            'note': HELLASWAG_NOTE,
            'samples': hellaswag_samples(src_dir),
        }

    out = HEADER
    out += render_dataset('GSM8K_SEED', gsm8k, 'GSM8K — multi-step math (numeric final answer)')
    out += '\n\n'
    out += render_dataset('HELLASWAG_SEED', hellaswag, 'HellaSwag — everyday-scene continuation (4-way choice)')
    out += '\n'

    with open(OUT, 'w', encoding='utf-8') as fh:
        fh.write(out)

    print(f'wrote {OUT}')
    print(f'  gsm8k: {len(gsm8k["samples"])} samples')
    print(f'  hellaswag: {len(hellaswag["samples"])} samples')


if __name__ == '__main__':
    main()
