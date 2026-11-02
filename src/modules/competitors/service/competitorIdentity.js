/**
 * Pure helpers for telling whether two records are the same business. Deliberately conservative: a false merge hides a real competitor, a
 * missed merge only shows two rows the user can remove, so nothing here ever matches on a name alone.
 */

const squash = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * A match key for a record with no place and no website: normalized name + normalized address. Null unless BOTH are present and the
 * address is specific enough to mean something (a bare city or country is not an address).
 */
export function matchKey(name, address) {
  const n = squash(name);
  const a = squash(address);
  if (!n || !a || a.split(' ').length < 3) return null;
  return `${n}|${a}`;
}

/** Great-circle distance in metres between two coordinates (haversine). Null when either point is not a finite coordinate. */
export function distanceMeters(a, b) {
  const ok = (p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
  if (!ok(a) || !ok(b)) return null;
  const R = 6371008.8; const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat); const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(h))));
}
