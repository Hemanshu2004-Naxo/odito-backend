import { isPublishingReady } from '../../model/SocialAccount.js';
import { isPubliclyReachableUrl } from '../../../../utils/publicUrlCheck.js';
import { parseScheduledAt, isValidIanaZone } from './bulkImportTime.js';
import {
  BULK_IMPORT_LIMITS, MEDIA_EXTENSION_TYPE, BULK_ERROR,
} from './bulkImportConstants.js';

/**
 * Bulk Upload — Phase 2 per-row business validation.
 *
 * Pure and synchronous: all DB work (resolving the project's connected
 * account for each platform) is done ONCE by the caller
 * (bulkImportService) and handed in via `context.accounts`, so validating
 * 200 rows is 200 in-memory checks, never 200 queries.
 *
 * Reuses the existing publishing rules rather than re-inventing them:
 *   - `isPublishingReady()` from SocialAccount.js (the same publish-scope
 *     check socialPublishingService.publishNow runs)
 *   - `isPubliclyReachableUrl()` from utils/publicUrlCheck.js (HTTPS +
 *     not loopback / private / link-local — the SSRF guard the platform
 *     adapters already rely on). NO media URL is fetched in this phase.
 *   - Instagram-requires-media / Facebook-requires-text-or-media mirror
 *     what instagramAdapter / facebookAdapter actually enforce.
 *
 * Character limits are NOT invented here — the adapters do not enforce a
 * numeric caption limit, and the parser's 10k-char cell cap already
 * bounds content.
 *
 * Mutates `normalized` in place to attach `socialAccountId` and
 * `scheduledAt` when they resolve. Returns `{ status, errors }`.
 */

const SUPPORTED_MEDIA_EXT = Object.keys(MEDIA_EXTENSION_TYPE);

function urlExtension(url) {
  try {
    const p = new URL(url).pathname;
    const dot = p.lastIndexOf('.');
    return dot === -1 ? '' : p.slice(dot).toLowerCase();
  } catch {
    return '';
  }
}

/**
 * @param {object} norm     the object returned by normalizeRow()
 * @param {object} context  { now: Date, accounts: { [platform]: { account } } }
 * @returns {{ status: 'valid'|'invalid', errors: Array<{field,code,message}> }}
 */
export function validateRow(norm, context) {
  const { normalized, mediaInputs, scheduledAtInput } = norm;
  const errors = [...(norm.errors || [])]; // carry normalization-time errors forward
  const now = context?.now instanceof Date ? context.now : new Date();

  // ── account (only when the platform itself resolved) ──
  let account = null;
  if (normalized.platform) {
    const entry = context?.accounts?.[normalized.platform];
    account = entry?.account || null;
    if (!account) {
      errors.push({
        field: 'platform',
        code: BULK_ERROR.ACCOUNT_NOT_CONNECTED,
        message: `No connected ${normalized.platform} account for this project. Connect ${normalized.platform} first.`,
      });
    } else {
      normalized.socialAccountId = account._id;
    }
  }

  // ── media (rebuild normalized.media from only the fully-valid items) ──
  const validMedia = [];
  if (mediaInputs.length > BULK_IMPORT_LIMITS.MAX_MEDIA_PER_ROW) {
    errors.push({
      field: 'media_urls',
      code: BULK_ERROR.TOO_MANY_MEDIA,
      message: `Only ${BULK_IMPORT_LIMITS.MAX_MEDIA_PER_ROW} media item is supported per post; this row has ${mediaInputs.length}.`,
    });
  }
  for (const url of mediaInputs) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      errors.push({ field: 'media_urls', code: BULK_ERROR.INVALID_MEDIA_URL, message: `"${url}" is not a valid URL.` });
      continue;
    }
    if (parsed.protocol !== 'https:') {
      errors.push({ field: 'media_urls', code: BULK_ERROR.INVALID_MEDIA_URL, message: `"${url}" must be an https:// URL.` });
      continue;
    }
    if (!isPubliclyReachableUrl(url)) {
      errors.push({
        field: 'media_urls',
        code: BULK_ERROR.INVALID_MEDIA_URL,
        message: `"${url}" must be a publicly reachable https URL (not localhost or a private / internal address).`,
      });
      continue;
    }
    const ext = urlExtension(url);
    const type = MEDIA_EXTENSION_TYPE[ext];
    if (!type) {
      errors.push({
        field: 'media_urls',
        code: BULK_ERROR.INVALID_MEDIA_TYPE,
        message: `Unsupported media type for "${url}". Allowed: ${SUPPORTED_MEDIA_EXT.join(', ')}.`,
      });
      continue;
    }
    validMedia.push({ url, type });
  }
  normalized.media = validMedia;

  // ── content ──
  const hasContent = typeof normalized.content === 'string' && normalized.content.trim() !== '';
  if (!hasContent && normalized.media.length === 0) {
    errors.push({
      field: 'content',
      code: BULK_ERROR.CONTENT_REQUIRED,
      message: 'content is required when the row has no media.',
    });
  }

  // ── Instagram requires media ──
  if (normalized.platform === 'instagram' && normalized.media.length === 0) {
    errors.push({
      field: 'media_urls',
      code: BULK_ERROR.MEDIA_REQUIRED,
      message: 'Instagram posts require an image or video.',
    });
  }

  // ── publish-readiness for schedule / publish ──
  if (account && (normalized.action === 'schedule' || normalized.action === 'publish') && !isPublishingReady(account)) {
    errors.push({
      field: 'platform',
      code: BULK_ERROR.ACCOUNT_NOT_PUBLISH_READY,
      message: `The connected ${normalized.platform} account is missing publishing permission — reconnect it before scheduling or publishing.`,
    });
  }

  // ── schedule / timezone ──
  const hasScheduleInput = scheduledAtInput !== '';
  if (normalized.action === 'schedule') {
    if (!hasScheduleInput) {
      errors.push({ field: 'scheduled_at', code: BULK_ERROR.INVALID_SCHEDULE, message: "scheduled_at is required when action is 'schedule'." });
    } else {
      const { date, error } = parseScheduledAt(scheduledAtInput, normalized.timezone);
      if (error) {
        errors.push({ field: error.code === BULK_ERROR.INVALID_TIMEZONE ? 'timezone' : 'scheduled_at', code: error.code, message: error.message });
      } else if (date.getTime() <= now.getTime()) {
        errors.push({ field: 'scheduled_at', code: BULK_ERROR.PAST_SCHEDULE, message: `scheduled_at (${date.toISOString()}) is in the past.` });
      } else {
        normalized.scheduledAt = date;
      }
    }
  } else if (normalized.action === 'draft' && hasScheduleInput) {
    // A draft MAY carry a planned time; validate its shape but do not
    // require it to be in the future.
    const { date, error } = parseScheduledAt(scheduledAtInput, normalized.timezone);
    if (error) {
      errors.push({ field: error.code === BULK_ERROR.INVALID_TIMEZONE ? 'timezone' : 'scheduled_at', code: error.code, message: error.message });
    } else {
      normalized.scheduledAt = date;
    }
  }

  // ── stray invalid timezone on a row that didn't already parse one ──
  if (
    normalized.timezone
    && normalized.scheduledAt === null
    && normalized.action !== 'schedule'
    && !isValidIanaZone(normalized.timezone)
  ) {
    errors.push({ field: 'timezone', code: BULK_ERROR.INVALID_TIMEZONE, message: `Unknown timezone "${normalized.timezone}".` });
  }

  return { status: errors.length === 0 ? 'valid' : 'invalid', errors };
}

export default { validateRow };
