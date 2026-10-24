import { normalizeKey } from '../utils/text.js';

/**
 * Comparing approved-question runs honestly. Pure.
 *
 * Two runs are EQUIVALENT only when they asked the same discovery questions: same stable question ids, and for every one of them the same
 * wording, intent and target location (including the city sent to the provider). A different question-set version, an added or removed
 * question, or a materially changed question makes the comparison non-equivalent - the figures are still shown side by side, but no
 * "change" is computed and the reasons are listed. A score difference is never attributed to an SEO change by this code.
 */

/** The figures a comparison or a trend point shows, read from a run's persisted metrics (schema v1 and v2 both carry `visibility`). */
export function pickRunFigures(run) {
  const v = run?.metrics?.visibility;
  if (!v) return null;
  return {
    eligibleAnswers: v.succeeded,
    attempted: v.attempted,
    failed: v.failed,
    skipped: v.skipped,
    visibilityRate: v.brandMentionRate ?? null,
    recommendationRate: v.recommendationRate ?? null,
    websiteCitationRate: v.websiteCitationRate ?? null,
    uniqueCitedPages: v.uniqueFirstPartyPages ?? null,
    citationOccurrences: v.firstPartyCitationOccurrences ?? null,
  };
}

const discovery = (run) => (run?.questionSnapshot || []).filter((q) => q.group === 'visibility');
const sig = (q) => ({ text: normalizeKey(q.text), intent: q.intent, location: normalizeKey(q.searchCity || q.location || '') });

/** @returns {{equivalent:boolean, comparable:number, changed:object[], onlyInA:string[], onlyInB:string[], reasons:string[]}} */
export function compareQuestionSnapshots(runA, runB) {
  const a = new Map(discovery(runA).map((q) => [q.questionId, q]));
  const b = new Map(discovery(runB).map((q) => [q.questionId, q]));
  const changed = [];
  let comparable = 0;
  for (const [id, qa] of a) {
    const qb = b.get(id);
    if (!qb) continue;
    const sa = sig(qa);
    const sb = sig(qb);
    const why = ['text', 'intent', 'location'].filter((k) => sa[k] !== sb[k]);
    if (why.length) changed.push({ questionId: id, reasons: why, before: qa.text, after: qb.text });
    else comparable += 1;
  }
  const onlyInA = [...a.keys()].filter((id) => !b.has(id));
  const onlyInB = [...b.keys()].filter((id) => !a.has(id));
  const reasons = [];
  if (runA?.questionSetVersion !== runB?.questionSetVersion) reasons.push('DIFFERENT_QUESTION_SET_VERSION');
  if (changed.length) reasons.push('QUESTIONS_CHANGED');
  if (onlyInA.length || onlyInB.length) reasons.push('DIFFERENT_QUESTIONS');
  if (!a.size || !b.size) reasons.push('NO_QUESTIONS');
  return { equivalent: reasons.length === 0, comparable, changed, onlyInA, onlyInB, reasons };
}

const diff = (x, y) => (x == null || y == null ? null : Math.round((y - x) * 10_000) / 10_000);

/** Side-by-side figures of two runs (A = older, B = newer), with changes only when the runs are equivalent. */
export function compareRuns(runA, runB) {
  const questions = compareQuestionSnapshots(runA, runB);
  const fa = pickRunFigures(runA);
  const fb = pickRunFigures(runB);
  const delta = questions.equivalent && fa && fb
    ? Object.fromEntries(['visibilityRate', 'recommendationRate', 'websiteCitationRate', 'uniqueCitedPages'].map((k) => [k, diff(fa[k], fb[k])]))
    : null;
  return {
    equivalent: questions.equivalent,
    reasons: questions.reasons,
    questions: { comparable: questions.comparable, changed: questions.changed, onlyInA: questions.onlyInA.length, onlyInB: questions.onlyInB.length },
    a: { id: String(runA._id), createdAt: runA.createdAt, completedAt: runA.completedAt ?? null, status: runA.status, questionSetVersion: runA.questionSetVersion ?? null, figures: fa },
    b: { id: String(runB._id), createdAt: runB.createdAt, completedAt: runB.completedAt ?? null, status: runB.status, questionSetVersion: runB.questionSetVersion ?? null, figures: fb },
    delta,
  };
}

/** Trend points from runs ordered oldest first. A point is "comparable" with the previous one only when both used the same set version. */
export function buildTrend(runs) {
  return runs.map((r, i) => {
    const prev = runs[i - 1];
    return {
      runId: String(r._id),
      date: r.completedAt || r.createdAt,
      status: r.status,
      questionSetVersion: r.questionSetVersion ?? null,
      comparableWithPrevious: Boolean(prev) && prev.questionSetVersion === r.questionSetVersion,
      figures: pickRunFigures(r),
    };
  });
}

export default { pickRunFigures, compareQuestionSnapshots, compareRuns, buildTrend };
