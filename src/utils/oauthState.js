import jwt from 'jsonwebtoken';

/**
 * Signed, short-lived state token shared by every OAuth flow in this
 * backend (Google, Meta, and any future provider). Carries whatever the
 * caller puts in `payload` (typically { provider, purpose, projectId,
 * userId, returnTo }) so a callback never has to trust client-suppliable
 * query params for access control — a tampered or expired token fails
 * verification outright (jwt.verify throws).
 */
const STATE_TOKEN_TTL = '10m';

export function signOAuthState(payload, secret = process.env.JWT_SECRET) {
  return jwt.sign(payload, secret, { expiresIn: STATE_TOKEN_TTL });
}

export function verifyOAuthState(state, secret = process.env.JWT_SECRET) {
  return jwt.verify(state, secret);
}

/**
 * Google's own flow predates the generic functions above — kept as thin,
 * behavior-identical wrappers (same TTL, same secret default) so
 * oauth.routes.js's existing imports/behavior are completely unaffected by
 * this generalization.
 */
export function signGoogleVisibilityState(payload, secret = process.env.JWT_SECRET) {
  return signOAuthState(payload, secret);
}

export function verifyGoogleVisibilityState(state, secret = process.env.JWT_SECRET) {
  return verifyOAuthState(state, secret);
}
