import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FONT_DIR = path.resolve(here, '..', '..', '..', '..', 'assets', 'fonts');

// Bundled files (no network at render time). Inter is a variable font covering every weight.
const FACES = [
  { family: 'Inter', file: 'Inter.var.ttf', weight: '100 900' },
  { family: 'DM Sans', file: path.join('DM_Sans', 'DMSans-Regular.ttf'), weight: '300 400' },
  { family: 'DM Sans', file: path.join('DM_Sans', 'DMSans-Medium.ttf'), weight: '500' },
  { family: 'DM Sans', file: path.join('DM_Sans', 'DMSans-SemiBold.ttf'), weight: '600' },
  { family: 'DM Sans', file: path.join('DM_Sans', 'DMSans-Bold.ttf'), weight: '700 900' },
];

let cached = null;

/** @font-face CSS with the font files inlined as data URIs (read once, cached). */
export function getFontCss() {
  if (cached) return cached;
  cached = FACES.map((f) => {
    const buf = fs.readFileSync(path.join(FONT_DIR, f.file));
    return `@font-face{font-family:'${f.family}';font-weight:${f.weight};font-style:normal;font-display:block;src:url(data:font/ttf;base64,${buf.toString('base64')}) format('truetype');}`;
  }).join('\n');
  return cached;
}

export const FONT_FACE_CHECKS = ['400 16px "DM Sans"', '500 16px "DM Sans"', '600 16px "DM Sans"', '700 16px "DM Sans"', '400 16px Inter', '700 16px Inter', '800 16px Inter'];
