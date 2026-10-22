import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import mediaStorageService, { upload } from './mediaStorageService.js';

/** deleteByKey — the key-based delete catalog media uses. It must only ever remove a file upload() itself wrote. */
const P1 = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const P2 = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const ROOT = path.resolve(process.cwd(), 'storage', 'social_media');
const exists = (f) => fs.access(f).then(() => true, () => false);

after(async () => {
  await fs.rm(path.join(ROOT, P1), { recursive: true, force: true });
  await fs.rm(path.join(ROOT, P2), { recursive: true, force: true });
});

describe('mediaStorageService.deleteByKey', () => {
  test('1: deletes exactly the file upload() wrote, by its "<project>/<uuid>.<ext>" key', async () => {
    const { filename } = await upload({ buffer: Buffer.from('x'), projectId: P1, extension: '.png' });
    const file = path.join(ROOT, P1, filename);
    assert.equal(await exists(file), true);
    assert.equal(await mediaStorageService.deleteByKey(`${P1}/${filename}`, { projectId: P1 }), true);
    assert.equal(await exists(file), false);
  });

  test('2: a missing file is not an error (false), and it never throws', async () => {
    assert.equal(await mediaStorageService.deleteByKey(`${P1}/${randomUUID()}.png`), false);
  });

  test('3: anything that is not exactly that shape is refused and nothing is deleted', async () => {
    const { filename } = await upload({ buffer: Buffer.from('x'), projectId: P1, extension: '.jpg' });
    const file = path.join(ROOT, P1, filename);
    const bad = [
      `../${P1}/${filename}`, `${P1}/../${P1}/${filename}`, `${P1}/${filename}/..`, `${P1}\\${filename}`, `/${P1}/${filename}`, `${P1}//${filename}`,
      `${P1}/${filename}.exe`, `${P1}/${filename.replace('.jpg', '.svg')}`, `${P1}/${filename.replace('.jpg', '.html')}`, `${P1}/${filename}%00.png`,
      '../../package.json', '../../../etc/passwd', 'package.json', '', `${P1}`, `${P1.slice(1)}/${filename}`, `${P1}/not-a-uuid.png`,
      null, undefined, 42, {}, [`${P1}/${filename}`], { toString: () => `${P1}/${filename}` },
    ];
    for (const key of bad) assert.equal(await mediaStorageService.deleteByKey(key), false, String(key));
    assert.equal(await exists(file), true, 'the file is still there');
    await mediaStorageService.deleteByKey(`${P1}/${filename}`);
  });

  test('4: with a projectId it only deletes that project\'s own files', async () => {
    const { filename } = await upload({ buffer: Buffer.from('x'), projectId: P2, extension: '.webp' });
    const file = path.join(ROOT, P2, filename);
    assert.equal(await mediaStorageService.deleteByKey(`${P2}/${filename}`, { projectId: P1 }), false);
    assert.equal(await exists(file), true, 'another project cannot delete it');
    assert.equal(await mediaStorageService.deleteByKey(`${P2}/${filename}`, { projectId: P2.toUpperCase() }), true);
    assert.equal(await exists(file), false);
  });
});
