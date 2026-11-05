import { readFromDatabase } from '../datasets/datasetReader.js';
import { latestDatasetState } from '../datasets/datasetCollector.js';
import { compareDatasets, keywordHistory, PERIODS } from '../datasets/datasetHistory.js';
import { deriveFromBacklinks, DERIVED_SORTS } from '../datasets/derived.js';
import { parseRankedKeywordsQuery } from '../../domain_overview/validator/rankedKeywordsQuery.js';
import { parseBacklinksListQuery } from '../../domain_overview/validator/backlinksListQuery.js';
import { parseReferringDomainsQuery } from '../../domain_overview/validator/referringDomainsQuery.js';
import { sendError } from '../../domain_overview/controller/domainOverviewController.js';
import { ValidationFailure } from '../../shared/targetDomain.js';

/**
 * Database-only listing endpoints for the stored datasets. These accept SIMPLE parameters (search text, ranges, flags), turn them into the
 * pages' provider-shaped filters, and run them through the SAME validators the section routes use (whitelists, length limits, caps)
 * before anything reaches MongoDB. None of them can reach the provider; they answer `missing` when no dataset has been collected.
 *
 * Runs AFTER auth + validateProjectAccess(): `req.project` is a project the user owns. Project, domain and market never come from the request.
 */

const one = (v) => (Array.isArray(v) ? v[v.length - 1] : v);
const text = (field, raw, max = 100) => {
  const v = one(raw);
  if (v === undefined || v === '') return null;
  if (typeof v !== 'string' || v.length > max || /[\u0000-\u001f%]/.test(v)) throw new ValidationFailure(field, `${field} must be plain text of at most ${max} characters`);
  return v.trim() || null;
};
const whole = (field, raw, { min = 0, max = 1e9 } = {}) => {
  const v = one(raw);
  if (v === undefined || v === '') return null;
  if (!/^\d{1,10}$/.test(String(v)) || Number(v) < min || Number(v) > max) throw new ValidationFailure(field, `${field} must be a whole number from ${min} to ${max}`);
  return Number(v);
};
const flag = (field, raw) => {
  const v = one(raw);
  if (v === undefined || v === '') return null;
  if (v !== 'true' && v !== 'false') throw new ValidationFailure(field, `${field} must be true or false`);
  return v === 'true';
};
const dateDay = (field, raw) => {
  const v = one(raw);
  if (v === undefined || v === '') return null;
  const d = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : null;
  if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw new ValidationFailure(field, `${field} must be a date as YYYY-MM-DD`);
  return v;
};
const oneOf = (field, raw, allowed, fallback) => {
  const v = one(raw);
  if (v === undefined || v === '') return fallback;
  if (!allowed.includes(v)) throw new ValidationFailure(field, `${field} must be one of ${allowed.join(', ')}`);
  return v;
};
/** page (1-based) + limit -> offset/limit strings for the shared validators. */
function paging(q, { limits = ['25', '50', '100'], defaultLimit = '50' } = {}) {
  const limit = oneOf('limit', q.limit, limits, defaultLimit);
  const page = whole('page', q.page, { min: 1, max: 1000 }) ?? 1;
  return { limit, offset: String((page - 1) * Number(limit)), page };
}
const pageMeta = (data, page, limit) => ({ ...data, page, limit: Number(limit) });
const noStore = (res) => res.set('Cache-Control', 'no-store');
const missing = (res) => { noStore(res); return res.status(200).json({ success: true, data: { missing: true, items: [], totalCount: 0 } }); };

const ROW = 'ranked_serp_element.serp_item';
const KEYWORD_SORTS = Object.freeze({
  traffic: `${ROW}.etv`, position: `${ROW}.rank_group`, volume: 'keyword_data.keyword_info.search_volume',
  difficulty: 'keyword_data.keyword_properties.keyword_difficulty', cpc: 'keyword_data.keyword_info.cpc', keyword: 'keyword_data.keyword',
});

async function respond(res, project, section, query, extraConditions, page, limit) {
  const out = await readFromDatabase({ project, section, query, extraConditions });
  if (!out) return missing(res);
  noStore(res);
  return res.status(200).json({
    success: true,
    data: pageMeta({ missing: false, stale: out.stale, capturedAt: out.capturedAt, expiresAt: out.expiresAt, dataset: out.dataset, ...out.payload }, page, limit),
  });
}

/** GET /seo-datasets/keywords?q&url&intent&position_min&position_max&volume_min&difficulty_max&location&device&sort&dir&page&limit */
export async function listKeywords(req, res) {
  try {
    const q = req.query;
    const { limit, offset, page } = paging(q);
    const filters = [];
    const kw = text('q', q.q); if (kw) filters.push(['keyword_data.keyword', 'like', `%${kw.toLowerCase()}%`]);
    const url = text('url', q.url); if (url) filters.push([`${ROW}.relative_url`, 'like', `%${url}%`]);
    const pmin = whole('position_min', q.position_min, { min: 1, max: 100 }); if (pmin !== null) filters.push([`${ROW}.rank_group`, '>=', pmin]);
    const pmax = whole('position_max', q.position_max, { min: 1, max: 100 }); if (pmax !== null) filters.push([`${ROW}.rank_group`, '<=', pmax]);
    const vol = whole('volume_min', q.volume_min); if (vol !== null) filters.push(['keyword_data.keyword_info.search_volume', '>=', vol]);
    const kd = whole('difficulty_max', q.difficulty_max, { max: 100 }); if (kd !== null) filters.push(['keyword_data.keyword_properties.keyword_difficulty', '<=', kd]);
    const intent = one(q.intent);
    if (intent !== undefined && intent !== '') {
      const list = String(intent).split(',');
      filters.push(['keyword_data.search_intent_info.main_intent', 'in', list]);
    }
    const sort = oneOf('sort', q.sort, Object.keys(KEYWORD_SORTS), 'traffic');
    const dir = oneOf('dir', q.dir, ['asc', 'desc'], sort === 'position' || sort === 'keyword' ? 'asc' : 'desc');
    const query = parseRankedKeywordsQuery({
      limit, offset, order_by: `${KEYWORD_SORTS[sort]},${dir}`, ...(filters.length ? { filters: JSON.stringify(filters.length === 1 ? filters[0] : filters.flatMap((f, i) => (i ? ['and', f] : [f]))) } : {}),
    });
    const extra = [];
    const loc = text('location', q.location); if (loc) extra.push({ path: 'location', op: '=', value: loc });
    const dev = text('device', q.device, 20); if (dev) extra.push({ path: 'device', op: '=', value: dev });
    return await respond(res, req.project, 'ranked-keywords', query, extra, page, limit);
  } catch (err) {
    return sendError(res, err, { projectId: String(req.project?._id || ''), route: 'seo-datasets/keywords' });
  }
}

const BACKLINK_SORTS = Object.freeze(['rank', 'domain_from_rank', 'page_from_rank', 'first_seen', 'last_seen', 'backlink_spam_score']);

/** GET /seo-datasets/backlinks?status&source_url&target_url&anchor&source_domain&follow&first_seen_from&sort&dir&mode&page&limit */
export async function listBacklinks(req, res) {
  try {
    const q = req.query;
    const { limit, offset, page } = paging(q);
    const filters = [];
    const src = text('source_url', q.source_url); if (src) filters.push(['url_from', 'like', `%${src}%`]);
    const tgt = text('target_url', q.target_url); if (tgt) filters.push(['url_to', 'like', `%${tgt}%`]);
    const anchor = text('anchor', q.anchor); if (anchor) filters.push(['anchor', 'like', `%${anchor}%`]);
    const dom = text('source_domain', q.source_domain, 253); if (dom) filters.push(['domain_from', '=', dom.toLowerCase()]);
    const follow = flag('follow', q.follow); if (follow !== null) filters.push(['dofollow', '=', follow]);
    const since = dateDay('first_seen_from', q.first_seen_from); if (since) filters.push(['first_seen', '>=', since]);
    const sort = oneOf('sort', q.sort, BACKLINK_SORTS, 'rank');
    const dir = oneOf('dir', q.dir, ['asc', 'desc'], 'desc');
    const query = parseBacklinksListQuery({
      status: oneOf('status', q.status, ['live', 'lost'], 'live'), mode: oneOf('mode', q.mode, ['as_is', 'one_per_domain', 'one_per_anchor'], 'as_is'),
      limit, offset, order_by: `${sort},${dir}`, ...(filters.length ? { filters: JSON.stringify(filters.length === 1 ? filters[0] : filters.flatMap((f, i) => (i ? ['and', f] : [f]))) } : {}),
    });
    return await respond(res, req.project, 'backlinks-list', query, [], page, limit);
  } catch (err) {
    return sendError(res, err, { projectId: String(req.project?._id || ''), route: 'seo-datasets/backlinks' });
  }
}

const RD_SORTS = Object.freeze(['rank', 'backlinks', 'referring_pages', 'backlinks_spam_score', 'broken_backlinks', 'first_seen']);

/** GET /seo-datasets/referring-domains?status&q&follow&country&first_seen_from&first_seen_to&min_rank&sort&dir&page&limit */
export async function listReferringDomains(req, res) {
  try {
    const q = req.query;
    const { limit, offset, page } = paging(q);
    const filters = [];
    const dom = text('q', q.q, 100); if (dom) filters.push(['domain', 'like', `%${dom.toLowerCase()}%`]);
    const rank = whole('min_rank', q.min_rank, { max: 1000 }); if (rank !== null) filters.push(['rank', '>=', rank]);
    const since = dateDay('first_seen_from', q.first_seen_from); if (since) filters.push(['first_seen', '>=', since]);
    const sort = oneOf('sort', q.sort, RD_SORTS, 'rank');
    const dir = oneOf('dir', q.dir, ['asc', 'desc'], 'desc');
    const query = parseReferringDomainsQuery({
      status: oneOf('status', q.status, ['live', 'lost'], 'live'), ...(flag('follow', q.follow) === true ? { dofollow: '1' } : {}),
      limit, offset, order_by: `${sort},${dir}`, ...(filters.length ? { filters: JSON.stringify(filters.length === 1 ? filters[0] : filters.flatMap((f, i) => (i ? ['and', f] : [f]))) } : {}),
    });
    const extra = [];
    const country = text('country', q.country, 10); if (country) extra.push({ path: 'country', op: '=', value: country.toUpperCase() });
    const to = dateDay('first_seen_to', q.first_seen_to); if (to) extra.push({ path: 'firstSeen', op: '<=', value: to, kind: 'date' });
    return await respond(res, req.project, 'referring-domains', query, extra, page, limit);
  } catch (err) {
    return sendError(res, err, { projectId: String(req.project?._id || ''), route: 'seo-datasets/referring-domains' });
  }
}

/** GET /seo-datasets/anchors | /seo-datasets/pages  (derived from the stored backlinks) */
export const listDerived = (view) => async (req, res) => {
  try {
    const q = req.query;
    const { limit, offset, page } = paging(q);
    const sort = oneOf('sort', q.sort, DERIVED_SORTS[view], 'backlinks');
    const out = await deriveFromBacklinks({
      project: req.project, view, status: oneOf('status', q.status, ['live', 'lost'], 'live'), sort, dir: oneOf('dir', q.dir, ['asc', 'desc'], 'desc'), skip: Number(offset), limit: Number(limit),
    });
    if (!out) return missing(res);
    noStore(res);
    return res.status(200).json({ success: true, data: pageMeta({ missing: false, ...out }, page, limit) });
  } catch (err) {
    return sendError(res, err, { projectId: String(req.project?._id || ''), route: `seo-datasets/${view}` });
  }
};

/** GET /seo-datasets -> what is stored: per dataset, the latest complete scan, its row count, the provider's total and whether it is capped. */
export async function datasetStatus(req, res) {
  try {
    const projectId = req.project._id;
    const specs = [['keywords', null], ['backlinks', 'live'], ['backlinks', 'lost'], ['referringDomains', 'live'], ['referringDomains', 'lost']];
    const states = await Promise.all(specs.map(([kind, status]) => latestDatasetState({ projectId, kind, status })));
    noStore(res);
    return res.status(200).json({
      success: true,
      data: {
        datasets: specs.map(([kind, status], i) => {
          const s = states[i];
          return {
            kind, status, collected: Boolean(s), scanId: s ? String(s.scanId) : null, capturedAt: s?.capturedAt ?? null,
            rows: s?.data?.rows ?? null, providerTotal: s?.data?.totalCount ?? null, truncated: s ? Boolean(s.data?.truncated) : null,
          };
        }),
      },
    });
  } catch (err) {
    return sendError(res, err, { projectId: String(req.project?._id || ''), route: 'seo-datasets' });
  }
}

const KIND_PARAM = Object.freeze({ keywords: 'keywords', backlinks: 'backlinks', 'referring-domains': 'referringDomains' });

/** GET /seo-datasets/changes?dataset=keywords|backlinks|referring-domains&status&period=previous|week|month  (MongoDB only) */
export async function datasetChanges(req, res) {
  try {
    const dataset = oneOf('dataset', req.query.dataset, Object.keys(KIND_PARAM), null);
    if (!dataset) throw new ValidationFailure('dataset', `dataset must be one of ${Object.keys(KIND_PARAM).join(', ')}`);
    const kind = KIND_PARAM[dataset];
    const status = kind === 'keywords' ? null : oneOf('status', req.query.status, ['live', 'lost'], 'live');
    const out = await compareDatasets({ projectId: req.project._id, kind, status, period: oneOf('period', req.query.period, PERIODS, 'previous') });
    noStore(res);
    return res.status(200).json({ success: true, data: out });
  } catch (err) {
    return sendError(res, err, { projectId: String(req.project?._id || ''), route: 'seo-datasets/changes' });
  }
}

/** GET /seo-datasets/keywords/history?keyword= -> that keyword's stored positions over time and its best position. */
export async function keywordHistoryRoute(req, res) {
  try {
    const keyword = text('keyword', req.query.keyword, 200);
    if (!keyword) throw new ValidationFailure('keyword', 'keyword is required');
    const out = await keywordHistory({ projectId: req.project._id, keyword });
    noStore(res);
    return res.status(200).json({ success: true, data: out });
  } catch (err) {
    return sendError(res, err, { projectId: String(req.project?._id || ''), route: 'seo-datasets/keywords/history' });
  }
}
