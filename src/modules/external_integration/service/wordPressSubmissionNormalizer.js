import { isSensitiveField } from '../utils/sensitiveFieldFilter.js';

/**
 * WordPress Submission Normalizer
 *
 * Turns a raw plugin submission payload (arbitrary field names/values, one
 * per WordPress form plugin's own convention) into a Lead-shaped payload —
 * the ONE place this mapping happens, kept out of the controller and out
 * of wordPressSubmissionService.js's orchestration logic.
 *
 * Sensitive fields are dropped here too (defense in depth — the plugin
 * already filters them before sending, Node re-filters on arrival, never
 * trusting the plugin as the only line of defense) — a sensitive field is
 * excluded from EVERY possible target, including the generic "extra
 * fields -> message" fallback, not just skipped for direct mapping.
 */

const EMAIL_FORMAT_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MESSAGE_MAX_LENGTH = 4900; // headroom under Lead.message's 5000 schema maxlength
const MAX_EXTRA_FIELDS_IN_MESSAGE = 20;

const FIELD_CANDIDATES = {
  email: ['email', 'email_address', 'e_mail', 'your_email', 'work_email'],
  phone: ['phone', 'telephone', 'tel', 'mobile', 'mobile_number', 'phone_number', 'phone_no', 'your_phone'],
  company: ['company', 'company_name', 'organization', 'organisation', 'business', 'business_name', 'your_company', 'agency', 'agency_name'],
  message: ['message', 'comments', 'comment', 'description', 'enquiry', 'inquiry', 'your_message'],
  name: ['name', 'full_name', 'fullname', 'your_name'],
};
const FIRST_NAME_KEYS = ['first_name', 'firstname', 'fname'];
const LAST_NAME_KEYS = ['last_name', 'lastname', 'lname'];

function normalizeKey(rawKey) {
  return String(rawKey || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function stringifyValue(rawValue) {
  if (rawValue === null || rawValue === undefined) return '';
  if (Array.isArray(rawValue)) return rawValue.map(String).join(', ').trim();
  return String(rawValue).trim();
}

function humanizeLabel(rawKey) {
  return String(rawKey)
    .replace(/[_-]+/g, ' ')
    .replace(/\byour\b/gi, '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase()) || rawKey;
}

/**
 * http(s)-only — `new URL()` alone accepts any well-formed scheme
 * (`javascript:alert(1)` parses successfully), so a bare try/catch isn't
 * enough here: pageUrl/referrer are stored and may later be rendered as a
 * clickable link in the dashboard, so a non-http(s) scheme must be
 * rejected explicitly, not just "does it parse".
 */
function isValidUrl(value) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Resolves raw submitted fields into { name, email, phone, company, message }
 * plus a list of unmapped, non-sensitive "extra" fields (folded into
 * message text so nothing legitimate is silently lost).
 */
function resolveFields(rawFields) {
  const resolved = { name: null, email: null, phone: null, company: null, message: null };
  const entries = Object.entries(rawFields && typeof rawFields === 'object' ? rawFields : {});

  const safeEntries = entries
    .filter(([key]) => !isSensitiveField(key))
    .map(([rawKey, rawValue]) => ({ rawKey, norm: normalizeKey(rawKey), value: stringifyValue(rawValue) }))
    .filter((e) => e.value.length > 0);

  const extras = [];

  for (const entry of safeEntries) {
    let matchedTarget = null;
    for (const [target, candidates] of Object.entries(FIELD_CANDIDATES)) {
      if (candidates.includes(entry.norm)) {
        matchedTarget = target;
        break;
      }
    }
    if (matchedTarget && resolved[matchedTarget] === null) {
      resolved[matchedTarget] = entry.value;
    } else {
      extras.push(entry);
    }
  }

  // first_name + last_name combo — only used if a direct "name" match
  // wasn't already found above.
  if (!resolved.name) {
    const firstIdx = extras.findIndex((e) => FIRST_NAME_KEYS.includes(e.norm));
    const lastIdx = extras.findIndex((e) => LAST_NAME_KEYS.includes(e.norm));
    const parts = [];
    if (firstIdx !== -1) parts.push(extras[firstIdx].value);
    if (lastIdx !== -1) parts.push(extras[lastIdx].value);
    if (parts.length) {
      resolved.name = parts.join(' ');
      // Remove from extras in descending index order so removal doesn't
      // shift the other index out from under it.
      [firstIdx, lastIdx].filter((i) => i !== -1).sort((a, b) => b - a).forEach((i) => extras.splice(i, 1));
    }
  }

  // Email format validation — never manufacture/guess an email; if the
  // matched value isn't actually email-shaped, treat it as an extra field
  // instead of silently assigning garbage to lead.email.
  if (resolved.email && !EMAIL_FORMAT_RE.test(resolved.email)) {
    extras.push({ rawKey: 'email', norm: 'email', value: resolved.email });
    resolved.email = null;
  }
  if (resolved.email) {
    resolved.email = resolved.email.toLowerCase();
  }

  return { resolved, extras };
}

function buildMessage(resolvedMessage, extras) {
  const lines = [];
  if (resolvedMessage) lines.push(resolvedMessage);

  if (extras.length) {
    const extraLines = extras
      .slice(0, MAX_EXTRA_FIELDS_IN_MESSAGE)
      .map((e) => `${humanizeLabel(e.rawKey)}: ${e.value}`);
    lines.push(...extraLines);
  }

  const combined = lines.join('\n').trim();
  return combined ? combined.slice(0, MESSAGE_MAX_LENGTH) : null;
}

/**
 * @param {object} params
 * @param {object} params.form       { externalId, provider, name, pageUrl }
 * @param {object} params.submission { fields: { [rawFieldName]: value } }
 * @param {object} params.context    { pageUrl, referrer, utmSource, utmMedium, utmCampaign, utmTerm, utmContent }
 * @returns {object} a payload shaped for leadService.createLeadIdempotent()'s `payload` argument
 */
export function normalizeSubmission({ form = {}, submission = {}, context = {} }) {
  const { resolved, extras } = resolveFields(submission.fields);

  const pageUrl = isValidUrl(context.pageUrl) ? context.pageUrl : (isValidUrl(form.pageUrl) ? form.pageUrl : null);
  const referrer = isValidUrl(context.referrer) ? context.referrer : null;

  return {
    name: resolved.name ? resolved.name.slice(0, 200) : null,
    email: resolved.email ? resolved.email.slice(0, 254) : null,
    phone: resolved.phone ? resolved.phone.slice(0, 30) : null,
    company: resolved.company ? resolved.company.slice(0, 200) : null,
    message: buildMessage(resolved.message, extras),
    formName: typeof form.name === 'string' ? form.name.trim().slice(0, 200) : null,
    pageUrl,
    referrer,
    // Canonical, server-set source — the plugin's payload has no `source`
    // field at all (see wordPressSubmissionValidator.js), so there is
    // nothing for a compromised plugin to override this with.
    source: 'wordpress',
    utmSource: typeof context.utmSource === 'string' ? context.utmSource.trim().slice(0, 200) : null,
    utmMedium: typeof context.utmMedium === 'string' ? context.utmMedium.trim().slice(0, 200) : null,
    utmCampaign: typeof context.utmCampaign === 'string' ? context.utmCampaign.trim().slice(0, 200) : null,
    utmTerm: typeof context.utmTerm === 'string' ? context.utmTerm.trim().slice(0, 200) : null,
    utmContent: typeof context.utmContent === 'string' ? context.utmContent.trim().slice(0, 200) : null,
  };
}

export default { normalizeSubmission };
