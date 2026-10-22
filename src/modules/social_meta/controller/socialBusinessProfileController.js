import { resolveSocialBusinessProfile } from '../service/socialBusinessProfileResolver.js';
import { updateProfile, setBrandLogo, clearBrandLogo } from '../service/socialBusinessProfileService.js';
import { processAndStoreCatalogImage } from '../service/media/catalogMedia.js';
import mediaStorageService from '../service/media/mediaStorageService.js';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * SocialBusinessProfileController — HTTP only. Both routes run behind
 * auth + validateProjectAccess() (see routes/socialBusinessProfileRoutes.js),
 * which sets req.projectId / req.userId; those are the only identities used
 * here. The resolver and the service never see a client-supplied project id.
 *
 * GET -> { resolvedProfile, editableProfile, googleStatus }
 * PUT -> the same shape, re-read after the write, so the client always gets
 *        the effect of the save on the resolved profile (e.g. an override
 *        taking precedence) from the server, not from its own guess.
 */

const ERROR_STATUS = {
  NOT_FOUND: 404,
  CONFLICT: 409,
  // every validation code (INVALID_PROFILE, UNKNOWN_FIELD, EMPTY_UPDATE, INVALID_BODY) is a 400
};

export async function getSocialBusinessProfileHandler(req, res) {
  const projectId = req.projectId;
  try {
    const result = await resolveSocialBusinessProfile(projectId);
    if (!result) return res.status(404).json(ResponseUtil.error('Project not found.', 404, { code: 'NOT_FOUND' }));
    return res.json(ResponseUtil.success(result));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_BUSINESS_PROFILE] Failed to load profile', { message: error.message }, { projectId });
    return res.status(500).json(ResponseUtil.error('Failed to load the business profile', 500, { code: 'SOCIAL_BUSINESS_PROFILE_FAILED' }));
  }
}

export async function updateSocialBusinessProfileHandler(req, res) {
  const projectId = req.projectId;
  try {
    const saved = await updateProfile(projectId, req.userId, req.body);
    if (!saved.success) {
      const status = ERROR_STATUS[saved.error.code] || 400;
      return res.status(status).json(ResponseUtil.error(saved.error.message, status, { code: saved.error.code }));
    }
    const result = await resolveSocialBusinessProfile(projectId);
    if (!result) return res.status(404).json(ResponseUtil.error('Project not found.', 404, { code: 'NOT_FOUND' }));
    return res.json(ResponseUtil.success(result));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_BUSINESS_PROFILE] Failed to save profile', { message: error.message }, { projectId });
    return res.status(500).json(ResponseUtil.error('Failed to save the business profile', 500, { code: 'SOCIAL_BUSINESS_PROFILE_FAILED' }));
  }
}

/**
 * POST /logo (multipart `file`) — the user's own brand logo. It goes through the SAME shared media pipeline as a
 * product image (validate the decoded bytes, re-encode, store under storage/social_media/<projectId>/), is saved as
 * a reference on the profile, and then takes top precedence in the resolver's logo order (user upload -> Google
 * logo -> website logo -> favicon). The file it replaces is deleted. The response is the re-resolved profile.
 */
export async function uploadBrandLogoHandler(req, res) {
  const projectId = req.projectId;
  if (!req.file || !Buffer.isBuffer(req.file.buffer)) {
    return res.status(400).json(ResponseUtil.error('No file was uploaded.', 400, { code: 'MEDIA_REQUIRED' }));
  }
  try {
    const processed = await processAndStoreCatalogImage({ buffer: req.file.buffer, projectId: String(projectId) });
    if (processed.error) {
      return res.status(processed.error.status).json(ResponseUtil.error(processed.error.message, processed.error.status, { code: processed.error.code }));
    }
    const saved = await setBrandLogo(projectId, req.userId, processed.media);
    if (!saved.success) {
      await mediaStorageService.deleteByKey(processed.media.storageKey, { projectId }); // stored but never attached
      const status = ERROR_STATUS[saved.error.code] || 400;
      return res.status(status).json(ResponseUtil.error(saved.error.message, status, { code: saved.error.code }));
    }
    if (saved.previousStorageKey) await mediaStorageService.deleteByKey(saved.previousStorageKey, { projectId });
    const result = await resolveSocialBusinessProfile(projectId);
    if (!result) return res.status(404).json(ResponseUtil.error('Project not found.', 404, { code: 'NOT_FOUND' }));
    return res.status(201).json(ResponseUtil.success(result));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_BUSINESS_PROFILE] Failed to save logo', { message: error.message }, { projectId });
    return res.status(500).json(ResponseUtil.error('Failed to save the logo', 500, { code: 'SOCIAL_BUSINESS_PROFILE_FAILED' }));
  }
}

/** DELETE /logo — removes the user's logo; the resolver falls back to the Google / website logo. */
export async function deleteBrandLogoHandler(req, res) {
  const projectId = req.projectId;
  try {
    const cleared = await clearBrandLogo(projectId, req.userId);
    if (!cleared.success) {
      const status = ERROR_STATUS[cleared.error.code] || 400;
      return res.status(status).json(ResponseUtil.error(cleared.error.message, status, { code: cleared.error.code }));
    }
    if (cleared.previousStorageKey) await mediaStorageService.deleteByKey(cleared.previousStorageKey, { projectId });
    const result = await resolveSocialBusinessProfile(projectId);
    if (!result) return res.status(404).json(ResponseUtil.error('Project not found.', 404, { code: 'NOT_FOUND' }));
    return res.json(ResponseUtil.success(result));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_BUSINESS_PROFILE] Failed to remove logo', { message: error.message }, { projectId });
    return res.status(500).json(ResponseUtil.error('Failed to remove the logo', 500, { code: 'SOCIAL_BUSINESS_PROFILE_FAILED' }));
  }
}

export default { getSocialBusinessProfileHandler, updateSocialBusinessProfileHandler, uploadBrandLogoHandler, deleteBrandLogoHandler };
