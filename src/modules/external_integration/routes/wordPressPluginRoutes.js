import express from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import auth from '../../user/middleware/auth.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import pluginAuth from '../middleware/pluginAuth.middleware.js';
import {
  projectIdBodyValidator,
  projectIdQueryValidator,
  pairPluginValidator,
  heartbeatValidator,
  formsSyncValidator,
} from '../validator/wordPressPluginValidator.js';
import { submitFormValidator } from '../validator/wordPressSubmissionValidator.js';
import {
  generatePairingToken,
  getPluginStatus,
  listForms,
  downloadPlugin,
  downloadSeoBridgePlugin,
  pairPlugin,
  heartbeat,
  syncForms,
} from '../controller/wordPressPluginController.js';
import { submitForm } from '../controller/wordPressSubmissionController.js';

const router = express.Router();

// ── Rate limiters — these are machine-to-machine endpoints, not
// user-click-driven, so limits are generous relative to the recommended
// 30-60 minute plugin cadence but still bound worst-case abuse. ──────────

const pairingTokenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many pairing token requests. Please try again later.' },
});

const pairLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many pairing attempts. Please try again later.' },
});

const heartbeatLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30, // well above the recommended once-per-30-60-min cadence
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many heartbeat requests.' },
});

const formsSyncLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many form sync requests.' },
});

/**
 * Keyed by plugin installation, not IP (Section 31 — "do not globally
 * throttle all WordPress customers together"; many small WP sites can
 * share a hosting provider's outbound IP, so IP-keying would let one
 * customer's traffic exhaust another's budget). This requires
 * pluginAuth to have already run and set req.pluginInstallation — see the
 * route below, where pluginAuth is deliberately placed BEFORE this
 * limiter (the opposite order from heartbeat/forms-sync above, which
 * don't need per-plugin keying as critically). Falls back to IP only for
 * the pathological case where pluginAuth somehow didn't run — using the
 * library's own ipKeyGenerator() helper for that fallback, not req.ip
 * directly: express-rate-limit v8 validates against bare req.ip in a
 * custom keyGenerator because it doesn't normalize IPv6 addresses, which
 * could let an IPv6 client bypass the limit by varying its address within
 * the same /64 (caught at server startup as a ValidationError during
 * Phase 3B testing, not silently missed).
 */
const submissionLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 60, // generous relative to genuine form-submission volume; bounds a compromised/looping plugin
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.pluginInstallation?.plugin_id || ipKeyGenerator(req.ip),
  // code: RATE_LIMITED (Section 31) — a stable field, not just message
  // text, so class-odito-cf7-capture.php's send_with_fallback() can queue
  // a 429 for retry without needing to parse this string.
  message: { success: false, message: 'Too many form submissions. Please try again shortly.', code: 'RATE_LIMITED' },
});

/**
 * Content-Length pre-check (Section 32 — payload size limits). The global
 * body parser (server.js, express.json({ limit: '50mb' })) already applies
 * to every route before this one runs, so this cannot prevent an oversized
 * body from being read into memory at the transport layer — a true
 * per-route parse-time limit would require restructuring server.js's
 * global middleware mount order, which is out of scope for this module.
 * What this DOES achieve: rejecting an oversized submission before it
 * reaches validation/normalization/DB work, and documenting the size
 * policy explicitly rather than silently inheriting the 50mb global
 * ceiling. The validator's own per-field length caps (50 fields x 5000
 * chars each, ~250KB worst case) are the tighter, more meaningful bound in
 * practice.
 */
const MAX_SUBMISSION_BYTES = 200 * 1024;
function limitSubmissionSize(req, res, next) {
  const contentLength = parseInt(req.headers['content-length'] || '0', 10);
  if (contentLength > MAX_SUBMISSION_BYTES) {
    return res.status(413).json({ success: false, message: 'Submission payload is too large.', code: 'INVALID_PAYLOAD' });
  }
  next();
}

// ── Odito dashboard routes (JWT + project ownership) ────────────────────

router.post('/pairing-token', auth, pairingTokenLimiter, projectIdBodyValidator, validateProjectAccess(), generatePairingToken);
router.get('/status', auth, projectIdQueryValidator, validateProjectAccess(), getPluginStatus);
router.get('/forms', auth, projectIdQueryValidator, validateProjectAccess(), listForms);
router.get('/download', auth, downloadPlugin);
router.get('/seo-bridge/download', auth, downloadSeoBridgePlugin);

// ── Plugin -> Odito routes. NOT JWT-gated — identity comes from the
// pairing token (pair) or the plugin credential (heartbeat, forms/sync via
// pluginAuth middleware), never from a client-supplied project ID. ──────

router.post('/pair', pairLimiter, pairPluginValidator, pairPlugin);
router.post('/heartbeat', heartbeatLimiter, pluginAuth, heartbeatValidator, heartbeat);
router.post('/forms/sync', formsSyncLimiter, pluginAuth, formsSyncValidator, syncForms);
// pluginAuth runs BEFORE the limiter here (opposite order from the two
// routes above) so submissionLimiter can key by plugin installation.
router.post('/submissions', limitSubmissionSize, pluginAuth, submissionLimiter, submitFormValidator, submitForm);

export default router;
