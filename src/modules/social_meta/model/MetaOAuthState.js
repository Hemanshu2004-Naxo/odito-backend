import mongoose from 'mongoose';

/**
 * MetaOAuthState - the server-side half of a Meta OAuth `state`. The state in the redirect URL is a signed token that carries only an
 * unpredictable nonce; WHO started the flow, for WHICH project and where to send the browser back live HERE, so nothing about them is
 * ever readable or forgeable from the URL. A record can be used ONCE (`usedAt`), expires on its own (TTL), and stores only a hash of the
 * nonce and of the optional browser-binding secret - a database leak does not yield a usable state.
 */
export const META_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

const metaOAuthStateSchema = new mongoose.Schema({
  nonce_hash: { type: String, required: true },
  user_id: { type: mongoose.Schema.Types.ObjectId, required: true },
  project_id: { type: mongoose.Schema.Types.ObjectId, required: true },
  returnTo: { type: String, default: null, maxlength: 40 },
  // sha256 of the secret placed in the initiating browser's httpOnly cookie (null when none was issued)
  binding_hash: { type: String, default: null },
  usedAt: { type: Date, default: null },
  expiresAt: { type: Date, required: true },
}, { timestamps: { createdAt: 'createdAt', updatedAt: false }, strict: true, collection: 'meta_oauth_states' });

metaOAuthStateSchema.index({ nonce_hash: 1 }, { unique: true, name: 'unique_meta_oauth_nonce' });
metaOAuthStateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 60, name: 'meta_oauth_state_ttl' });
metaOAuthStateSchema.index({ user_id: 1, project_id: 1, createdAt: -1 }, { name: 'meta_oauth_state_by_owner' });

const MetaOAuthState = mongoose.model('MetaOAuthState', metaOAuthStateSchema);
export default MetaOAuthState;
