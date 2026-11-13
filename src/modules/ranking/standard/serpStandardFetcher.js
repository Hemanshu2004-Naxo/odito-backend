import { getStandardService, SerpTaskError } from './serpStandardService.js';
import { envelopeFromTask } from './serpStandardCore.js';
import { summarizeOrganicResponse, assessOrganicOutcome, toSerpMeta } from '../services/serpResponseOutcome.js';
import { resolveSerpDepth } from '../services/serpDevices.js';

/**
 * The Standard counterpart of the Live organic request: same inputs, same OUTPUT. The returned object is a Live-shaped envelope
 * ({ status_code, tasks: [task] } carrying `dfsAttempts` and `dfsSerpMeta`), so everything downstream - resolveSerpResultUrl,
 * matchSerpResultDomain, calculateSerpRankings, RankingParserService, buildDeviceResult, rankingHistoryService - runs UNCHANGED.
 *
 * Failure semantics are the Live ones: a task that cannot deliver throws (a scan_error; the previous ranking is kept, never rank 101).
 * `err.standardFinal` tells the caller whether Odito has stopped trying for this request (used by the optional Live fallback).
 *
 * @param {{ keyword: string, locationCode: number, languageCode: string, device: 'desktop'|'mobile', context?: { projectId?: any, keywordId?: any } }} input
 * @param {{ service?: object, waitMs?: number }} [deps]
 */
export async function fetchSerpViaStandard({ keyword, locationCode, languageCode, device, context = {} }, { service = getStandardService(), waitMs } = {}) {
  const depth = resolveSerpDepth();
  const { task, reused } = await service.requestTask({
    keyword, locationCode, languageCode, device, depth, projectId: context.projectId ?? null, keywordId: context.keywordId ?? null,
  });
  console.log(`[DATAFORSEO_STANDARD_REQUEST] device=${device} | keyword="${keyword}" | loc=${locationCode} | depth=${depth} | taskId=${task._id} | status=${task.status} | reused=${reused ?? 'no'}`);

  const done = task.status === 'completed' ? task : await service.awaitTask(task._id, waitMs ? { timeoutMs: waitMs } : undefined);
  const data = envelopeFromTask(done.result, { attempts: done.attempts ?? 1 });
  const summary = summarizeOrganicResponse(data, { requestedDepth: depth });
  const outcome = assessOrganicOutcome(summary);
  console.log(`[DATAFORSEO_STANDARD_RESPONSE] device=${device} | taskId=${done._id} | outcome=${outcome} | attempts=${done.attempts} | cost=${done.cost} | organic=${summary.organicCount}`);
  Object.defineProperty(data, 'dfsSerpMeta', { value: toSerpMeta(summary, outcome), enumerable: false });
  Object.defineProperty(data, 'dfsProvider', { value: 'standard', enumerable: false });
  return data;
}

export { SerpTaskError };
