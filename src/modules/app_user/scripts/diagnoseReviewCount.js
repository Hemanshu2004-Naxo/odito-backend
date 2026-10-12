/**
 * READ-ONLY diagnostic: where does the difference between Google's reported
 * review total and the number Odito shows come from?
 *
 *   node src/modules/app_user/scripts/diagnoseReviewCount.js <projectId>
 *
 * - Reads this project's Business Profile connection and stored reviews (no DB write).
 * - Calls Google's reviews.list (GET only) and pages through everything.
 * - Gets its access token IN MEMORY (the stored token if still valid, otherwise a
 *   refresh whose result is never saved) and never uses getValidAccessToken, so it
 *   cannot change a connection's status. Tokens are never printed.
 * - Prints counts and review IDS only (no reviewer names, review text or tokens).
 */
import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import axios from 'axios';
import { OAuth2Client } from 'google-auth-library';

const { default: GoogleConnection } = await import('../model/GoogleConnection.js');
const { default: BusinessProfileReview } = await import('../model/BusinessProfileReview.js');
const { default: BusinessProfileMetadata } = await import('../model/BusinessProfileMetadata.js');
const { fetchAllReviews } = await import('../../../services/businessProfileReviewService.js');
const { reconcileReviewIds } = await import('../../../services/businessProfileReviewReconcile.js');

const projectId = process.argv[2];
if (!projectId || !mongoose.isValidObjectId(projectId)) {
  console.error('Usage: node diagnoseReviewCount.js <projectId>');
  process.exit(1);
}

async function accessTokenInMemory(connection) {
  const expiresAt = connection.token_expires_at ? new Date(connection.token_expires_at).getTime() : 0;
  if (connection.access_token && expiresAt - Date.now() > 5 * 60 * 1000) return connection.access_token;
  const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  client.setCredentials({ refresh_token: connection.refresh_token });
  const { credentials } = await client.refreshAccessToken(); // not persisted anywhere
  return credentials.access_token;
}

await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 });
try {
  const connection = await GoogleConnection.findOne({ project_id: projectId, purpose: 'business_profile' });
  if (!connection?.business_location_id) throw new Error('No Business Profile location connected for this project');
  const { business_account_id: accountId, business_location_id: locationId } = connection;

  const token = await accessTokenInMemory(connection);
  const client = axios.create({
    baseURL: 'https://mybusiness.googleapis.com/v4/',
    headers: { Authorization: `Bearer ${token}` },
    timeout: 30000,
  });
  const fetched = await fetchAllReviews(connection, accountId, locationId, { client });

  const pid = new mongoose.Types.ObjectId(projectId);
  const ids = async (filter) => (await BusinessProfileReview.find({ project_id: pid, ...filter }).select('google_review_id').lean()).map((r) => r.google_review_id);
  const [storedLiveIds, storedDeletedIds, storedOtherLocationIds, metadata] = await Promise.all([
    ids({ business_location_id: locationId, is_deleted: false }),
    ids({ business_location_id: locationId, is_deleted: true }),
    ids({ business_location_id: { $ne: locationId } }),
    BusinessProfileMetadata.findOne({ project_id: pid }).select('total_review_count reviews_last_synced_at').lean(),
  ]);

  const report = reconcileReviewIds({
    googleIds: fetched.reviews.map((r) => r.google_review_id),
    googleTotal: fetched.totalReviewCount,
    storedLiveIds, storedDeletedIds, storedOtherLocationIds,
  });
  console.log(JSON.stringify({
    projectId, locationId,
    fetch: {
      pagesFetched: fetched.pagesFetched, recordsReturned: fetched.rawFetched, uniqueIds: fetched.uniqueFetched,
      duplicatesWithinPass: fetched.duplicatesWithinPass, skippedWithoutId: fetched.skippedWithoutId,
      recoveryPassUsed: fetched.retried, pageCeilingHit: fetched.truncated, complete: fetched.complete,
    },
    lastStoredGoogleTotal: metadata?.total_review_count ?? null,
    lastSyncedAt: metadata?.reviews_last_synced_at ?? null,
    ...report,
  }, null, 2));
} catch (error) {
  console.error('Diagnostic failed:', error.response?.status ? `Google HTTP ${error.response.status}` : error.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
