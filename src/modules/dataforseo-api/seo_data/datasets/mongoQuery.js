import { ValidationFailure } from '../../shared/targetDomain.js';

/**
 * Turns validated filter conditions into a MongoDB filter, and validated sort rules into a MongoDB sort. NOTHING from a request is ever
 * used as a field name or an operator: every field is looked up in a whitelist (`fieldMap` / `orderMap`) and every operator is a case in
 * a switch, so a request cannot inject `$where`, `$ne`, a path of its own or a regular expression (text is escaped and length-limited).
 *
 * A condition is `{ path, op, value }` where `path` is a stored (Mongo) field. Provider-shaped canonical conditions (what the pages send:
 * `[providerField, op, value]` or `{ or: [...] }`) are translated by `fromCanonical` with the dataset's field map first.
 */

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** `%text%` (the provider's contains pattern) or plain text -> the text. */
const unwrap = (v) => String(v).replace(/^%/, '').replace(/%$/, '');
const MAX_TEXT = 200;

const asDate = (v) => {
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new ValidationFailure('filters', 'invalid date');
  return d;
};

/** One internal condition -> a Mongo filter fragment. */
export function conditionToMongo({ path, op, value, kind }) {
  switch (op) {
    case 'like': return { [path]: { $regex: escapeRegex(unwrap(value).slice(0, MAX_TEXT)), $options: 'i' } };
    case 'not_like': return { [path]: { $not: { $regex: escapeRegex(unwrap(value).slice(0, MAX_TEXT)), $options: 'i' } } };
    case '=':
      // "no anchor text" is stored as null by the parser; the provider's "" means the same thing.
      if (value === '') return { [path]: { $in: [null, ''] } };
      return { [path]: value };
    case 'in': return { [path]: { $in: Array.isArray(value) ? value.slice(0, 200) : [value] } };
    case '>=': return { [path]: { $gte: kind === 'date' ? asDate(value) : value } };
    case '>': return { [path]: { $gt: kind === 'date' ? asDate(value) : value } };
    case '<=': return { [path]: { $lte: kind === 'date' ? asDate(value) : value } };
    case '<': return { [path]: { $lt: kind === 'date' ? asDate(value) : value } };
    default: throw new ValidationFailure('filters', `operator ${String(op).slice(0, 10)} is not supported`);
  }
}

/** Internal conditions (all must hold) -> a Mongo filter. Groups: `{ any: [conditions...] }` = OR. */
export function conditionsToMongo(conditions) {
  const parts = [];
  for (const c of conditions) {
    if (c && Array.isArray(c.any)) parts.push({ $or: c.any.map(conditionToMongo) });
    else parts.push(conditionToMongo(c));
  }
  return parts.length === 0 ? {} : parts.length === 1 ? parts[0] : { $and: parts };
}

/**
 * The page's canonical filters -> internal conditions through a field map `{ providerField: { path, kind?, transform? } }`.
 * A field that is not in the map is a ValidationFailure (the validators already restrict the fields; this is the second wall).
 */
export function fromCanonical(canonical, fieldMap) {
  const one = ([field, op, value]) => {
    const spec = Object.hasOwn(fieldMap, field) ? fieldMap[field] : null;
    if (!spec) throw new ValidationFailure('filters', `filtering by "${String(field).slice(0, 60)}" is not available from stored data`);
    return { path: spec.path, op, value: spec.transform ? spec.transform(value, op) : value, kind: spec.kind };
  };
  return canonical.map((c) => (c && !Array.isArray(c) && Array.isArray(c.or) ? { any: c.or.map(one) } : one(c)));
}

/**
 * Sort rules ("field,dir") -> a Mongo sort object. `_id` is always the last key so equal values page in a stable order (no row is shown on
 * two pages or skipped between them).
 */
export function toMongoSort(rules, orderMap) {
  const sort = {};
  for (const rule of rules) {
    const [field, dir] = String(rule).split(',');
    const spec = Object.hasOwn(orderMap, field) ? orderMap[field] : null;
    if (!spec || !['asc', 'desc'].includes(dir)) throw new ValidationFailure('order_by', 'that sort is not available from stored data');
    if (!(spec in sort)) sort[spec] = dir === 'asc' ? 1 : -1;
  }
  sort._id = 1;
  return sort;
}
