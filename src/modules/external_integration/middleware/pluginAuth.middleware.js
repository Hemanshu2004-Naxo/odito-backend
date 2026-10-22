import crypto from 'crypto';
import WordPressPluginInstallation from '../model/WordPressPluginInstallation.js';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * Authenticates a WordPress plugin request — the machine-to-machine
 * equivalent of the JWT `auth` middleware, used ONLY by
 * wordPressPluginRoutes.js's heartbeat/forms-sync endpoints. Never accepts
 * a JWT, a WordPress Application Password, or a client-supplied project ID
 * as proof of identity (Section 26 of the Phase 3A spec) — identity comes
 * exclusively from the plugin credential, and the project is *resolved
 * from* that credential, never trusted from the request body.
 *
 * Credential is presented as two headers:
 *   X-Odito-Plugin-Id:     the installation's public identifier (safe to log)
 *   X-Odito-Plugin-Secret: the opaque high-entropy secret (never logged)
 *
 * On success, attaches `req.pluginInstallation` (the full document, so
 * downstream handlers can read `.project_id` and update `.last_seen_at`
 * etc. without a second query).
 */
// Stable machine-readable code every plugin-auth failure returns
// (Section 31, Phase 3C) — the plugin/queue can branch on `.code` without
// parsing message text, and message text stays free to be reworded later.
const UNAUTHORIZED_PLUGIN = 'UNAUTHORIZED_PLUGIN';

export async function pluginAuth(req, res, next) {
  const pluginId = req.header('X-Odito-Plugin-Id');
  const pluginSecret = req.header('X-Odito-Plugin-Secret');

  if (!pluginId || !pluginSecret) {
    LoggerUtil.security('plugin_auth_failed', null, { reason: 'missing_credentials', pluginId: pluginId || null });
    return res.status(401).json(ResponseUtil.error('Missing plugin credentials', 401, { code: UNAUTHORIZED_PLUGIN }));
  }

  const installation = await WordPressPluginInstallation.findOne({ plugin_id: pluginId });

  if (!installation) {
    LoggerUtil.security('plugin_auth_failed', null, { reason: 'unknown_plugin_id', pluginId });
    return res.status(401).json(ResponseUtil.error('Invalid plugin credentials', 401, { code: UNAUTHORIZED_PLUGIN }));
  }

  if (installation.status === 'revoked') {
    LoggerUtil.security('plugin_auth_failed', null, { reason: 'revoked', pluginId });
    return res.status(401).json(ResponseUtil.error('This plugin connection has been revoked', 401, { code: UNAUTHORIZED_PLUGIN }));
  }

  const presentedHash = crypto.createHash('sha256').update(pluginSecret).digest();
  const storedHash = Buffer.from(installation.credential_hash, 'hex');

  // Constant-time comparison — a plain === on the hash strings would leak
  // timing information about how many leading bytes matched. Lengths must
  // match before timingSafeEqual is called (it throws on mismatched
  // lengths, which would itself be a length side-channel if unhandled).
  const isValid = presentedHash.length === storedHash.length
    && crypto.timingSafeEqual(presentedHash, storedHash);

  if (!isValid) {
    LoggerUtil.security('plugin_auth_failed', null, { reason: 'invalid_secret', pluginId });
    return res.status(401).json(ResponseUtil.error('Invalid plugin credentials', 401, { code: UNAUTHORIZED_PLUGIN }));
  }

  req.pluginInstallation = installation;
  next();
}

export default pluginAuth;
