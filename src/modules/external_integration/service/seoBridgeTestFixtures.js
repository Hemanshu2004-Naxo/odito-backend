import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Test-only helper (deliberately not named *.test.js so the runner doesn't
 * treat it as a suite): builds a throwaway plugin source directory that looks
 * just enough like odito-seo-bridge/ for the packaging/version code.
 */
export function makeFakeBridgeSource({
  version = '9.9.9',
  stableTag = version,
  versionLiteral = null,
  extraFiles = {},
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odito-bridge-src-'));
  const defineLine = versionLiteral
    ? `define( 'ODITO_SEO_BRIDGE_VERSION', '${versionLiteral}' );`
    : "define( 'ODITO_SEO_BRIDGE_VERSION', odito_seo_bridge_read_version() );";
  const files = {
    'odito-seo-bridge.php': `<?php\n/**\n * Plugin Name:       Odito SEO Bridge\n * Version:           ${version}\n */\n${defineLine}\n`,
    'readme.txt': `=== Odito SEO Bridge ===\nStable tag: ${stableTag}\n\n== Changelog ==\n\n= ${version} =\n* test\n`,
    'includes/class-thing.php': '<?php\n// fixture\n',
    ...extraFiles,
  };
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return dir;
}

export function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Runs `fn` with ODITO_SEO_BRIDGE_SOURCE_DIR pointed at `dir`, restoring the previous value after. */
export async function withBridgeSourceDir(dir, fn) {
  const previous = process.env.ODITO_SEO_BRIDGE_SOURCE_DIR;
  process.env.ODITO_SEO_BRIDGE_SOURCE_DIR = dir;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.ODITO_SEO_BRIDGE_SOURCE_DIR;
    else process.env.ODITO_SEO_BRIDGE_SOURCE_DIR = previous;
  }
}
