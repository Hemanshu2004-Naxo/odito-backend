import { ValidationFailure } from '../../shared/targetDomain.js';
import {
  SECTION_NAMES, DEFAULT_MARKET, HISTORY_MONTHS, HISTORY_MONTH_OPTIONS, LANGUAGE_NAME_OVERRIDES, LOCATION_NAME_OVERRIDES,
} from '../config.js';

/**
 * Pure input handling for the Domain Overview API. Nothing here touches the network or MongoDB.
 * The browser chooses only WHICH section and whether to skip the cache; the target and market always come from the project.
 */

export function parseSection(raw) {
  if (typeof raw !== 'string' || !SECTION_NAMES.includes(raw)) {
    throw new ValidationFailure('section', `section must be one of ${SECTION_NAMES.join(', ')}`, 'UNKNOWN_SECTION');
  }
  return raw;
}

/** ?refresh=1 | true skips the cache (subject to the minimum refresh interval). Absent / 0 / false = use the cache. */
export function parseRefresh(raw) {
  if (raw === undefined || raw === null || raw === '' || raw === '0' || raw === 'false') return false;
  if (raw === '1' || raw === 'true') return true;
  throw new ValidationFailure('refresh', 'refresh must be 1 or true when present');
}

/** ?peek=1 | true answers from the cache only (never a provider call); allowed for the sections in PEEKABLE_SECTIONS. Absent / 0 / false = normal. */
export function parsePeek(raw) {
  if (raw === undefined || raw === null || raw === '' || raw === '0' || raw === 'false') return false;
  if (raw === '1' || raw === 'true') return true;
  throw new ValidationFailure('peek', 'peek must be 1 or true when present');
}

/** ?months=6|12|24 (history only). Absent = the default window. Anything else is rejected before a billed call can happen. */
export function parseMonths(raw) {
  if (raw === undefined || raw === null || raw === '') return HISTORY_MONTHS;
  const n = typeof raw === 'string' && /^\d{1,3}$/.test(raw) ? Number(raw) : NaN;
  if (!HISTORY_MONTH_OPTIONS.includes(n)) {
    throw new ValidationFailure('months', `months must be one of ${HISTORY_MONTH_OPTIONS.join(', ')}`);
  }
  return n;
}

const regionNames = (() => { try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch { return null; } })();
const languageNames = (() => { try { return new Intl.DisplayNames(['en'], { type: 'language' }); } catch { return null; } })();

function locationNameFor(country) {
  if (typeof country !== 'string' || !/^[A-Za-z]{2}$/.test(country.trim())) return null;
  const code = country.trim().toUpperCase();
  if (LOCATION_NAME_OVERRIDES[code]) return LOCATION_NAME_OVERRIDES[code];
  try {
    const name = regionNames?.of(code);
    // Intl echoes the code back (or says "Unknown Region") for codes it does not know: that is not a usable location.
    return name && name !== code && !/unknown/i.test(name) ? name : null;
  } catch { return null; }
}

function languageNameFor(language) {
  if (typeof language !== 'string' || !language.trim()) return null;
  const primary = language.trim().toLowerCase().split(/[-_]/)[0];
  if (!/^[a-z]{2,3}$/.test(primary)) return null;
  if (LANGUAGE_NAME_OVERRIDES[primary]) return LANGUAGE_NAME_OVERRIDES[primary];
  try {
    const name = languageNames?.of(primary);
    return name && name.toLowerCase() !== primary ? name : null;
  } catch { return null; }
}

/** The project's search market as DataForSEO names it ("India" / "English"), falling back to the defaults field by field. */
export function resolveMarket(project) {
  return {
    location_name: locationNameFor(project?.country) || DEFAULT_MARKET.location_name,
    language_name: languageNameFor(project?.language) || DEFAULT_MARKET.language_name,
  };
}

const firstOfMonth = (year, monthIndex) => new Date(Date.UTC(year, monthIndex, 1)).toISOString().slice(0, 10);

/** { date_from: "<today minus N months>", date_to: "<this month>" }, both YYYY-MM-01 in UTC. N defaults to 12 (13 monthly points). */
export function buildHistoryRange(now = new Date(), months = HISTORY_MONTHS) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return { date_from: firstOfMonth(y, m - months), date_to: firstOfMonth(y, m) };
}
