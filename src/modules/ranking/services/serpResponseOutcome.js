/**
 * What a Google Organic SERP (live/advanced) response actually contains, and what the ranking pipeline may do with it.
 *
 * Pure — no I/O. Used by DataForSeoService.getSerpOrganic to decide whether a response is usable and to log a sanitized
 * shape (never credentials, never SERP content beyond item types and counts).
 *
 * Outcomes:
 *   complete                 task 20000: the full requested depth was searched
 *   no_results               task 40102: the search ran and Google returned no results (a completed check: not found)
 *   partial                  task 40106 with organic items: some result pages were not retrieved (and not billed); the
 *                            returned items are real and a rank found in them is real
 *   partial_without_results  task 40106 with no organic items: nothing usable, treated as a failed scan
 */

import { DFS_TASK_CODES } from './dataForSeoRetry.js';

export const ORGANIC_OUTCOMES = Object.freeze({
  COMPLETE:                'complete',
  NO_RESULTS:              'no_results',
  PARTIAL:                 'partial',
  PARTIAL_WITHOUT_RESULTS: 'partial_without_results',
});

/** Task codes getSerpOrganic accepts as a completed task instead of throwing. */
export const ORGANIC_ACCEPTED_TASK_CODES = new Set([DFS_TASK_CODES.NO_RESULTS, DFS_TASK_CODES.PARTIAL]);

function finiteOrNull(v) {
  return Number.isFinite(v) ? v : null;
}

/**
 * Sanitized structure of one organic response. Counts and codes only.
 * @returns {object}
 */
export function summarizeOrganicResponse(data, { httpStatus = null, requestedDepth = null } = {}) {
  const task   = data?.tasks?.[0];
  const result = task?.result;
  const itemTypes = {};
  let itemsCount = 0, organicCount = 0, deepestOrganicRank = null;

  if (Array.isArray(result)) {
    for (const page of result) {
      if (!Array.isArray(page?.items)) continue;
      for (const item of page.items) {
        itemsCount++;
        const type = typeof item?.type === 'string' ? item.type : 'unknown';
        itemTypes[type] = (itemTypes[type] ?? 0) + 1;
        if (type !== 'organic') continue;
        organicCount++;
        const pos = item.rank_group ?? item.rank_absolute;
        if (Number.isFinite(pos) && (deepestOrganicRank === null || pos > deepestOrganicRank)) deepestOrganicRank = pos;
      }
    }
  }

  return {
    httpStatus:         finiteOrNull(httpStatus),
    statusCode:         finiteOrNull(data?.status_code),
    taskStatusCode:     finiteOrNull(task?.status_code),
    taskStatusMessage:  typeof task?.status_message === 'string' ? task.status_message.slice(0, 200) : null,
    taskId:             typeof task?.id === 'string' ? task.id : null,
    cost:               finiteOrNull(task?.cost),
    resultCount:        finiteOrNull(task?.result_count),
    resultPresent:      result != null,
    resultLength:       Array.isArray(result) ? result.length : 0,
    itemsCount,
    itemTypes,
    organicCount,
    deepestOrganicRank,
    requestedDepth:     finiteOrNull(requestedDepth),
  };
}

/** Outcome for a summary from summarizeOrganicResponse. Anything not listed in the module doc is 'complete' only on 20000. */
export function assessOrganicOutcome(summary) {
  switch (summary?.taskStatusCode) {
    case DFS_TASK_CODES.NO_RESULTS: return ORGANIC_OUTCOMES.NO_RESULTS;
    case DFS_TASK_CODES.PARTIAL:
      return summary.organicCount > 0 ? ORGANIC_OUTCOMES.PARTIAL : ORGANIC_OUTCOMES.PARTIAL_WITHOUT_RESULTS;
    default: return ORGANIC_OUTCOMES.COMPLETE;
  }
}

/** The compact form carried with a scan result and persisted on the channel scan state. */
export function toSerpMeta(summary, outcome) {
  return {
    outcome,
    provider_code:    summary.taskStatusCode,
    requested_depth:  summary.requestedDepth,
    returned_results: summary.organicCount,
  };
}
