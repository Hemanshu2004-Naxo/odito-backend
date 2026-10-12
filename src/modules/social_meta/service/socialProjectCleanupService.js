import mongoose from 'mongoose';
import SeoProject from '../../app_user/model/SeoProject.js';
import SocialProjectCleanup, { EXTERNAL_REVOCATION, cleanupExpiry } from '../model/SocialProjectCleanup.js';
import mediaStorageService from './media/mediaStorageService.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * socialProjectCleanupService - removes everything the Social Media modules hold for ONE project when it is permanently
 * purged (called from projectCascadeDeleteService, the single deletion code path) and for projects that no longer exist
 * (purgeOrphanedSocialData, which cleans up what older purges left behind).
 *
 * Order matters, because a publish can be racing the deletion:
 *   1. CREDENTIALS FIRST. Every SocialAccount of the project is switched to `revoked` and its stored token is $unset in one
 *      write, so from this moment no dispatch can obtain a usable token - even if a later step fails.
 *   2. Publications (this is what stops scheduled posts), imports, approval settings, pending Meta connections, synced posts.
 *   3. The account documents themselves.
 *   4. The project's stored media folder.
 *   The non-sensitive SocialProjectCleanup record (what the owner still has to do at the provider) is written first of
 *   all, before the credentials are touched, so it survives a partial purge.
 *
 * Idempotent: every step is a project-scoped deleteMany / updateMany, so running it again after a crash or a partial failure
 * simply finishes the job. Never throws for one step: failures are returned, and the CRITICAL ones (credentials, publications,
 * accounts) tell the caller NOT to delete the SeoProject yet, so the daily purge retries the project instead of orphaning
 * live credentials. Nothing here ever logs or returns a token.
 *
 * External revocation: Meta can only revoke a grant with the connecting user's token, which Odito discards after Page
 * selection (PendingMetaConnection holds it only until a Page is chosen). With only Page tokens left there is no supported
 * call, so the record says so and tells the owner where to remove Odito. Google connections are NOT revoked here: a Google
 * grant may be shared with the owner's other projects, and revoking it would break them.
 */

const SERVICE = 'SocialProjectCleanup';
const toId = (id) => (mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : id);
const getDb = () => mongoose.connection.db;

/** The simple project-scoped collections (everything except the credential and publication steps, which have their own handling). */
export const SOCIAL_SIMPLE_COLLECTIONS = Object.freeze([
  { collection: 'socialapprovalsettings', field: 'project_id' },
  { collection: 'socialimportrows', field: 'project_id' },
  { collection: 'socialimportbatches', field: 'project_id' },
  { collection: 'pendingmetaconnections', field: 'project_id' },
  { collection: 'socialposts', field: 'project_id' },
]);

/** Every collection that can hold social rows of a project (used to find orphans). */
const ORPHAN_SCAN = Object.freeze([
  { collection: 'socialaccounts', field: 'project_id' },
  { collection: 'socialpublications', field: 'project_id' },
  ...SOCIAL_SIMPLE_COLLECTIONS,
]);

export const ACTION_REQUIRED_META = 'Odito deleted its copy of the connection, but Meta can only revoke access from your side. In Facebook go to Settings > Business Integrations (and in Instagram, Settings > Apps and Websites) and remove Odito.';

/**
 * @param {string} projectId
 * @param {{ now?: Date }} [options]
 * @returns {Promise<{ projectId: string, counts: object, failures: object[], criticalFailures: object[], retryable: boolean }>}
 */
export async function purgeProjectSocialData(projectId, { now = new Date() } = {}) {
  const pid = toId(projectId);
  const db = getDb();
  const counts = { accounts: 0, publications: 0, scheduledPublications: 0, collections: {} };
  const failures = [];
  const critical = [];
  let accountRefs = [];
  let ownerId = null;

  const attempt = async (name, isCritical, fn) => {
    try {
      await fn();
    } catch (error) {
      const failure = { step: name, error: error.message };
      failures.push(failure);
      if (isCritical) critical.push(failure);
      LoggerUtil.error(`${SERVICE}: step failed`, { step: name, message: error.message }, { projectId: String(projectId) });
    }
  };

  // 1a. What is being removed, recorded BEFORE anything is changed: the account documents are the only other place these ids
  // live and they are deleted at the end (or earlier, if a later step has to be retried), so the trace is written first.
  // $setOnInsert: a re-run never overwrites it.
  await attempt('inventory', true, async () => {
    const accounts = await db.collection('socialaccounts')
      .find({ project_id: pid }, { projection: { platform: 1, platformAccountId: 1, user_id: 1 } }).toArray();
    accountRefs = accounts.map((a) => ({ platform: a.platform, platformAccountId: String(a.platformAccountId) }));
    ownerId = accounts.find((a) => a.user_id)?.user_id || null;
    if (accountRefs.length) {
      await SocialProjectCleanup.updateOne(
        { project_id: pid },
        {
          $setOnInsert: {
            project_id: pid,
            user_id: ownerId,
            completedAt: now,
            accounts: accountRefs.map((a) => ({ ...a, externalRevocation: EXTERNAL_REVOCATION.NOT_SUPPORTED })),
            counts: { accounts: accountRefs.length, publications: 0, scheduledPublications: 0 },
            actionRequired: ACTION_REQUIRED_META,
            expiresAt: cleanupExpiry(now),
          },
        },
        { upsert: true },
      );
    }
  });

  // 1b. Credentials: unusable before anything else is touched (token $unset + revoked in one write).
  await attempt('credentials', true, async () => {
    await db.collection('socialaccounts').updateMany(
      { project_id: pid },
      { $set: { status: 'revoked', statusReason: 'PROJECT_DELETED', isActive: false, updatedAt: now }, $unset: { accessToken: '' } },
    );
  });

  // 2. Publications: removing them is what stops anything scheduled from ever being dispatched.
  await attempt('publications', true, async () => {
    counts.scheduledPublications = await db.collection('socialpublications').countDocuments({ project_id: pid, status: 'scheduled' });
    counts.publications = (await db.collection('socialpublications').deleteMany({ project_id: pid })).deletedCount;
    // $max: a re-run (which finds nothing left to delete) can never lower what the first run recorded
    if (counts.publications || counts.scheduledPublications) {
      await SocialProjectCleanup.updateOne({ project_id: pid }, { $max: { 'counts.publications': counts.publications, 'counts.scheduledPublications': counts.scheduledPublications } });
    }
  });

  for (const { collection, field } of SOCIAL_SIMPLE_COLLECTIONS) {
    // eslint-disable-next-line no-await-in-loop
    await attempt(collection, false, async () => {
      counts.collections[collection] = (await db.collection(collection).deleteMany({ [field]: pid })).deletedCount;
    });
  }

  // 3. The account documents (their tokens are already gone).
  await attempt('accounts', true, async () => {
    counts.accounts = (await db.collection('socialaccounts').deleteMany({ project_id: pid })).deletedCount;
  });

  // 4. Stored media of the project (post media, AI designs, catalog images, logo).
  await attempt('media', false, async () => {
    if (!(await mediaStorageService.deleteProjectDirectory(String(projectId)))) throw new Error('media folder could not be removed');
  });

  LoggerUtil.info(`${SERVICE}: social data purged`, { projectId: String(projectId), counts, failureCount: failures.length, criticalFailureCount: critical.length });
  return { projectId: String(projectId), counts, failures, criticalFailures: critical, retryable: critical.length > 0 };
}

/**
 * Removes social rows whose project no longer exists (left behind by purges that predate purgeProjectSocialData), so a
 * stored credential or a scheduled post can never outlive its project. Idempotent; one project failing does not stop the rest.
 * @returns {Promise<{ projects: number, purged: number, failed: number }>}
 */
export async function purgeOrphanedSocialData({ now = new Date() } = {}) {
  const db = getDb();
  const referenced = new Set();
  for (const { collection, field } of ORPHAN_SCAN) {
    // eslint-disable-next-line no-await-in-loop
    for (const id of await db.collection(collection).distinct(field)) if (id) referenced.add(String(id));
  }
  if (!referenced.size) return { projects: 0, purged: 0, failed: 0 };

  const existing = new Set((await SeoProject.find({ _id: { $in: [...referenced].map(toId) } }).select('_id').lean()).map((p) => String(p._id)));
  const orphans = [...referenced].filter((id) => !existing.has(id) && mongoose.Types.ObjectId.isValid(id));

  const summary = { projects: orphans.length, purged: 0, failed: 0 };
  for (const id of orphans) {
    // eslint-disable-next-line no-await-in-loop
    const result = await purgeProjectSocialData(id, { now });
    if (result.retryable) summary.failed += 1; else summary.purged += 1;
  }
  if (orphans.length) LoggerUtil.warn(`${SERVICE}: orphaned social data removed`, summary);
  return summary;
}

export default { purgeProjectSocialData, purgeOrphanedSocialData, SOCIAL_SIMPLE_COLLECTIONS, ACTION_REQUIRED_META };
