import mongoose from 'mongoose';
import { unlink } from 'fs/promises';
import path from 'path';
import User from '../model/User.js';
import SeoProject from '../../app_user/model/SeoProject.js';
import GoogleConnection from '../../app_user/model/GoogleConnection.js';
import HomepageAudit from '../../external/model/HomepageAudit.js';
import { deleteProjectCascade } from '../../app_user/service/projectCascadeDeleteService.js';
import { revokeGoogleToken } from '../../app_user/service/googleTokenRevocationService.js';
import { cancelSubscriptionImmediately } from '../../../services/stripeService.js';
import { deleteOwnedAvatarFile } from './authService.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

const SERVICE = 'UserCascadeDelete';

const getDb = () => mongoose.connection.db;

/**
 * Deletes every file this backend generated for a HomepageAudit (the
 * anonymous/pre-signup homepage-audit-tool feature) — its PDF report and
 * its generated video, neither of which projectCascadeDeleteService.js can
 * reach (HomepageAudit has no project_id at all; it's user_id-scoped
 * only, see external/model/HomepageAudit.js). Same ENOENT-safe unlink
 * pattern as projectCascadeDeleteService.js's purgeProjectScreenshots.
 */
async function purgeHomepageAuditFiles(userIdObj) {
  const videosDir = path.resolve(process.cwd(), 'public', 'videos');
  let pdfDeleted = 0, pdfMissing = 0, pdfErrors = 0;
  let videoDeleted = 0, videoMissing = 0, videoErrors = 0;

  // Mongoose's Model.find(filter, projection) takes the projection object
  // directly — unlike the native MongoDB driver's db.collection().find()
  // used elsewhere in this cascade, which expects it wrapped as
  // {projection: {...}}. Different API, different shape.
  const audits = await HomepageAudit.find(
    { user_id: userIdObj },
    { 'pdf.filePath': 1, 'video.videoUrl': 1 }
  ).lean();

  for (const audit of audits) {
    const pdfPath = audit.pdf?.filePath;
    if (pdfPath) {
      try {
        // Stored as an absolute path already (see HomepageAudit.js's own
        // schema comment) — unlike screenshot_path/videoFileName, no join
        // needed here.
        await unlink(pdfPath);
        pdfDeleted += 1;
      } catch (error) {
        if (error.code === 'ENOENT') pdfMissing += 1;
        else { pdfErrors += 1; LoggerUtil.error(`${SERVICE}: failed to delete homepage audit PDF`, error, { path: pdfPath }); }
      }
    }

    const videoUrl = audit.video?.videoUrl;
    if (videoUrl) {
      try {
        const filename = path.basename(new URL(videoUrl).pathname);
        const absolutePath = path.resolve(videosDir, filename);
        if (!absolutePath.startsWith(videosDir)) continue;
        await unlink(absolutePath);
        videoDeleted += 1;
      } catch (error) {
        if (error.code === 'ENOENT') videoMissing += 1;
        else { videoErrors += 1; LoggerUtil.error(`${SERVICE}: failed to delete homepage audit video`, error, { videoUrl }); }
      }
    }
  }

  return {
    auditsFound: audits.length,
    pdf: { deleted: pdfDeleted, missing: pdfMissing, errors: pdfErrors },
    video: { deleted: videoDeleted, missing: videoMissing, errors: videoErrors },
  };
}

/**
 * Revokes every active Google OAuth grant this user has (the
 * google_visibility / Search Console+Analytics+GBP connections — see
 * GoogleConnection.js) BEFORE any project is deleted. Order matters: once
 * deleteProjectCascade() runs, it purges these same documents by
 * project_id (they're project-scoped, never user-only) — the token must
 * be read and revoked while the row (and its decrypted token, via the
 * schema's own getter) still exists.
 *
 * Never throws — a revocation failure is logged and counted, never fatal
 * to account deletion (see revokeGoogleToken's own doc comment).
 */
async function revokeAllGoogleConnections(userIdObj) {
  let revoked = 0, failed = 0, total = 0;

  try {
    // NOT .lean() — the encrypted refresh_token/access_token fields only
    // decrypt via the schema's `get` transform on a hydrated document.
    const connections = await GoogleConnection.find({ user_id: userIdObj });
    total = connections.length;

    for (const connection of connections) {
      const token = connection.refresh_token || connection.access_token;
      if (!token) continue;
      const ok = await revokeGoogleToken(token);
      if (ok) revoked += 1; else failed += 1;
    }
  } catch (error) {
    LoggerUtil.error(`${SERVICE}: failed to load GoogleConnections for revocation`, error, { userId: userIdObj.toString() });
    failed += 1;
  }

  return { total, revoked, failed };
}

/**
 * Cancels the user's Stripe subscription immediately, if one exists.
 * Non-fatal on failure (per the cascade's overall resilience philosophy),
 * but the failure is reported prominently in the summary — unlike a purged
 * collection, a subscription that failed to cancel means real, ongoing
 * billing continues after the account is gone, which is worth flagging
 * for manual follow-up even though it doesn't block deletion.
 */
async function cancelStripeSubscription(user) {
  const stripeSubscriptionId = user.subscription?.stripeSubscriptionId;
  if (!stripeSubscriptionId) {
    return { attempted: false, cancelled: false, alreadyCancelled: false, error: null };
  }

  try {
    const result = await cancelSubscriptionImmediately(stripeSubscriptionId);
    return { attempted: true, ...result, error: null };
  } catch (error) {
    LoggerUtil.error(`${SERVICE}: failed to cancel Stripe subscription`, error, {
      userId: user._id.toString(), stripeSubscriptionId,
    });
    return { attempted: true, cancelled: false, alreadyCancelled: false, error: error.message };
  }
}

/**
 * Disconnects every currently-connected socket belonging to this user, so
 * a browser tab that's still open keeps receiving no further live events
 * (job progress, audit completion, etc.) for data that no longer exists.
 * Purely in-memory (see server.js's socket auth — socket.userId is set at
 * handshake, never persisted), so there is nothing to query or clean up
 * beyond this. A no-op, not a failure, if socket.io was never initialized
 * (e.g. this function running outside the main server process) or nothing
 * is connected.
 */
function disconnectUserSockets(userId) {
  const io = global.io;
  if (!io) return { disconnected: 0 };

  let disconnected = 0;
  const userIdStr = userId.toString();
  for (const socket of io.sockets.sockets.values()) {
    if (socket.userId && socket.userId.toString() === userIdStr) {
      socket.disconnect(true);
      disconnected += 1;
    }
  }
  return { disconnected };
}

/**
 * The single source of truth for permanently deleting a user account and
 * every piece of data it owns — the account-level counterpart to
 * projectCascadeDeleteService.js's deleteProjectCascade(), built on the
 * exact same philosophy: sequential (no Mongo transaction — this
 * deployment's MongoDB is a standalone instance, same as the project
 * cascade), every step individually try/caught into a `failures` array so
 * one failure never aborts the rest, retryable (re-running against a
 * partially-deleted user is safe — every step is idempotent).
 *
 * Caller contract: this function assumes identity has ALREADY been
 * verified (password or OTP) and a short-lived deletion-authorization
 * token has already been checked — see accountDeletionService.js. This
 * function itself does no re-authentication; it only performs the
 * deletion once authorized.
 *
 * Deliberately NOT touched, by design (not a bug, not a gap):
 *   - Transaction / CreditPurchase / PagePurchase: contain no directly
 *     stored personal information (verified against their schemas — only
 *     a plain `user`/`userId` ObjectId reference, amounts, currency, and
 *     Stripe-hosted invoice URLs). Left completely untouched: this
 *     satisfies "preserve financial history" with no field to redact, and
 *     once the User document itself is deleted below, the reference can
 *     no longer resolve to any personal data anyway.
 *   - SystemAdminAuditLog: compliance/audit trail, explicitly never deleted.
 *   - CustomPlanRequest: a sales-lead record that may also carry admin
 *     actors' references (adminNotes[].addedBy/statusHistory[].changedBy)
 *     — left untouched, same reasoning as SystemAdminAuditLog.
 *   - public/audio/*: no field anywhere in this codebase links an audio
 *     file to a user or project (confirmed via a full-schema search) — an
 *     audio file cannot be safely attributed to this user, so none are
 *     touched. Deleting arbitrary audio files would risk deleting another
 *     user's data.
 *
 * @param {string} userId
 * @returns {Promise<object>} full deletion summary
 */
export async function deleteUserCascade(userId) {
  const userIdObj = new mongoose.Types.ObjectId(userId);
  const startedAt = Date.now();
  const failures = [];

  LoggerUtil.service(SERVICE, 'delete', 'started', { userId });

  // Atomic claim: the very first write. Doubles as (a) a duplicate-request
  // guard — a concurrent second call sees isActive already false and is
  // rejected before any destructive work starts — and (b) an immediate
  // account lock for the duration of the cascade, reusing the exact field
  // the auth middleware already checks on every request (middleware/auth.js)
  // rather than introducing a new "deletionInProgress" field.
  const claimedUser = await User.findOneAndUpdate(
    { _id: userIdObj, isActive: true },
    { $set: { isActive: false } },
    { new: true }
  );
  if (!claimedUser) {
    const error = new Error('Account deletion is already in progress, or the account no longer exists.');
    error.code = 'DELETION_ALREADY_IN_PROGRESS';
    throw error;
  }

  // 1. Revoke Google OAuth tokens — must happen before any project (and
  // therefore any GoogleConnection row) is deleted.
  let googleRevocation = { total: 0, revoked: 0, failed: 0 };
  try {
    googleRevocation = await revokeAllGoogleConnections(userIdObj);
  } catch (error) {
    failures.push({ step: 'google_revocation', error: error.message });
    LoggerUtil.error(`${SERVICE}: google revocation step failed`, error, { userId });
  }

  // 2. Cancel Stripe subscription.
  const stripeCancellation = await cancelStripeSubscription(claimedUser);
  if (stripeCancellation.error) {
    failures.push({ step: 'stripe_cancellation', error: stripeCancellation.error });
  }

  // 3. Disconnect active sockets.
  let socketResult = { disconnected: 0 };
  try {
    socketResult = disconnectUserSockets(userIdObj);
  } catch (error) {
    failures.push({ step: 'socket_disconnect', error: error.message });
    LoggerUtil.error(`${SERVICE}: socket disconnect step failed`, error, { userId });
  }

  // 4. Delete every project the user owns — reuses deleteProjectCascade()
  // verbatim, once per project. This is the single biggest chunk of data:
  // ~30 project-scoped collections plus screenshots/videos, all handled by
  // the existing, already-hardened implementation.
  const projectResults = [];
  try {
    const projects = await SeoProject.find({ user_id: userIdObj }, { _id: 1 }).lean();
    for (const project of projects) {
      const result = await deleteProjectCascade(project._id.toString());
      projectResults.push(result);
      if (result.failures?.length) {
        failures.push({ step: 'project_cascade', projectId: project._id.toString(), errors: result.failures });
      }
    }
  } catch (error) {
    failures.push({ step: 'project_lookup', error: error.message });
    LoggerUtil.error(`${SERVICE}: failed to enumerate user's projects`, error, { userId });
  }

  // 5. User-only collections — never project-scoped, so never reached by
  // step 4 above.
  const userOnlyCounts = {};

  try {
    userOnlyCounts.homepageAuditFiles = await purgeHomepageAuditFiles(userIdObj);
  } catch (error) {
    failures.push({ step: 'homepage_audit_files', error: error.message });
    LoggerUtil.error(`${SERVICE}: homepage audit file cleanup failed`, error, { userId });
  }

  const db = getDb();
  const userOnlyCollections = [
    // Orphan jobs with no project_id (e.g. HOMEPAGE_VIDEO_GENERATION) —
    // every project-scoped job was already removed by step 4's project
    // cascades, so anything still matching user_id here is, by
    // construction, exactly the set the project cascade could never reach.
    { collection: 'jobs', field: 'user_id' },
    { collection: 'otps', field: 'userId' },
    { collection: 'passwordresetsessions', field: 'userId' },
    // Phase 2 — every server-stored refresh-token session for this user.
    // The `isActive: false` claim at the top of this cascade already blocks
    // /auth/refresh (refreshTokenService checks user.isActive), and the
    // User document is deleted below regardless; this hard-deletes the rows
    // so nothing is left pointing at a gone account.
    { collection: 'refreshtokens', field: 'userId' },
    { collection: 'homepage_audits', field: 'user_id' },
    // Defensive: every GoogleConnection is project-scoped and required to
    // have a project_id (see GoogleConnection.js), so step 4 should have
    // already cleared all of them — this is a zero-cost safety net against
    // an orphan left behind by a project whose own cascade partially failed.
    { collection: 'googleconnections', field: 'user_id' },
  ];

  for (const { collection, field } of userOnlyCollections) {
    try {
      const result = await db.collection(collection).deleteMany({ [field]: userIdObj });
      userOnlyCounts[collection] = result.deletedCount;
    } catch (error) {
      failures.push({ step: collection, error: error.message });
      LoggerUtil.error(`${SERVICE}: failed to clear ${collection}`, error, { userId });
    }
  }

  // 6. Avatar file — reuses authService.js's own deleteOwnedAvatarFile
  // verbatim (same function DELETE /auth/avatar already uses). Safe no-op
  // for the ui-avatars.com default or a Google profile picture URL — only
  // ever deletes a file this app itself wrote to storage/avatars/.
  try {
    await deleteOwnedAvatarFile(claimedUser.avatar);
  } catch (error) {
    // deleteOwnedAvatarFile never throws by design, but guarded anyway —
    // consistent with every other step in this cascade.
    failures.push({ step: 'avatar', error: error.message });
    LoggerUtil.error(`${SERVICE}: avatar cleanup failed`, error, { userId });
  }

  // 7. The User document itself — always last, always attempted regardless
  // of any failure above (same convention as deleteProjectCascade deleting
  // the SeoProject document last).
  let userDeleted = false;
  try {
    const result = await User.deleteOne({ _id: userIdObj });
    userDeleted = result.deletedCount > 0;
  } catch (error) {
    failures.push({ step: 'user_document', error: error.message });
    LoggerUtil.error(`${SERVICE}: failed to delete User document`, error, { userId });
  }

  const summary = {
    userId,
    durationMs: Date.now() - startedAt,
    googleRevocation,
    stripeCancellation,
    socketResult,
    projectsDeleted: projectResults.length,
    projectResults,
    userOnlyCounts,
    failures,
    userDeleted,
  };

  LoggerUtil.service(SERVICE, 'delete', failures.length ? 'completed_with_errors' : 'completed', {
    userId,
    durationMs: summary.durationMs,
    projectsDeleted: projectResults.length,
    failureCount: failures.length,
    userDeleted,
  });

  return summary;
}
