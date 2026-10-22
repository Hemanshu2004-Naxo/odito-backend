import mongoose from 'mongoose';

/**
 * WordPressPairingToken Model
 *
 * A short-lived, one-time-use secret an Odito user generates in the
 * dashboard and pastes into the WordPress plugin's settings page to link
 * the plugin to their project — the "one-time pairing token" step of:
 *
 *   Odito dashboard -> generate token -> paste into plugin ->
 *   plugin POSTs it to Odito -> Odito verifies + issues a
 *   long-lived WordPressPluginInstallation credential -> token consumed
 *
 * Modeled on the existing OTP pattern (modules/otp/model/Otp.js) — hashed
 * value, expiry, single-use flag, attempt counter, TTL auto-cleanup index —
 * rather than a JWT: the token only ever needs to prove "the person who
 * clicked Generate in the dashboard also controls this WordPress site,"
 * once, within a few minutes. A JWT would add signature-verification
 * machinery for no benefit over a single hashed-lookup-and-compare, and
 * this codebase already has a proven hashed-short-lived-secret pattern to
 * follow instead of inventing a second one.
 */

const pairingTokenSchema = new mongoose.Schema({
  project_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SeoProject',
    required: true,
    index: true,
  },
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  // SHA-256 hex digest of the raw token — the raw value is shown to the
  // user exactly once (at generation) and is never stored. A high-entropy
  // random value doesn't need bcrypt's deliberate slowness (see
  // wordPressPluginService.js for the same reasoning applied to plugin
  // credentials) — a fast hash is appropriate and keeps pairing snappy.
  token_hash: {
    type: String,
    required: true,
    unique: true,
  },
  expires_at: {
    type: Date,
    required: true,
  },
  used_at: {
    type: Date,
    default: null,
  },
  // Failed pairing attempts against tokens for this project — used only to
  // detect/rate-limit brute-force guessing patterns; a correctly-generated
  // token cannot practically be guessed regardless (see generation code),
  // this is defense in depth, not the primary protection.
  attempts: {
    type: Number,
    default: 0,
  },
}, {
  timestamps: { createdAt: 'created_at', updatedAt: false },
});

// Auto-purge once expired — mirrors Otp.js's TTL index exactly, no separate
// cleanup job needed. A used-but-not-yet-expired token is intentionally
// kept until its natural expiry (not deleted on use) so a reused-token
// attempt can still be detected and logged rather than looking like "token
// never existed".
pairingTokenSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

const WordPressPairingToken = mongoose.model('WordPressPairingToken', pairingTokenSchema);
export default WordPressPairingToken;
