import { QualityDatasetSeed } from './types';
import { GSM8K_SEED, HELLASWAG_SEED } from './publicBenchmarks';
import { OBJECTIVE_TASK_SEEDS } from './objectiveTasks';

/**
 * Built-in datasets, seeded into SQLite on first boot.
 *
 * Split into two groups on purpose: `publicBenchmarks` holds subsets reproduced
 * verbatim from upstream projects (see ATTRIBUTION.md for their notices and
 * licences), while `objectiveTasks` holds datasets authored by this project for
 * task families that have no portable public benchmark.
 *
 * Order is user-facing — the picker lists them in this order.
 */
export const SEED_QUALITY_DATASETS: QualityDatasetSeed[] = [
  GSM8K_SEED,
  HELLASWAG_SEED,
  ...OBJECTIVE_TASK_SEEDS,
];

export type { QualityDatasetSeed };
