/**
 * Development seed: realistic keyword_ranking_history scan trajectory.
 *
 * Populates a fixed, realistic rank history (today, -7d, -14d, -21d, -30d,
 * -45d, -60d) for every keyword already tracked on a project, so Current,
 * Last Scan, Best, Previous Week, and Previous Month can all be exercised
 * and eyeballed in the real UI without waiting weeks for real scan data to
 * accumulate, and WITHOUT calling any external ranking API — every rank
 * value here is synthetic, written directly to MongoDB through the same
 * production merge function (mergeSingleKeywordRescan) real rescans use, so
 * Current/Best/Last-Scan invariants are computed by production code, not
 * re-implemented here.
 *
 * Never calls DataForSeoService or any paid third-party API.
 *
 * Idempotent: every history entry this script writes is tagged
 * scan_source: 'dev_seed'. Re-running it first deletes exactly the
 * 'dev_seed'-tagged entries for the target keyword(s) and re-inserts them —
 * real scan history (onboarding/manual_rescan/scheduled) is never touched,
 * and repeat runs never accumulate duplicates.
 *
 * Refuses to run when NODE_ENV=production. Requires the project to already
 * have at least one tracked keyword (run onboarding first) — this seeds
 * HISTORY for existing keywords, it does not create new ones.
 *
 * Usage:
 *   npm run seed:ranking-history -- --project=<projectId>
 *   npm run seed:ranking-history -- --project=<projectId> --keyword="best software company near me"
 *   npm run seed:ranking-history -- --project=<projectId> --dry-run
 */

import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import connectDB from '../../../config/database.js';
import SeoRankingCurrent from '../model/SeoRankingCurrent.js';
import KeywordRankingHistory from '../model/KeywordRankingHistory.js';
import { mergeSingleKeywordRescan } from '../../../services/rankingHistoryService.js';

const DAY = 24 * 60 * 60 * 1000;

// Oldest first — applied in this exact order so Current/Best/Last-Scan roll
// forward correctly through production merge logic, exactly as real
// sequential scans would.
const SCAN_TRAJECTORY = [
  { daysAgo: 60, rank: 18 },
  { daysAgo: 45, rank: 20 },
  { daysAgo: 30, rank: 15 },
  { daysAgo: 21, rank: 9 },
  { daysAgo: 14, rank: 10 },
  { daysAgo: 7,  rank: 8 },
  { daysAgo: 0,  rank: 7 },
];

function parseArgs(argv) {
  const args = { project: null, keyword: null, dryRun: false };
  for (const raw of argv) {
    if (raw === '--dry-run') args.dryRun = true;
    else if (raw.startsWith('--project=')) args.project = raw.slice('--project='.length);
    else if (raw.startsWith('--keyword=')) args.keyword = raw.slice('--keyword='.length);
  }
  return args;
}

async function seedKeyword({ projectId, userId, domain, keyword, dryRun }) {
  const keywordNormalized = keyword.toLowerCase().trim();

  if (dryRun) {
    console.log(`  [dry-run] would seed ${SCAN_TRAJECTORY.length} history points for "${keyword}"`);
    return;
  }

  // Idempotent cleanup — only ever touches entries THIS script created.
  const deleted = await KeywordRankingHistory.deleteMany({
    project_id: projectId,
    keyword_normalized: keywordNormalized,
    scan_source: 'dev_seed',
  });

  for (const point of SCAN_TRAJECTORY) {
    const rankingUrls = [{ rank: point.rank, url: `https://${domain}/`, type: 'homepage' }];

    await mergeSingleKeywordRescan({
      projectId,
      userId,
      domain,
      keywordResult: { keyword, ranking_urls: rankingUrls, maps_rank: null },
      scanSource: 'dev_seed',
    });

    // mergeSingleKeywordRescan always timestamps the new history entry as
    // "now" — backdate it to the intended point in the trajectory.
    const backdatedAt = new Date(Date.now() - point.daysAgo * DAY);
    await KeywordRankingHistory.updateOne(
      { project_id: projectId, keyword_normalized: keywordNormalized, scan_source: 'dev_seed' },
      { $set: { scanned_at: backdatedAt } },
      { sort: { scanned_at: -1 } }
    );
  }

  console.log(`  ✓ "${keyword}" — replaced ${deleted.deletedCount} old dev_seed entries with ${SCAN_TRAJECTORY.length} new ones`);
}

async function run() {
  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to run: NODE_ENV=production. This seed script is for local development only.');
    process.exit(1);
  }

  const args = parseArgs(process.argv.slice(2));
  if (!args.project) {
    console.error('Usage: npm run seed:ranking-history -- --project=<projectId> [--keyword="..."] [--dry-run]');
    process.exit(1);
  }
  if (!mongoose.Types.ObjectId.isValid(args.project)) {
    console.error(`Invalid --project value: "${args.project}" is not a valid ObjectId.`);
    process.exit(1);
  }

  await connectDB();

  try {
    const canonical = await SeoRankingCurrent.findOne({ project_id: args.project }).lean();
    if (!canonical) {
      console.error(`No seo_rankings_current document found for project ${args.project}. Run onboarding for this project first — this script seeds HISTORY for already-tracked keywords, it does not create new ones.`);
      process.exit(1);
    }

    let targetKeywords = canonical.keywords || [];
    if (args.keyword) {
      const normalized = args.keyword.toLowerCase().trim();
      targetKeywords = targetKeywords.filter(k => k.keyword.toLowerCase().trim() === normalized);
      if (targetKeywords.length === 0) {
        console.error(`Keyword "${args.keyword}" is not tracked on project ${args.project}.`);
        process.exit(1);
      }
    }
    if (targetKeywords.length === 0) {
      console.error(`Project ${args.project} has no tracked keywords to seed history for.`);
      process.exit(1);
    }

    console.log(`Seeding ${targetKeywords.length} keyword(s) for project ${args.project} (domain: ${canonical.domain})${args.dryRun ? ' [DRY RUN]' : ''}`);
    console.log('Trajectory:', SCAN_TRAJECTORY.map(p => `${p.daysAgo}d ago=${p.rank}`).join(', '));
    console.log('');

    for (const kw of targetKeywords) {
      await seedKeyword({
        projectId: args.project,
        userId: canonical.user_id,
        domain: canonical.domain,
        keyword: kw.keyword,
        dryRun: args.dryRun,
      });
    }

    if (!args.dryRun) {
      const finalDoc = await SeoRankingCurrent.findOne({ project_id: args.project }).lean();
      console.log('\nFinal state:');
      for (const kw of finalDoc.keywords) {
        if (args.keyword && kw.keyword.toLowerCase().trim() !== args.keyword.toLowerCase().trim()) continue;
        console.log(`  "${kw.keyword}" — current=${kw.current_rank} last_scan=${kw.prev_scan_rank} best=${kw.best_rank}`);
      }
      console.log('\nDone. Previous Week / Previous Month are computed live on the next GET /api/seo/rankings/:projectId call — reload the Keywords page to see them.');
    }
  } finally {
    await mongoose.disconnect();
  }
}

run().catch((error) => {
  console.error('Failed to seed ranking history:', error);
  process.exit(1);
});
