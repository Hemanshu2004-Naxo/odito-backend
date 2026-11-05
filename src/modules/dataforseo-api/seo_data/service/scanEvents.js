/**
 * Socket.IO progress events for SEO scans. Same transport and room convention as the other long-running features: global.io -> room
 * `project-{projectId}` (joined through the ownership-checked `join-project` handler in server.js).
 *
 * State is persisted BEFORE an event is emitted, so a client that missed one (or reloaded the page) recovers the same state from
 * GET .../seo-scans/latest. Payloads are an allow-list: identifiers, counters and stable codes only - never costs, errors or provider data.
 */
export const EVENTS = Object.freeze({
  started: 'seo_scan:started',
  progress: 'seo_scan:progress',
  dataset_completed: 'seo_scan:dataset_completed',
  dataset_failed: 'seo_scan:dataset_failed',
  completed: 'seo_scan:completed',
  partial: 'seo_scan:partial',
  failed: 'seo_scan:failed',
});

export function buildEventPayload(run, extra = {}) {
  const total = run.datasets?.length ?? run.datasetsRequested?.length ?? 0;
  const payload = {
    projectId: String(run.projectId),
    scanId: String(run._id),
    scope: run.scope,
    status: run.status,
    totalDatasets: total,
    completedDatasets: run.datasetsCompleted ?? 0,
    failedDatasets: run.datasetsFailed ?? 0,
    timestamp: new Date(),
  };
  if (extra.datasetId) payload.datasetId = String(extra.datasetId);
  if (extra.errorCode) payload.errorCode = String(extra.errorCode);
  return payload;
}

/** Never throws: a missing socket server must not affect a scan. */
export function emitScanEvent(kind, run, extra = {}) {
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
