/**
 * Retention for the stored SEO row sets (keywords, backlinks, referring domains) and the provider request ledger.
 *
 *   node src/modules/dataforseo-api/seo_data/scripts/retention.js                        DRY RUN: reports what would be removed, changes nothing
 *   node ... retention.js --project=<projectId>                                         one project only
 *   SEO_RETENTION_CONFIRM=<database name> node ... retention.js --apply                 really delete (batched, with a pause between batches)
 *
 * Safety: --apply is refused unless SEO_RETENTION_CONFIRM equals the name of the database it is connected to, so it cannot be run against the
 * wrong environment by accident. Nothing schedules this; run it by hand (or from your own cron) after reading a dry run.
 * Settings (environment): SEO_RETENTION_KEEP_SCANS (8), SEO_RETENTION_MAX_AGE_DAYS (180), SEO_RETENTION_ORPHAN_HOURS (48),
 * SEO_RETENTION_LEDGER_DAYS (400), SEO_RETENTION_BATCH (1000), SEO_RETENTION_PAUSE_MS (100). Rules: see service/retentionService.js.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { runRetention, RETENTION_DEFAULTS } from '../service/retentionService.js';

const apply = process.argv.includes('--apply');
const projectArg = process.argv.find((a) => a.startsWith('--project='))?.split('=')[1];

async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set');
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000, autoIndex: false, autoCreate: false, ...(process.env.MONGO_DB_NAME ? { dbName: process.env.MONGO_DB_NAME } : {}) });
  const dbName = mongoose.connection.db.databaseName;
  if (projectArg && !mongoose.isValidObjectId(projectArg)) throw new Error('--project must be a project id');
  if (apply && process.env.SEO_RETENTION_CONFIRM !== dbName) {
    throw new Error(`Refusing to delete: set SEO_RETENTION_CONFIRM=${dbName} to confirm you mean the database "${dbName}".`);
  }
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} on database "${dbName}"${projectArg ? `, project ${projectArg}` : ', all projects'}`);
  console.log('settings:', JSON.stringify(RETENTION_DEFAULTS));
  const out = await runRetention({ dryRun: !apply, ...(projectArg ? { projectId: new mongoose.Types.ObjectId(projectArg) } : {}) });
  for (const g of out.groups.filter((x) => x.scansRemoved || x.orphanScans)) console.log(JSON.stringify(g));
  console.log(`${apply ? 'deleted' : 'would delete'}:`, JSON.stringify(out.totals));
  if (!apply) console.log('Dry run only. Nothing was changed. Re-run with --apply (and SEO_RETENTION_CONFIRM) to delete.');
}

main().catch((err) => { console.error('Retention failed:', err.message); process.exitCode = 1; }).finally(() => mongoose.disconnect());
