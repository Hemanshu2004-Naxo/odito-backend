import mongoose from 'mongoose';

/**
 * WordPressPluginInstallation Model
 *
 * Represents one installed-and-paired Odito WordPress plugin. Distinct from
 * WordPressConnection (Phase 2): WordPressConnection holds the WordPress
 * Application Password used for Odito's own server-to-site REST calls
 * (verify/status/plugin-detection); this model holds the plugin's OWN
 * scoped machine-to-machine credential, issued after pairing, used for
 * every plugin -> Odito call (heartbeat, forms/sync). The two are never
 * merged — the plugin never sees or stores the Application Password (see
 * class-odito-connection.php), and Odito's own dashboard calls never use
 * the plugin credential.
 *
 * One installation per project, same reasoning as WordPressConnection's
 * `{project_id}` unique index (a project has at most one paired WordPress
 * site/plugin).
 */

const PLUGIN_STATUSES = ['active', 'revoked'];

const wordPressPluginInstallationSchema = new mongoose.Schema({
  project_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SeoProject',
    required: true,
  },
  // Links back to the Phase 2 connection this plugin was paired through —
  // not used for authentication (see plugin_id/credential_hash below), only
  // so the dashboard can show "plugin paired via this WordPress connection"
  // and so wordPressService.disconnectWordPress() knows what to revoke.
  wordpress_connection_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WordPressConnection',
    default: null,
  },
  site_url: {
    type: String,
    required: true,
    trim: true,
  },
  // Public identifier the plugin presents alongside its secret on every
  // request (X-Odito-Plugin-Id header) — safe to log, safe to show in the
  // WordPress admin UI (unlike the secret itself, see credential_hash).
  plugin_id: {
    type: String,
    required: true,
    unique: true,
  },
  // SHA-256 hex digest of the plugin's opaque credential. The raw secret is
  // returned to the plugin exactly once, at pairing time, and is never
  // stored — every subsequent request re-hashes the presented secret and
  // compares against this (see pluginAuth.middleware.js).
  credential_hash: {
    type: String,
    required: true,
  },
  status: {
    type: String,
    enum: PLUGIN_STATUSES,
    default: 'active',
    index: true,
  },
  plugin_version: {
    type: String,
    default: null,
  },
  wordpress_version: {
    type: String,
    default: null,
  },
  last_seen_at: {
    type: Date,
    default: null,
  },
  last_form_sync_at: {
    type: Date,
    default: null,
  },
  connected_at: {
    type: Date,
    default: Date.now,
  },
  // Set when status transitions to 'revoked' (WordPress disconnect, or a
  // future manual revoke action) — lets the dashboard show *when* access
  // was cut, not just that it was.
  revoked_at: {
    type: Date,
    default: null,
  },
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
});

// One plugin installation per project.
wordPressPluginInstallationSchema.index({ project_id: 1 }, { unique: true });

export { PLUGIN_STATUSES };

const WordPressPluginInstallation = mongoose.model('WordPressPluginInstallation', wordPressPluginInstallationSchema);
export default WordPressPluginInstallation;
