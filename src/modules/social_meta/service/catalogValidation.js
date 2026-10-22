/**
 * Shared field validators for the user-entered Social Media AI data (the business profile, services, brand kit and
 * the product catalog). They were extracted from socialBusinessProfileService.js unchanged so every writer
 * applies exactly the same rules:
 *
 *  - Every value is validated and COERCED to a plain primitive before it gets near a query, so a client-supplied
 *    object can never reach Mongo as an operator ({ $set / $where / ... }).
 *  - An unknown key is REJECTED (UNKNOWN_FIELD), never silently dropped and never persisted.
 *  - Text is bounded, and control characters are refused (newlines only where a field is explicitly multiline).
 *
 * Validators throw ValidationError (code + message); callers catch it and turn it into { error }.
 */

export class ValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const bad = (message, code = 'INVALID_PROFILE') => { throw new ValidationError(code, message); };
export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
// eslint-disable-next-line no-control-regex
const ANY_NEWLINE_OR_CONTROL = /[\u0000-\u001F\u007F]/;

export const MAX_URL_LENGTH = 500;
export const MAX_FONT_LENGTH = 60;
export const MAX_PHONE_LENGTH = 40;

export function assertKnownKeys(obj, allowed, path, code = 'UNKNOWN_FIELD') {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) bad(`"${path ? `${path}.` : ''}${key}" is not an editable field.`, code);
  }
}

/** A trimmed string, '' / null -> null. Single-line unless `multiline`. */
export function text(value, path, max, { multiline = false, required = false } = {}) {
  if (value === null || value === undefined) {
    if (required) bad(`${path} is required.`);
    return null;
  }
  if (typeof value !== 'string') bad(`${path} must be text.`);
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) bad(`${path} is required.`);
    return null;
  }
  if (trimmed.length > max) bad(`${path} must be ${max} characters or fewer.`);
  if ((multiline ? CONTROL_CHARS : ANY_NEWLINE_OR_CONTROL).test(trimmed)) bad(`${path} contains characters that are not allowed.`);
  return trimmed;
}

/** A bounded list of short strings; blanks dropped, case-insensitive duplicates removed. */
export function stringList(value, path, { items, length }) {
  if (!Array.isArray(value)) bad(`${path} must be a list.`);
  if (value.length > items * 3) bad(`${path} can have at most ${items} entries.`); // cheap guard before per-item work
  const seen = new Set();
  const out = [];
  value.forEach((entry, i) => {
    const t = text(entry, `${path}[${i}]`, length);
    if (!t) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  });
  if (out.length > items) bad(`${path} can have at most ${items} entries.`);
  return out;
}

const PRIVATE_V4 = [/^0\./, /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];

/** True for a host a public product / service page can never live on (loopback, private ranges, IP literals, internal names). */
function isNonPublicHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host.includes(':')) return true; // IPv6 literal
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return true; // any IPv4 literal: a business page has a name
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return true; // decimal / hex integer host forms
  if (PRIVATE_V4.some((re) => re.test(host))) return true;
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan');
}

/**
 * http(s) URL only. A bare "example.com" is accepted and stored as https://example.com/.
 * `publicOnly` additionally refuses loopback / private / IP-literal hosts (used for catalog links, which are
 * stored and shown to customers; they are never fetched by Odito).
 */
export function url(value, path, { publicOnly = false } = {}) {
  const raw = text(value, path, MAX_URL_LENGTH);
  if (raw === null) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    return bad(`${path} must be a valid web address.`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) bad(`${path} must start with http:// or https://.`);
  if (parsed.username || parsed.password) bad(`${path} must not contain credentials.`);
  if (!parsed.hostname || !parsed.hostname.includes('.')) bad(`${path} must be a valid web address.`);
  if (publicOnly && isNonPublicHost(parsed.hostname)) bad(`${path} must be a public web address.`);
  return parsed.toString();
}

export function color(value, path) {
  const raw = text(value, path, 7);
  if (raw === null) return null;
  if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw)) bad(`${path} must be a hex colour like #1A2B3C.`);
  return raw.toUpperCase();
}

export function font(value, path) {
  const raw = text(value, path, MAX_FONT_LENGTH);
  if (raw === null) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9 \-_.']*$/.test(raw)) bad(`${path} contains characters that are not allowed.`);
  return raw;
}

export function phone(value, path) {
  const raw = text(value, path, MAX_PHONE_LENGTH);
  if (raw === null) return null;
  if (!/^[+\d][\d\s().-]{2,}$/.test(raw)) bad(`${path} must be a phone number.`);
  return raw;
}

/** A 24-hex ObjectId string. Anything else (an object, an operator, a path) is refused. */
export function objectIdString(value, path) {
  if (typeof value !== 'string' || !/^[a-f0-9]{24}$/i.test(value)) bad(`${path} must be a valid id.`);
  return value.toLowerCase();
}

const MAX_MONEY = 1_000_000_000;

/** A non-negative amount with at most 2 decimals, from a number or a plain numeric string. null / '' -> null. */
export function money(value, path) {
  if (value === null || value === undefined || value === '') return null;
  let n;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && /^\d{1,10}(\.\d{1,2})?$/.test(value.trim())) n = Number(value.trim());
  else return bad(`${path} must be a number.`);
  if (!Number.isFinite(n)) bad(`${path} must be a number.`);
  if (n < 0) bad(`${path} must not be negative.`);
  if (n > MAX_MONEY) bad(`${path} is too large.`);
  const rounded = Math.round(n * 100) / 100;
  if (Math.abs(rounded - n) > 1e-9) bad(`${path} can have at most 2 decimal places.`);
  return rounded;
}

let CURRENCIES = null;
function supportedCurrencies() {
  if (CURRENCIES) return CURRENCIES;
  try {
    CURRENCIES = new Set(Intl.supportedValuesOf('currency'));
  } catch {
    CURRENCIES = false; // very old runtime: fall back to the format check alone
  }
  return CURRENCIES;
}

/** An ISO 4217 currency code ("INR", "usd" -> "USD"); must be a real currency when the runtime knows the list. */
export function currency(value, path) {
  const raw = text(value, path, 3);
  if (raw === null) return null;
  const code = raw.toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) bad(`${path} must be a 3-letter currency code like USD.`);
  const known = supportedCurrencies();
  if (known && !known.has(code)) bad(`${path} is not a supported currency.`);
  return code;
}

export function enumValue(value, path, allowed) {
  if (typeof value !== 'string' || !allowed.includes(value)) bad(`${path} must be one of: ${allowed.join(', ')}.`);
  return value;
}

// ── display formatting (deterministic, no Intl so a snapshot hashes the same on every host) ──

const CURRENCY_SYMBOLS = Object.freeze({ USD: '$', EUR: '€', GBP: '£', INR: '₹', JPY: '¥' });

/**
 * "₹1,299", "$19.99", "CHF 40". Symbol currencies are written with their symbol because that is how a caption
 * states a price — and the content guard only accepts a price that appears in the supplied business text.
 */
export function formatPrice(amount, currencyCode) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
  const [whole, frac] = (Math.round(amount * 100) / 100).toFixed(2).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const number = frac === '00' ? grouped : `${grouped}.${frac}`;
  if (!currencyCode) return number;
  const symbol = CURRENCY_SYMBOLS[currencyCode];
  return symbol ? `${symbol}${number}` : `${currencyCode} ${number}`;
}
