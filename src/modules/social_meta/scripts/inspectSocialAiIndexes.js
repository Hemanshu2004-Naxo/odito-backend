/**
 * READ-ONLY pre-deploy / post-deploy inspection of the Social AI collections. It never creates, drops, updates or deletes anything
 * (autoIndex is switched off for this connection; only list / diff / count / aggregate calls are made).
 *
 *   MONGO_URI=... [MONGO_DB_NAME=...] npm run inspect:social-indexes
 *
 * Why it exists: Mongoose creates the indexes a model declares the first time the new code connects (autoIndex is on by default and the app does
 * not turn it off). That is additive and safe EXCEPT for a unique index over data that already breaks the rule - the build then fails (and is only
 * logged), and the guarantee the index was meant to give is missing. So before deploying, this prints:
 *   1. per collection: indexes present, indexes the code declares that are missing, and indexes in the database the code no longer declares
 *   2. data that WOULD block a unique index from being built (more than one `generating` calendar per project; duplicate calendar slots)
 * and after deploying it shows that every unique / TTL / partial index exists with the expected options.
 * Exit code 0 = nothing blocks, 1 = something needs attention, 2 = could not inspect.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import SocialContentCalendar from '../model/SocialContentCalendar.js';
import SocialContentCalendarItem from '../model/SocialContentCalendarItem.js';
import SocialAIUsage from '../model/SocialAIUsage.js';
import MetaOAuthState from '../model/MetaOAuthState.js';
import SocialProjectCleanup from '../model/SocialProjectCleanup.js';
import SocialPublication from '../model/SocialPublication.js';

dotenv.config();

const MODELS = [SocialContentCalendar, SocialContentCalendarItem, SocialAIUsage, MetaOAuthState, SocialProjectCleanup, SocialPublication];
/** Indexes whose OPTIONS matter (unique / TTL / partial): checked by name, not just "exists". */
const REQUIRED = {
  unique_calendar_version: { unique: true },
  unique_calendar_generating_in_flight: { unique: true, partial: true },
  unique_calendar_item_slot: { unique: true, partial: true },
  unique_usage_scope_period: { unique: true },
  unique_meta_oauth_nonce: { unique: true },
  meta_oauth_state_ttl: { ttl: 60 },
  unique_social_cleanup_project: { unique: true },
  social_cleanup_ttl: { ttl: 0 },
};

const redact = (uri) => String(uri || '').replace(/^(mongodb(?:\+srv)?:\/\/)[^@/]*@/i, '$1***@').replace(/\?.*$/, '');

export async function inspect({ log = console.log } = {}) {
  const findings = [];
  const existing = new Set((await mongoose.connection.db.listCollections().toArray()).map((c) => c.name));
  log(`database: ${mongoose.connection.name}`);

  for (const Model of MODELS) {
    const name = Model.collection.name;
    if (!existing.has(name)) { log(`\n${name}: collection does not exist yet (it is created, with its indexes, on first use)`); continue; }
    const actual = await Model.collection.indexes();
    const diff = await Model.diffIndexes();
    const missing = diff.toCreate.map((entry) => { const [keys, options] = Array.isArray(entry) ? entry : [entry, null]; return options?.name || Object.entries(keys).map(([field, dir]) => field + '_' + dir).join('_'); });
    log(`\n${name}: ${actual.length} indexes`);
    log(`  missing (will be built on first start): ${missing.length ? missing.join(', ') : 'none'}`);
    log(`  not declared by the code (left alone, never dropped here): ${diff.toDrop.length ? diff.toDrop.join(', ') : 'none'}`);
    for (const [indexName, want] of Object.entries(REQUIRED)) {
      const index = actual.find((i) => i.name === indexName);
      if (!index) continue;
      const problems = [];
      if (want.unique && !index.unique) problems.push('not unique');
      if (want.partial && !index.partialFilterExpression) problems.push('not partial');
      if (want.ttl !== undefined && index.expireAfterSeconds !== want.ttl) problems.push(`ttl is ${index.expireAfterSeconds}, expected ${want.ttl}`);
      log(`  ${indexName}: ${problems.length ? `PROBLEM - ${problems.join('; ')}` : 'ok'}`);
      if (problems.length) findings.push(`${name}.${indexName}: ${problems.join('; ')}`);
    }
  }

  // data that would stop a unique index from being built
  if (existing.has(SocialContentCalendar.collection.name)) {
    const stuck = await SocialContentCalendar.aggregate([
      { $match: { status: 'generating' } }, { $group: { _id: '$project_id', n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }, { $limit: 20 },
    ]).option({ maxTimeMS: 20000 });
    log(`\nprojects with more than one 'generating' calendar (would block unique_calendar_generating_in_flight): ${stuck.length}`);
    if (stuck.length) findings.push(`${stuck.length} project(s) have several generating calendars: resolve before deploying`);
  }
  if (existing.has(SocialContentCalendarItem.collection.name)) {
    const dupes = await SocialContentCalendarItem.aggregate([
      { $match: { slot: { $type: 'number' } } }, { $group: { _id: { c: '$calendar_id', s: '$slot' }, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }, { $limit: 20 },
    ]).option({ maxTimeMS: 20000, allowDiskUse: true });
    log(`duplicate (calendar, slot) pairs (would block unique_calendar_item_slot): ${dupes.length}`);
    if (dupes.length) findings.push(`${dupes.length} duplicate calendar slot(s): resolve before deploying`);
  }
  return findings;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  if (!process.env.MONGO_URI) { console.error('MONGO_URI is not set'); process.exit(2); }
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000, autoIndex: false, autoCreate: false, ...(process.env.MONGO_DB_NAME ? { dbName: process.env.MONGO_DB_NAME } : {}) });
    console.log(`connected: ${redact(process.env.MONGO_URI)}`);
    const findings = await inspect();
    console.log(findings.length ? `\nNEEDS ATTENTION:\n - ${findings.join('\n - ')}` : '\nNothing blocks the deploy.');
    await mongoose.disconnect();
    process.exit(findings.length ? 1 : 0);
  } catch (error) {
    console.error(`could not inspect: ${String(error.message).replace(/mongodb(?:\+srv)?:\/\/[^@\s]*@/gi, 'mongodb://***@')}`);
    process.exit(2);
  }
}
