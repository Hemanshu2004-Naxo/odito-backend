/**
 * Test-only: real stored media files on a PUBLIC https media origin. Importing this module sets PUBLIC_MEDIA_BASE_URL for the
 * test process (each test file runs in its own process), so the URLs it hands out satisfy the same rule production applies
 * before media can be scheduled for Meta: owned by Odito, on the public https media origin, a real file under
 * storage/social_media/<project>/<uuid>.jpg.
 */
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

export const TEST_MEDIA_ORIGIN = 'https://media.odito-test.example';
process.env.PUBLIC_MEDIA_BASE_URL = TEST_MEDIA_ORIGIN;

const dirFor = (projectId) => path.resolve(process.cwd(), 'storage', 'social_media', String(projectId));

/** Writes a small file and returns its public URL (a fresh uuid each call, like a real upload). */
export function storedTestMediaUrl(projectId) {
  const filename = `${randomUUID()}.jpg`;
  fs.mkdirSync(dirFor(projectId), { recursive: true });
  fs.writeFileSync(path.join(dirFor(projectId), filename), 'test-media');
  return `${TEST_MEDIA_ORIGIN}/storage/social_media/${projectId}/${filename}`;
}

export function removeStoredTestMedia(projectId) {
  fs.rmSync(dirFor(projectId), { recursive: true, force: true });
}
