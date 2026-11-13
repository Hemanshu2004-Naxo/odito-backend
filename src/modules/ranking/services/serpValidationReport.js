/**
 * Per-item SERP -> ranking audit report, built by the SAME engine that produces rankings (serpRankCalculator /
 * serpUrlResolver / serpDomainMatcher). Used by scripts/serp-validation/validate-serp-ranking.mjs (live, after explicit
 * authorisation) and by the fixture tests. Contains no credentials: it only reads a response body.
 */

import { calculateSerpRankings } from './serpRankCalculator.js';
import { resolveSerpItem } from './serpUrlResolver.js';
import { matchSerpResultDomain } from './serpDomainMatcher.js';

function flatten(data) {
  const result = data?.tasks?.[0]?.result;
  return Array.isArray(result) ? result.flatMap((p) => (Array.isArray(p?.items) ? p.items : [])) : [];
}

export function buildSerpValidationReport(data, trackedDomain, { device = null, requestedDepth = null, providerCode = null } = {}) {
  const items = flatten(data);
  const calc = calculateSerpRankings(items, trackedDomain);
  const task = data?.tasks?.[0] ?? null;
  const rows = [];
  items.forEach((item, index) => {
    const base = { index, type: item?.type ?? null, rank_group: item?.rank_group ?? null, rank_absolute: item?.rank_absolute ?? null };
    if (item?.type === 'organic') {
      const r = resolveSerpItem(item);
      const m = r.resolutionStatus === 'resolved' ? matchSerpResultDomain({ trackedDomain, resultHostname: r.hostname }) : null;
      rows.push({
        ...base, originalUrl: item.url ?? null, resolvedUrl: r.resolvedUrl, resolvedHostname: r.hostname,
        resolutionStatus: r.resolutionStatus, resolutionMethod: r.resolutionMethod,
        matched: !!m?.matched, matchType: m?.matchType ?? null,
      });
    } else if (item?.type === 'local_pack') {
      for (const el of Array.isArray(item.items) ? item.items : []) {
        const r = resolveSerpItem(el);
        rows.push({
          ...base, type: 'local_pack_element', rank_group: el?.rank_group ?? null, rank_absolute: el?.rank_absolute ?? null,
          cid: el?.cid ?? null, title: el?.title ?? null, originalUrl: el?.url ?? null, resolvedHostname: r.hostname,
          resolutionStatus: r.resolutionStatus,
          matched: !!(r.hostname && matchSerpResultDomain({ trackedDomain, resultHostname: r.hostname }).matched),
        });
      }
    } else {
      rows.push(base);
    }
  });
  const returnedOrganic = items.filter((i) => i?.type === 'organic').length;
  const partial = providerCode === 40106 || task?.status_code === 40106;
  return {
    device, trackedDomain, requestedDepth, providerCode: providerCode ?? task?.status_code ?? null,
    completeness: partial ? 'partial' : 'complete', returnedOrganic,
    resultTypes: [...new Set(items.map((i) => i?.type ?? 'unknown'))],
    final: {
      organicRank: calc.organicRank, absoluteRank: calc.absoluteRank, localPackRank: calc.localPackRank,
      rankingStatus: partial && calc.rankingStatus === 'not_found' ? 'unknown' : calc.rankingStatus,
      betterRankPossible: calc.betterRankPossible, unresolvedOrganic: calc.stats.unresolvedOrganic,
    },
    rows,
  };
}

/** Compact fixed-width table for terminals / saved .txt reports. */
export function formatSerpValidationReport(report) {
  const head = `device=${report.device} target=${report.trackedDomain} code=${report.providerCode} completeness=${report.completeness} ` +
    `organicReturned=${report.returnedOrganic} types=${report.resultTypes.join(',')}`;
  const lines = report.rows.map((r) =>
    `${String(r.index).padStart(3)} ${String(r.type).padEnd(18)} grp=${String(r.rank_group ?? '-').padEnd(4)} abs=${String(r.rank_absolute ?? '-').padEnd(4)} ` +
    `${(r.resolvedHostname ?? '-').padEnd(34)} ${r.resolutionStatus ?? ''}${r.matched ? `  <== MATCH(${r.matchType ?? 'local'})` : ''}` +
    `${r.originalUrl && r.resolvedUrl && r.originalUrl !== r.resolvedUrl ? `  (from ${r.originalUrl.slice(0, 60)})` : ''}`);
  const f = report.final;
  return [head, ...lines, `FINAL organic=${f.organicRank} absolute=${f.absoluteRank} localPack=${f.localPackRank} status=${f.rankingStatus}` +
    `${f.unresolvedOrganic ? ` unresolvedRedirects=${f.unresolvedOrganic}` : ''}${f.betterRankPossible ? ' (better rank possible)' : ''}`].join('\n');
}
