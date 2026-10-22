import fs from 'fs';
import path from 'path';

/**
 * Resolve the Chromium/Chrome executable used for PDF rendering.
 *
 * Order:
 *   1. PDF_CHROME_PATH / PUPPETEER_EXECUTABLE_PATH / CHROME_PATH (explicit; production should set one)
 *   2. Puppeteer's managed browser (`npx puppeteer browsers install chrome`)
 *   3. A standard system install location for the current OS
 * Returns null when nothing is found; the caller turns that into a clear error.
 */
export function candidateSystemPaths(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
    return roots.map((r) => path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'))
      .concat(roots.map((r) => path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe')));
  }
  if (platform === 'darwin') {
    return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'];
  }
  return ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
}

export function resolveChromePath({ env = process.env, exists = fs.existsSync, managedPath = null, platform = process.platform } = {}) {
  for (const key of ['PDF_CHROME_PATH', 'PUPPETEER_EXECUTABLE_PATH', 'CHROME_PATH']) {
    const v = env[key];
    if (v && exists(v)) return v;
    if (v && !exists(v)) return null; // an explicit but wrong path must fail loudly, not fall through silently
  }
  if (managedPath && exists(managedPath)) return managedPath;
  return candidateSystemPaths(platform, env).find((p) => exists(p)) || null;
}

