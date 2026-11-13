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
  // What the provider itself says about the SERP it read (first result block): counts only, never content.
  const block  = Array.isArray(result) ? result[0] : null;
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
    pagesCount:         finiteOrNull(block?.pages_count),
    reportedItemsCount: finiteOrNull(block?.items_count),
    seResultsCount:     finiteOrNull(block?.se_results_count),
  };
}

/**
 * COVERAGE: how much of the requested depth the response actually establishes - separate from the rank and from the task status.
 *   full      complete task (20000) AND the depth is established: organic count >= requested depth, OR every result the SERP reports
 *             (se_results_count) was returned, OR Google ran out of pages (pages_count < ceil(depth / 10))
 *   short     complete task but fewer organic positions than requested came back and none of the above holds: the response does not
 *             say whether Google has fewer results or pages are missing, so the depth is NOT established. A "not found" only means
 *             "not within the deepestOrganicRank results returned".
 *   partial   40106: pages were not retrieved
 *   no_results 40102: the search ran and Google returned nothing (nothing is hidden)
 *   none      40106 with no organic items
 * `coverageComplete` is true only for full and no_results. deepestOrganicRank / returnedOrganicCount are measurements of the response,
 * not claims about the SERP beyond it (and `Math.min(...,100)` is not applied here: the number is what the response held).
 */
export function assessCoverage(summary, outcome) {
  const base = {
    requestedDepth: summary.requestedDepth,
    returnedOrganicCount: summary.organicCount,
    deepestOrganicRank: summary.deepestOrganicRank,
    providerTaskStatus: summary.taskStatusCode,
    pagesCount: summary.pagesCount,
  };
  let resultCompleteness;
  if (outcome === ORGANIC_OUTCOMES.NO_RESULTS) resultCompleteness = 'no_results';
  else if (outcome === ORGANIC_OUTCOMES.PARTIAL) resultCompleteness = 'partial';
  else if (outcome === ORGANIC_OUTCOMES.PARTIAL_WITHOUT_RESULTS) resultCompleteness = 'none';
  else {
    // A COMPLETED task (20000) established the requested depth when ANY of these holds: it returned at least that many organic results;
    // it returned every result the SERP reports (se_results_count); or Google ran out of pages (fewer result pages than the depth needs).
    // Otherwise the response does not say why fewer came back, so the depth is not established ('short').
    const req = summary.requestedDepth;
    const reachedDepth = Number.isFinite(req) && (summary.organicCount >= req || (Number.isFinite(summary.deepestOrganicRank) && summary.deepestOrganicRank >= req));
    const returnedAll = Number.isFinite(summary.seResultsCount) && summary.seResultsCount > 0 && summary.organicCount >= summary.seResultsCount;
    const outOfPages = Number.isFinite(req) && Number.isFinite(summary.pagesCount) && summary.pagesCount > 0 && summary.pagesCount < Math.ceil(req / 10);
    resultCompleteness = reachedDepth || returnedAll || outOfPages ? 'full' : 'short';
  }
  return { ...base, resultCompleteness, coverageComplete: resultCompleteness === 'full' || resultCompleteness === 'no_results' };
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
  const c = assessCoverage(summary, outcome);
  return {
    outcome,
    provider_code:    summary.taskStatusCode,
    requested_depth:  summary.requestedDepth,
    returned_results: summary.organicCount,
    deepest_organic_rank: summary.deepestOrganicRank,
    coverage_complete: c.coverageComplete,
    result_completeness: c.resultCompleteness,
    ...(summary.pagesCount !== null ? { pages_count: summary.pagesCount } : {}),
  };
}
