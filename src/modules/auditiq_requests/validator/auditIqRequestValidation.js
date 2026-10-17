import { REQUEST_TYPES } from '../model/AuditIqServiceRequest.js';

/**
 * Pure input validation for POST /auditiq/service-requests. Throws an Error with
 * `.code === 'VALIDATION_ERROR'` and `.field` set, so the controller can return a
 * structured 400 without leaking anything else.
 *
 * Only the fields the request actually needs are accepted; anything else in the
 * body (including any attempt to name a userId/status/isOpen) is ignored.
 */

const MESSAGE_MIN = 10;
const MESSAGE_MAX = 2000;

function fail(field, message) {
  const error = new Error(message);
  error.code = 'VALIDATION_ERROR';
  error.field = field;
  return error;
}

// Strips control characters (keeping tab/newline for free text), then trims.
// The value is stored and emailed as plain text — never interpreted as HTML.
function cleanText(value, { multiline = false } = {}) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const stripped = value.replace(multiline ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g, '');
  return stripped.trim();
}

function requireBounded(field, label, value, max) {
  const text = cleanText(value);
  if (!text) throw fail(field, `${label} is required`);
  if (text.length > max) throw fail(field, `${label} must be ${max} characters or fewer`);
  return text;
}

function optionalBounded(field, label, value, max) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw fail(field, `${label} must be text`);
  const text = cleanText(value);
  if (text.length > max) throw fail(field, `${label} must be ${max} characters or fewer`);
  return text;
}

/**
 * @param {object} body - req.body
 * @returns {{requestType:string, issueKey:string, issueTitle:string, issueCategory:string,
 *            affectedPageCount:number|null, pageUrl:string|null, message:string|null}}
 */
export function validateCreateRequestInput(body = {}) {
  const input = body && typeof body === 'object' ? body : {};

  if (!REQUEST_TYPES.includes(input.requestType)) {
    throw fail('requestType', `requestType must be one of: ${REQUEST_TYPES.join(', ')}`);
  }

  const issueKey = requireBounded('issueKey', 'Issue', input.issueKey, 200);
  const issueTitle = optionalBounded('issueTitle', 'Issue title', input.issueTitle, 300) || issueKey;
  const issueCategory = optionalBounded('issueCategory', 'Issue category', input.issueCategory, 100);

  let affectedPageCount = null;
  if (input.affectedPageCount !== undefined && input.affectedPageCount !== null) {
    const n = input.affectedPageCount;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 1000000) {
      throw fail('affectedPageCount', 'affectedPageCount must be a whole number between 0 and 1,000,000');
    }
    affectedPageCount = n;
  }

  let pageUrl = null;
  if (input.pageUrl !== undefined && input.pageUrl !== null && input.pageUrl !== '') {
    const raw = optionalBounded('pageUrl', 'Page URL', input.pageUrl, 2000);
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      throw fail('pageUrl', 'Page URL must be a valid http(s) URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw fail('pageUrl', 'Page URL must be a valid http(s) URL');
    }
    pageUrl = raw;
  }

  let message = null;
  const rawMessage = input.message;
  if (rawMessage !== undefined && rawMessage !== null && typeof rawMessage !== 'string') {
    throw fail('message', 'Message must be text');
  }
  const cleanedMessage = cleanText(rawMessage, { multiline: true });
  if (input.requestType === 'expert_fix') {
    if (cleanedMessage.length < MESSAGE_MIN) {
      throw fail('message', `Please describe the help you need (at least ${MESSAGE_MIN} characters)`);
    }
  }
  if (cleanedMessage.length > MESSAGE_MAX) {
    throw fail('message', `Message must be ${MESSAGE_MAX} characters or fewer`);
  }
  if (cleanedMessage) message = cleanedMessage;

  return {
    requestType: input.requestType,
    issueKey,
    issueTitle,
    issueCategory,
    affectedPageCount,
    pageUrl,
    message,
  };
}

export { MESSAGE_MIN, MESSAGE_MAX };
