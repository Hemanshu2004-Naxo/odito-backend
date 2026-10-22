import path from 'path';
import fs from 'fs';
import { validationResult } from 'express-validator';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import wordPressPluginService from '../service/wordPressPluginService.js';
import wordPressFormService from '../service/wordPressFormService.js';
import { resolveSeoBridgeDownload } from '../service/seoBridgePackage.js';

/** Same error-shape convention as leadController.js/wordPressController.js. */
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
  console.error(`[WORDPRESS_PLUGIN] ${fallbackMessage}:`, error.message, error.stack);
  return res.status(error.statusCode || 500).json(
    ResponseUtil.error(error.message || fallbackMessage, error.statusCode || 500)
  );
}

function firstValidationError(req, res) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return null;
  return res.status(400).json(ResponseUtil.validationError(errors.array(), errors.array()[0].msg));
}

// ── Odito-dashboard-authenticated (JWT) ──────────────────────────────────

// POST /api/wordpress/plugin/pairing-token
export async function generatePairingToken(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    const result = await wordPressPluginService.generatePairingToken({
      projectId: req.body.projectId,
      userId: req.user._id,
    });

    return res.status(201).json(ResponseUtil.created(result, 'Pairing token generated'));
  } catch (error) {
    return handleError(res, error, 'Failed to generate pairing token');
  }
}

// GET /api/wordpress/plugin/status?projectId=
export async function getPluginStatus(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    const status = await wordPressPluginService.getPluginStatus(req.query.projectId);
    return res.status(200).json(ResponseUtil.success(status, 'Plugin status retrieved'));
  } catch (error) {
    return handleError(res, error, 'Failed to fetch plugin status');
  }
}

// GET /api/wordpress/plugin/forms?projectId=
export async function listForms(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    const forms = await wordPressFormService.getForms(req.query.projectId);
    return res.status(200).json(ResponseUtil.success(forms, 'Detected forms retrieved'));
  } catch (error) {
    return handleError(res, error, 'Failed to fetch detected forms');
  }
}

// GET /api/wordpress/plugin/download
// Login-gated only (no project-specific data in the file itself) — streams
// the pre-built plugin package. See odito-wordpress-plugin/ for source;
// the .zip is a build artifact, not committed source.
export async function downloadPlugin(req, res) {
  try {
    const zipPath = path.resolve(process.cwd(), 'storage', 'plugin', 'odito-lead-capture.zip');
    if (!fs.existsSync(zipPath)) {
      return res.status(404).json(ResponseUtil.notFound('Plugin package is not currently available'));
    }
    return res.download(zipPath, 'odito-lead-capture.zip');
  } catch (error) {
    return handleError(res, error, 'Failed to download plugin package');
  }
}

// GET /api/wordpress/plugin/seo-bridge/download
// A separate, unrelated plugin from the Lead Capture one above (the Odito SEO
// Bridge, see odito-seo-bridge/ for source). Unlike the Lead Capture download,
// this does NOT stream a pre-built file: the ZIP is built from the plugin's
// current source on every request (seoBridgePackage.js), so what a user
// downloads can never lag behind the source. The pre-built artifact is only
// the fallback when this backend is deployed without the plugin source.
export async function downloadSeoBridgePlugin(req, res) {
  try {
    const download = await resolveSeoBridgeDownload();
    if (!download) {
      return res.status(404).json(ResponseUtil.notFound('Plugin package is not currently available'));
    }

    if (download.kind === 'prebuilt') {
      console.warn(
        `[WORDPRESS_PLUGIN] Serving the pre-built Odito SEO Bridge artifact (${download.version}) — ` +
        'the plugin source directory was not found next to the backend, so it cannot be rebuilt on demand.'
      );
    }

    // Never cacheable: a browser, proxy or CDN holding an older response is
    // exactly the "download is stuck on an old version" failure this prevents.
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${download.fileName}"`,
      'Content-Length': String(download.buffer.length),
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
      'X-Odito-Bridge-Version': download.version,
      'X-Odito-Bridge-Package': download.kind,
      'Access-Control-Expose-Headers': 'Content-Disposition, X-Odito-Bridge-Version, X-Odito-Bridge-Package',
    });
    return res.status(200).send(download.buffer);
  } catch (error) {
    return handleError(res, error, 'Failed to download plugin package');
  }
}

// ── Plugin-authenticated (no JWT — see pluginAuth.middleware.js) ───────

// POST /api/wordpress/plugin/pair
export async function pairPlugin(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    const { token, siteUrl, wordpressVersion, pluginVersion } = req.body;
    const result = await wordPressPluginService.pairPlugin({ token, siteUrl, wordpressVersion, pluginVersion });

    return res.status(201).json(ResponseUtil.created(result, 'Plugin paired successfully'));
  } catch (error) {
    return handleError(res, error, 'Failed to pair plugin');
  }
}

// POST /api/wordpress/plugin/heartbeat
export async function heartbeat(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    await wordPressPluginService.recordHeartbeat(req.pluginInstallation, req.body);
    return res.status(200).json(ResponseUtil.success(null, 'Heartbeat recorded'));
  } catch (error) {
    return handleError(res, error, 'Failed to record heartbeat');
  }
}

// POST /api/wordpress/plugin/forms/sync
export async function syncForms(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    const result = await wordPressFormService.syncForms(req.pluginInstallation, req.body.forms);
    return res.status(200).json(ResponseUtil.success(result, 'Forms synced successfully'));
  } catch (error) {
    return handleError(res, error, 'Failed to sync forms');
  }
}
