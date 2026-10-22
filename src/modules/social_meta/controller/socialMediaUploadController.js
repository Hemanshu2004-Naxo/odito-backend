import { validateImage, validateVideo } from '../service/media/mediaValidationService.js';
import mediaStorageService from '../service/media/mediaStorageService.js';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * SocialMediaUploadController — HTTP only. Authoritative content
 * validation lives in mediaValidationService.js; the actual write lives in
 * mediaStorageService.js. req.projectId here is always
 * validateProjectAccess()'s verified project — never trusts a
 * client-supplied project id for where a file gets stored.
 */
export async function uploadSocialMediaHandler(req, res) {
  const projectId = req.projectId;

  if (!req.file) {
    return res.status(400).json(ResponseUtil.error('No file was uploaded.', 400, { code: 'MEDIA_REQUIRED' }));
  }

  const isVideo = req.file.mimetype === 'video/mp4';
  const validated = isVideo
    ? await validateVideo(req.file.buffer)
    : await validateImage(req.file.buffer);

  if (validated.error) {
    const status = validated.error.code === 'MEDIA_TOO_LARGE' ? 413 : 400;
    return res.status(status).json(ResponseUtil.error(validated.error.message, status, { code: validated.error.code }));
  }

  try {
    const { url } = await mediaStorageService.upload({
      buffer: req.file.buffer,
      projectId,
      extension: validated.extension,
    });

    LoggerUtil.service('SocialMediaUpload', 'upload', 'completed', {
      projectId: String(projectId), type: validated.type, size: req.file.buffer.length,
    });

    return res.status(201).json(ResponseUtil.success({
      url,
      type: validated.type,
      mimeType: validated.mimeType,
      width: validated.width,
      height: validated.height,
      size: req.file.buffer.length,
    }));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_MEDIA_UPLOAD] Failed to store uploaded file', { message: error.message }, { projectId });
    return res.status(500).json(ResponseUtil.error('Failed to store the uploaded file.', 500, { code: 'MEDIA_UPLOAD_FAILED' }));
  }
}

export default { uploadSocialMediaHandler };
