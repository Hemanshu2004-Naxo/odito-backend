/**
 * Socket.IO progress events for ChatGPT visibility. Same transport and room convention as every other long-running feature:
 * global.io -> room `project-{projectId}` (joined through the ownership-checked `join-project` handler in server.js).
 *
 * Events: chatgpt_visibility:started | :progress | :completed | :failed                      (legacy five-prompt runs, unchanged)
 *         chatgpt_visibility:question_started | :question_completed | :question_failed        (approved-question runs)
 *         chatgpt_visibility:partial | :cancelled                                            (approved-question runs: precise terminal states)
 *
 * Payloads are built by an ALLOW-LIST: only the fields below can ever be emitted. Answers, question/prompt text, annotations, costs, lease
 * data and error messages are never put on the socket; the frontend fetches details through the authenticated HTTP API. State is persisted
 * BEFORE an event is emitted, so a client that missed one (reconnect) recovers the same state from GET .../summary.
 */

const EVENTS = Object.freeze({
  started: 'chatgpt_visibility:started',
  progress: 'chatgpt_visibility:progress',
  completed: 'chatgpt_visibility:completed',
  failed: 'chatgpt_visibility:failed',
  partial: 'chatgpt_visibility:partial',
  cancelled: 'chatgpt_visibility:cancelled',
  question_started: 'chatgpt_visibility:question_started',
  question_completed: 'chatgpt_visibility:question_completed',
  question_failed: 'chatgpt_visibility:question_failed',
});

// The only extras a caller may add: identifiers, counters and a stable error CODE (never a message).
const EXTRA_ALLOWED = ['questionId', 'intent', 'questionStatus', 'errorCode', 'succeeded', 'failed', 'skipped', 'pending'];

export function buildEventPayload(run, extra = {}) {
  const payload = {
    projectId: String(run.projectId),
    runId: String(run._id),
    auditRunId: run.auditRunId ? String(run.auditRunId) : null,
    status: run.status,
    stage: run.progress?.stage ?? run.status,
    completedPrompts: run.progress?.completed ?? 0,
    totalPrompts: run.progress?.total ?? 5,
    completedAt: run.completedAt ?? null,
    failureCode: run.failureCode ?? null,
    timestamp: new Date(),
  };
  if (run.executionMode === 'approved_questions') {
    payload.executionMode = 'approved_questions';
    payload.questionSetId = run.questionSetId ? String(run.questionSetId) : null;
    payload.questionSetVersion = run.questionSetVersion ?? null;
  }
  for (const key of EXTRA_ALLOWED) if (extra[key] !== undefined) payload[key] = extra[key];
  return payload;
}

/** Never throws: a missing socket server or a bad room must not affect a run. */
export function emitVisibilityEvent(kind, run, extra = {}) {
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

export default { emitVisibilityEvent, buildEventPayload };
