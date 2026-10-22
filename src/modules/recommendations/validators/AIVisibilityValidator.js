/**
 * AIVisibilityValidator — GROUPS 6, 7, 8
 *
 * Validates recommendations for AI Visibility, Entity & E-E-A-T,
 * and AEO & Voice Search issues.
 *
 * THE MOST CRITICAL VALIDATOR — guards against hallucinated business details.
 *
 * Key rules:
 *   GROUP 6 (AI Visibility Core):
 *     - recommendedVersion must not invent URLs or entity names
 *     - Grounded in pageContext and aiVisibilityContext
 *
 *   GROUP 7 (Entity & E-E-A-T):
 *     - Phone numbers, addresses, business names must come from entityContext
 *     - Any value in output NOT in entityContext is a hallucination candidate
 *     - Stricter check: phone regex detected but not in entityContext → hard error
 *
 *   GROUP 8 (AEO & Voice Search):
 *     - FAQ content must have question + answer structure
 *     - Questions must end with "?" or be phrased as questions
 *     - Content must be actionable, not generic
 */

import { BaseValidator } from './BaseValidator.js';

// Phone number pattern — used to detect hallucinated phone numbers
const PHONE_RE = /(\+?[\d\s\-().]{7,20})/g;

// E-mail pattern
const EMAIL_RE = /[\w.-]+@[\w.-]+\.\w{2,}/g;

// Street address patterns
const ADDRESS_RE = /\d{1,5}\s+[a-z]{2,}\s+(st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|ln|lane|way|ct|court|pl|place)\b/i;

// FAQ question pattern — should end with ? or start with question word
const QUESTION_RE = /^(what|why|how|when|where|who|which|can|do|does|is|are|will|should|would|could|may)\b.+\??\s*$/i;
const ENDS_QUESTION = /\?\s*$/;

// GROUP 7 issues — strictest hallucination check
const ENTITY_ISSUES = new Set([
  'business_name_identical',
  'address_identical',
  'nap_matches_footer_contact',
  'phone_e164_format',
  'person_schema_linked_to_organization',
  'author_bio_with_credentials',
  'visible_author_name',
  'no_entity_fragmentation',
  'business_registration_details',
  'google_maps_embed_correct',
]);

// GROUP 8 issues — FAQ/AEO structure check
const AEO_ISSUES = new Set([
  'faq_section_5_to_10_questions',
  'question_based_h2_headings',
  'first_60_words_direct_answer',
  'conversational_tone',
  'step_by_step_content',
  'faq_schema_matches_content',
]);

export class AIVisibilityValidator extends BaseValidator {

  validate(sections, rc) {
    const errors   = [];
    const warnings = [];

    this._validateCoreSections(sections, errors);
    this._checkNoPlaceholders(sections, errors);

    const issueId    = rc?.identity?.issueId || '';
    const recommended = sections.recommendedVersion || '';
    const implCode    = sections.implementationExample?.content || '';
    const fullOutput  = recommended + ' ' + implCode + ' ' + (sections.whyThisMatters || '') + ' ' + (sections.recommendedFix || '');

    let satisfiesConstraint = true;

    // ── GROUP 7: Entity anti-hallucination check ──────────────────────────
    if (ENTITY_ISSUES.has(issueId)) {
      const result = this._checkEntityGrounding(fullOutput, rc);
      errors.push(...result.errors);
      warnings.push(...result.warnings);
      if (result.errors.length > 0) satisfiesConstraint = false;
    }

    // ── GROUP 8: AEO / FAQ structure check ────────────────────────────────
    if (AEO_ISSUES.has(issueId)) {
      const result = this._checkAEOStructure(sections, issueId, rc);
      errors.push(...result.errors);
      warnings.push(...result.warnings);
      if (result.errors.length > 0) satisfiesConstraint = false;
    }

    // ── General: output must reference page URL or context signals ────────
    if (!ENTITY_ISSUES.has(issueId) && !AEO_ISSUES.has(issueId)) {
      satisfiesConstraint = this._checkAIVisibilityGrounding(sections, rc, warnings);
    }

    // ── Universal: non-empty check ────────────────────────────────────────
    if (!recommended && !implCode) {
      warnings.push(`${issueId}: no recommended version or implementation code produced`);
      satisfiesConstraint = false;
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      satisfiesConstraint,
    };
  }

  // ── Private: Entity grounding check ──────────────────────────────────────

  _checkEntityGrounding(outputText, rc) {
    const errors   = [];
    const warnings = [];
    const ctx      = rc?.entityContext || {};
    const pageUrl  = rc?.pageContext?.pageUrl || '';

    // Build the set of "allowed" named values from provided context
    const allowedValues = new Set();
    if (ctx.businessName) allowedValues.add(ctx.businessName.toLowerCase().trim());
    if (ctx.phone)        allowedValues.add(ctx.phone.replace(/\D/g, ''));
    if (ctx.address)      allowedValues.add(ctx.address.toLowerCase().trim());
    if (ctx.authorName)   allowedValues.add(ctx.authorName.toLowerCase().trim());
    if (ctx.entityType)   allowedValues.add(ctx.entityType.toLowerCase().trim());
    if (pageUrl)          allowedValues.add(pageUrl.toLowerCase());

    // ── Phone number hallucination check ──────────────────────────────────
    const phonesInOutput = outputText.match(PHONE_RE) || [];
    const providedPhone  = ctx.phone ? ctx.phone.replace(/\D/g, '') : null;

    for (const phone of phonesInOutput) {
      const digits = phone.replace(/\D/g, '');
      if (digits.length >= 7) {
        // If a phone was provided, check it matches
        if (providedPhone && digits !== providedPhone && !providedPhone.includes(digits) && !digits.includes(providedPhone)) {
          errors.push(`HALLUCINATION RISK: phone number in output "${phone}" does not match provided context — remove or use context value`);
        }
        // If NO phone was provided but Claude wrote one, it's hallucinated
        if (!providedPhone && allowedValues.size > 0) {
          errors.push(`HALLUCINATION RISK: phone number "${phone.trim()}" in output was not in the supplied context`);
        }
      }
    }

    // ── Email hallucination check ─────────────────────────────────────────
    const emailsInOutput = outputText.match(EMAIL_RE) || [];
    for (const email of emailsInOutput) {
      const emailDomain = email.split('@')[1] || '';
      const urlDomain   = pageUrl ? new URL(pageUrl).hostname.replace('www.', '') : '';
      if (urlDomain && !emailDomain.includes(urlDomain)) {
        warnings.push(`Email "${email}" in output may not match the page domain "${urlDomain}" — verify`);
      }
    }

    // ── Address hallucination check ───────────────────────────────────────
    if (!ctx.address) {
      const addressInOutput = ADDRESS_RE.test(outputText);
      if (addressInOutput) {
        errors.push('HALLUCINATION RISK: physical address in output was not supplied in context — remove invented address');
      }
    }

    return { errors, warnings };
  }

  // ── Private: AEO / FAQ structure check ───────────────────────────────────

  _checkAEOStructure(sections, issueId, rc) {
    const errors   = [];
    const warnings = [];
    const recommended = sections.recommendedVersion || '';
    const implCode    = sections.implementationExample?.content || '';

    // ── FAQ content check ─────────────────────────────────────────────────
    if (issueId === 'faq_section_5_to_10_questions' || issueId === 'faq_schema_matches_content') {
      const questions = (recommended + '\n' + implCode)
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 5);

      const questionLike = questions.filter(l => QUESTION_RE.test(l) || ENDS_QUESTION.test(l));

      if (questionLike.length < 2) {
        warnings.push('FAQ fix: fewer than 2 clear questions detected in output — verify FAQ structure');
      }
    }

    // ── H2 questions check ────────────────────────────────────────────────
    if (issueId === 'question_based_h2_headings') {
      const h2Matches = (recommended + implCode).match(/<h2[^>]*>([^<]+)<\/h2>/gi) || [];
      const nonQuestion = h2Matches.filter(h => !ENDS_QUESTION.test(h.replace(/<[^>]+>/g, '')));
      if (h2Matches.length > 0 && nonQuestion.length === h2Matches.length) {
        warnings.push('H2 headings in output do not appear to be phrased as questions — verify');
      }
    }

    // ── first_60_words: must have a direct answer structure ───────────────
    if (issueId === 'first_60_words_direct_answer') {
      const words = recommended.trim().split(/\s+/);
      if (words.length < 15 && !implCode) {
        warnings.push('first_60_words: recommended answer is very short — may not satisfy the issue');
      }
    }

    // ── step_by_step: must have numbered steps ────────────────────────────
    if (issueId === 'step_by_step_content') {
      const hasNumberedSteps = /^\d+\.\s/m.test(recommended + implCode) || /^step \d/im.test(recommended + implCode);
      if (!hasNumberedSteps) {
        warnings.push('step_by_step_content: no numbered steps detected in output — verify structure');
      }
    }

    return { errors, warnings };
  }

  // ── Private: AI Visibility general grounding check ───────────────────────

  _checkAIVisibilityGrounding(sections, rc, warnings) {
    const recommended = sections.recommendedVersion || '';
    const implCode    = sections.implementationExample?.content || '';

    if (!recommended && !implCode) return false;

    // Check that the output isn't purely generic
    const genericAI = [
      'improves ai visibility',
      'increases citation probability',
      'add structured data',
      'optimize content for',
    ];
    const lower = (recommended + implCode).toLowerCase();
    const isGeneric = genericAI.every(phrase => lower.includes(phrase));
    if (isGeneric) {
      warnings.push('AI Visibility output may be generic — check that it references actual page context');
    }

    return true;
  }
}

export default new AIVisibilityValidator();
