import mongoose from 'mongoose';
import { encryptToken, decryptToken } from './SocialAccount.js';

/**
 * PendingMetaConnection
 *
 * Phase 1 deliberately persisted nothing after a successful OAuth
 * exchange. Phase 2 needs somewhere secure to hold the Meta USER access
 * token between "callback succeeded" and "user finished selecting a
 * Page" — never the browser (Section 2's explicit requirements: never in
 * the redirect URL, frontend JSON, React state, or the signed OAuth
 * state itself).
 *
 * Modeled directly on WordPressPairingToken.js's existing short-lived,
 * TTL-purged, single-owner secret pattern — this codebase already has a
 * proven "hold a sensitive value server-side for a few minutes, then
 * auto-expire it" mechanism, so this reuses that shape rather than
 * inventing a session/cache layer.
 *
 * Keyed uniquely on (user_id, project_id) with upsert-on-write (see
 * metaOAuthController.js's handleMetaCallback): a new OAuth attempt for
 * the same user+project simply replaces any prior pending record, which
 * is what "bind pending connection to userId + projectId, and don't let
 * one project's pending connection be reused for another" actually
 * requires — no separate transaction/state identifier field is needed on
 * top of that compound key, since the verified, single-use OAuth state
 * (see oauthState.js) is what produces this record in the first place,
 * and the compound key alone already makes it impossible for a
 * project A pending record to satisfy a project B request.
 *
 * `pages` is populated once, by the Page List endpoint's first live
 * /me/accounts call (see metaPageService.js) — cached here so Page
 * Selection never needs a second Graph API round-trip and always
 * validates the chosen Page against exactly what was actually returned
 * to this user, not a value the client could supply.
 */

const pendingMetaConnectionSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  project_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SeoProject',
    required: true,
  },
  // Meta's own user identifier — not populated in Phase 2 (would require
  // an extra /me call this phase doesn't otherwise need; see Section 19's
  // "do not introduce unnecessary Meta API requests"). Present on the
  // schema so populating it later is additive, not a migration.
  meta_user_id: {
    type: String,
    default: null,
  },
  // The Meta USER access token — never the Page token (Page tokens live
  // only inside `pages[].accessToken` below, and only the SELECTED one
  // is ever copied out to a persisted SocialAccount).
  userAccessToken: {
    type: String,
    required: true,
    set: encryptToken,
    get: decryptToken,
  },
  tokenExpiresAt: {
    type: Date,
    default: null,
  },
  // The permissions Meta ACTUALLY granted for this connection — fetched
  // via GET /me/permissions right after token exchange (see
  // metaOAuthController.js's handleMetaCallback), never assumed from
  // what was requested at /start time. Meta's token-exchange response
  // does not itself echo back granted scopes, and requesting a scope is
  // no guarantee it was granted (Advanced Access permissions especially).
  scopes: {
    type: [String],
    default: [],
  },
  // Cached /me/accounts result — each entry's accessToken is that Page's
  // own token, encrypted the same way. Empty until the Page List endpoint
  // populates it.
  pages: {
    type: [
      {
        id: { type: String, required: true },
        name: { type: String, default: null },
        category: { type: String, default: null },
        picture: { type: String, default: null },
        accessToken: { type: String, required: true, set: encryptToken, get: decryptToken },
        tasks: { type: [String], default: [] },
      },
    ],
    default: [],
    _id: false,
  },
  expiresAt: {
    type: Date,
    required: true,
  },
}, {
  timestamps: { createdAt: 'createdAt', updatedAt: false },
});

// One pending connection per (user, project) — see file header for why
// this alone is sufficient binding, no separate transaction id needed.
pendingMetaConnectionSchema.index({ user_id: 1, project_id: 1 }, { unique: true });

// TTL auto-purge — mirrors WordPressPairingToken.js's own index exactly.
// Short (15 minutes): long enough for a real user to see the Page
// selection dialog and choose, short enough that an abandoned OAuth
// attempt's token doesn't linger.
pendingMetaConnectionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const PENDING_TTL_MS = 15 * 60 * 1000;

pendingMetaConnectionSchema.statics.PENDING_TTL_MS = PENDING_TTL_MS;

// Strip every token, decrypted or not, from any serialized form — same
// discipline as SocialAccount.js / GoogleConnection.js.
function stripSecrets(doc, ret) {
  delete ret.userAccessToken;
  delete ret.__v;
  if (Array.isArray(ret.pages)) {
    ret.pages = ret.pages.map(({ accessToken, ...safe }) => safe);
  }
  return ret;
}
pendingMetaConnectionSchema.set('toJSON', { virtuals: true, transform: stripSecrets });
pendingMetaConnectionSchema.set('toObject', { virtuals: true, transform: stripSecrets });

const PendingMetaConnection = mongoose.model('PendingMetaConnection', pendingMetaConnectionSchema);
export default PendingMetaConnection;
export { PENDING_TTL_MS };
