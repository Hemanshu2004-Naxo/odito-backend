/**
 * Socket.IO progress events for Google AI Overview Visibility. Same transport and room convention as every other long-running feature:
 * global.io -> room `project-{projectId}` (joined through the ownership-checked `join-project` handler in server.js, so a client can
 * only ever listen to runs of projects it owns).
 *
 *   google_aio_visibility:started | :question_started | :question_completed | :question_failed | :progress
 *   google_aio_visibility:completed | :partial | :failed | :cancelled         (terminal: emitted once, after the run is persisted)
 *
 * Payloads are built by an ALLOW-LIST: identifiers, counters and stable error CODES only. Question text, overview text, URLs, costs
 * and error messages never go on the socket; the frontend reads them through the authenticated HTTP API. State is persisted BEFORE an
 * event is emitted, so a client that missed one recovers the same state from GET .../summary.
 */

export const EVENTS = Object.freeze({
  started: 'google_aio_visibility:started',
  progress: 'google_aio_visibility:progress',
  question_started: 'google_aio_visibility:question_started',
  question_completed: 'google_aio_visibility:question_completed',
  question_failed: 'google_aio_visibility:question_failed',
  completed: 'google_aio_visibility:completed',
  partial: 'google_aio_visibility:partial',
  failed: 'google_aio_visibility:failed',
  cancelled: 'google_aio_visibility:cancelled',
});

const EXTRA_ALLOWED = ['questionId', 'questionIndex', 'questionStatus', 'overviewPresent', 'errorCode', 'succeeded', 'failed', 'skipped', 'pending'];

export function buildEventPayload(run, extra = {}) {
  const payload = {
    projectId: String(run.projectId),
    runId: String(run._id),
    status: run.status,
    stage: run.progress?.stage ?? run.status,
    completedQuestions: run.progress?.completed ?? 0,
    totalQuestions: run.progress?.total ?? 5,
    questionSetVersion: run.questionSetVersion ?? null,
    completedAt: run.completedAt ?? null,
    failureCode: run.failureCode ?? null,
    timestamp: new Date(),
  };
  for (const key of EXTRA_ALLOWED) if (extra[key] !== undefined) payload[key] = extra[key];
  return payload;
}

/** Never throws: a missing socket server or a bad room must not affect a run. */
export function emitGoogleAioEvent(kind, run, extra = {}) {
  try {
    const io = global.io;
    const event = EVENTS[kind];
    if (!io || !event || !run?.projectId) return false;
    io.to(`project-${String(run.projectId)}`).emit(event, buildEventPayload(run, extra));
    return true;
  } catch {
    return false;
  }
}

export default { emitGoogleAioEvent, buildEventPayload, EVENTS };
