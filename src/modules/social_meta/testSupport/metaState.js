import crypto from 'crypto';
import MetaOAuthState, { META_OAUTH_STATE_TTL_MS } from '../model/MetaOAuthState.js';
import { issueMetaOAuthState, signMetaStateToken } from '../service/metaOAuthStateService.js';

/**
 * Test-only helpers (not imported by production code): make the `state` a Meta callback would receive.
 *   mintState({ userId, projectId })                     a real, one-time state exactly as /start issues it (returns the token)
 *   mintStateWith({ userId, projectId, provider, ... })   the same record but a token whose signed provider / purpose / lifetime is chosen
 */
export async function mintState({ userId, projectId, returnTo = null }) {
  const { state } = await issueMetaOAuthState({ userId, projectId, returnTo });
  return state;
}

export async function mintStateWith({ userId, projectId, provider = 'meta', purpose = 'social_meta', expiresIn = '10m', returnTo = null }) {
  const nonce = crypto.randomBytes(32).toString('base64url');
  await MetaOAuthState.create({
    nonce_hash: crypto.createHash('sha256').update(nonce).digest('hex'), user_id: userId, project_id: projectId, returnTo,
    expiresAt: new Date(Date.now() + META_OAUTH_STATE_TTL_MS),
  });
  return signMetaStateToken({ provider, purpose, nonce }, { expiresIn });
}
