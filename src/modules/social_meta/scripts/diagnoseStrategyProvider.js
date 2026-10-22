/**
 * Real-provider diagnostic for AI Strategy generation. Prints ONLY sanitised facts: timing, token counts, the shape of the tool result,
 * and the validation result as { attempt, path, code, rule } - never the model's text, the business profile, a prompt, a header or a key.
 *
 *   node src/modules/social_meta/scripts/diagnoseStrategyProvider.js --project <projectId> [--runs 1]
 *       DRY: reads the project's latest stored profile snapshot, makes the real provider call(s), validates the answer exactly as the
 *       service does (including the repair prompt on a refusal). Writes NOTHING.
 *   node src/modules/social_meta/scripts/diagnoseStrategyProvider.js --project <projectId> --user <userId> --live
 *       LIVE: runs the real generation through the service (claim -> provider -> validate -> repair -> persist). Creates the next version.
 *
 * Requires ANTHROPIC_API_KEY (the same one the app uses). Run from the odito_backend root so .env is found.
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

const arg = (name, fallback = null) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? fallback : (process.argv[i + 1]?.startsWith('--') ? true : process.argv[i + 1] ?? true); };

const projectId = arg('project');
if (!projectId || projectId === true) { console.error('usage: --project <projectId> [--runs N] [--live --user <userId>]'); process.exit(2); }

await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 5000 });
const { default: SocialAIStrategy } = await import('../model/SocialAIStrategy.js');
const { buildSystemPrompt, buildUserPrompt } = await import('../service/aiStrategy/socialAIStrategyPromptBuilder.js');
const { computeProfileGaps, snapshotFactsText } = await import('../service/aiStrategy/profileSnapshot.js');
const { validateStrategyOutput } = await import('../service/aiStrategy/strategyOutputSchema.js');
const { attemptRecord, describeProviderFailure } = await import('../service/aiStrategy/strategyDiagnostics.js');
const { default: provider } = await import('../service/aiStrategy/claudeStrategyProvider.js');
const { STRATEGY_MODEL, STRATEGY_MAX_OUTPUT_TOKENS, STRATEGY_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS } = await import('../service/aiStrategy/strategyConfig.js');

const report = (o) => console.log(JSON.stringify(o, null, 1));

try {
  if (arg('live')) {
    const userId = arg('user');
    const { startGeneration } = await import('../service/aiStrategy/socialAIStrategyService.js');
    const started = Date.now();
    const r = await startGeneration(projectId, userId, { background: false });
    const doc = await SocialAIStrategy.findOne({ project_id: projectId }).sort({ version: -1 }).lean();
    report({
      mode: 'live', seconds: Math.round((Date.now() - started) / 1000), started: r.started, version: doc?.version, status: doc?.status, model: doc?.generation?.model, attempts: doc?.generation?.attempts,
      usage: doc?.generation?.usage, failure: doc?.failure?.code ? { code: doc.failure.code, validation: doc.failure.validation } : null,
    });
  } else {
    const stored = await SocialAIStrategy.findOne({ project_id: projectId, 'profileSnapshot.data': { $ne: null } }).sort({ version: -1 }).lean();
    if (!stored) { console.error('no stored profile snapshot for that project (generate once, or use --live)'); process.exit(1); }
    const data = stored.profileSnapshot.data;
    const gaps = computeProfileGaps(data);
    const runs = Math.max(1, Number(arg('runs', 1)) || 1);
    report({ mode: 'dry', model: STRATEGY_MODEL, maxOutputTokens: STRATEGY_MAX_OUTPUT_TOKENS, timeoutMs: STRATEGY_TIMEOUT_MS, idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS, providerConfigured: provider.isAvailable() });
    for (let run = 1; run <= runs; run += 1) {
      const options = { prohibitedPhrases: data.prohibitedPhrases, suppliedCompetitors: (data.competitors || []).map((c) => c.name), allowedFactsText: snapshotFactsText(data) };
      let feedback = [];
      const attempts = [];
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const started = Date.now();
        try {
          const result = await provider.generateStrategy({ system: buildSystemPrompt(), user: buildUserPrompt({ snapshotData: data, profileGaps: gaps, previous: null, repairFeedback: feedback }) });
          const check = validateStrategyOutput(result.parsed, options);
          attempts.push({
            attempt, seconds: Math.round((Date.now() - started) / 1000), inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, model: result.model,
            toolResultChars: JSON.stringify(result.parsed).length, topLevelKeys: Object.keys(result.parsed || {}).length,
            accepted: check.ok, trimmedLists: check.ok ? check.trimmed : undefined, ...(check.ok ? {} : attemptRecord({ attempt, errors: check.errors, outputTokens: result.usage.outputTokens })),
          });
          if (check.ok) break;
          feedback = check.errors.slice(0, 15);
        } catch (error) {
          attempts.push({ attempt, seconds: Math.round((Date.now() - started) / 1000), providerFailure: describeProviderFailure(error) });
          break;
        }
      }
      report({ run, attempts });
    }
  }
} finally {
  await mongoose.connection.close();
}
