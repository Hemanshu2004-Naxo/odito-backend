import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import archiver from 'archiver';
import {
  SEO_BRIDGE_SLUG,
  SEO_BRIDGE_MAIN_FILE,
  getLatestBridgeVersion,
  getSeoBridgeSourceDir,
  parsePluginHeaderVersion,
  parseReadmeStableTag,
} from './seoBridgeVersion.js';

/**
 * Builds the installable Odito SEO Bridge ZIP straight from the plugin's
 * canonical source (odito-seo-bridge/ at the repo root).
 *
 * WHY THIS EXISTS: the download endpoint used to serve a static
 * storage/plugin/odito-seo-bridge.zip that only changed when someone
 * remembered to run the packaging script — so the source could move on to
 * 1.3.0 while every download stayed 1.1.0. Building on demand makes that
 * structurally impossible: there is no cached artifact between the source and
 * the download.
 *
 * INVARIANTS enforced here (a violation throws — a broken package is never
 * produced, let alone served):
 *   - one root folder named after the plugin slug, holding the main file
 *     (`odito-seo-bridge/odito-seo-bridge.php`) — what WordPress's installer
 *     needs to treat an upload as an update of the same plugin;
 *   - forward-slash entry names only (the ZIP spec's form; PHP's ZipArchive
 *     on Linux hosts does not treat a backslash as a directory separator);
 *   - no development/credential/temporary files, whatever they're called;
 *   - the plugin header Version, readme.txt Stable tag and any literal
 *     ODITO_SEO_BRIDGE_VERSION define all agree.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// odito_backend/storage/plugin/odito-seo-bridge.zip — fallback artifact + CLI output.
export const SEO_BRIDGE_ARTIFACT_PATH = path.resolve(__dirname, '../../../../storage/plugin', `${SEO_BRIDGE_SLUG}.zip`);

// Anything matching is left out of the package, wherever it sits in the tree.
const EXCLUDED_PATTERNS = [
  /(^|\/)\.[^/]+/,                                   // dotfiles/dirs: .env, .git, .DS_Store, .gitignore …
  /(^|\/)(node_modules|tests?|__tests__)(\/|$)/i,
  /(^|\/)(package(-lock)?\.json|composer\.(json|lock)|phpunit\.xml(\.dist)?|Makefile)$/i,
  /\.(zip|log|bak|orig|rej|swp|tmp|env|pem|key)$/i,
  /~$/,
];

export function isExcludedFromPackage(relativePath) {
  return EXCLUDED_PATTERNS.some((pattern) => pattern.test(relativePath));
}

function walkFiles(dir, base = '') {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = base ? `${base}/${entry.name}` : entry.name;
    if (isExcludedFromPackage(relative)) continue;
    if (entry.isDirectory()) {
      found.push(...walkFiles(path.join(dir, entry.name), relative));
    } else if (entry.isFile()) {
      found.push(relative);
    }
  }
  return found.sort();
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Throws unless every version statement in the plugin source agrees. Returns
 * the version. Exported separately so the CLI and tests can use it on its own.
 */
export function assertSeoBridgeVersionConsistency(sourceDir = getSeoBridgeSourceDir()) {
  const mainFile = path.join(sourceDir, SEO_BRIDGE_MAIN_FILE);
  if (!fs.existsSync(mainFile)) {
    throw new Error(
      `Expected the plugin's main file at ${mainFile} — this doesn't look like the ${SEO_BRIDGE_SLUG} plugin. ` +
      'Refusing to package a possibly-wrong directory.'
    );
  }
  const mainSource = fs.readFileSync(mainFile, 'utf8');
  const headerVersion = parsePluginHeaderVersion(mainSource);
  if (!headerVersion) {
    throw new Error(`${SEO_BRIDGE_MAIN_FILE} has no valid "Version: x.y.z" plugin header.`);
  }

  const readmePath = path.join(sourceDir, 'readme.txt');
  const stableTag = fs.existsSync(readmePath) ? parseReadmeStableTag(fs.readFileSync(readmePath, 'utf8')) : null;
  if (stableTag !== headerVersion) {
    throw new Error(
      `readme.txt "Stable tag" (${stableTag ?? 'missing'}) does not match the plugin header Version (${headerVersion}).`
    );
  }

  // The constant is derived from the header at runtime; a hardcoded literal is
  // only tolerated if it happens to agree (it would otherwise be a second,
  // silently divergent version).
  const literal = mainSource.match(/define\(\s*['"]ODITO_SEO_BRIDGE_VERSION['"]\s*,\s*['"]([^'"]+)['"]\s*\)/);
  if (literal && literal[1] !== headerVersion) {
    throw new Error(
      `ODITO_SEO_BRIDGE_VERSION is hardcoded as ${literal[1]} but the plugin header says ${headerVersion}. ` +
      'Derive the constant from the header instead of duplicating it.'
    );
  }
  return headerVersion;
}

/**
 * @typedef {Object} SeoBridgePackage
 * @property {Buffer} buffer the ZIP bytes
 * @property {string} version plugin header version inside the package
 * @property {string} fileName suggested download name, e.g. odito-seo-bridge-1.3.0.zip
 * @property {string} contentSha256 hash over every packaged path + content (stable across rebuilds of identical source)
 * @property {{path: string, size: number, sha256: string}[]} files
 * @property {string} sourceDir
 */

/** @returns {Promise<SeoBridgePackage>} */
export async function buildSeoBridgePackage({ sourceDir = getSeoBridgeSourceDir() } = {}) {
  const version = assertSeoBridgeVersionConsistency(sourceDir);
  const relativePaths = walkFiles(sourceDir);

  const files = relativePaths.map((relative) => {
    const content = fs.readFileSync(path.join(sourceDir, relative));
    return { path: relative, content, size: content.length, sha256: sha256(content) };
  });

  const newest = relativePaths.reduce(
    (latest, relative) => Math.max(latest, fs.statSync(path.join(sourceDir, relative)).mtimeMs),
    0
  );
  const zipDate = new Date(newest || Date.now());

  const buffer = await new Promise((resolve, reject) => {
    const chunks = [];
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('data', (chunk) => chunks.push(chunk));
    archive.on('warning', (err) => { if (err.code !== 'ENOENT') reject(err); });
    archive.on('error', reject);
    archive.on('end', () => resolve(Buffer.concat(chunks)));

    const directories = new Set();
    for (const { path: relative } of files) {
      const segments = relative.split('/').slice(0, -1);
      for (let i = 1; i <= segments.length; i += 1) directories.add(segments.slice(0, i).join('/'));
    }
    archive.append(Buffer.alloc(0), { name: `${SEO_BRIDGE_SLUG}/`, date: zipDate });
    for (const directory of [...directories].sort()) {
      archive.append(Buffer.alloc(0), { name: `${SEO_BRIDGE_SLUG}/${directory}/`, date: zipDate });
    }
    // Every entry is nested under the ONE root folder — the slug — so the
    // main file always lands at <slug>/<slug>.php, never <slug>/<slug>/<slug>.php.
    for (const file of files) {
      archive.append(file.content, { name: `${SEO_BRIDGE_SLUG}/${file.path}`, date: zipDate });
    }
    archive.finalize();
  });

  const contentSha256 = crypto
    .createHash('sha256')
    .update(files.map((f) => `${f.path}\n${f.sha256}`).join('\n'))
    .digest('hex');

  return {
    buffer,
    version,
    fileName: `${SEO_BRIDGE_SLUG}-${version}.zip`,
    contentSha256,
    files: files.map(({ path: p, size, sha256: hash }) => ({ path: p, size, sha256: hash })),
    sourceDir,
  };
}

/**
 * Minimal reader for ZIPs (central directory + raw-deflate/stored entries),
 * used to verify a package by looking INSIDE it rather than trusting how it
 * was built. Not a general-purpose unzip: no ZIP64, no encryption.
 * @returns {{name: string, isDirectory: boolean, content: Buffer}[]}
 */
export function readZipEntries(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i >= buffer.length - 22 - 65535; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('Not a valid ZIP: end-of-central-directory record not found.');

  const total = buffer.readUInt16LE(eocd + 10);
  let pointer = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < total; n += 1) {
    if (buffer.readUInt32LE(pointer) !== 0x02014b50) throw new Error('Corrupt ZIP central directory.');
    const method = buffer.readUInt16LE(pointer + 10);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.toString('utf8', pointer + 46, pointer + 46 + nameLength);

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    let content;
    if (method === 0) content = Buffer.from(raw);
    else if (method === 8) content = zlib.inflateRawSync(raw);
    else throw new Error(`Unsupported ZIP compression method ${method} for ${name}.`);

    entries.push({ name, isDirectory: name.endsWith('/'), content });
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Describes a built or prebuilt ZIP by inspecting its contents: the plugin
 * header version and Stable tag it carries, its root folders, and whether any
 * entry name contains a backslash.
 */
export function inspectSeoBridgePackage(zipBuffer) {
  const entries = readZipEntries(zipBuffer);
  const names = entries.map((entry) => entry.name);
  const mainEntry = entries.find((entry) => entry.name === `${SEO_BRIDGE_SLUG}/${SEO_BRIDGE_MAIN_FILE}`);
  const readmeEntry = entries.find((entry) => entry.name === `${SEO_BRIDGE_SLUG}/readme.txt`);
  return {
    entries,
    names,
    rootFolders: [...new Set(names.map((name) => name.split('/')[0]))],
    hasBackslash: names.some((name) => name.includes('\\')),
    hasMainFileAtExpectedPath: Boolean(mainEntry),
    version: mainEntry ? parsePluginHeaderVersion(mainEntry.content.toString('utf8')) : null,
    stableTag: readmeEntry ? parseReadmeStableTag(readmeEntry.content.toString('utf8')) : null,
  };
}

/**
 * Chooses what the download endpoint serves.
 *   - `fresh`: the plugin source is present on this machine → build from it now.
 *   - `prebuilt`: it isn't (a backend deployed without the sibling
 *     odito-seo-bridge/ directory) → serve the artifact, whose version is read
 *     from inside the ZIP itself, never assumed.
 *   - `null`: neither exists.
 */
export async function resolveSeoBridgeDownload() {
  const sourceMain = path.join(getSeoBridgeSourceDir(), SEO_BRIDGE_MAIN_FILE);
  if (fs.existsSync(sourceMain)) {
    const pkg = await buildSeoBridgePackage();
    return { kind: 'fresh', buffer: pkg.buffer, version: pkg.version, fileName: pkg.fileName, contentSha256: pkg.contentSha256 };
  }

  if (fs.existsSync(SEO_BRIDGE_ARTIFACT_PATH)) {
    const buffer = fs.readFileSync(SEO_BRIDGE_ARTIFACT_PATH);
    const { version } = inspectSeoBridgePackage(buffer);
    if (!version) return null;
    return { kind: 'prebuilt', buffer, version, fileName: `${SEO_BRIDGE_SLUG}-${version}.zip`, contentSha256: sha256(buffer) };
  }
  return null;
}

/**
 * The version resolveSeoBridgeDownload() will deliver, without building a ZIP:
 * the source header when the source is present, else the version found inside
 * the fallback artifact. This is what "an update is available" is measured
 * against, so the update prompt can never disagree with what the Download
 * button actually serves.
 * @returns {string|null}
 */
export function getDownloadableBridgeVersion() {
  const fromSource = getLatestBridgeVersion();
  if (fromSource) return fromSource;
  try {
    if (fs.existsSync(SEO_BRIDGE_ARTIFACT_PATH)) {
      return inspectSeoBridgePackage(fs.readFileSync(SEO_BRIDGE_ARTIFACT_PATH)).version || null;
    }
  } catch {
    // An unreadable artifact means no download is offered either — see resolveSeoBridgeDownload.
  }
  return null;
}

/** Writes a freshly built package to the fallback artifact path (used by the CLI). */
export async function writeSeoBridgeArtifact() {
  const pkg = await buildSeoBridgePackage();
  fs.mkdirSync(path.dirname(SEO_BRIDGE_ARTIFACT_PATH), { recursive: true });
  fs.writeFileSync(SEO_BRIDGE_ARTIFACT_PATH, pkg.buffer);
  return { ...pkg, artifactPath: SEO_BRIDGE_ARTIFACT_PATH };
}

/**
 * Compares the on-disk artifact with what the current source would build.
 * @returns {{ok: boolean, reason?: string, sourceVersion: string, artifactVersion: string|null}}
 */
export async function checkSeoBridgeArtifactFresh() {
  const pkg = await buildSeoBridgePackage();
  if (!fs.existsSync(SEO_BRIDGE_ARTIFACT_PATH)) {
    return { ok: false, reason: 'artifact is missing', sourceVersion: pkg.version, artifactVersion: null };
  }
  const inspected = inspectSeoBridgePackage(fs.readFileSync(SEO_BRIDGE_ARTIFACT_PATH));
  const artifactFiles = new Map(
    inspected.entries.filter((e) => !e.isDirectory).map((e) => [e.name, sha256(e.content)])
  );
  for (const file of pkg.files) {
    const packaged = artifactFiles.get(`${SEO_BRIDGE_SLUG}/${file.path}`);
    if (packaged !== file.sha256) {
      return {
        ok: false,
        reason: packaged === undefined ? `artifact is missing ${file.path}` : `artifact's ${file.path} differs from the source`,
        sourceVersion: pkg.version,
        artifactVersion: inspected.version,
      };
    }
  }
  if (artifactFiles.size !== pkg.files.length) {
    return { ok: false, reason: 'artifact contains files the source no longer has', sourceVersion: pkg.version, artifactVersion: inspected.version };
  }
  return { ok: true, sourceVersion: pkg.version, artifactVersion: inspected.version };
}

export default {
  SEO_BRIDGE_ARTIFACT_PATH,
  isExcludedFromPackage,
  assertSeoBridgeVersionConsistency,
  buildSeoBridgePackage,
  readZipEntries,
  inspectSeoBridgePackage,
  resolveSeoBridgeDownload,
  writeSeoBridgeArtifact,
  checkSeoBridgeArtifactFresh,
};
