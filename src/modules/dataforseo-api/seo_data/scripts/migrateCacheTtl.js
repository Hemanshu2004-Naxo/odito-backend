/**
 * One-off, idempotent index migration for the DataForSEO cache.
 *
 * The collection `dataforseo_api_cache` used to have a MongoDB TTL index (`dataforseo_cache_ttl` on `expiresAt`, expireAfterSeconds 0) that
 * DELETED every entry when it expired. The model no longer declares it, but MongoDB keeps an index that already exists, so on an existing
 * database it must be dropped once. Dropping an index never touches a document: every cached response is preserved.
 *
 *   node src/modules/dataforseo-api/seo_data/scripts/migrateCacheTtl.js           dry run: reports, changes nothing
 *   node src/modules/dataforseo-api/seo_data/scripts/migrateCacheTtl.js --apply   drops the TTL index (and nothing else)
 *
 * Run it BEFORE relying on stale data being kept. Rollback: recreate the index with
 *   db.dataforseo_api_cache.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'dataforseo_cache_ttl' })
 * (that re-enables deletion of every entry already past its expiry, immediately).
 */
import 'dotenv/config';
import mongoose from 'mongoose';

const COLLECTION = 'dataforseo_api_cache';
const INDEX = 'dataforseo_cache_ttl';
const apply = process.argv.includes('--apply');

async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set');
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000, autoIndex: false, autoCreate: false, ...(process.env.MONGO_DB_NAME ? { dbName: process.env.MONGO_DB_NAME } : {}) });
  const col = mongoose.connection.db.collection(COLLECTION);
  const exists = (await mongoose.connection.db.listCollections({ name: COLLECTION }).toArray()).length > 0;
  if (!exists) { console.log(`${COLLECTION} does not exist: nothing to do.`); return; }
  const docs = await col.estimatedDocumentCount();
  const indexes = await col.indexes();
  const ttl = indexes.find((i) => i.name === INDEX || (i.key?.expiresAt === 1 && typeof i.expireAfterSeconds === 'number'));
  console.log(`documents: ${docs}`);
  console.log(`indexes: ${indexes.map((i) => i.name).join(', ')}`);
  if (!ttl) { console.log('No TTL index on expiresAt: already migrated.'); return; }
  const expired = await col.countDocuments({ expiresAt: { $lt: new Date() } });
  console.log(`TTL index found: ${ttl.name} (expireAfterSeconds ${ttl.expireAfterSeconds}); entries already past their expiry (kept once the index is gone): ${expired}`);
  if (!apply) { console.log('Dry run. Re-run with --apply to drop the TTL index. No document is changed either way.'); return; }
  const countBefore = await col.countDocuments({});
  await col.dropIndex(ttl.name);
  // Verify the result instead of assuming it: no TTL index left, same documents, the unique key index untouched.
  const after = await col.indexes();
  const countAfter = await col.countDocuments({});
  const stillTtl = after.some((i) => typeof i.expireAfterSeconds === 'number' && i.key?.expiresAt === 1);
  const keyIndex = after.some((i) => i.name === 'key_1' && i.unique);
  console.log(`Dropped index ${ttl.name}.`);
  console.log(`indexes now: ${after.map((i) => i.name).join(', ')}`);
  console.log(`documents before: ${countBefore}, after: ${countAfter}`);
  const ok = !stillTtl && countBefore === countAfter && keyIndex;
  console.log(ok ? 'VERIFIED: no TTL index on expiresAt, every cached document preserved, unique key index intact.' : 'VERIFICATION FAILED: check the lines above before relying on this migration.');
  if (!ok) process.exitCode = 1;
}

main().catch((err) => { console.error('Migration failed:', err.message); process.exitCode = 1; }).finally(() => mongoose.disconnect());
