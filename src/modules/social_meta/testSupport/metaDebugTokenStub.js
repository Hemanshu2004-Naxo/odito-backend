import metaApiService from '../service/metaApiService.js';

/**
 * Test-only helper (not imported by production code). Meta cannot return a
 * deterministic debug_token answer for the fake tokens these tests use, and
 * hitting the real endpoint would make a unit test depend on the network —
 * so, exactly like the rest of this module's tests substitute Graph calls on
 * metaApiService's default export, this replaces ONLY `/debug_token` requests
 * and delegates everything else to whatever `request` was installed before.
 *
 * Returns a restore function (call it in `after`/`finally`).
 */
export function debugTokenResponse({
  valid = true,
  expiresAtSeconds = 0, // 0 = Meta's "never expires"
  dataAccessExpiresAtSeconds = Math.floor(Date.now() / 1000) + 60 * 24 * 3600,
  appId = process.env.META_APP_ID,
  scopes = ['pages_manage_posts', 'instagram_content_publish'],
} = {}) {
  return {
    success: true,
    status: 200,
    data: {
      data: {
        app_id: appId,
        type: 'PAGE',
        is_valid: valid,
        expires_at: expiresAtSeconds,
        data_access_expires_at: dataAccessExpiresAtSeconds,
        scopes,
        user_id: 'meta_user_1',
      },
    },
  };
}

export function installDebugTokenStub(options = {}) {
  const previous = metaApiService.request;
  const calls = [];
  metaApiService.request = async (opts) => {
    if (opts?.path === '/debug_token') {
      calls.push(opts);
      return typeof options.respond === 'function' ? options.respond(opts) : debugTokenResponse(options);
    }
    return previous(opts);
  };
  const restore = () => { metaApiService.request = previous; };
  restore.calls = calls;
  return restore;
}

export default { installDebugTokenStub, debugTokenResponse };
