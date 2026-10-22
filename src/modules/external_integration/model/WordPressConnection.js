import mongoose from 'mongoose';
import crypto from 'crypto';

/**
 * WordPressConnection Model
 *
 * A project's connection to a customer's WordPress site, authenticated via
 * a WordPress Application Password (not OAuth — WordPress core has no OAuth
 * flow of its own; Application Passwords are the standard, host-portable
 * mechanism). Structurally modeled on GoogleConnection.js — snake_case
 * fields, encrypted-secret-at-rest via schema get/set, status + timestamp
 * bookkeeping — but with its OWN encryption key
 * (WORDPRESS_CREDENTIAL_ENCRYPTION_KEY, not GOOGLE_TOKEN_ENCRYPTION_KEY) so
 * rotating one vendor's key can never affect the other's connections.
 *
 * One connection per project (see the unique index below) — unlike
 * GoogleConnection, there is no "purpose" dimension here: a project has at
 * most one WordPress site, so { project_id } alone is the natural key.
 * Ownership is transitively enforced by SeoProject.user_id (one user per
 * project) rather than duplicating user_id into the uniqueness constraint.
 */

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const ENCRYPTION_PREFIX = 'enc:v1:';

function getEncryptionKey() {
  const keyHex = process.env.WORDPRESS_CREDENTIAL_ENCRYPTION_KEY;
  if (!keyHex || keyHex.length !== 64) {
    throw new Error('WORDPRESS_CREDENTIAL_ENCRYPTION_KEY must be set to a 64-character hex string (32 bytes)');
  }
  return Buffer.from(keyHex, 'hex');
}

/** Same AES-256-GCM / versioned-prefix scheme as GoogleConnection.js's encryptToken. */
export function encryptCredential(plainText) {
  if (plainText === null || plainText === undefined || plainText === '') return plainText;
  if (typeof plainText === 'string' && plainText.startsWith(ENCRYPTION_PREFIX)) return plainText;

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${ENCRYPTION_PREFIX}${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/** Same AES-256-GCM / versioned-prefix scheme as GoogleConnection.js's decryptToken. */
export function decryptCredential(cipherText) {
  if (!cipherText || typeof cipherText !== 'string' || !cipherText.startsWith(ENCRYPTION_PREFIX)) {
    return cipherText;
  }

  try {
    const [ivHex, authTagHex, dataHex] = cipherText.slice(ENCRYPTION_PREFIX.length).split(':');
    const key = getEncryptionKey();
    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (error) {
    console.error('[WORDPRESS_CONNECTION] Failed to decrypt credential:', error.message);
    return null;
  }
}

const wordPressConnectionSchema = new mongoose.Schema({
  // 👤 Connection owner (denormalized from project_id.user_id for cheap
  // ownership checks in list-style queries — same reasoning GoogleConnection
  // uses it for; the authoritative check is still always
  // AuthUtil.validateProjectAccess against the live SeoProject).
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'User ID is required'],
    index: true
  },

  // 📌 Project association — the tenant boundary.
  project_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SeoProject',
    required: [true, 'Project ID is required']
  },

  // 🌐 WordPress site
  site_url: {
    type: String,
    required: [true, 'Site URL is required'],
    trim: true
  },

  username: {
    type: String,
    required: [true, 'WordPress username is required'],
    trim: true
  },

  // 🔐 Application Password — encrypted at rest, transparently decrypted on
  // direct property access via the schema getter (NOT during toJSON/toObject
  // — see stripSecrets below, which deletes it unconditionally so a getter
  // firing during serialization can never leak it either way).
  application_password: {
    type: String,
    required: [true, 'Application password is required'],
    set: encryptCredential,
    get: decryptCredential
  },

  // 📊 Connection status — mirrors GoogleConnection's status+timestamp
  // approach rather than a separate boolean "verified" flag. No
  // 'disconnected' value: disconnecting removes the document entirely (see
  // wordPressService.disconnectWordPress), so a "disconnected" project has
  // no WordPressConnection row at all rather than one sitting in that
  // status — the API represents that case as status: 'not_connected' at
  // the response-shaping layer, not as a stored enum value.
  status: {
    type: String,
    enum: ['connected', 'verification_failed'],
    default: 'connected',
    index: true
  },

  // 🏷️ Site metadata — only what's needed for the status card. Best-effort:
  // WordPress core doesn't guarantee wordpress_version is discoverable (many
  // hosts/security plugins deliberately hide it), so this is frequently null
  // and that is not treated as a connection failure.
  wordpress_version: {
    type: String,
    default: null
  },
  site_name: {
    type: String,
    default: null
  },

  // 🔌 Plugin detection — best-effort, secondary to the connection itself.
  // Deliberately NOT the raw WP REST API response (that can be large and
  // contains fields Odito has no use for) — a normalized, capped summary.
  plugin_summary: {
    status: {
      type: String,
      enum: ['available', 'unavailable'],
      default: 'unavailable'
    },
    reason: { type: String, default: null }, // e.g. 'insufficient_permissions', 'endpoint_unavailable'
    count: { type: Number, default: null },
    plugins: {
      type: [{
        name: String,
        slug: String,
        status: String,
        version: String,
        _id: false
      }],
      default: []
    },
    checked_at: { type: Date, default: null }
  },

  // ⏰ Timestamps
  connected_at: {
    type: Date,
    default: Date.now
  },
  last_verified_at: {
    type: Date,
    default: null
  },

  // ⚠️ Safe (non-secret, non-stack-trace) error message from the most
  // recent failed verification attempt — cleared on the next success.
  last_error: {
    type: String,
    default: null
  },

  // 🔎 SEO provider detection (Phase 4 — read + capability detection only,
  // no writes yet). Derived from plugin_summary.plugins[].slug at
  // connect/verify time (see wordPressService.js's detectSeoProvider) plus,
  // when the slug list is ambiguous or unavailable, a best-effort REST
  // namespace probe. 'none' (not 'null') is the deliberate default so every
  // pre-existing connection — created before this field existed — reads as
  // "no SEO plugin detected yet" rather than an unset/nullable state that
  // callers would have to special-case; the next verify() call populates it
  // like any other best-effort field on this model (wordpress_version,
  // plugin_summary).
  detected_seo_provider: {
    type: String,
    enum: ['rank_math', 'yoast', 'aioseo', 'seopress', 'none', 'multiple'],
    default: 'none'
  },

  // Every SEO-plugin slug actually matched — length 0 (none), 1 (the normal
  // case, mirrored 1:1 into detected_seo_provider), or 2+ (ambiguous, in
  // which case detected_seo_provider is forced to 'multiple' and the
  // frontend must show the ambiguity rather than this field silently
  // picking one — see wordPressService.js's detectSeoProvider).
  detected_seo_providers: {
    type: [{
      type: String,
      enum: ['rank_math', 'yoast', 'aioseo', 'seopress']
    }],
    default: []
  },

  seo_provider_detected_at: {
    type: Date,
    default: null
  }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});

// One WordPress connection per project — a project has at most one
// WordPress site, so project_id alone (not a compound key) is the natural
// uniqueness boundary. Ownership uniqueness-by-user is implied transitively
// through SeoProject.user_id (one owning user per project), so duplicating
// user_id into this index would add no additional protection.
wordPressConnectionSchema.index({ project_id: 1 }, { unique: true });

// Status filtering (e.g. a future "which projects have a broken WP
// connection" admin view).
wordPressConnectionSchema.index({ status: 1 });

// Strip the encrypted secret from any serialized form of this document —
// unconditional, regardless of whether the getter fired, matching
// GoogleConnection.js's stripSecrets pattern exactly.
function stripSecrets(doc, ret) {
  delete ret.application_password;
  delete ret.__v;
  return ret;
}

wordPressConnectionSchema.set('toJSON', { virtuals: true, transform: stripSecrets });
wordPressConnectionSchema.set('toObject', { virtuals: true, transform: stripSecrets });

const WordPressConnection = mongoose.model('WordPressConnection', wordPressConnectionSchema);
export default WordPressConnection;
