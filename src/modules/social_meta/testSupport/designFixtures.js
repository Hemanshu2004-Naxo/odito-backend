/**
 * Test-only fixtures for AI design generation: REAL image bytes made with sharp (so the real media pipeline
 * runs on real pixels), a scripted image provider, and an OpenAI Images API response builder. Nothing here is
 * used at runtime.
 */
import sharp from 'sharp';
import { promises as fs } from 'fs';
import path from 'path';

const rand = (n) => Math.floor(Math.random() * n);

/**
 * A real image of the given size/format (so two generations never share bytes). By default it is PHOTOGRAPH-LIKE - a random gradient with a few
 * shapes - because the pipeline now refuses a blank picture; pass `background` for a deliberately flat one (a logo, a blank-image test).
 */
export async function makeImage({ width = 1024, height = 1024, format = 'png', background } = {}) {
  const color = background || { r: rand(200) + 30, g: rand(200) + 30, b: rand(200) + 30 };
  let pipeline = sharp({ create: { width, height, channels: 3, background: color } });
  if (!background) {
    const hue = () => `rgb(${rand(256)},${rand(256)},${rand(256)})`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${hue()}"/><stop offset="1" stop-color="${hue()}"/></linearGradient></defs><rect width="${width}" height="${height}" fill="url(#g)"/><circle cx="${width * 0.7}" cy="${height * 0.35}" r="${Math.min(width, height) * 0.22}" fill="${hue()}" opacity="0.8"/><rect x="${width * 0.1}" y="${height * 0.6}" width="${width * 0.5}" height="${height * 0.25}" fill="${hue()}" opacity="0.7"/></svg>`;
    pipeline = sharp({ create: { width, height, channels: 3, background: color } }).composite([{ input: Buffer.from(svg), left: 0, top: 0 }]);
  }
  if (format === 'jpeg') pipeline = pipeline.withMetadata({ exif: { IFD0: { Copyright: 'SECRET-EXIF-MARKER' } } }).jpeg();
  else if (format === 'webp') pipeline = pipeline.webp();
  else pipeline = pipeline.png();
  return pipeline.toBuffer();
}

const parseSize = (size) => { const [w, h] = String(size).split('x').map(Number); return { width: w || 1024, height: h || 1024 }; };

/** Scripted image provider with the same contract as OpenAIImageProvider (isAvailable / generateImage). */
export function mockImageProvider({ behavior = null, available = true, gate = null, model = 'mock-image-model' } = {}) {
  const calls = [];
  return {
    calls,
    isAvailable: () => available,
    async generateImage({ prompt, size, generationId, referenceImages }) {
      calls.push({ prompt, size, generationId, referenceImages });
      if (gate) await gate;
      const buffer = behavior ? await behavior({ prompt, size, callNumber: calls.length }) : await makeImage({ ...parseSize(size), format: 'png' });
      return { buffer, usage: { inputTokens: 30, outputTokens: 1_000 }, model, durationMs: 5, attempts: 1 };
    },
  };
}

/** An OpenAI Images API response body carrying `buffer` as base64. */
export const imagesResponseBody = (buffer, { usage = { input_tokens: 60, output_tokens: 1056, total_tokens: 1116 } } = {}) => ({
  created: 1_760_000_000, data: [{ b64_json: buffer.toString('base64') }], output_format: 'jpeg', quality: 'medium', size: '1024x1024', usage,
});

/** Removes the files a test stored for a project (storage/social_media/<projectId>). */
export async function removeProjectMedia(projectId) {
  await fs.rm(path.resolve(process.cwd(), 'storage', 'social_media', String(projectId)), { recursive: true, force: true });
}

/** Files currently stored for a project. */
export async function listProjectMedia(projectId) {
  try { return await fs.readdir(path.resolve(process.cwd(), 'storage', 'social_media', String(projectId))); } catch { return []; }
}
