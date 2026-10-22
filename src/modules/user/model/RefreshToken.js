import mongoose from 'mongoose';

/**
 * A server-stored, rotating, revocable refresh token — the credential that
 * keeps a mobile session alive without a long-lived access JWT (Phase 2).
 *
 * This is NOT a JWT. The plaintext is 32 cryptographically-random bytes
 * (base64url) generated in refreshTokenService.js; only its SHA-256 hash is
 * ever persisted here. SHA-256 (not bcrypt) is correct: the token is already
 * 256-bit, so brute-forcing the hash is infeasible and bcrypt's slowness
 * would only add latency to the hot /auth/refresh path.
 *
 * Rotation chain: every initial login opens a `familyId` (a UUID). Each call
 * to /auth/refresh atomically revokes the presented token and issues a new
 * one in the SAME family, with `replacedBy` pointing forward. Presenting an
 * already-rotated token later is refresh-token REUSE — refreshTokenService
 * revokes the whole family (`revokedReason: 'reuse_detected'`).
 *
 * Never rely on the TTL index alone for security — it is asynchronous. Every
 * read path also checks `expiresAt > now` and `revokedAt == null`.
 */

export const REFRESH_TOKEN_REVOKED_REASONS = [
  'rotation',          // superseded by the next token in its family (normal)
  'logout',            // POST /auth/logout with this token
  'logout_all',        // POST /auth/logout-all
  'reuse_detected',    // an already-rotated token in this family was replayed
  'password_changed',  // POST /auth/change-password
  'password_reset',    // POST /auth/reset-password
  'account_suspended', // isActive flipped to false
  'account_deleted',   // user cascade delete
  'manual_revoke',     // ops / future admin action
];

const refreshTokenSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    // SHA-256(plaintext) as lowercase hex (64 chars). The plaintext is
    // returned to the caller exactly once and never stored or logged.
    // `unique` here builds the hot-lookup index (see schema.index calls
    // below for the rest); a collision or duplicate-insert bug can never
    // produce two live rows for one token.
    tokenHash: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    // Rotation-chain / device-session id. All rotated descendants of one
    // login share this. Used by reuse detection to revoke the whole chain.
    familyId: {
      type: String,
      required: true,
    },

    // Optional, client-supplied, length-bounded. Never trusted for anything
    // security-relevant — display only.
    deviceLabel: {
      type: String,
      trim: true,
      maxlength: 120,
      default: null,
    },

    // Bounded copy of the request User-Agent (truncated in the service).
    userAgent: {
      type: String,
      maxlength: 400,
      default: null,
    },

    // Request IP at issue time (honours the app's TRUST_PROXY setting).
    ipAddress: {
      type: String,
      maxlength: 64,
      default: null,
    },

    // The account's tokenVersion at issue time. A password change/reset both
    // bumps User.tokenVersion AND revokes every refresh token — this field
    // is the defence-in-depth check on /auth/refresh in case a token was
    // created in the same instant the revoke-all ran.
    tokenVersionAtIssue: {
      type: Number,
      default: 0,
    },

    // Absolute family expiry — carried forward unchanged on every rotation
    // so a session has a hard maximum lifetime (it does not slide forever on
    // use). TTL index below purges the row once past this.
    expiresAt: {
      type: Date,
      required: true,
    },

    lastUsedAt: {
      type: Date,
      default: Date.now,
    },

    revokedAt: {
      type: Date,
      default: null,
    },

    revokedReason: {
      type: String,
      enum: [...REFRESH_TOKEN_REVOKED_REASONS, null],
      default: null,
    },

    // The token that superseded this one (set on rotation). Trace aid only.
    replacedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'RefreshToken',
      default: null,
    },
  },
  { timestamps: true } // createdAt / updatedAt
);

// (tokenHash unique index is declared on the field above — the hot lookup
// on every /auth/refresh and /auth/logout.)

// "All active sessions for this user" — logout-all, password change/reset
// revoke-all, and a future GET /auth/sessions.
refreshTokenSchema.index({ userId: 1, revokedAt: 1 });

// Reuse detection revokes an entire family at once.
refreshTokenSchema.index({ familyId: 1 });

// Async TTL cleanup once past the absolute family expiry. Security still
// depends on the explicit `expiresAt > now` check in the service.
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const RefreshToken = mongoose.model('RefreshToken', refreshTokenSchema);
export default RefreshToken;
