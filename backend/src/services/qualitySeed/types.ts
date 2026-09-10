import { QualitySample } from '../../types';

/**
 * A built-in dataset definition, seeded into SQLite on first boot.
 *
 * The `slug` becomes the row id (`builtin:<slug>`), which is what makes
 * re-seeding idempotent: a seed that is already present is skipped by name, so
 * a user editing a built-in dataset in their own database never gets it
 * silently rewritten on the next restart.
 */
export interface QualityDatasetSeed {
  slug: string;
  name: string;
  description: string;
  tags: string[];
  /** Provenance / licence notice. Surfaced verbatim in the UI and in exports. */
  note: string;
  samples: QualitySample[];
}
