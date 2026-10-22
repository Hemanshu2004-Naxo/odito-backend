import {
  writeSeoBridgeArtifact,
  checkSeoBridgeArtifactFresh,
  inspectSeoBridgePackage,
} from '../service/seoBridgePackage.js';

/**
 * Packages the Odito SEO Bridge (canonical source: odito-seo-bridge/ at the
 * repo root) into storage/plugin/odito-seo-bridge.zip.
 *
 * NOTE: the download endpoint no longer depends on this file when the plugin
 * source is present — it builds the ZIP from source on every request (see
 * seoBridgePackage.js), so it cannot serve a stale package. This artifact is
 * only the fallback for a backend deployed WITHOUT the sibling
 * odito-seo-bridge/ directory, and the file you hand to someone by hand.
 *
 * Usage (cwd = odito_backend/):
 *   npm run package:seo-bridge-plugin           build + write the artifact
 *   npm run package:seo-bridge-plugin -- --check  exit 1 if the artifact is stale
 *
 * The build refuses to run when the plugin header Version, readme.txt Stable
 * tag and any literal ODITO_SEO_BRIDGE_VERSION define disagree.
 */

async function main() {
  if (process.argv.includes('--check')) {
    const result = await checkSeoBridgeArtifactFresh();
    if (result.ok) {
      console.log(`Artifact is current (version ${result.artifactVersion}).`);
      return;
    }
    console.error(
      `Artifact is STALE: ${result.reason} (source ${result.sourceVersion}, artifact ${result.artifactVersion ?? 'n/a'}). ` +
      'Run: npm run package:seo-bridge-plugin'
    );
    process.exitCode = 1;
    return;
  }

  const result = await writeSeoBridgeArtifact();
  const inspected = inspectSeoBridgePackage(result.buffer);
  console.log(`Packaged ${result.sourceDir} -> ${result.artifactPath}`);
  console.log(`  version:      ${inspected.version}`);
  console.log(`  root folder:  ${inspected.rootFolders.join(', ')}`);
  console.log(`  files:        ${result.files.length}`);
  console.log(`  content hash: ${result.contentSha256}`);
}

main().catch((error) => {
  console.error('Failed to package the Odito SEO Bridge plugin:', error.message);
  process.exitCode = 1;
});
