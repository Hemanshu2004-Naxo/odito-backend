import { createHash } from 'node:crypto';
import { resolveSerpDevice } from '../services/serpDevices.js';

/**
 * Pure rules of the Standard task lifecycle (no I/O): request building, provider status classification, retry timing, circuit breaker.
 * Status codes (DataForSEO errors appendix): 20100 task created; 40601 task handed / 40602 task in queue (still processing);
 * 40101 internal SE error and 40103 execution failed (retryable); 40102 no results and 40106 partial results (the task COMPLETED);
 * 40401 not found / 40403 results expired / 40105 deleted (no result to fetch); 40202 rate limit / 40209 too many simultaneous queries;
 * 40200 payment required / 40201 account paused / 40100 not authorised (account level: nothing is submitted until it is fixed).
 */

export const POST_CREATED = 20100;
export const TASK_CODES = Object.freeze({
  OK: 20000, HANDED: 40601, IN_QUEUE: 40602,
  SE_INTERNAL: 40101, NO_RESULTS: 40102, EXEC_FAILED: 40103, DELETED: 40105, PARTIAL: 40106,
  NOT_FOUND: 40401, EXPIRED: 40403,
});
const THROTTLE_CODES = new Set([40202, 40209, 429]);
const ACCOUNT_CODES = new Set([40100, 40200, 40201]); // not authorised, payment required, account paused

/** The identity of a logical request. Project and keyword ids are NOT part of it: the same market question is the same purchase. */
export function dedupeKeyOf({ keyword, locationCode, languageCode, device, depth }) {
  return createHash('sha1')
    .update([String(keyword).trim().toLowerCase(), locationCode, String(languageCode).toLowerCase(), device, depth].join('|'))
    .digest('hex');
}

/** The task_post item for one logical request. Only fields task_post documents; `tag` carries OUR task id back on every result. */
export function buildTaskPostItem(task, { priority = 1, pingbackBaseUrl = '', pingbackSecret = '' } = {}) {
  const device = resolveSerpDevice(task.device);
  const item = {
    keyword: task.keyword,
    location_code: task.locationCode,
    language_code: task.languageCode,
    depth: task.depth,
    device: device.device,
    os: device.os,
    tag: String(task._id),
  };
  if (priority === 2) item.priority = 2;
  if (pingbackBaseUrl && pingbackSecret) {
    // $id / $tag are replaced by DataForSEO; the secret proves the call is ours (it only hints "ready": the fetch still verifies).
    item.pingback_url = `${pingbackBaseUrl}/api/serp-standard/pingback?id=$id&tag=$tag&token=${encodeURIComponent(pingbackSecret)}`;
  }
  return item;
}

/** How a task_post response item for one submitted task is to be treated. */
export function classifyPostItem(item) {
  const code = item?.status_code;
  if (code === POST_CREATED && typeof item?.id === 'string' && item.id) return { kind: 'accepted', id: item.id, cost: Number.isFinite(item.cost) ? item.cost : 0 };
  if (THROTTLE_CODES.has(code)) return { kind: 'throttled', code };
  if (ACCOUNT_CODES.has(code)) return { kind: 'account', code };
  if (code >= 50000 && code < 60000) return { kind: 'retryable', code };
  return { kind: 'rejected', code: code ?? null, message: typeof item?.status_message === 'string' ? item.status_message.slice(0, 200) : null };
}

/**
 * How one task_get/advanced answer is to be treated:
 *   ready      the task completed: 20000, or the completed-with-caveat 40102 (no results) / 40106 (partial); its data may be used
 *   pending    40601 / 40602: not finished yet (poll later)
 *   retryable  40101 / 40103 / 5xxxx: the provider gave up after its own retries; Odito-level recovery may resubmit later
 *   gone       40401 / 40403 / 40105: there is no result to fetch (resubmit if attempts remain)
 *   permanent  anything else (a rejected request): retrying the same request cannot help
 */
export function classifyTaskGet(task) {
  const code = task?.status_code;
  if (code === TASK_CODES.OK || code === TASK_CODES.NO_RESULTS || code === TASK_CODES.PARTIAL) return { kind: 'ready', code };
  if (code === TASK_CODES.HANDED || code === TASK_CODES.IN_QUEUE) return { kind: 'pending', code };
  if (code === TASK_CODES.SE_INTERNAL || code === TASK_CODES.EXEC_FAILED || (code >= 50000 && code < 60000)) return { kind: 'retryable', code };
  if (code === TASK_CODES.NOT_FOUND || code === TASK_CODES.EXPIRED || code === TASK_CODES.DELETED) return { kind: 'gone', code };
  return { kind: 'permanent', code: code ?? null };
}

/** A Live-shaped envelope around a stored task, so the existing parser / outcome code reads it exactly like a Live response. */
export function envelopeFromTask(task, { attempts = 1 } = {}) {
  const env = { status_code: 20000, status_message: 'Ok.', tasks_count: 1, tasks: [task] };
  Object.defineProperty(env, 'dfsAttempts', { value: attempts, enumerable: false });
  return env;
}

/** Odito-level recovery delay: base * 2^(attempt-1), capped, with +/-25% jitter so retries of one outage do not arrive together. */
export function retryDelayMs(attempt, { retryBaseMs, retryMaxMs }, random = Math.random) {
  const exp = Math.min(retryMaxMs, retryBaseMs * 2 ** Math.max(0, attempt - 1));
  return Math.max(1, Math.round(exp * (0.75 + random() * 0.5)));
}

/** Delay before the next direct task_get of a task that is still processing (exponential from pollCount, capped). */
export function directPollDelayMs(pollCount, { directPollMaxMs }, base = 15_000, random = Math.random) {
  const exp = Math.min(directPollMaxMs, base * 2 ** Math.min(pollCount, 10));
  return Math.round(exp * (0.85 + random() * 0.3));
}

/** Next ready-list poll interval: back to the base after something was ready, doubling (capped) while nothing is. */
export function nextPollIntervalMs(currentMs, gotReady, { pollBaseMs, pollMaxMs }) {
  if (gotReady || !currentMs) return pollBaseMs;
  return Math.min(pollMaxMs, currentMs * 2);
}

/** Circuit breaker verdict over the recent terminal outcomes (true = success). */
export function breakerShouldOpen(outcomes, { breakerWindow, breakerMinFailures }) {
  const recent = outcomes.slice(-breakerWindow);
  const failures = recent.filter((ok) => ok === false).length;
  return failures >= breakerMinFailures && failures * 2 >= recent.length;
}
