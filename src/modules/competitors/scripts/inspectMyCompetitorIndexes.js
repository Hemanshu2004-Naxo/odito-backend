/**
 * READ-ONLY pre-deploy / post-deploy inspection of the `project_competitors` collection (My Competitors). It never creates, drops,
 * updates or deletes anything: autoIndex / autoCreate are switched off for this connection and only list / count / aggregate calls run.
 *
 *   MONGO_URI=... [MONGO_DB_NAME=...] npm run inspect:my-competitor-indexes
 *
 * It prints, for the database it is pointed at:
 *   1. the indexes that exist, compared with the required ones (model/indexSpec.js): missing, wrong (key order / unique / partial filter),
 *      conflicting (a required key under another name) and unexpected (left alone: Odito never drops an index)
 *   2. data that WOULD stop a unique index from being built: duplicate (project, website), duplicate (project, place), duplicate
 *      (project, slot), entries with no slot, and projects holding more entries than the limit
 * Exit code 0 = indexes are right and nothing blocks, 1 = something needs attention, 2 = could not inspect.
 * Run it BEFORE the first deploy (the collection may not exist yet: that is fine) and AFTER (every required index must show ok).
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { diffIndexes, REQUIRED_INDEXES } from '../model/indexSpec.js';
import { MY_COMPETITORS_MAX } from '../model/ProjectCompetitor.js';

const COLLECTION = 'project_competitors';
const redact = (uri) => String(uri || '').replace(/^(mongodb(?:\+srv)?:\/\/)[^@/]*@/i, '$1***@').replace(/\?.*$/, '');

const duplicates = (db, field, extraMatch) => db.collection(COLLECTION).aggregate([
  { $match: { [field]: { $type: field === 'slot' ? 'number' : 'string' }, ...extraMatch } },
  { $group: { _id: { p: '$project_id', v: `$${field}` }, n: { $sum: 1 } } },
  { $match: { n: { $gt: 1 } } },
  { $limit: 20 },
], { maxTimeMS: 20000, allowDiskUse: true }).toArray();

/** @returns {Promise<string[]>} what needs attention (empty = nothing blocks) */
export async function inspect({ db, log = console.log } = {}) {
  const findings = [];
  log(`database: ${db.databaseName}`);
  const exists = (await db.listCollections({ name: COLLECTION }).toArray()).length > 0;
  if (!exists) {
    log(`\n${COLLECTION}: collection does not exist yet (it is created, with its indexes, when the new code first starts)`);
    return findings;
  }
  const actual = await db.collection(COLLECTION).indexes();
  const diff = diffIndexes(actual);
  log(`\n${COLLECTION}: ${actual.length} indexes`);
  for (const want of REQUIRED_INDEXES) {
    const bad = diff.wrong.find((w) => w.name === want.name);
    const state = diff.missing.includes(want.name) ? 'MISSING (built on first start)' : bad ? `PROBLEM - ${bad.problems.join('; ')}` : 'ok';
    log(`  ${want.name}: ${state}`);
    if (bad) findings.push(`${want.name}: ${bad.problems.join('; ')}`);
  }
  for (const c of diff.conflicting) {
    log(`  CONFLICT: index "${c.name}" has the key of "${c.required}" under another name`);
    findings.push(`index "${c.name}" blocks "${c.required}" (same key, other name): needs a planned migration, see docs/my-competitors-deployment.md`);
  }
  log(`  not declared by the code (left alone, never dropped here): ${diff.unexpected.length ? diff.unexpected.join(', ') : 'none'}`);

  const total = await db.collection(COLLECTION).countDocuments({}, { maxTimeMS: 20000 });
  log(`\nentries: ${total}`);
  const dupDomain = await duplicates(db, 'domain');
  const dupPlace = await duplicates(db, 'place_id');
  const dupSlot = await duplicates(db, 'slot');
  const noSlot = await db.collection(COLLECTION).countDocuments({ slot: { $not: { $type: 'number' } } }, { maxTimeMS: 20000 });
  const over = await db.collection(COLLECTION).aggregate([
    { $group: { _id: '$project_id', n: { $sum: 1 } } }, { $match: { n: { $gt: MY_COMPETITORS_MAX } } }, { $limit: 20 },
  ], { maxTimeMS: 20000 }).toArray();
  log(`duplicate (project, website) pairs, would block project_competitor_domain_unique: ${dupDomain.length}`);
  log(`duplicate (project, place id) pairs, would block project_competitor_place_unique: ${dupPlace.length}`);
  log(`duplicate (project, slot) pairs, would block project_competitor_slot_unique: ${dupSlot.length}`);
  log(`entries with no slot (written before the slot design; the index cannot count them): ${noSlot}`);
  log(`projects with more than ${MY_COMPETITORS_MAX} entries: ${over.length}`);
  if (dupDomain.length) findings.push(`${dupDomain.length} duplicate (project, website) pair(s): resolve before deploying`);
  if (dupPlace.length) findings.push(`${dupPlace.length} duplicate (project, place id) pair(s): resolve before deploying`);
  if (dupSlot.length) findings.push(`${dupSlot.length} duplicate (project, slot) pair(s): resolve before deploying`);
  if (noSlot) findings.push(`${noSlot} entr(ies) have no slot: they need a slot assigned (see docs/my-competitors-deployment.md)`);
  if (over.length) findings.push(`${over.length} project(s) exceed ${MY_COMPETITORS_MAX} entries`);
  return findings;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  dotenv.config();
  if (!process.env.MONGO_URI) { console.error('MONGO_URI is not set'); process.exit(2); }
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000, autoIndex: false, autoCreate: false, ...(process.env.MONGO_DB_NAME ? { dbName: process.env.MONGO_DB_NAME } : {}) });
    console.log(`connected: ${redact(process.env.MONGO_URI)}`);
    const findings = await inspect({ db: mongoose.connection.db });
    console.log(findings.length ? `\nNEEDS ATTENTION:\n - ${findings.join('\n - ')}` : '\nNothing blocks the deploy.');
    await mongoose.disconnect();
    process.exit(findings.length ? 1 : 0);
  } catch (error) {
    console.error(`could not inspect: ${String(error.message).replace(/mongodb(?:\+srv)?:\/\/[^@\s]*@/gi, 'mongodb://***@')}`);
    process.exit(2);
  }
}
