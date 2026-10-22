import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import MetaOAuthState, { META_OAUTH_STATE_TTL_MS } from '../model/MetaOAuthState.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * metaOAuthStateService - the `state` of the Meta OAuth round trip.
 *
 *   SIGNING    a dedicated key: META_OAUTH_STATE_SECRET when set, else a key DERIVED (HKDF) from JWT_SECRET for this one purpose. Either
 *              way it is not the key that signs login sessions, so a state can never be used as a session token or the reverse, and
 *              states minted before this change (signed with the session key) are simply not valid any more - a flow that was in
 *              flight during the deploy is retried by the person; existing CONNECTIONS are untouched (no one has to reconnect).
 *   CONTENT    the signed token carries only { typ, provider, purpose, nonce } with an audience and issuer. Who started it, for which
 *              project and where to return live in MetaOAuthState, keyed by a hash of the nonce.
 *   ONE-TIME   a state is consumed by one atomic update (usedAt); a replay, a double submit or a stolen URL finds it already used.
 *   BINDING    /start also sets an httpOnly, SameSite=Lax cookie holding a secret whose hash is stored with the state; the callback
 *              (a top-level navigation from Meta) must present it. It is checked whenever the browser sends it. Because some deployments
 *              serve the API from another site (where browsers refuse the cookie), a MISSING cookie is only refused when
 *              META_OAUTH_REQUIRE_BROWSER_BINDING=true (log line META_OAUTH_BINDING_MISSING otherwise).
 *   EXPIRY     10 minutes, in the token and in the record (which is also purged by a TTL index).
 */

const PROVIDER = 'meta';
const PURPOSE = 'social_meta';
const TYP = 'meta_oauth_state';
const AUDIENCE = 'odito:meta-oauth-callback';
const ISSUER = 'odito';
export const BINDING_COOKIE = 'odito_meta_oauth';
export const BINDING_COOKIE_PATH = '/api/social/meta';

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const toId = (id) => (mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : id);

export function getStateSecret() {
  const explicit = process.env.META_OAUTH_STATE_SECRET;
  if (explicit && explicit.length >= 32) return explicit;
  const base = process.env.JWT_SECRET;
  if (!base) throw new Error('JWT_SECRET (or META_OAUTH_STATE_SECRET) is not configured');
  return Buffer.from(crypto.hkdfSync('sha256', base, 'odito-oauth', 'odito-meta-oauth-state-v1', 32)).toString('hex');
}

/** Signs a state token (exported so tests can make tokens with the wrong provider / purpose / lifetime). */
export function signMetaStateToken({ provider = PROVIDER, purpose = PURPOSE, nonce }, { expiresIn = '10m' } = {}) {
  return jwt.sign({ typ: TYP, provider, purpose, nonce }, getStateSecret(), { algorithm: 'HS256', audience: AUDIENCE, issuer: ISSUER, expiresIn });
}

/** @throws on a bad signature, wrong audience / issuer / type, or expiry */
export function verifyMetaStateToken(token) {
  const decoded = jwt.verify(token, getStateSecret(), { algorithms: ['HS256'], audience: AUDIENCE, issuer: ISSUER });
  if (decoded?.typ !== TYP || typeof decoded.nonce !== 'string' || decoded.nonce.length < 20) throw Object.assign(new Error('not a Meta OAuth state'), { name: 'JsonWebTokenError' });
  return decoded;
}

/**
 * Starts a flow for an already-authenticated, already-authorised (user, project).
 * @returns {Promise<{ state: string, bindingSecret: string }>}  the state goes in the Meta URL, the secret in the browser cookie
 */
export async function issueMetaOAuthState({ userId, projectId, returnTo = null, now = new Date() }) {
  const nonce = crypto.randomBytes(32).toString('base64url');
  const bindingSecret = crypto.randomBytes(32).toString('base64url');
  await MetaOAuthState.create({
    nonce_hash: sha256(nonce),
    user_id: toId(userId),
    project_id: toId(projectId),
    returnTo: returnTo || null,
    binding_hash: sha256(bindingSecret),
    expiresAt: new Date(now.getTime() + META_OAUTH_STATE_TTL_MS),
  });
  return { state: signMetaStateToken({ nonce }), bindingSecret };
}

/**
 * Validates and CONSUMES a state at the callback. Every refusal has a stable reason (never a message from a library):
 *   invalid | expired | wrong_provider | unknown | replayed | binding_mismatch | binding_missing
 * @returns {Promise<{ ok: true, userId: string, projectId: string, returnTo: string|null, bindingChecked: boolean } | { ok: false, reason: string }>}
 */
export async function consumeMetaOAuthState(state, { bindingSecret = null, now = new Date() } = {}) {
  let decoded;
  try {
    decoded = verifyMetaStateToken(state);
  } catch (error) {
    return { ok: false, reason: error?.name === 'TokenExpiredError' ? 'expired' : 'invalid' };
  }
  if (decoded.provider !== PROVIDER || decoded.purpose !== PURPOSE) return { ok: false, reason: 'wrong_provider' };

  const record = await MetaOAuthState.findOne({ nonce_hash: sha256(decoded.nonce) }).lean();
  if (!record) return { ok: false, reason: 'unknown' };
  if (record.usedAt) return { ok: false, reason: 'replayed' };
  if (record.expiresAt <= now) return { ok: false, reason: 'expired' };

  let bindingChecked = false;
  if (record.binding_hash) {
    if (bindingSecret) {
      const a = Buffer.from(sha256(bindingSecret));
      const b = Buffer.from(record.binding_hash);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'binding_mismatch' };
      bindingChecked = true;
    } else if (process.env.META_OAUTH_REQUIRE_BROWSER_BINDING === 'true') {
      return { ok: false, reason: 'binding_missing' };
    } else {
      LoggerUtil.warn('META_OAUTH_BINDING_MISSING', { projectId: String(record.project_id) });
    }
  }

  // exactly one caller wins: a replay or a parallel duplicate finds usedAt already set
  const consumed = await MetaOAuthState.findOneAndUpdate({ _id: record._id, usedAt: null, expiresAt: { $gt: now } }, { $set: { usedAt: now } });
  if (!consumed) return { ok: false, reason: 'replayed' };
  return { ok: true, userId: String(record.user_id), projectId: String(record.project_id), returnTo: record.returnTo || null, bindingChecked };
}

/** Reads one cookie from a raw Cookie header (the API has no cookie parser; this is the only cookie it reads). */
export function readCookie(req, name) {
  const header = req?.headers?.cookie;
  if (!header) return null;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export const bindingCookieOptions = () => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: META_OAUTH_STATE_TTL_MS,
  path: BINDING_COOKIE_PATH,
});

export default { issueMetaOAuthState, consumeMetaOAuthState, signMetaStateToken, verifyMetaStateToken, getStateSecret, readCookie, bindingCookieOptions };
