import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { getServiceUrls } from '../../../../config/env.js';
import { isPubliclyReachableUrl } from '../../../../utils/publicUrlCheck.js';

/**
 * MediaStorageService — the ONLY place that writes/deletes a social-post
 * media file, behind a small provider-agnostic interface
 * (upload/deleteByUrl/isOwnedUrl). Local disk today, matching the ONLY
 * upload pattern that already exists anywhere in Odito (authService.js's
 * avatar storage: files under storage/<feature>/, served by server.js's
 * existing `app.use('/storage', express.static(...))` — no new static
 * route, no new storage provider). No S3/Cloudinary/R2 SDK exists in
 * odito_backend/package.json, so introducing one here would be a second,
 * redundant storage system; swapping to a real object store later only
 * means replacing this one file — nothing above it (the upload
 * controller, the platform adapters) knows or cares how a URL was made.
 */

const ROOT_DIR = path.resolve(process.cwd(), 'storage', 'social_media');

const MEDIA_PATH = '/storage/social_media/';

/**
 * The origin Odito puts in the media URLs it generates. Computed lazily (not at module load) so it always reads the env at
 * call time — same reasoning as authService.js's getAvatarUrlPrefix().
 *
 * Meta's Graph API FETCHES image_url / url / video_url from the public internet, so this origin must be public HTTPS in any
 * environment that publishes media. PUBLIC_MEDIA_BASE_URL (optional) names a public origin that serves the SAME
 * `/storage/social_media/<project>/<file>` paths - a reverse proxy, CDN or tunnel in front of this backend's storage - so the
 * API itself can stay private; when it is not set, BACKEND_URL is used exactly as before. The origin is configuration only:
 * a client can never supply or influence it.
 */
export function publicMediaOrigin() {
  const configured = (process.env.PUBLIC_MEDIA_BASE_URL || '').trim().replace(/\/+$/, '');
  return configured || getServiceUrls().backend;
}

function urlPrefix() {
  return `${publicMediaOrigin()}${MEDIA_PATH}`;
}

/** Every prefix a URL this service issued can carry: today's public origin, and BACKEND_URL (what rows written before PUBLIC_MEDIA_BASE_URL was set carry). */
function ownedPrefixes() {
  return [...new Set([urlPrefix(), `${getServiceUrls().backend}${MEDIA_PATH}`])];
}

/** True only for a URL this service itself wrote — the sole gate before any delete is attempted. */
export function isOwnedUrl(url) {
  return typeof url === 'string' && ownedPrefixes().some((prefix) => url.startsWith(prefix));
}

const STORED_MEDIA_PATH_RE = /^[a-f0-9]{24}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|mp4)$/i;

/**
 * Why a stored-media URL could NOT be handed to Meta, or null when it can. Everything is judged from the URL string and the
 * server's own configuration - nothing is fetched (no SSRF surface):
 *   NOT_OWNED     - not a URL this service issued (a client can never put an arbitrary URL on a post)
 *   WRONG_ORIGIN  - not on the CURRENT public media origin (e.g. a row written under an old / private BACKEND_URL)
 *   NOT_PUBLIC    - the origin is not public HTTPS (localhost, loopback, private/link-local address, http)
 *   BAD_PATH      - not exactly <24-hex project id>/<uuid>.<jpg|png|webp|mp4>, no query string or fragment
 */
export function publishableMediaProblem(url) {
  if (!isOwnedUrl(url)) return 'NOT_OWNED';
  if (!url.startsWith(urlPrefix())) return 'WRONG_ORIGIN';
  if (!isPubliclyReachableUrl(url)) return 'NOT_PUBLIC';
  if (!STORED_MEDIA_PATH_RE.test(url.slice(urlPrefix().length))) return 'BAD_PATH';
  return null;
}

/** True when the stored file this URL names actually exists under storage/social_media/ (a deleted or never-written file is not publishable). */
export async function storedMediaExists(url) {
  if (!isOwnedUrl(url)) return false;
  const filePath = safeFilePath(url);
  if (!filePath) return false;
  try { await fs.access(filePath); return true; } catch { return false; }
}

// isPubliclyReachableUrl is re-exported from utils/publicUrlCheck.js (the
// single authoritative definition, also used by config/env.js's startup
// validation) — kept as a named re-export here so every existing importer
// in this module (platformAdapters/facebookAdapter.js, instagramAdapter.js,
// this file's own tests) is unaffected.
export { isPubliclyReachableUrl };

/**
 * Resolves a public URL this service issued back to its real file path,
 * rejecting anything that isn't exactly "<24-hex-projectId>/<filename>" —
 * defense in depth against path traversal, even though in practice the
 * project-id segment only ever came from a validated ObjectId and the
 * filename only ever came from randomUUID() (see upload() below), never
 * from user input.
 */
function safeFilePath(url) {
  const prefix = ownedPrefixes().find((p) => url.startsWith(p));
  if (!prefix) return null;
  const rel = url.slice(prefix.length);
  const segments = rel.split('/');
  if (segments.length !== 2) return null;
  const [projectSegment, filename] = segments;
  if (!/^[a-f0-9]{24}$/i.test(projectSegment)) return null;
  if (!filename || filename.includes('..') || filename.includes('\\') || filename.includes('/')) return null;
  return path.join(ROOT_DIR, projectSegment, filename);
}

/**
 * Writes `buffer` under storage/social_media/<projectId>/<uuid><extension>
 * and returns its public HTTPS URL. Scoped per PROJECT (never per-user or
 * globally) — matching this module's existing isolation discipline
 * (SocialPublication, SocialAccount are both project_id-scoped). The
 * filename is always a fresh UUID; the original client filename is never
 * read or reused anywhere in this path.
 */
export async function upload({ buffer, projectId, extension }) {
  const dir = path.join(ROOT_DIR, String(projectId));
  await fs.mkdir(dir, { recursive: true });
  const filename = `${randomUUID()}${extension}`;
  await fs.writeFile(path.join(dir, filename), buffer);
  return { url: `${urlPrefix()}${projectId}/${filename}`, filename };
}

/**
 * Best-effort delete — never throws (logs internally); ENOENT (already
 * gone) is silently ignored, same discipline as authService.js's
 * deleteOwnedAvatarFile.
 */
export async function deleteByUrl(url) {
  if (!isOwnedUrl(url)) return;
  const filePath = safeFilePath(url);
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('[MEDIA_STORAGE] Failed to delete media file:', error.message);
    }
  }
}

const STORAGE_KEY_RE = /^[a-f0-9]{24}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|mp4)$/i;

/**
 * Best-effort delete by the relative "<projectId>/<uuid>.<ext>" key upload() hands back (callers that persist the
 * key use this instead of the URL, so a file is still removable after PUBLIC_MEDIA_BASE_URL / BACKEND_URL changed).
 * The key must match exactly the shape upload() produces — anything else (a path, "..", another project's
 * directory layout) is refused — and when `projectId` is given the key must belong to that project.
 * Never throws; ENOENT is ignored.
 */
export async function deleteByKey(storageKey, { projectId = null } = {}) {
  if (typeof storageKey !== 'string' || !STORAGE_KEY_RE.test(storageKey)) return false;
  const [projectSegment, filename] = storageKey.split('/');
  if (projectId && String(projectId).toLowerCase() !== projectSegment.toLowerCase()) return false;
  try {
    await fs.unlink(path.join(ROOT_DIR, projectSegment, filename));
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('[MEDIA_STORAGE] Failed to delete media file:', error.message);
    return false;
  }
}

const PROJECT_SEGMENT_RE = /^[a-f0-9]{24}$/i;

/**
 * Removes EVERY stored file of one project (storage/social_media/<projectId>/): post media, AI designs, catalog images, logo.
 * Used only when a project is permanently purged. The id must be a 24-hex project id and the resolved path must sit directly
 * under ROOT_DIR, so nothing else can ever be removed through it. Idempotent (a missing folder is success); never throws.
 * @returns {Promise<boolean>} false only when a folder existed and could not be removed
 */
export async function deleteProjectDirectory(projectId) {
  const segment = String(projectId || '');
  if (!PROJECT_SEGMENT_RE.test(segment)) return false;
  const dir = path.resolve(ROOT_DIR, segment);
  if (path.dirname(dir) !== ROOT_DIR) return false;
  try {
    await fs.rm(dir, { recursive: true, force: true });
    return true;
  } catch (error) {
    console.error('[MEDIA_STORAGE] Failed to remove a project media folder:', error.message);
    return false;
  }
}

/** Largest stored file read back for processing (a logo or a product photo): bigger files are refused, never loaded. */
const MAX_READ_BYTES = 12 * 1024 * 1024;

/**
 * Reads a stored file back by the relative "<projectId>/<uuid>.<ext>" key upload() produced - for the AI design step, which
 * needs the REAL logo / product photo bytes. The key must match that exact shape and MUST belong to the given project (another
 * project's file is never readable), and nothing is returned for a missing or oversized file. Never throws; null on any problem.
 */
export async function readByKey(storageKey, { projectId }) {
  if (typeof storageKey !== 'string' || !STORAGE_KEY_RE.test(storageKey) || !projectId) return null;
  const [projectSegment, filename] = storageKey.split('/');
  if (String(projectId).toLowerCase() !== projectSegment.toLowerCase()) return null;
  try {
    const file = path.join(ROOT_DIR, projectSegment, filename);
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_READ_BYTES) return null;
    return await fs.readFile(file);
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('[MEDIA_STORAGE] Failed to read media file:', error.message);
    return null;
  }
}

export default { upload, deleteByUrl, deleteByKey, deleteProjectDirectory, readByKey, isOwnedUrl, isPubliclyReachableUrl, publicMediaOrigin, publishableMediaProblem, storedMediaExists };
