import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Which code this process runs, for /healthz: the commit and when it was built. Read ONCE at startup.
 *
 *   1. BUILD_COMMIT / BUILD_TIME env vars (set by a deploy script or CI: the most reliable source)
 *   2. else the git checkout the server runs from: `git rev-parse HEAD` and that commit's time
 *   3. else null (never guessed)
 *
 * Plus `startedAt` (when this process started) and `dirty` (uncommitted changes in the checkout, from git only).
 * Nothing else: no branch names of other people, no paths, no remotes.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMMIT_RE = /^[0-9a-f]{7,40}$/i;

const git = (args, run) => {
  try { return String(run('git', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 })).trim(); } catch { return null; }
};

export function readBuildInfo({ env = process.env, run = execFileSync, now = new Date() } = {}) {
  const envCommit = String(env.BUILD_COMMIT || '').trim();
  const envTime = String(env.BUILD_TIME || '').trim();
  let commit = COMMIT_RE.test(envCommit) ? envCommit.toLowerCase() : null;
  let builtAt = envTime && !Number.isNaN(Date.parse(envTime)) ? new Date(envTime).toISOString() : null;
  let source = commit ? 'env' : null;
  let dirty = null;
  if (!commit) {
    const head = git(['rev-parse', 'HEAD'], run);
    if (head && COMMIT_RE.test(head)) {
      commit = head.toLowerCase(); source = 'git';
      const time = git(['log', '-1', '--format=%cI', 'HEAD'], run);
      if (!builtAt && time && !Number.isNaN(Date.parse(time))) builtAt = new Date(time).toISOString();
      const status = git(['status', '--porcelain', '--untracked-files=no'], run);
      dirty = status === null ? null : status.length > 0;
    }
  }
  return { commit, shortCommit: commit ? commit.slice(0, 7) : null, builtAt, source, dirty, startedAt: new Date(now.getTime() - process.uptime() * 1000).toISOString() };
}

let cached = null;
export const buildInfo = () => { if (!cached) cached = readBuildInfo(); return cached; };
export const resetBuildInfo = () => { cached = null; }; // tests
