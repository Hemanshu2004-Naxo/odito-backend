/**
 * Integration harness: seeds an ISOLATED test database (never the dev/prod one), mints real Odito JWTs, and talks to a running Odito server.
 *
 *   MONGO_URI is read from .env but the database name is forced to INVESTIGATION_IT_DB (default odito_investigation_it).
 *   The harness refuses to run against any other database name.
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

dotenv.config();
// Integration tests start dozens of investigations per user; the production per-user throttle is covered by its own test.
process.env.INVESTIGATION_RATE_LIMIT ??= '100000';

export const TEST_DB = process.env.INVESTIGATION_IT_DB || 'odito_investigation_it';
export const testMongoUri = () => process.env.MONGO_URI.replace(/\/([^/?]+)(\?|$)/, `/${TEST_DB}$2`);

export async function connectTestDb() {
  if (!/investigation_it|_test$/i.test(TEST_DB)) throw new Error(`Refusing to use database "${TEST_DB}": not an isolated test database name.`);
  await mongoose.connect(testMongoUri(), { serverSelectionTimeoutMS: 4000 });
  if (mongoose.connection.name !== TEST_DB) throw new Error('Connected to an unexpected database.');
  return mongoose.connection;
}

export async function seedTenant({ label, siteUrl }) {
  const { default: User } = await import('../../user/model/User.js');
  const { default: SeoProject } = await import('../../app_user/model/SeoProject.js');
  const { signAuthToken } = await import('../../user/service/tokenService.js');
  const stamp = `${label}-${Date.now().toString(36)}`;
  const user = await User.create({
    firstName: 'It', lastName: label, email: `inv-it-${stamp}@example.test`, password: await bcrypt.hash('Password#12345', 4), roleId: 5, isActive: true, isEmailVerified: true,
  });
  const project = await SeoProject.create({ user_id: user._id, project_name: `IT ${stamp}`, main_url: siteUrl, keywords: ['seo'], seo_scope: 'national', description: 'investigation integration test' });
  const token = signAuthToken(user);
  return { user, project, token, userId: String(user._id), projectId: String(project._id) };
}

export function apiClient(base, token) {
  return async (method, path, body) => {
    const res = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await res.json(); } catch { /* non-json */ }
    return { status: res.status, json };
  };
}

export async function poll(api, projectId, id, { timeoutMs = 240_000, everyMs = 1500, onTick } = {}) {
  const t0 = Date.now(); const seen = [];
  for (;;) {
    const r = await api('GET', `/recommendations/investigations/${id}?projectId=${projectId}`);
    if (r.status !== 200) return { error: r, seen };
    const d = r.json.data; if (!seen.length || seen[seen.length - 1] !== `${d.status}:${d.stage}`) seen.push(`${d.status}:${d.stage}`);
    onTick?.(d);
    if (!['queued', 'running'].includes(d.status)) return { data: d, seen };
    if (Date.now() - t0 > timeoutMs) return { timeout: true, data: d, seen };
    await new Promise((r2) => setTimeout(r2, everyMs));
  }
}

export async function cleanupTenant(...tenants) {
  const { default: Task } = await import('../../tasks/model/Task.js');
  const { default: Investigation } = await import('../model/Investigation.js');
  const { default: User } = await import('../../user/model/User.js');
  const { default: SeoProject } = await import('../../app_user/model/SeoProject.js');
  const { default: Recommendation } = await import('../../recommendations/model/Recommendation.js');
  for (const t of tenants.filter(Boolean)) {
    await Promise.all([Investigation.deleteMany({ projectId: t.project._id }), Task.deleteMany({ projectId: t.project._id }), Recommendation.deleteMany({ projectId: t.project._id })]);
    await SeoProject.deleteOne({ _id: t.project._id }); await User.deleteOne({ _id: t.user._id });
  }
}
