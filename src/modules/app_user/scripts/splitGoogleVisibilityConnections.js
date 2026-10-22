/**
 * One-time backfill: splits every legacy `purpose: 'google_visibility'`
 * GoogleConnection (one row bundling Search Console + Analytics + Business
 * Profile behind a single Google account) into up to three independent
 * rows — `purpose: 'search_console'`, `purpose: 'analytics'`,
 * `purpose: 'business_profile'` — one per service the legacy row actually
 * had enabled (`service_type`), so existing users keep working exactly as
 * before (same Google account per service, same tokens, same selections)
 * while gaining the ability to swap any one service to a different account
 * going forward.
 *
 * Non-destructive: the legacy `google_visibility` row is never modified or
 * deleted. It becomes a frozen, unused artifact once this script has run —
 * see GoogleConnection.js's `purpose` field comment.
 *
 * Idempotent: each new row is upserted on the same
 * {user_id, project_id, purpose} unique index the model already enforces,
 * so re-running after new users have connected between deploy and this
 * script's run just no-ops for anything already split, and safely fills in
 * anything new.
 *
 * Copies the refresh_token/access_token ciphertext strings directly (same
 * AES-256-GCM key, same `enc:v1:` format) — never decrypts/re-encrypts, and
 * never logs a token value.
 *
 * Usage:
 *   npm run migrate:split-google-visibility
 *   npm run migrate:split-google-visibility -- --dry-run
 */

import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import connectDB from '../../../config/database.js';
import GoogleConnection from '../model/GoogleConnection.js';

const SPLIT_SERVICES = ['search_console', 'analytics', 'business_profile'];

function buildServiceFields(legacyDoc, service) {
  // Read via the raw document (not the decrypting getters) is unnecessary
  // here — Mongoose getters run on read regardless, so refresh_token/
  // access_token below are the DECRYPTED plaintext; the schema's `set`
  // transform (encryptToken) re-encrypts them on write, same as any normal
  // save. This is not a raw ciphertext copy, but it is still the exact
  // same value round-tripped through the model's own encrypt/decrypt pair
  // it already uses for every other write — no new code path.
  const base = {
    google_email: legacyDoc.google_email,
    google_name: legacyDoc.google_name,
    google_avatar: legacyDoc.google_avatar,
    refresh_token: legacyDoc.refresh_token,
    access_token: legacyDoc.access_token,
    token_expires_at: legacyDoc.token_expires_at,
    status: legacyDoc.status,
    connected_at: legacyDoc.connected_at,
    last_used_at: legacyDoc.last_used_at,
    last_sync_at: legacyDoc.last_sync_at,
    service_type: [service],
  };

  if (service === 'search_console') {
    base.search_console_site_url = legacyDoc.search_console_site_url;
  } else if (service === 'analytics') {
    base.analytics_property_id = legacyDoc.analytics_property_id;
  } else if (service === 'business_profile') {
    base.business_account_id = legacyDoc.business_account_id;
    base.business_location_id = legacyDoc.business_location_id;
    base.business_accounts_cache = legacyDoc.business_accounts_cache;
    base.business_accounts_cached_at = legacyDoc.business_accounts_cached_at;
  }

  return base;
}

async function run({ dryRun }) {
  await connectDB();

  try {
    const legacyConnections = await GoogleConnection.find({ purpose: 'google_visibility' });
    console.log(`Found ${legacyConnections.length} legacy 'google_visibility' connection(s).`);

    const summary = { search_console: 0, analytics: 0, business_profile: 0, skipped: 0 };

    for (const legacyDoc of legacyConnections) {
      const enabledServices = (legacyDoc.service_type || []).filter((s) => SPLIT_SERVICES.includes(s));

      if (enabledServices.length === 0) {
        summary.skipped += 1;
        continue;
      }

      for (const service of enabledServices) {
        const filter = { user_id: legacyDoc.user_id, project_id: legacyDoc.project_id, purpose: service };

        if (dryRun) {
          const exists = await GoogleConnection.exists(filter);
          console.log(`  [dry-run] would upsert ${service} for user=${legacyDoc.user_id} project=${legacyDoc.project_id} (already split: ${!!exists})`);
          continue;
        }

        await GoogleConnection.findOneAndUpdate(
          filter,
          { $set: buildServiceFields(legacyDoc, service) },
          { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
        );

        summary[service] += 1;
      }
    }

    console.log('');
    console.log(dryRun ? 'Dry run complete — no writes were made.' : 'Migration complete.');
    console.log(`  search_console rows upserted: ${summary.search_console}`);
    console.log(`  analytics rows upserted:      ${summary.analytics}`);
    console.log(`  business_profile rows upserted: ${summary.business_profile}`);
    console.log(`  legacy rows with no split-able service_type: ${summary.skipped}`);
  } finally {
    await mongoose.disconnect();
  }
}

const dryRun = process.argv.slice(2).includes('--dry-run');

run({ dryRun }).catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
