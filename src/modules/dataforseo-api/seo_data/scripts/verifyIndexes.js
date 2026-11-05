/**
 * Index check for the SEO data collections: compares the indexes the models declare with the ones that really exist in the database.
 *
 *   node src/modules/dataforseo-api/seo_data/scripts/verifyIndexes.js            read-only report (exit code 1 if an expected index is missing)
 *   node src/modules/dataforseo-api/seo_data/scripts/verifyIndexes.js --apply    creates the MISSING indexes (createIndexes); never drops or changes one
 *
 * Why it matters: the scan lock (`seo_scan_runs_active_lock`) and every duplicate guarantee are UNIQUE indexes. With Mongoose autoIndex off in
 * production they would not exist until something creates them. The API creates the scan-run indexes itself before the first scan, but this
 * script is the way to check (and prepare) all of them before a deploy. It also reports any TTL index on dataforseo_api_cache.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import SeoScanRun from '../model/SeoScanRun.js';
import SeoSnapshot from '../model/SeoSnapshot.js';
import SeoKeywordRanking from '../model/SeoKeywordRanking.js';
import SeoBacklink from '../model/SeoBacklink.js';
import SeoReferringDomain from '../model/SeoReferringDomain.js';
import SeoProviderRequest from '../model/SeoProviderRequest.js';

const apply = process.argv.includes('--apply');
const MODELS = [SeoScanRun, SeoSnapshot, SeoKeywordRanking, SeoBacklink, SeoReferringDomain, SeoProviderRequest];

async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set');
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000, autoIndex: false, autoCreate: false, ...(process.env.MONGO_DB_NAME ? { dbName: process.env.MONGO_DB_NAME } : {}) });
  const db = mongoose.connection.db;
  console.log(`${apply ? 'APPLY' : 'READ-ONLY'} on database "${db.databaseName}"`);
  let missingTotal = 0;
  for (const model of MODELS) {
    const name = model.collection.name;
    const exists = (await db.listCollections({ name }).toArray()).length > 0;
    const actual = exists ? await db.collection(name).indexes() : [];
    const have = new Map(actual.map((i) => [i.name, i]));
    const expected = model.schema.indexes().map(([, o]) => o.name).filter(Boolean);
    const missing = expected.filter((n) => !have.has(n));
    const unique = [...have.values()].filter((i) => i.unique && i.name !== '_id_').map((i) => i.name);
    console.log(`${name}${exists ? '' : ' (collection does not exist yet)'}: expected ${expected.length}, found ${actual.length}${missing.length ? `, MISSING: ${missing.join(', ')}` : ', all present'}${unique.length ? ` | unique: ${unique.join(', ')}` : ''}`);
    missingTotal += missing.length;
    if (apply && missing.length) { await model.createIndexes(); console.log(`  created: ${missing.join(', ')}`); }
  }
  const cacheExists = (await db.listCollections({ name: 'dataforseo_api_cache' }).toArray()).length > 0;
  if (cacheExists) {
    const ttl = (await db.collection('dataforseo_api_cache').indexes()).filter((i) => typeof i.expireAfterSeconds === 'number');
    console.log(ttl.length ? `dataforseo_api_cache HAS A TTL INDEX (${ttl.map((i) => i.name).join(', ')}): expired cache entries are being deleted. Run migrateCacheTtl.js.` : 'dataforseo_api_cache: no TTL index (expired entries are kept).');
    if (ttl.length) process.exitCode = 1;
  }
  if (!apply && missingTotal) { console.log(`${missingTotal} index(es) missing. Re-run with --apply to create them.`); process.exitCode = 1; }
}

main().catch((err) => { console.error('Index check failed:', err.message); process.exitCode = 1; }).finally(() => mongoose.disconnect());
