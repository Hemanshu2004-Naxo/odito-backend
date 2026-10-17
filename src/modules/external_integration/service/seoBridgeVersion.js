import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Single owner of everything version-related about the Odito SEO Bridge.
 *
 * THE authoritative plugin version is the `Version:` line of the plugin
 * header in odito-seo-bridge/odito-seo-bridge.php — it is what WordPress
 * itself displays and compares when deciding whether an upload is an update.
 * Everything else derives from it or is checked against it:
 *
 *   - ODITO_SEO_BRIDGE_VERSION (PHP) is read from that header at runtime
 *     (get_file_data), so the `bridge_version` the Bridge reports can never
 *     disagree with what WordPress shows.
 *   - readme.txt's `Stable tag` cannot be derived, so the package builder
 *     (seoBridgePackage.js) refuses to ship a package where it differs.
 *   - The downloadable ZIP is built from the source on demand, so it can never
 *     lag behind it.
 *   - `latestBridgeVersion` in the capabilities response is read from it, so
 *     the UI's "update available" prompt compares against what the Download
 *     button will actually deliver.
 *
 * Deliberately NOT here: the global compatibility floor
 * (MIN_SUPPORTED_BRIDGE_VERSION in wordPressSeoDataService.js). That answers
 * "can this backend still talk to this Bridge at all" (a 1.0.0 Bridge still
 * serves title/meta/canonical perfectly), which is a different question from
 * the per-capability minimums below.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const SEO_BRIDGE_SLUG = 'odito-seo-bridge';
export const SEO_BRIDGE_MAIN_FILE = `${SEO_BRIDGE_SLUG}.php`;

/**
 * The first Bridge version that can perform each capability. Every key matches
 * a flag the Bridge itself reports in /status `supports` (or, for `robots`, a
 * field in /capabilities) — the FLAG is what actually gates a feature at
 * runtime; this map only supplies the human-readable "requires Bridge X or
 * newer" text, and the /wordpress/capabilities response hands it to the
 * frontend so no version number is hardcoded there.
 *
 * seoBridgeVersion.test.js proves every entry is (a) not newer than the
 * current source version and (b) introduced under that exact version in the
 * plugin's own changelog, so this map cannot drift from the plugin.
 */
export const BRIDGE_CAPABILITY_MIN_VERSIONS = Object.freeze({
  robots: '1.1.0',
  site_schema: '1.1.0',
  faq_schema: '1.2.0',
  rating_schema: '1.3.0',
  organization_type: '1.4.0',
  media_alt: '1.5.0',
  conditional_writes: '1.5.0',
  organization_address: '1.6.0',
});

// odito_backend/src/modules/external_integration/service/ -> repo root is 5 levels up.
const DEFAULT_SOURCE_DIR = path.resolve(__dirname, '../../../../../', SEO_BRIDGE_SLUG);

/** Where the plugin's canonical source lives; overridable for tests / unusual deployments. */
export function getSeoBridgeSourceDir() {
  return process.env.ODITO_SEO_BRIDGE_SOURCE_DIR
    ? path.resolve(process.env.ODITO_SEO_BRIDGE_SOURCE_DIR)
    : DEFAULT_SOURCE_DIR;
}

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Strict "x.y.z[-prerelease]" check — what a plugin header Version must look like. */
export function isValidBridgeVersion(value) {
  return typeof value === 'string' && VERSION_RE.test(value);
}

/**
 * Reads the `Version:` value out of a WordPress plugin header, the same way
 * WordPress does (only the first 8 KB is scanned, comment-decoration
 * characters before the field name are ignored).
 * @returns {string|null} null when the header has no valid version.
 */
export function parsePluginHeaderVersion(phpSource) {
  if (typeof phpSource !== 'string') return null;
  const header = phpSource.slice(0, 8192);
  const match = header.match(/^[ \t/*#@]*Version:[ \t]*(.+?)[ \t]*$/im);
  if (!match) return null;
  const version = match[1].replace(/\s*\*\/.*$/, '').trim();
  return isValidBridgeVersion(version) ? version : null;
}

/** `Stable tag:` from a WordPress readme.txt, or null. */
export function parseReadmeStableTag(readmeSource) {
  if (typeof readmeSource !== 'string') return null;
  const match = readmeSource.match(/^Stable tag:[ \t]*(.+?)[ \t]*$/im);
  return match ? match[1].trim() : null;
}

function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().replace(/^v/i, '');
  const [main, ...rest] = cleaned.split('-');
  const prerelease = rest.length ? rest.join('-') : null;
  const parts = main.split('.');
  if (parts.length === 0 || parts.length > 4) return null;
  const numbers = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    numbers.push(parseInt(part, 10));
  }
  while (numbers.length < 3) numbers.push(0);
  return { numbers, prerelease };
}

function comparePrerelease(a, b) {
  const left = a.split('.');
  const right = b.split('.');
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    if (left[i] === undefined) return -1;
    if (right[i] === undefined) return 1;
    const leftNumeric = /^\d+$/.test(left[i]);
    const rightNumeric = /^\d+$/.test(right[i]);
    if (leftNumeric && rightNumeric) {
      const diff = parseInt(left[i], 10) - parseInt(right[i], 10);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    } else if (left[i] !== right[i]) {
      return left[i] < right[i] ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Semantic-version comparison — component-wise NUMERIC, never string order
 * (so 1.10.0 > 1.2.0), and a prerelease sorts below its release.
 * @returns {-1|0|1|null} null when either side is not a parseable version.
 */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  const length = Math.max(left.numbers.length, right.numbers.length);
  for (let i = 0; i < length; i += 1) {
    const x = left.numbers[i] || 0;
    const y = right.numbers[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return comparePrerelease(left.prerelease, right.prerelease);
}

/**
 * Whether `version` satisfies a minimum. An unknown or unparseable `version`
 * returns `unknownIs` — the compatibility-floor gate passes true ("can't tell,
 * never block"), while the per-capability messaging passes false.
 */
export function isVersionAtLeast(version, min, { unknownIs = true } = {}) {
  if (!version) return unknownIs;
  const result = compareVersions(version, min);
  if (result === null) return unknownIs;
  return result >= 0;
}

/**
 * Version of the source the Download button ships, read from the plugin
 * header — or null when the source isn't present on this machine (a backend
 * deployed without the sibling odito-seo-bridge/ directory).
 */
export function getLatestBridgeVersion() {
  try {
    const mainFile = path.join(getSeoBridgeSourceDir(), SEO_BRIDGE_MAIN_FILE);
    return parsePluginHeaderVersion(fs.readFileSync(mainFile, 'utf8'));
  } catch {
    return null;
  }
}

export default {
  SEO_BRIDGE_SLUG,
  SEO_BRIDGE_MAIN_FILE,
  BRIDGE_CAPABILITY_MIN_VERSIONS,
  getSeoBridgeSourceDir,
  isValidBridgeVersion,
  parsePluginHeaderVersion,
  parseReadmeStableTag,
  compareVersions,
  isVersionAtLeast,
  getLatestBridgeVersion,
};
