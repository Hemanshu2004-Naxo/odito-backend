import { generateConceptOptions } from './conceptPipeline.js';
import { isBriefProviderOverridden } from './creativeBrief.js';
import { snapshotFactsText } from '../../aiStrategy/profileSnapshot.js';
import { BRIEF_VERSION, SINGLE_LAYOUTS } from './conceptConfig.js';
import { registerProjectFonts } from '../../brandFontService.js';

const STYLE_LABELS = { photo: 'Photo', '3d_render': '3D render', editorial_illustration: 'Editorial illustration', bold_typographic: 'Bold type' };

/**
 * The bridge between a post and the CONCEPT pipeline (creative brief -> image -> overlay -> QC): what the pipeline is given
 * (caption, pillar, the business facts it may show, the brand, the latest designs for rotation) and what a design version stores
 * about it (the brief as drawn, the exact image prompt, the image model ids, quality, size, QC, every call's cost).
 *
 * Kill switch: SOCIAL_AI_DESIGN_PIPELINE=rules goes back to the rule-based designs everywhere.
 */

export const PIPELINE = Object.freeze({ CONCEPT: 'concept', RULES: 'rules' });

/** Is the concept pipeline used for this run? `imageProviderOverridden` = a test substituted the image provider; then the brief
 *  provider must be substituted too (a test never reaches the real Claude API through this path). */
export function conceptPipelineActive({ imageProviderOverridden = false } = {}) {
  if (String(process.env.SOCIAL_AI_DESIGN_PIPELINE || '').trim().toLowerCase() === PIPELINE.RULES) return false;
  return !imageProviderOverridden || isBriefProviderOverridden();
}

/** Errors after which the post falls back to the rule-based design (the brief or the concept could not be made). A stale run is not one. */
export const conceptFallbackAllowed = (error) => error?.code !== 'DESIGN_STALE';

/** The brand as the pipeline needs it: name, the CURRENT colours, the heading/body font names. */
export function conceptBrand(snapshotData, liveProfile) {
  const b = snapshotData?.brand || {};
  const lb = liveProfile?.brand || {};
  return {
    name: snapshotData?.business?.name || lb.name || '',
    primary: b.primaryColor || lb.primaryColor || null, secondary: b.secondaryColor || lb.secondaryColor || null, accent: b.accentColor || lb.accentColor || null,
    headingFont: lb.fontHeading || b.fontHeading || null, bodyFont: lb.fontBody || b.fontBody || null,
    // the brand's uploaded font files (registered with the renderer by withBrandFonts); null until then
    customFonts: null,
    tone: snapshotData?.toneOfVoice?.primary || '',
  };
}

/** The brand with its uploaded fonts registered for the renderer (Brand Kit font upload). */
export async function withBrandFonts(brand, liveProfile) {
  if (!liveProfile?.project_id || !liveProfile?.brand?.fonts) return brand;
  const keys = await registerProjectFonts(String(liveProfile.project_id), liveProfile.brand.fonts);
  return keys.heading || keys.body ? { ...brand, customFonts: keys } : brand;
}

/** The pipeline input for a post. `recent` = the project's latest concept designs, newest first (for style/layout rotation). */
export function conceptInput(pub, snapshotData, recent = []) {
  return {
    caption: pub.content, pillar: pub.generation?.contentPillar || '', platform: pub.platform, objective: pub.generation?.objective || '',
    audience: snapshotData?.audience?.primary || '', facts: snapshotFactsText(snapshotData).slice(0, 3500), recent, format: 'single_image',
  };
}

/** The latest concept designs of a project in the shape the brief's rotation rule reads. */
export const recentConcepts = (records) => (records || [])
  .map((r) => r.creative?.concept)
  .filter((c) => c?.layout && c?.visual_style)
  .map((c) => ({ layout: c.layout, visual_style: c.visual_style, big_idea: c.big_idea || '' }));

/**
 * ONE concept design for a post. Returns { png, option, run } (the rendered option and the whole run, for the record) or throws
 * (BRIEF_INVALID, CLAUDE_*, an image-provider error, TEXT_DOES_NOT_FIT, CONCEPT_FAILED).
 */
export async function produceConceptDesign({ pub, snapshotData, liveProfile, recent, provider, logo = null, quality = 'medium', onStage = null }) {
  const brand = await withBrandFonts(conceptBrand(snapshotData, liveProfile), liveProfile);
  const run = await generateConceptOptions({ input: conceptInput(pub, snapshotData, recent), count: 1, provider, brand, logo, shape: 'portrait', quality, onStage });
  const option = run.options[0];
  if (option?.cause && typeof option.cause === 'object') { option.cause.costUsd = run.costUsd; throw option.cause; }
  if (!option || option.error) {
    throw Object.assign(new Error('concept failed'), { code: option?.error?.code || 'CONCEPT_FAILED', reason: option?.error?.reason || null, costUsd: run.costUsd, photoStep: option?.error?.photoStep || false });
  }
  return { png: option.png, option, run, brand };
}

const round4 = (n) => Math.round((n || 0) * 10_000) / 10_000;

/** What a design version stores about a concept design (additive fields on SocialDesignGeneration). */
export function conceptRecordFields({ option, run, brand = {} }) {
  const { concept } = option;
  const fonts = option.report?.fonts || {};
  const fontMissing = (brand.headingFont && fonts.headingFromBrand === false) || (brand.bodyFont && fonts.bodyFromBrand === false);
  return {
    creative: {
      pipeline: PIPELINE.CONCEPT,
      type: concept.visual_style, label: `${STYLE_LABELS[concept.visual_style] || concept.visual_style} · ${SINGLE_LAYOUTS[concept.layout]?.label || concept.layout}`.slice(0, 80), layoutId: concept.layout, briefVersion: BRIEF_VERSION,
      logoApplied: option.report?.mark?.kind === 'logo', referencePhotos: 0,
      notes: [...new Set([...(option.report?.notes || []), ...(fontMissing ? ['brand_font_unavailable'] : []), ...(option.dropped ? [`${option.dropped}_dropped_to_fit`] : [])])],
      concept: {
        format: concept.format || 'single_image', big_idea: concept.big_idea, hook_headline: concept.hook_headline, subline: concept.subline || '', cta: concept.cta || '',
        kicker: concept.kicker || '', visual_style: concept.visual_style, layout: concept.layout, image_prompt: concept.image_prompt,
        headline_candidates: (concept.headline_candidates || []).slice(0, 5).map((h) => String(h).slice(0, 120)), image_labels: (concept.image_labels || []).slice(0, 2),
      },
      imagePrompt: option.imagePrompt,
      image: {
        model: option.image?.model || null, modelReturned: option.image?.modelReturned || null, fallbackUsed: !!option.image?.fallbackUsed,
        quality: option.image?.quality || null, size: option.image?.size || null, seed: null, referenceImages: 0,
      },
      qc: {
        score: option.qc?.score ?? null, passed: !!option.qc?.passed, hardFail: !!option.qc?.hardFail, wordCount: option.qc?.wordCount ?? null,
        issues: (option.qc?.issues || []).slice(0, 10).map((s) => String(s).slice(0, 300)), checks: option.qc?.checks || null, attempts: (option.attempts || []).length,
        retries: (option.retries || []).slice(0, 6),
        needsAttention: option.needsAttention ? { score: option.needsAttention.score ?? null, failure: option.needsAttention.failure || null, reasons: (option.needsAttention.reasons || []).map((r) => String(r).slice(0, 300)) } : null,
      },
    },
    cost: {
      usd: round4(run.costUsd),
      calls: [...run.brief.calls, ...option.calls].map((c) => ({
        step: c.step || c.kind, kind: c.kind, model: c.model || null, modelReturned: c.modelReturned || null, inputTokens: c.usage?.inputTokens || 0, outputTokens: c.usage?.outputTokens || 0,
        durationMs: c.durationMs ?? null, usd: round4(c.costUsd),
      })),
    },
  };
}

export default { conceptPipelineActive, produceConceptDesign, conceptRecordFields, recentConcepts, conceptBrand, conceptInput, PIPELINE };
