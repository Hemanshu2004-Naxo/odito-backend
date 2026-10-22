import { validationResult } from 'express-validator';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import wordPressService, { WordPressConnectionError } from '../service/wordPressService.js';
import wordPressSeoDataService from '../service/wordPressSeoDataService.js';
import wordPressSeoFixService from '../service/wordPressSeoFixService.js';

/**
 * Maps a thrown error to an HTTP response without ever including
 * credentials, raw Authorization headers, or stack traces. Handles both the
 * app-wide AuthUtil/ErrorUtil error shape (.type/.statusCode, used by
 * validateProjectAccess()) and this module's own WordPressConnectionError
 * (.code/.statusCode) — the two coexist because project-authorization
 * failures and WordPress-connection failures are different failure domains
 * with different existing conventions.
 */
function handleError(res, error, fallbackMessage) {
  if (error.type === 'NOT_FOUND') {
    return res.status(404).json(ResponseUtil.notFound(error.message));
  }
  if (error.type === 'ACCESS_DENIED') {
    return res.status(403).json(ResponseUtil.accessDenied(error.message));
  }
  if (error.type === 'VALIDATION_ERROR') {
    return res.status(400).json(ResponseUtil.validationError(error.details, error.message));
  }

  if (error instanceof WordPressConnectionError) {
    console.error(`[WORDPRESS] ${fallbackMessage} (${error.code})`);
    return res.status(error.statusCode || 502).json({
      success: false,
      message: error.message,
      code: error.code,
      // WordPress's own sanitized REST error code, when it sent one
      // (e.g. "incorrect_password") — lets support tell a wrong credential
      // from a stripped Authorization header. Never credential material.
      ...(error.wpCode ? { wpCode: error.wpCode } : {}),
    });
  }

  console.error(`[WORDPRESS] ${fallbackMessage}:`, error.message, error.stack);
  return res.status(error.statusCode || 500).json(
    ResponseUtil.error(error.message || fallbackMessage, error.statusCode || 500)
  );
}

function firstValidationError(req, res) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return null;
  return res.status(400).json(ResponseUtil.validationError(errors.array(), errors.array()[0].msg));
}

// POST /api/wordpress/connect
// projectId travels in the body — ownership already validated by
// validateProjectAccess() middleware before this handler runs.
export async function connectWordPress(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    const { projectId, siteUrl, username, applicationPassword } = req.body;
    const status = await wordPressService.connectWordPress({
      projectId,
      userId: req.user._id,
      siteUrl,
      username,
      applicationPassword,
    });

    return res.status(201).json(ResponseUtil.created(status, 'WordPress connected successfully'));
  } catch (error) {
    return handleError(res, error, 'Failed to connect WordPress site');
  }
}

// GET /api/wordpress/status?projectId=
export async function getConnectionStatus(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    const status = await wordPressService.getConnectionStatus(req.query.projectId);
    return res.status(200).json(ResponseUtil.success(status, 'WordPress connection status retrieved'));
  } catch (error) {
    return handleError(res, error, 'Failed to fetch WordPress connection status');
  }
}

// POST /api/wordpress/verify
export async function verifyConnection(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    const status = await wordPressService.verifyWordPressConnection(req.body.projectId);
    return res.status(200).json(ResponseUtil.success(status, 'WordPress connection verified'));
  } catch (error) {
    return handleError(res, error, 'Failed to verify WordPress connection');
  }
}

// DELETE /api/wordpress/disconnect?projectId=
export async function disconnectConnection(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    await wordPressService.disconnectWordPress(req.query.projectId);
    return res.status(200).json(ResponseUtil.deleted('WordPress disconnected successfully'));
  } catch (error) {
    return handleError(res, error, 'Failed to disconnect WordPress');
  }
}

// GET /api/wordpress/capabilities?projectId=
// Never touches WordPress directly — reads the connection's own
// last-detected provider (refreshed on every connect/verify call) and
// returns a static per-provider capability table. Credentials are never
// part of the response (wordPressService.getConnectionStatus already omits
// application_password from the underlying read).
export async function getCapabilities(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    const capabilities = await wordPressSeoDataService.getCapabilities(req.query.projectId);
    return res.status(200).json(ResponseUtil.success(capabilities, 'WordPress SEO capabilities retrieved'));
  } catch (error) {
    return handleError(res, error, 'Failed to fetch WordPress SEO capabilities');
  }
}

// GET /api/wordpress/seo-data?projectId=&pageUrl=
// Live, on-demand read from the customer's WordPress site — never written
// into seo_page_data (the crawler's own audit snapshot remains
// authoritative for scoring/verification; this is integration data only).
export async function getPageSeoData(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    const data = await wordPressSeoDataService.getPageSeoData(req.query.projectId, req.query.pageUrl);
    if (!data) {
      return res.status(200).json(ResponseUtil.success(null, 'This URL could not be resolved to a WordPress post or page'));
    }
    return res.status(200).json(ResponseUtil.success(data, 'Live WordPress SEO data retrieved'));
  } catch (error) {
    return handleError(res, error, 'Failed to fetch live WordPress SEO data');
  }
}

// GET /api/wordpress/page-resolution?projectId=&pageUrl=
// Read-only: does this URL resolve to a WordPress page/post Odito can act on, and if not, why
// (different site, blog-index homepage, unsupported content type, not exposed by REST). Always 200.
export async function getPageResolution(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    const data = await wordPressSeoDataService.getPageResolution(req.query.projectId, req.query.pageUrl);
    return res.status(200).json(ResponseUtil.success(data, 'WordPress page resolution retrieved'));
  } catch (error) {
    return handleError(res, error, 'Failed to resolve the page in WordPress');
  }
}

// GET /api/wordpress/h1-context?projectId=&pageUrl=[&recommended=]
// Read-only: whether this page's H1 can be fixed automatically (builder adapter decision), what
// the page currently has, and the fingerprint of the state the user is reviewing. Always 200 —
// `supported:false` carries the reason instead of an error.
export async function getH1Context(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    const data = await wordPressSeoFixService.readH1Context({
      projectId: req.query.projectId,
      pageUrl: req.query.pageUrl,
      recommended: req.query.recommended,
    });
    return res.status(200).json(ResponseUtil.success(data, 'Page H1 context retrieved'));
  } catch (error) {
    return handleError(res, error, 'Failed to read the page H1 context');
  }
}

// GET /api/wordpress/site-schema?projectId=
// Live, on-demand read of SITE-LEVEL schema (Organization sameAs,
// breadcrumbs) — always 200 with `supported:false` (never a 4xx/5xx) when
// the connected site's Bridge doesn't support this yet, so the frontend can
// cleanly decide whether to show the sameAs/breadcrumb UI at all.
export async function getSiteSchema(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    const data = await wordPressSeoDataService.getSiteSchema(req.query.projectId);
    return res.status(200).json(ResponseUtil.success(data, 'Live WordPress site schema retrieved'));
  } catch (error) {
    return handleError(res, error, 'Failed to fetch live WordPress site schema');
  }
}
