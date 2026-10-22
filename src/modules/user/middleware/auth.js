import User from '../model/User.js';
import {
  verifyAuthToken,
  resolveTokenVersion,
  resolveUserTokenVersion,
  ACCESS_TOKEN_TYPE,
  TOKEN_ISSUER,
  TOKEN_AUDIENCE_MOBILE,
} from '../service/tokenService.js';

/**
 * Bearer-JWT authentication for every protected /api route.
 *
 * Unchanged architecture (per the hardening brief — refresh tokens are a
 * later phase): parse `Authorization: Bearer <jwt>`, verify it, load the
 * user, attach `req.user`.
 *
 * Hardened:
 *   - The user is loaded WITHOUT the password hash (`select('-password')`,
 *     belt-and-braces on top of the schema's `select: false`). `req.user`
 *     therefore never carries the bcrypt hash to any downstream handler.
 *   - A valid token for a user who no longer exists is an *authentication*
 *     failure -> 401 (was 404: a deleted account is not a "missing
 *     resource", and the web client already turns 401 into a re-login).
 *   - `tokenVersion` is enforced: a token minted before a password
 *     change/reset (older `tokenVersion`, or none at all) is rejected.
 *     "No claim" and "user has no field yet" both resolve to 0, so no
 *     currently-valid session is invalidated just by deploying this.
 *   - Suspended (`isActive: false`) users stay blocked with 403 — this is
 *     the sole enforcement point for suspension on existing tokens, so
 *     suspension needs no separate tokenVersion bump.
 *
 * Phase 2 (mobile access tokens) — accept BOTH shapes:
 *   - LEGACY web token: no `type` / `iss` / `aud` claim -> accepted.
 *   - MOBILE access token: `type:'access'`, `iss:'odito'`, `aud:'odito-mobile'`.
 * A token whose `type` is present but not `'access'` is rejected (a refresh
 * token is opaque and cannot `jwt.verify` anyway — this is defence in
 * depth). `iss`/`aud`, when present, must match; when absent, skipped.
 */
const auth = async (req, res, next) => {
  try {
    let token;

    const header = req.headers.authorization;
    if (header && header.startsWith('Bearer ')) {
      token = header.slice(7).trim();
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. No token provided.',
      });
    }

    const decoded = verifyAuthToken(token);

    // A refresh token (opaque) can never reach here — it fails jwt.verify.
    // But a JWT that explicitly declares a non-access type, or a mismatched
    // issuer/audience, is rejected outright.
    if (decoded.type != null && decoded.type !== ACCESS_TOKEN_TYPE) {
      return res.status(401).json({ success: false, message: 'Invalid token.', code: 'INVALID_TOKEN_TYPE' });
    }
    if (decoded.iss != null && decoded.iss !== TOKEN_ISSUER) {
      return res.status(401).json({ success: false, message: 'Invalid token.', code: 'INVALID_TOKEN_ISSUER' });
    }
    if (decoded.aud != null) {
      // jsonwebtoken stores a single audience as a string, multiple as an array.
      const audOk = Array.isArray(decoded.aud)
        ? decoded.aud.includes(TOKEN_AUDIENCE_MOBILE)
        : decoded.aud === TOKEN_AUDIENCE_MOBILE;
      if (!audOk) {
        return res.status(401).json({ success: false, message: 'Invalid token.', code: 'INVALID_TOKEN_AUDIENCE' });
      }
    }

    const userId = decoded.id || decoded.sub;
    const user = await User.findById(userId).select('-password');

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Account not found.',
        code: 'AUTH_USER_NOT_FOUND',
      });
    }

    // Token issued before the account's most recent password change/reset.
    if (resolveTokenVersion(decoded) !== resolveUserTokenVersion(user)) {
      return res.status(401).json({
        success: false,
        message: 'Your session has expired. Please sign in again.',
        code: 'TOKEN_REVOKED',
      });
    }

    // Re-checked here (not only at login) so a suspended account's existing
    // JWT stops working on its very next request.
    if (!user.isActive) {
      return res.status(403).json({ success: false, message: 'This account has been suspended.' });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('Auth middleware error:', error.message);
    res.status(401).json({
      success: false,
      message: 'Invalid token.',
    });
  }
};

export default auth;
