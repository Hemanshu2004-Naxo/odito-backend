import { JOB_TYPES } from '../../jobs/constants/jobTypes.js';

/**
 * URL Verification progress stage model (P3-006). Maps the existing job
 * pipeline (no new worker stages) to a friendly stage name + monotonic
 * progress percentage for realtime events.
 *
 * Queued -> Page Scraping -> Accessibility -> Page Analysis -> SEO Scoring
 * -> AI Visibility -> Finalization -> Completed
 */
export const VERIFICATION_STAGE_NAMES = {
  QUEUED: 'Queued',
  [JOB_TYPES.PAGE_SCRAPING]: 'Page Scraping',
  [JOB_TYPES.HEADLESS_ACCESSIBILITY]: 'Accessibility',
  [JOB_TYPES.PAGE_ANALYSIS]: 'Page Analysis',
  [JOB_TYPES.SEO_SCORING]: 'SEO Scoring',
  [JOB_TYPES.AI_VISIBILITY]: 'AI Visibility',
  FINALIZATION: 'Finalization',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
};

const STAGE_PROGRESS = {
  QUEUED: 0,
  [JOB_TYPES.PAGE_SCRAPING]: 15,
  [JOB_TYPES.HEADLESS_ACCESSIBILITY]: 30,
  [JOB_TYPES.PAGE_ANALYSIS]: 50,
  [JOB_TYPES.SEO_SCORING]: 70,
  [JOB_TYPES.AI_VISIBILITY]: 85,
  FINALIZATION: 95,
  COMPLETED: 100,
};

/** Stage name for a completed job type (the stage that JUST finished). */
export function stageNameForJobType(jobType) {
  return VERIFICATION_STAGE_NAMES[jobType] || jobType;
}

/** Progress percentage for a completed job type. */
export function progressForJobType(jobType) {
  return STAGE_PROGRESS[jobType] ?? 0;
}
