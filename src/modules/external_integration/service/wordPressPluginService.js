import crypto from 'crypto';
import WordPressPairingToken from '../model/WordPressPairingToken.js';
import WordPressPluginInstallation from '../model/WordPressPluginInstallation.js';
import WordPressForm from '../model/WordPressForm.js';
import SeoProject from '../../app_user/model/SeoProject.js';
import { NotFoundError, ValidationError, AccessDeniedError } from '../../../utils/ErrorUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * WordPress Plugin Service — pairing, plugin-credential lifecycle, status,
 * and revocation. Distinct from wordPressService.js (Phase 2), which owns
 * the WordPressConnection/Application-Password side of the integration.
 *
 * Tokens and credentials here are opaque high-entropy random values, not
 * JWTs (per the Phase 3A spec's explicit instruction) — a 256-bit random
 * value has no need for a signature scheme; a hashed-lookup-and-compare is
 * both simpler and sufficient. Hashing uses SHA-256 (fast), not bcrypt
 * (deliberately slow): bcrypt's cost exists to blunt brute-forcing a
 * low-entropy human-chosen/typed secret (see modules/otp/service/otpService.js's
 * 6-digit codes) — it adds nothing against a 256-bit random value, which is
 * already infeasible to brute-force at any hash speed, and would just make
 * every plugin heartbeat/sync artificially slower for no security benefit.
 */

const PAIRING_TOKEN_BYTES = 32;
const PAIRING_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Generates a one-time pairing token for a project. Called from the
 * authenticated Odito dashboard (JWT + validateProjectAccess already
 * enforced by the route) — the raw token is returned exactly once and never
 * stored; only its hash is persisted.
 */
async function generatePairingToken({ projectId, userId }) {
  const raw = crypto.randomBytes(PAIRING_TOKEN_BYTES).toString('base64url');
  const tokenHash = sha256Hex(raw);
  const expiresAt = new Date(Date.now() + PAIRING_TOKEN_TTL_MS);

  // A freshly generated token supersedes any earlier still-unused one for
  // this project, so clicking "Generate" twice can't leave two valid
  // tokens floating around (only the latest is pairable).
  await WordPressPairingToken.deleteMany({ project_id: projectId, used_at: null });

  await WordPressPairingToken.create({
    project_id: projectId,
    user_id: userId,
    token_hash: tokenHash,
    expires_at: expiresAt,
  });

  LoggerUtil.service('WordPressPlugin', 'generate_pairing_token', 'completed', { projectId: String(projectId) });

  return { token: raw, expiresAt };
}

/**
 * Consumes a pairing token presented by the plugin and issues a new,
 * long-lived plugin credential. Never trusts a project ID from the plugin
 * — the project is resolved entirely from the token itself.
 */
async function pairPlugin({ token, siteUrl, wordpressVersion, pluginVersion, wordpressConnectionId }) {
  if (!token || typeof token !== 'string') {
    throw new ValidationError('A pairing token is required');
  }

  const tokenHash = sha256Hex(token);
  const record = await WordPressPairingToken.findOne({ token_hash: tokenHash });

  if (!record) {
    LoggerUtil.security('plugin_pairing_failed', null, { reason: 'unknown_token' });
    throw new AccessDeniedError('Invalid or expired pairing token');
  }

  if (record.used_at) {
    await WordPressPairingToken.updateOne({ _id: record._id }, { $inc: { attempts: 1 } });
    LoggerUtil.security('plugin_pairing_failed', String(record.user_id), { reason: 'token_reused', projectId: String(record.project_id) });
    throw new AccessDeniedError('This pairing token has already been used');
  }

  if (record.expires_at.getTime() < Date.now()) {
    LoggerUtil.security('plugin_pairing_failed', String(record.user_id), { reason: 'token_expired', projectId: String(record.project_id) });
    throw new AccessDeniedError('This pairing token has expired');
  }

  // Claim the token atomically — a concurrent second request presenting the
  // same token can never also succeed (findOneAndUpdate with used_at: null
  // in the filter means only the first caller sees a non-null result).
  const claimed = await WordPressPairingToken.findOneAndUpdate(
    { _id: record._id, used_at: null },
    { $set: { used_at: new Date() } },
    { new: true }
  );
  if (!claimed) {
    throw new AccessDeniedError('This pairing token has already been used');
  }

  const pluginId = crypto.randomUUID();
  const secret = crypto.randomBytes(32).toString('base64url');
  const credentialHash = sha256Hex(secret);
  const now = new Date();

  // Upsert on project_id (the unique key) — re-pairing (reinstall, site
  // migration) replaces the previous installation's plugin_id/credential
  // entirely, which self-invalidates the old credential (a lookup by the
  // old plugin_id no longer matches anything).
  const installation = await WordPressPluginInstallation.findOneAndUpdate(
    { project_id: claimed.project_id },
    {
      $set: {
        project_id: claimed.project_id,
        wordpress_connection_id: wordpressConnectionId || null,
        site_url: siteUrl,
        plugin_id: pluginId,
        credential_hash: credentialHash,
        status: 'active',
        plugin_version: pluginVersion || null,
        wordpress_version: wordpressVersion || null,
        connected_at: now,
        last_seen_at: now,
        revoked_at: null,
      },
    },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
  );

  LoggerUtil.service('WordPressPlugin', 'pair', 'completed', { projectId: String(claimed.project_id), pluginId });

  // Read-only lookup purely for display in the plugin's own settings page
  // (Section 12's "Odito Project: Sapphire Digital Agency" example) — not
  // persisted on the installation document itself, since it's derivable
  // from project_id at any time and would just be a second copy to keep in
  // sync.
  const project = await SeoProject.findById(installation.project_id).select('project_name').lean();

  return {
    pluginId,
    secret, // returned exactly once — never persisted, never logged again
    projectId: String(installation.project_id),
    projectName: project?.project_name || null,
  };
}

/** Updates last_seen_at (+ any refreshed version info) for an already-authenticated plugin. */
async function recordHeartbeat(installation, { wordpressVersion, pluginVersion } = {}) {
  const update = { last_seen_at: new Date() };
  if (wordpressVersion) update.wordpress_version = wordpressVersion;
  if (pluginVersion) update.plugin_version = pluginVersion;

  await WordPressPluginInstallation.updateOne({ _id: installation._id }, { $set: update });
  LoggerUtil.service('WordPressPlugin', 'heartbeat', 'completed', { projectId: String(installation.project_id), pluginId: installation.plugin_id });
}

/** Safe (no credential) status for the Odito dashboard. */
async function getPluginStatus(projectId) {
  const installation = await WordPressPluginInstallation.findOne({ project_id: projectId }).lean();

  if (!installation || installation.status !== 'active') {
    return { installed: false, connected: false };
  }

  const formsDetected = await WordPressForm.countDocuments({ project_id: projectId, is_active: true });

  return {
    installed: true,
    connected: true,
    pluginVersion: installation.plugin_version,
    wordpressVersion: installation.wordpress_version,
    lastSeenAt: installation.last_seen_at,
    lastFormSyncAt: installation.last_form_sync_at,
    formsDetected,
  };
}

/**
 * Revokes the plugin installation for a project — called by
 * wordPressService.disconnectWordPress() (Phase 2) so disconnecting the
 * WordPress Application Password connection also cuts off the plugin, per
 * Section 27 of the Phase 3A spec. The installation row is kept (status
 * flips to 'revoked'), not deleted, so its history/audit trail survives;
 * pluginAuth.middleware.js rejects any request against a revoked
 * installation regardless.
 */
async function revokePluginForProject(projectId) {
  const result = await WordPressPluginInstallation.updateOne(
    { project_id: projectId, status: 'active' },
    { $set: { status: 'revoked', revoked_at: new Date() } }
  );
  if (result.modifiedCount > 0) {
    LoggerUtil.service('WordPressPlugin', 'revoke', 'completed', { projectId: String(projectId) });
  }
  return { revoked: result.modifiedCount > 0 };
}

async function getInstallationByProject(projectId) {
  const installation = await WordPressPluginInstallation.findOne({ project_id: projectId });
  if (!installation) throw new NotFoundError('No WordPress plugin installation found for this project');
  return installation;
}

export default {
  generatePairingToken,
  pairPlugin,
  recordHeartbeat,
  getPluginStatus,
  revokePluginForProject,
  getInstallationByProject,
};
