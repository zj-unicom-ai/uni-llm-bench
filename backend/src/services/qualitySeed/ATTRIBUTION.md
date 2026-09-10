# Third-party dataset attribution

The built-in quality datasets under `backend/src/services/qualitySeed/` include a
subset of two public benchmarks. Both are MIT licensed, which permits
redistribution provided the copyright notice and permission notice travel with
the copies. The required notices are reproduced in full below.

Datasets that this project authored itself carry no third-party terms; their
`note` field says so explicitly.

---

## GSM8K — `gsm8k-math` (20 questions, test split)

- Upstream: https://github.com/openai/grade-school-math
- File: `grade_school_math/data/test.jsonl`
- Citation: Cobbe, K., Kosaraju, V., Bavarian, M., et al. *Training Verifiers to
  Solve Math Word Problems.* arXiv:2110.14168, 2021.
- Modifications: the 20 selected questions are reproduced verbatim; this project
  appends a final-answer instruction (`#### <answer>`) to the prompt and wraps it
  with the `numeric_tolerance` grader. No question or reference answer was edited.

```
MIT License

Copyright (c) 2021 OpenAI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## HellaSwag — `hellaswag-commonsense` (16 questions, validation split)

- Upstream: https://github.com/rowanz/hellaswag
- File: `data/hellaswag_val.jsonl`
- Citation: Zellers, R., Holtzman, A., Bisk, Y., Farhadi, A., Choi, Y.
  *HellaSwag: Can a Machine Really Finish Your Sentence?* ACL 2019.
- Modifications: the 16 selected rows are reproduced verbatim; this project
  renders the context and four endings into an A–D multiple-choice prompt. The
  gold label is unchanged.

```
MIT License

Copyright (c) 2019 Rowan Zellers

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Benchmarks considered but deliberately not bundled

| Benchmark | Licence | Why not |
|---|---|---|
| CMMLU | CC BY-NC-SA 4.0 | **Incompatible with this project's MIT licence.** The NonCommercial term forbids the commercial use MIT grants, and ShareAlike would force this repository's derived files under the same terms. Data was reachable and would have added Chinese knowledge coverage — excluded purely on licence grounds. Import it yourself via the dataset import endpoint if your use qualifies. |
| MMLU | MIT | Permissive, but the subject files were not retrievable from the mirror reachable at the time of writing. Worth adding the same way GSM8K was if you can reach the upstream repo. |
| ARC | Apache-2.0 | Permissive, same retrieval problem. |
| TruthfulQA | Apache-2.0 | Reachable and permissive, but its task is free-form generation. Grading it with string matching produces false negatives — a truthful paraphrase sharing no words with the reference would be scored wrong. It belongs with the LLM-judge milestone, not with rule-based grading. |

If you bundle an additional benchmark, add its copyright and permission notice
to this file. Redistributing a dataset without its notice is a licence breach,
not an oversight.

To regenerate the bundled subsets, run:

```bash
python3 scripts/generate-quality-seed.py
```
