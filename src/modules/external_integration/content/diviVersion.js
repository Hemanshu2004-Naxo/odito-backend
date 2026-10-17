/**
 * diviVersion — which Divi is installed, read from the theme's own public style.css header (the WordPress theme header block).
 *
 * The version matters because the alt-text capability is only offered for Divi versions it has been checked against
 * (diviImageAlt.TESTED_DIVI_VERSIONS). The file is fetched through renderedHtml.fetchRenderedHtml: same host as the connected site only,
 * no cross-site redirects, size capped. Remembered for 30 minutes per site; any failure means "not verified", never "assume supported".
 */

import { fetchRenderedHtml } from './renderedHtml.js';
import { TESTED_DIVI_VERSIONS } from './diviImageAlt.js';

const TTL_MS = 30 * 60 * 1000;
const cache = new Map(); // site origin -> { at, result }

/** Pure: the theme header block of a style.css. */
export function parseThemeHeader(css) {
  const head = String(css || '').slice(0, 4096);
  const field = (name) => (new RegExp(String.raw`^[\s*]*${name}:[ \t]*(.+?)[ \t]*$`, 'im').exec(head) || [])[1] || null;
  return { themeName: field('Theme Name'), version: field('Version') };
}

/** @returns {Promise<{installed: boolean, version: string|null, tested: boolean, testedVersions: string[]}>} */
export async function detectDiviVersion(siteUrl, { fetchText = fetchRenderedHtml, now = Date.now } = {}) {
  let origin;
  try { origin = new URL(siteUrl).origin; } catch { return { installed: false, version: null, tested: false, testedVersions: [...TESTED_DIVI_VERSIONS] }; }
  const hit = cache.get(origin);
  if (hit && now() - hit.at < TTL_MS) return hit.result;
  let result = { installed: false, version: null, tested: false, testedVersions: [...TESTED_DIVI_VERSIONS] };
  try {
    const { html } = await fetchText(`${origin}/wp-content/themes/Divi/style.css`, { siteUrl: origin });
    const { themeName, version } = parseThemeHeader(html);
    const installed = (themeName || '').toLowerCase() === 'divi';
    result = { installed, version: installed ? version : null, tested: installed && TESTED_DIVI_VERSIONS.includes(version), testedVersions: [...TESTED_DIVI_VERSIONS] };
  } catch { /* not readable: reported as not verified below */ }
  cache.set(origin, { at: now(), result });
  return result;
}

export const clearDiviVersionCache = () => cache.clear();

export default { parseThemeHeader, detectDiviVersion, clearDiviVersionCache };
