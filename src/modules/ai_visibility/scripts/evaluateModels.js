/**
 * Compare ChatGPT models on the SAME questions, target business, market and evaluation rules. PAID: every question x model x repeat is
 * one DataForSEO request, so it refuses to run without --confirm. Nothing is written to the database; a JSON report goes to stdout.
 *
 *   npm run visibility:evaluate -- --project <id> --models gpt-4o-mini,gpt-5.4-mini --limit 5 --repeat 2 --confirm
 *   npm run visibility:evaluate -- --project <id> --question "Which eye hospitals near Gangapur Road offer cataract surgery?" --models gpt-4o-mini,gpt-6-sol --confirm
 *
 * Models are checked against the account's model list first; an unsupported model is reported and skipped (never substituted).
 * Per model: mention / recommendation / official-site citation / third-party citation rates, competitor mentions, invalid citation
 * URLs, latency, provider-reported cost (unknown is reported as unknown) and repeatability (share of questions whose mention result was
 * identical across repeats). One answer proves nothing: use several questions and repeats before choosing a model.
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { getChatGptConfig } from '../chatgpt_visibility/config/chatgptConfig.js';
import { executeChatGptPrompt } from '../chatgpt_visibility/providers/dataForSeoChatGptProvider.js';
import { listSupportedModels } from '../chatgpt_visibility/providers/modelCatalog.js';
import { buildBusinessProfile } from '../shared/services/businessProfileService.js';
import { findMentions } from '../shared/services/brandMatchingService.js';
import { classifyCitations } from '../shared/services/citationNormalizationService.js';
import { detectRecommendation } from '../shared/services/recommendationDetection.js';
import AiVisibilityQuestionSet from '../shared/questions/models/AiVisibilityQuestionSet.js';

dotenv.config();

const arg = (name, dflt = null) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : dflt; };
const has = (name) => process.argv.includes(`--${name}`);

async function main() {
  const projectId = arg('project');
  const models = (arg('models', 'gpt-4o-mini') || '').split(',').map((m) => m.trim()).filter(Boolean);
  const repeat = Math.max(1, Math.min(5, Number(arg('repeat', 1)) || 1));
  const limit = Math.max(1, Math.min(30, Number(arg('limit', 5)) || 5));
  if (!projectId) throw new Error('--project <id> is required');
  await mongoose.connect(process.env.MONGO_URI);
  const profile = await buildBusinessProfile(projectId);
  const brandNames = [profile.business.name, ...profile.business.aliases].filter(Boolean);
  const market = { ...profile.market };
  let questions = arg('question') ? [arg('question')] : null;
  if (!questions) {
    const set = await AiVisibilityQuestionSet.findOne({ projectId, status: 'approved' }).lean();
    questions = (set?.questions || []).filter((q) => q.enabled && q.group === 'visibility').slice(0, limit).map((q) => q.text);
  }
  await mongoose.disconnect();
  const requests = questions.length * models.length * repeat;
  if (!has('confirm')) {
    console.log(JSON.stringify({ dryRun: true, questions, models, repeat, paidRequests: requests, note: 'Add --confirm to send these paid requests.' }, null, 2));
    return;
  }

  const supported = new Set((await listSupportedModels()).map((m) => m.model_name));
  const report = { business: brandNames[0], officialDomain: profile.website.targetHost, market: { city: market.city, countryCode: market.countryCode }, questions, repeat, models: [] };
  for (const model of models) {
    if (!supported.has(model)) { report.models.push({ model, skipped: 'MODEL_NOT_SUPPORTED' }); continue; }
    const config = { ...getChatGptConfig(), model };
    const rows = [];
    for (const q of questions) {
      for (let r = 0; r < repeat; r += 1) {
        const started = Date.now();
        try {
          const res = await executeChatGptPrompt({ prompt: q, market, tag: `odito-eval:${model}` }, { config });
          const cls = classifyCitations({ answerText: res.answerText, annotations: res.annotations, targetHost: profile.website.targetHost, brandNames });
          rows.push({
            question: q, repeat: r + 1, ok: true, modelReported: res.model, latencyMs: Date.now() - started, cost: res.cost,
            mentioned: findMentions(res.answerText, brandNames).length > 0,
            recommended: detectRecommendation(res.answerText, brandNames).recommended,
            officialCited: cls.officialCited, officialPages: cls.officialPages, thirdPartyCited: cls.thirdPartyCited, thirdPartyHosts: cls.thirdPartyHosts,
            officialDomainInText: cls.officialDomainInText, brandListPosition: cls.brandListPosition,
            invalidCitations: cls.citations.filter((c) => !c.valid).length,
            competitors: findMentions(res.answerText, profile.business.competitors).map((m) => m.name),
          });
        } catch (error) {
          rows.push({ question: q, repeat: r + 1, ok: false, errorCode: error?.code || 'ERROR', latencyMs: Date.now() - started });
        }
      }
    }
    const ok = rows.filter((x) => x.ok);
    const rate = (k) => (ok.length ? Math.round((ok.filter((x) => x[k]).length / ok.length) * 1000) / 1000 : null);
    const byQ = new Map();
    for (const x of ok) byQ.set(x.question, [...(byQ.get(x.question) || []), x.mentioned]);
    const repeated = [...byQ.values()].filter((v) => v.length > 1);
    const known = ok.filter((x) => typeof x.cost === 'number');
    report.models.push({
      model, answered: ok.length, failed: rows.length - ok.length,
      mentionRate: rate('mentioned'), recommendationRate: rate('recommended'), officialCitationRate: rate('officialCited'), thirdPartyCitationRate: rate('thirdPartyCited'),
      officialDomainInTextRate: rate('officialDomainInText'), invalidCitations: ok.reduce((n, x) => n + x.invalidCitations, 0),
      avgLatencyMs: ok.length ? Math.round(ok.reduce((n, x) => n + x.latencyMs, 0) / ok.length) : null,
      knownCost: known.length ? Math.round(known.reduce((n, x) => n + x.cost, 0) * 1e6) / 1e6 : null, unknownCostCount: ok.length - known.length,
      mentionRepeatability: repeated.length ? Math.round((repeated.filter((v) => v.every((b) => b === v[0])).length / repeated.length) * 1000) / 1000 : null,
      rows,
    });
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => { console.error(e.message); process.exit(1); });
