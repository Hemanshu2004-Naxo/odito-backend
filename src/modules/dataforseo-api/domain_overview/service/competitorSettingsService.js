import SeoProject from '../../../app_user/model/SeoProject.js';
import { ValidationFailure } from '../../shared/targetDomain.js';
import { COMPETITORS_QUERY } from '../config.js';

/**
 * The Competitors page's two saved lists, kept on the project: `tracked_competitors` (pinned for the Compare section, max 10) and
 * `excluded_competitors` (sent to DataForSEO as `exclude_domains`, max 1,000). Both fields are `select: false` on the model, so they
 * are read here explicitly and never travel with a project list.
 *
 * Writes are single atomic updates ($addToSet / $pull) with the cap checked INSIDE the update's filter, so two tabs (or a double click)
 * can neither duplicate a domain nor push a list past its cap. Adding a domain that is already there succeeds (idempotent).
 * Callers pass domains that are already clean (see normalizeDomainInput).
 */

export const LISTS = Object.freeze({
  tracked: { field: 'tracked_competitors', cap: COMPETITORS_QUERY.maxTrackedDomains, code: 'TRACKED_LIMIT_REACHED', noun: 'tracked competitors' },
  excluded: { field: 'excluded_competitors', cap: COMPETITORS_QUERY.maxExcludedDomains, code: 'EXCLUDED_LIMIT_REACHED', noun: 'excluded domains' },
});

const alive = (projectId) => ({ _id: projectId, is_deleted: { $ne: true } });

/** @returns {Promise<{ tracked: string[], excluded: string[] }>} */
export async function getCompetitorSettings(projectId) {
  const doc = await SeoProject.findOne(alive(projectId)).select('+tracked_competitors +excluded_competitors').lean();
  return { tracked: [...(doc?.tracked_competitors ?? [])], excluded: [...(doc?.excluded_competitors ?? [])] };
}

/** The project's exclude list: what the competitors request sends as `exclude_domains`. */
export async function getExcludedCompetitors(projectId) {
  const doc = await SeoProject.findOne(alive(projectId)).select('+excluded_competitors').lean();
  return [...(doc?.excluded_competitors ?? [])];
}

const limitError = (spec) => new ValidationFailure('domain', `You can have at most ${spec.cap.toLocaleString('en-US')} ${spec.noun}. Remove one first.`, spec.code);

/**
 * Adds clean domains to a list. `list` = 'tracked' | 'excluded'. Resolves to both lists as saved.
 * The project's own domain can be neither tracked (it is always in the comparison) nor excluded (it is never in the list).
 */
export async function addDomains({ projectId, list, domains, projectDomain = null }) {
  const spec = LISTS[list];
  const wanted = [...new Set(domains)];
  if (projectDomain && wanted.includes(projectDomain)) {
    throw new ValidationFailure(
      'domain',
      list === 'tracked' ? 'Your own domain is always part of the comparison.' : 'This is your own domain, so there is nothing to exclude.',
      'OWN_DOMAIN',
    );
  }
  const before = await getCompetitorSettings(projectId);
  const fresh = wanted.filter((d) => !before[list].includes(d));
  if (fresh.length === 0) return before;
  if (before[list].length + fresh.length > spec.cap) throw limitError(spec);

  const res = await SeoProject.updateOne(
    // The cap is part of the filter: the update does nothing if the list is already too long to take `fresh` (a concurrent write).
    { ...alive(projectId), $expr: { $lte: [{ $size: { $ifNull: [`$${spec.field}`, []] } }, spec.cap - fresh.length] } },
    { $addToSet: { [spec.field]: { $each: fresh } } },
  );
  const after = await getCompetitorSettings(projectId);
  if (res.matchedCount === 0 && !fresh.every((d) => after[list].includes(d))) throw limitError(spec);
  return after;
}

/** Removes one clean domain from a list. Removing a domain that is not there succeeds. */
export async function removeDomain({ projectId, list, domain }) {
  const spec = LISTS[list];
  await SeoProject.updateOne(alive(projectId), { $pull: { [spec.field]: domain } });
  return getCompetitorSettings(projectId);
}
