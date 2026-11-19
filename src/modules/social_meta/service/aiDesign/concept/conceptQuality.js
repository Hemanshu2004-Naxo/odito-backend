import sharp from 'sharp';
import claudeStrategyProvider from '../../aiStrategy/claudeStrategyProvider.js';
import { MAX_WORDS_PER_IMAGE, QC_PASS_SCORE, CONCEPT_TEXT_MODEL, CONCEPT_TIMEOUT_MS } from './conceptConfig.js';
import { unsupportedClaims, awkwardHeadline } from './creativeBrief.js';

/**
 * The QUALITY CHECK of a finished concept design, before anyone sees it. Two halves:
 *   deterministic  every word on the image counted (<= 15), no figure or promise the caption/facts do not state, every text inside
 *                  the canvas (nothing cropped), nothing shortened by the renderer (it never shortens; this proves it)
 *   visual         Claude looks at the rendered image with a checklist: readable at phone size, spelling, the picture matches the
 *                  big idea, AI artifacts (hands, faces, warped objects), stock / template look, on brand, invented facts, cut-off text
 * Score 1-10. A design with cut-off text, an invented fact, a misspelling or a sensitive misreading is REJECTED whatever else it
 * scores (score capped at 3). Mixed styles, an awkward headline, unclear symbols or text over a busy area cap it at 6 (one new attempt).
 */

export const QC_TOOL = 'report_design_quality';

const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean);

/** Every word drawn on the image (what the renderer reports, else the brief). */
export function imageText(brief, report = null) {
  const drawn = report ? new Set((report.texts || []).map((t) => t.label)) : null;
  const has = (label) => !drawn || drawn.has(label);
  return [has('kicker') && brief.kicker, has('headline') && brief.hook_headline, has('subline') && brief.subline, has('cta') && brief.cta, ...(has('label') ? [...(brief.labels || []), ...(brief.image_labels || []).map((l) => l.text)] : [])].filter(Boolean).join(' \n ');
}

/** The deterministic checks. Returns { problems: string[], wordCount, claims }. */
export function deterministicChecks({ brief, report, caption, facts }) {
  const problems = [];
  const text = imageText(brief, report);
  const wordCount = words(text.replace(/→/g, '')).length;
  if (wordCount > MAX_WORDS_PER_IMAGE) problems.push(`${wordCount} words on the image (max ${MAX_WORDS_PER_IMAGE})`);
  const claims = unsupportedClaims(text, `${caption}\n${facts || ''}`);
  if (claims.length) problems.push(`not supported by the caption or facts: ${claims.join(', ')}`);
  for (const t of report?.texts || []) {
    if (t.x != null && (t.x < 0 || t.y < 0 || t.x + t.width > report.width + 1 || t.y + t.height > report.height + 1)) problems.push(`${t.label} runs outside the image (cut off)`);
  }
  if ((report?.shortened || []).length || (report?.overflow || []).length) problems.push('a text was shortened or overflowed its box');
  if (awkwardHeadline(brief.hook_headline)) problems.push(`the headline "${brief.hook_headline}" reads as a riddle / odd personification`);
  // a busy area under the text is covered by a plate, but the picture still failed its empty-area rule: worth one new picture
  // busy pixels under the text are covered by the renderer (scrim / plate): recorded in the report, not a defect of the design
  return { problems, wordCount, claims };
}

function qcToolSchema() {
  const bool = (d) => ({ type: 'boolean', description: d });
  const list = (d) => ({ type: 'array', items: { type: 'string', maxLength: 160 }, maxItems: 8, description: d });
  return {
    type: 'object', additionalProperties: false,
    required: ['score', 'readable_at_phone_size', 'spelling_errors', 'word_count', 'matches_big_idea', 'supports_message', 'message_mismatch', 'ai_artifacts', 'looks_stock_or_template', 'on_brand', 'invented_facts', 'cut_off_text', 'text_over_busy_area', 'sensitive_reading', 'mixed_styles', 'unclear_symbols', 'headline_awkward', 'issues'],
    properties: {
      score: { type: 'integer', minimum: 1, maximum: 10, description: 'Overall quality as a strong social agency would judge it (7 = good enough to post).' },
      readable_at_phone_size: bool('Is every text readable when the image is shown about 375 px wide on a phone?'),
      spelling_errors: list('Misspelled words in the image text, exactly as they appear; [] if none.'),
      word_count: { type: 'integer', minimum: 0, description: 'How many words of text you can see on the image.' },
      matches_big_idea: bool('Does the picture actually show the big idea?'),
      supports_message: bool('Does the visual support the headline\'s MESSAGE, not just its keywords? Judge what a viewer would take from the picture. Example of a FAIL: the headline "Three things holding your website back" (= problems dragging it down) over a three-legged stool (= stability, balance): it matches the word "three" but says the opposite. Another FAIL: "Stop losing leads" over a magnet pulling people in. A picture that shows the message (something weighed down, held back, blocked) passes.'),
      message_mismatch: { type: 'string', maxLength: 200, description: 'When supports_message is false: what the picture says instead, in plain words (e.g. "a stool means stability, the headline is about problems"); "" otherwise.' },
      ai_artifacts: list('Visible AI artifacts: warped hands or fingers, distorted faces, melted or impossible objects, garbled pseudo-text in the picture; [] if none.'),
      looks_stock_or_template: bool('Does it look like a generic stock photo or a flat template (e.g. a smiling team around a laptop, a fake dashboard)?'),
      on_brand: bool('Do the colours and type feel like the brand described?'),
      invented_facts: list('Numbers, results, client names, awards or promises shown on the image that are NOT in the caption or facts; [] if none.'),
      cut_off_text: bool('Is any text cut off, cropped at an edge, overlapping another element or hidden?'),
      text_over_busy_area: bool('Does any text sit directly on a detailed / busy part of the picture without a solid plate or dark scrim behind it?'),
      sensitive_reading: {
        type: 'array', maxItems: 4,
        description: 'Ways the image could be read as a social, political, religious or identity statement (e.g. a woman under a "glass ceiling" = gender discrimination; chains; flags; protests). strong = a typical viewer would likely read it that way; mild = only a stretch. [] if none.',
        items: { type: 'object', additionalProperties: false, required: ['reading', 'strength'], properties: { reading: { type: 'string', maxLength: 160 }, strength: { type: 'string', enum: ['strong', 'mild'] } } },
      },
      mixed_styles: bool('Does the PICTURE itself mix visual styles (e.g. a flat illustration over a blurred photo background, 3D objects in a photo)? The text, chips, plates, scrims and gradient panels Odito adds are NOT a style mix.'),
      unclear_symbols: list('Objects that carry the MESSAGE of this design (e.g. stand for services, a before/after) but whose meaning is not clear from the picture and its labels. Ignore incidental props. [] if none.'),
      headline_awkward: bool('Does the headline read awkwardly - a riddle, an odd personification, unclear on first read?'),
      issues: list('The most important problems to fix, in plain words; [] if none.'),
    },
  };
}

let providerOverride = null;
/** Test seam: substitute the vision provider (same generateStructured contract). */
export const setQualityProviderOverride = (p) => { providerOverride = p || null; };

/**
 * The full check. `png` = the rendered design. Returns { score, passed, checks, issues, deterministic, call }.
 * When the visual check is unavailable the deterministic result stands alone (score null, passed decided by it).
 */
export async function checkDesignQuality({ png, brief, report, caption, facts, brand, context = '', extraExpected = [] }) {
  const det = deterministicChecks({ brief, report, caption, facts });
  let visual = null;
  let call = null;
  try {
    const jpeg = await sharp(png).resize({ width: 1080, withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
    const res = await (providerOverride || claudeStrategyProvider).generateStructured({
      system: 'You are the creative director who signs off social media designs before they are posted. Judge strictly but fairly. Report only what you can see.',
      user: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } },
        { type: 'text', text: [
          `Big idea of this design: ${brief.big_idea}`,
          `The text that should be on it (and nothing else besides the brand name "${brand?.name || ''}" in the top-left corner${extraExpected.length ? `, and ${extraExpected.map((e) => `"${e}"`).join(', ')}` : ''}): ${imageText(brief, report).replace(/\n/g, ' ')}`,
          ...(context ? [context] : []),
          `Visual style asked for: ${brief.visual_style || 'not stated'} (one style only).`,
          'The renderer measured the contrast of every text (WCAG AA) and adds a plate or scrim where the pixels need one; judge readability as you see it, and do not count those plates or scrims as a style mix. Judge the design itself - do not penalise small departures from scene details of the brief (lighting direction, props) when the idea still reads.',
          `Brand: ${brand?.name || ''}; colours ${[brand?.primary, brand?.secondary, brand?.accent].filter(Boolean).join(', ')}; heading font ${brand?.headingFont || ''}.`,
          `<caption>\n${caption}\n</caption>`, `<business_facts>\n${facts || 'none'}\n</business_facts>`,
          'Check the image against every field of the tool and report.',
        ].join('\n') },
      ],
      tool: { name: QC_TOOL, description: 'Report the quality check. Call this exactly once.', schema: qcToolSchema() },
      model: CONCEPT_TEXT_MODEL, maxTokens: 1500, timeoutMs: CONCEPT_TIMEOUT_MS, retries: 1,
    });
    visual = res.parsed;
    call = { step: 'quality_check', model: res.model, usage: res.usage, durationMs: res.durationMs };
  } catch (error) {
    call = { step: 'quality_check', model: CONCEPT_TEXT_MODEL, usage: { inputTokens: 0, outputTokens: 0 }, failed: error?.code || 'error' };
  }

  const soft = [
    // the picture matches the headline's keywords but not its message (e.g. a stool = stability, for "things holding you back"): a concept retry
    ...(visual?.supports_message === false ? [`meaning mismatch: the picture does not support the headline's message${visual.message_mismatch ? ` (${visual.message_mismatch})` : ''}`] : []),
    ...(visual?.mixed_styles ? ['mixes visual styles - keep one style (illustrated / rendered / solid background for non-photo styles)'] : []),
    ...(visual?.headline_awkward ? ['the headline reads awkwardly'] : []),
    ...(visual?.text_over_busy_area ? ['text sits on a busy part of the picture'] : []),
    ...((visual?.unclear_symbols || []).length ? [`unclear symbols: ${visual.unclear_symbols.join('; ')}`] : []),
  ];
  const readings = (visual?.sensitive_reading || []).map((s) => (typeof s === 'string' ? { reading: s, strength: 'strong' } : s));
  // a STRONG misreading rejects the design; a mild one is only reported
  const sensitive = readings.filter((s) => s.strength === 'strong').map((s) => `sensitive reading: ${s.reading}`);
  const mild = readings.filter((s) => s.strength !== 'strong').map((s) => `possible (mild) reading: ${s.reading}`);
  const issues = [...det.problems, ...sensitive, ...soft, ...(visual?.issues || []), ...mild];
  const hardFail = det.problems.some((p) => /cut off|shortened|not supported/.test(p)) || !!visual?.cut_off_text || (visual?.invented_facts || []).length > 0 || (visual?.spelling_errors || []).length > 0 || sensitive.length > 0;
  let score = Number.isInteger(visual?.score) ? visual.score : null;
  if (score != null && (det.problems.length || soft.length)) score = Math.min(score, 6);
  if (score != null && hardFail) score = Math.min(score, 3);
  const passed = score != null ? score >= QC_PASS_SCORE && !hardFail : !det.problems.length;
  return {
    score, passed, hardFail,
    checks: visual ? {
      readable_at_phone_size: visual.readable_at_phone_size, spelling_errors: visual.spelling_errors, word_count: visual.word_count, matches_big_idea: visual.matches_big_idea,
      supports_message: visual.supports_message, message_mismatch: visual.message_mismatch || '',
      ai_artifacts: visual.ai_artifacts, looks_stock_or_template: visual.looks_stock_or_template, on_brand: visual.on_brand, invented_facts: visual.invented_facts, cut_off_text: visual.cut_off_text,
      text_over_busy_area: visual.text_over_busy_area, sensitive_reading: visual.sensitive_reading, mixed_styles: visual.mixed_styles, unclear_symbols: visual.unclear_symbols, headline_awkward: visual.headline_awkward,
    } : null,
    issues: [...new Set(issues)].slice(0, 12),
    deterministic: det,
    call,
  };
}

export default { checkDesignQuality, deterministicChecks, imageText, QC_TOOL };
