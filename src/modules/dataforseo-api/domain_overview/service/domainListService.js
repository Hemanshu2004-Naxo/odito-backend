import SeoProject from '../../../app_user/model/SeoProject.js';
import { ValidationFailure } from '../../shared/targetDomain.js';
import { DOMAIN_LISTS } from '../config.js';

/**
 * The Referring Domains page's two saved lists, kept on the project: `disavowed_domains` (the domains the user marked to disavow) and
 * `reviewed_domains` (marked "OK / keep", so they stop showing as toxic warnings).
 *
 * BOTH fields are `select: false` on the model, so a bare read of the project never carries them. Every path that needs them — the
 * settings endpoints, the row flags, the CSV export — reads them through getDomainLists(), which asks for them explicitly. Nothing
 * else should select them.
 *
 * A change is ONE atomic update (an aggregation-pipeline update), so two tabs or a double click can neither duplicate a domain nor leave a
 * half-applied change, and the size cap is part of the update's filter. The lists are mutually exclusive: disavowing a domain takes it out of
 * the reviewed list and marking it OK takes it out of the disavow list. Order is the order of adding (the page shows newest first).
 */

const alive = (projectId) => ({ _id: projectId, is_deleted: { $ne: true } });
const FIELDS = '+disavowed_domains +reviewed_domains';
const FIELD = Object.freeze({ disavowed: 'disavowed_domains', reviewed: 'reviewed_domains' });

/** @returns {Promise<{ disavowed: string[], reviewed: string[] }>} */
export async function getDomainLists(projectId) {
  const doc = await SeoProject.findOne(alive(projectId)).select(FIELDS).lean();
  return { disavowed: [...(doc?.disavowed_domains ?? [])], reviewed: [...(doc?.reviewed_domains ?? [])] };
}

const limitError = () => new ValidationFailure(
  'body', `A list can hold at most ${DOMAIN_LISTS.maxPerList.toLocaleString('en-US')} domains. Remove some first.`, 'LIST_LIMIT_REACHED',
);

// Pipeline pieces: the field's current array, with some domains removed, and some added when not already there.
const current = (field) => ({ $ifNull: [`$${field}`, []] });
const without = (array, list) => ({ $filter: { input: array, cond: { $not: { $in: ['$$this', { $literal: list }] } } } });
const withNew = (array, list) => ({ $concatArrays: [array, { $filter: { input: { $literal: list }, cond: { $not: { $in: ['$$this', array] } } } }] });

/**
 * Applies one validated change (see parseDomainListChange) and resolves to both lists as saved.
 * @param {{ projectId: unknown, change: ReturnType<import('../validator/domainListInput.js').parseDomainListChange> }} args
 */
export async function applyDomainListChange({ projectId, change }) {
  const before = await getDomainLists(projectId);
  // What leaves a list: its own explicit removals, plus whatever is added to the OTHER list (the lists are mutually exclusive).
  const leaving = {
    disavowed: [...new Set([...change.disavowed.remove, ...change.reviewed.add])],
    reviewed: [...new Set([...change.reviewed.remove, ...change.disavowed.add])],
  };
  const set = {};
  for (const list of ['disavowed', 'reviewed']) {
    const field = FIELD[list];
    const kept = before[list].filter((d) => !leaving[list].includes(d));
    const fresh = change[list].add.filter((d) => !kept.includes(d));
    if (kept.length + fresh.length > DOMAIN_LISTS.maxPerList) throw limitError();
    if (leaving[list].length === 0 && change[list].add.length === 0) continue;
    set[field] = withNew(without(current(field), leaving[list]), change[list].add);
  }
  if (Object.keys(set).length === 0) return before;

  const res = await SeoProject.updateOne(
    {
      ...alive(projectId),
      // The cap is part of the filter: the update does nothing if a concurrent write already filled a list.
      $and: ['disavowed', 'reviewed'].filter((l) => set[FIELD[l]]).map((l) => ({
        $expr: { $lte: [{ $size: current(FIELD[l]) }, DOMAIN_LISTS.maxPerList] },
      })),
    },
    [{ $set: set }],
    { timestamps: false },
  );
  const after = await getDomainLists(projectId);
  if (res.matchedCount === 0) {
    const applied = ['disavowed', 'reviewed'].every((l) => change[l].add.every((d) => after[l].includes(d)));
    if (!applied) throw limitError();
  }
  return after;
}
