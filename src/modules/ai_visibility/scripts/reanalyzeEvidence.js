/**
 * Re-check STORED answers of approved-question runs against the business's CURRENT brand names (including derived aliases) and
 * recompute each run's figures. No provider calls, no cost: only the analysis fields and run metrics are rewritten.
 *
 *   npm run visibility:reanalyze                 # every project
 *   npm run visibility:reanalyze -- <projectId>  # one project
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import ChatGptVisibilityRun from '../chatgpt_visibility/models/ChatGptVisibilityRun.js';
import AiVisibilityEvidence from '../shared/evidence/models/AiVisibilityEvidence.js';
import { buildBusinessProfile } from '../shared/services/businessProfileService.js';
import { analyzeAnswer } from '../shared/services/visibilityMetricsService.js';
import { classifyCitations } from '../shared/services/citationNormalizationService.js';
import { detectRecommendation } from '../shared/services/recommendationDetection.js';
import { computeApprovedQuestionMetrics } from '../shared/services/approvedQuestionMetrics.js';
import { getChatGptConfig } from '../chatgpt_visibility/config/chatgptConfig.js';

dotenv.config();

async function main() {
  const projectId = process.argv[2];
  await mongoose.connect(process.env.MONGO_URI);
  const config = getChatGptConfig();
  const q = { executionMode: 'approved_questions', status: { $in: ['completed', 'partial'] }, ...(projectId ? { projectId } : {}) };
  const runs = await ChatGptVisibilityRun.find(q).lean();
  let changed = 0;
  for (const run of runs) {
    let profile;
    try { profile = await buildBusinessProfile(String(run.projectId)); } catch { continue; }
    const target = { ...run.target, brandNames: [profile.business.name, ...profile.business.aliases].filter(Boolean), competitors: profile.business.competitors };
    const docs = await AiVisibilityEvidence.find({ runId: run._id, status: 'succeeded' }).lean();
    for (const e of docs) {
      const a = analyzeAnswer({ answerText: e.answerText, annotations: e.annotations }, target);
      const cls = classifyCitations({ answerText: e.answerText, annotations: e.annotations, targetHost: target.targetHost, brandNames: target.brandNames });
      const citations = cls.citations;
      const rec = e.group === 'visibility' ? detectRecommendation(e.answerText, target.brandNames) : null;
      const analysis = { brandMentioned: a.brandMentioned, brandMentionCount: a.brandMentionCount, recommended: rec ? rec.recommended : null, recommendationMethod: rec ? rec.method : null, competitorMentions: a.competitorMentions, officialCited: cls.officialCited, thirdPartyCited: cls.thirdPartyCited, officialDomainInText: cls.officialDomainInText, brandListPosition: cls.brandListPosition, officialDomain: target.targetHost || null };
      if (JSON.stringify(analysis) !== JSON.stringify(e.analysis)) changed += 1;
      await AiVisibilityEvidence.updateOne({ _id: e._id }, { $set: { analysis, citations, firstPartyPages: a.targetPages, externalDomains: [...new Set(citations.filter((c) => c.valid && !c.isTarget).map((c) => c.host))] } });
    }
    const all = await AiVisibilityEvidence.find({ runId: run._id }).select('status group intent analysis citations firstPartyPages externalDomains cost questionId').lean();
    const metrics = computeApprovedQuestionMetrics(all, target, { questionsPlanned: run.questionSnapshot?.length || all.length, costUnit: config.costUnit, budget: config.maxRunCost });
    await ChatGptVisibilityRun.updateOne({ _id: run._id }, { $set: { target, metrics } });
    console.log(`run ${run._id}: brand names ${JSON.stringify(target.brandNames)} -> visibility ${metrics.overview.visibilityAnswers}/${metrics.overview.eligibleAnswers}`);
  }
  console.log(`Re-analysed ${runs.length} runs; ${changed} answers changed.`);
  await mongoose.disconnect();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
