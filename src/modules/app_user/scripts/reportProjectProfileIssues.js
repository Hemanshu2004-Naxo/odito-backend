/**
 * READ-ONLY report of existing projects whose business profile needs the customer's correction before AI-visibility questions can be
 * trusted. It never writes: industries and target cities cannot be inferred safely, so every finding is a recommendation for the
 * customer (via the Business profile screen) or an operator to confirm.
 *
 *   npm run report:project-profiles                    # summary + up to 50 examples per issue
 *   npm run report:project-profiles -- --json > out.json
 *
 * Issues detected (codes match businessProfileService warnings):
 *   industry_is_generic_business_model   `industry` holds a business type ("Service-based") - not an industry
 *   industry_is_legacy_free_text          `industry` is free text from before the taxonomy (usable as a sub-industry hint)
 *   industry_not_set                      no industry at all
 *   location_conflict                     a typed `location` and an UNVERIFIED verified_business.city (no placeId) disagree -
 *                                         the website path stored a website-inferred city there (the "Mumbai vs Ahmedabad" bug)
 *   city_source_unverified                the only known city is that unverified verified_business.city
 *   local_scope_without_city              seo_scope is local but no city is known
 *   target_city_needs_confirmation        target_city came from the website, not the customer
 *
 * Note: keyword RANK tracking still reads verified_business.city; projects flagged location_conflict may also be tracking rankings in
 * the inferred city. That pipeline is intentionally not changed here.
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import SeoProject from '../model/SeoProject.js';
import { normalizeBusinessProfile } from '../../ai_visibility/shared/services/businessProfileService.js';

dotenv.config();

const ISSUES = ['industry_is_generic_business_model', 'industry_is_legacy_free_text', 'industry_not_set', 'location_conflict', 'city_source_unverified', 'target_city_needs_confirmation'];
const EXAMPLES = 50;

/** Pure: classify one project document. Exported for tests. */
export function classifyProject(project) {
  const profile = normalizeBusinessProfile({ project, socialProfile: null });
  const issues = profile.warnings.filter((w) => ISSUES.includes(w));
  if (project.seo_scope === 'local' && !profile.market.city) issues.push('local_scope_without_city');
  return {
    projectId: String(project._id),
    name: project.project_name,
    issues,
    current: {
      business_type: project.business_type ?? null, industry: project.industry ?? null, sub_industry: project.sub_industry ?? null,
      location: project.location ?? null, verified_city: project.verified_business?.city ?? null, verified_place: Boolean(project.verified_business?.placeId),
      target_city: project.target_city ?? null, seo_scope: project.seo_scope ?? null,
    },
    resolvedCity: profile.market.city,
    conflicts: profile.market.conflicts,
  };
}

async function main() {
  const json = process.argv.includes('--json');
  await mongoose.connect(process.env.MONGO_URI);
  const counts = {};
  const examples = {};
  let scanned = 0;
  const cursor = SeoProject.find({ is_deleted: { $ne: true } })
    .select('project_name business_type industry sub_industry location country seo_scope verified_business target_city location_source visibility_profile main_url canonical_host canonical_url language business_name')
    .lean().cursor();
  for await (const p of cursor) {
    scanned += 1;
    const row = classifyProject(p);
    for (const issue of row.issues) {
      counts[issue] = (counts[issue] || 0) + 1;
      (examples[issue] ||= []).length < EXAMPLES && examples[issue].push(row);
    }
  }
  await mongoose.disconnect();
  const report = { scanned, counts, examples, writes: 0 };
  if (json) process.stdout.write(JSON.stringify(report, null, 2));
  else {
    console.log(`Scanned ${scanned} projects (read-only, nothing changed).`);
    for (const [issue, n] of Object.entries(counts)) console.log(`  ${issue}: ${n}`);
    console.log('Re-run with --json for per-project details.');
  }
}

// Run only when executed directly (importing it - e.g. from a test - must not connect to a database).
if (typeof process.argv[1] === 'string' && process.argv[1].replace(/\\/g, '/').endsWith('reportProjectProfileIssues.js')) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
