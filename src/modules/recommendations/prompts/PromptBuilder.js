/**
 * PromptBuilder
 *
 * Builds context-aware Claude prompts from a normalized RecommendationContext.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ROUTING
 * ─────────────────────────────────────────────────────────────────────────────
 *   1. resolveGroup(issueId)           → GROUP constant
 *   2. resolveMaxTokens(group)         → per-call token budget
 *   3. _buildGroupPrompt(group, rc)    → prompt string
 *
 * Every prompt receives the actual detected values from RecommendationContext —
 * never generic placeholders.  Claude is forbidden from inventing values that
 * are not grounded in the context block.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * OUTPUT CONTRACT (all groups return this JSON shape)
 * ─────────────────────────────────────────────────────────────────────────────
 *   issueAnalysis       — 2-3 sentences: why this hurts AI/SEO specifically
 *   recommendedVersion  — the actual fixed content (text, code, or plan)
 *   beforeAfter         — { before: string, after: string }
 *   implementationNotes — step-by-step implementation guide
 *   implementationCode  — ready-to-paste code (HTML/JSX/JSON-LD as appropriate)
 *   impacts             — string[] of 2-4 specific impact bullets
 *   recovery            — { aiVisibility, semanticTrust, freshness, accessibility } 0-100
 *   difficulty          — "easy" | "medium" | "hard"
 *   estimatedFixTime    — "5 minutes"
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ANTI-HALLUCINATION RULES applied in every prompt:
 *   - Only use values from the CONTEXT block
 *   - Never invent page URLs, brand names, or business details
 *   - recommendedVersion must be derived from the current value — not invented
 *   - Forbidden strings: "your description here", "[insert", "[add", "[placeholder"
 */

import { resolveGroup, resolveMaxTokens, GROUP } from './GroupRegistry.js';
import { renderSchemaEvidence } from '../../schema-evidence/schemaEvidencePrompt.js';
import { PROMPT_MODE } from '../context/RecommendationContextSchema.js';
import { altImagesFromContext } from '../service/imageAltProposals.js';

// Extended anti-hallucination block for entity-sensitive groups (7 & 8)
const ANTI_HALLUCINATION_STRICT = `
CRITICAL RULES — ENTITY SAFETY:
- Use ONLY values provided in the CONTEXT block above
- Never invent: business names, phone numbers, physical addresses, email addresses,
  author credentials, certifications, registration numbers, URLs, or schema values
- If a required value is NOT in the CONTEXT: explicitly state "not provided in context"
- Never write a phone number that was not supplied
- Never write a street address that was not supplied
- Never write an author bio that was not supplied
- If entityContext is empty: state that entity data must be gathered before implementing
- Never fabricate NAP (Name, Address, Phone) data`.trim();

// JSON output format block injected at the end of every prompt
const OUTPUT_FORMAT = `
Return ONLY a valid JSON object with these exact fields (no markdown, no commentary):
{
  "issueAnalysis":       "2-3 sentences on why this specific issue hurts AI/SEO",
  "recommendedVersion":  "the actual fixed content — not instructions, the real thing",
  "beforeAfter":         { "before": "exact current value", "after": "exact fixed value" },
  "implementationNotes": "numbered steps for implementation — framework-specific",
  "implementationCode":  "copy-paste ready code (no markdown code fences)",
  "impacts":             ["specific impact 1", "specific impact 2"],
  "recovery":            { "aiVisibility": 0-100, "semanticTrust": 0-100, "freshness": 0-100, "accessibility": 0-100 },
  "difficulty":          "easy|medium|hard",
  "estimatedFixTime":    "X minutes"
}`.trim();

// Anti-hallucination guard injected into every prompt
const ANTI_HALLUCINATION = `
CRITICAL RULES:
- Use ONLY values provided in the CONTEXT block above
- Never invent brand names, page URLs, or business details not given
- recommendedVersion must be derived from the current value — not invented from scratch
- If the current value is absent, base the recommendation on the page title and URL
- Never output placeholder text: "[your text here]", "[add schema]", "Your description here"
- implementationCode must be copy-paste ready for the stated framework`.trim();

// Additional rules injected when element is absent AND context was inferred
const ANTI_HALLUCINATION_MISSING = `
MISSING ELEMENT RULES:
- The element is absent — you must GENERATE it, not describe how to add it
- Use the DETECTED CONTEXT values to produce the exact, production-ready content
- recommendedVersion MUST reference the specific business, topic, or service detected
- FORBIDDEN: "Your Title Here", "Your Heading Here", "Primary Keyword", "[Service Name]",
             "Your Company", "Your Brand", "Example Title", "Page Topic", "Lorem Ipsum"
- REQUIRED: Generated content must name the actual business/topic/service from DETECTED CONTEXT
- If a value is not in DETECTED CONTEXT, derive it from the page title or URL — do NOT invent`.trim();

class PromptBuilder {

  /**
   * Build a context-aware prompt from a RecommendationContext.
   *
   * @param {object} rc            — RecommendationContext (from RecommendationContextBuilder)
   * @param {object} ruleMetadata  — { title, description, category, severity }
   * @returns {{ prompt: string, maxTokens: number, group: number }}
   */
  build(rc, ruleMetadata = {}) {
    const issueId = rc.identity?.issueId || 'unknown';
    const group   = resolveGroup(issueId);
    const maxTokens = resolveMaxTokens(group);

    const prompt = this._buildGroupPrompt(group, rc, ruleMetadata);

    return { prompt, maxTokens, group };
  }

  /**
   * Build a repair prompt for a second attempt when the first attempt failed a
   * specific constraint (e.g. character count too long, cross-domain canonical).
   *
   * The repair prompt re-states the original task and adds a targeted REPAIR
   * instruction so Claude can fix the specific problem without regenerating
   * from scratch.
   *
   * @param {object} rc             — RecommendationContext
   * @param {object} ruleMetadata
   * @param {string} previousOutput — Claude's raw JSON string from attempt 1
   * @param {string[]} failureReasons — validation warnings that caused the retry
   * @returns {{ prompt: string, maxTokens: number, group: number }}
   */
  buildRepair(rc, ruleMetadata = {}, previousOutput = '', failureReasons = []) {
    const issueId   = rc.identity?.issueId || 'unknown';
    const group     = resolveGroup(issueId);
    const maxTokens = resolveMaxTokens(group);

    const basePrompt = this._buildGroupPrompt(group, rc, ruleMetadata);
    const repairBlock = this._buildRepairBlock(rc, previousOutput, failureReasons);

    const prompt = `${basePrompt}

${repairBlock}`;

    return { prompt, maxTokens, group };
  }

  /**
   * Build the REPAIR block appended to the original prompt on retry.
   * @private
   */
  _buildRepairBlock(rc, previousOutput, failureReasons) {
    const lines = [];
    lines.push('─────────────────────────────────────────────────────────────');
    lines.push('REPAIR INSTRUCTIONS (your previous attempt had the following issues):');
    lines.push('');

    for (const reason of failureReasons) {
      lines.push(`  ✗ ${reason}`);
    }
    lines.push('');

    // Add targeted fix guidance based on failure pattern
    const reasonText = failureReasons.join(' ').toLowerCase();

    if (reasonText.includes('chars too long') || reasonText.includes('exceeds maximum')) {
      const es = rc?.expectedState;
      const max = es?.targetMax;
      const unit = 'characters';
      lines.push(`REQUIRED FIX: Your recommendedVersion is too long.`);
      if (max) lines.push(`  It MUST be at most ${max} ${unit}.`);
      lines.push('  Shorten it by cutting redundant phrases while keeping the core meaning and primary keyword.');
      lines.push('  Do NOT change the topic or brand voice.');
    } else if (reasonText.includes('chars too short') || reasonText.includes('below minimum')) {
      const es = rc?.expectedState;
      const min = es?.targetMin;
      lines.push(`REQUIRED FIX: Your recommendedVersion is too short.`);
      if (min) lines.push(`  It MUST be at least ${min} characters.`);
      lines.push('  Expand it by adding a genuine supporting detail, qualifying phrase, or CTA.');
      lines.push('  Do NOT add filler words or generic padding.');
    } else if (reasonText.includes('robots directive')) {
      lines.push(`REQUIRED FIX: Your recommendedVersion was not one of the 4 exact allowed robots directive strings.`);
      lines.push(`  recommendedVersion MUST be EXACTLY one of: "index, follow", "noindex, follow", "index, nofollow", "noindex, nofollow" — no other wording, no HTML.`);
      lines.push(`  For this issue, the correct value is almost always "index, follow" (remove both restrictions).`);
      lines.push(`  Put the full HTML <meta name="robots" content="..."> tag in "implementationCode" instead — never in "recommendedVersion".`);
    } else if (reasonText.includes('markup') || reasonText.includes('html')) {
      const pageUrl = rc?.pageContext?.pageUrl || '';
      lines.push(`REQUIRED FIX: Your recommendedVersion contained an HTML tag instead of a plain URL.`);
      lines.push(`  recommendedVersion MUST be ONLY the bare URL string${pageUrl ? ` (e.g. "${pageUrl}")` : ''} — no <link>, no quotes, no markup of any kind.`);
      lines.push(`  Put the full HTML <link rel="canonical" href="..."> tag in "implementationCode" instead — never in "recommendedVersion".`);
    } else if (reasonText.includes('cross-domain') || reasonText.includes('canonical')) {
      const pageUrl = rc?.pageContext?.pageUrl || '';
      try {
        const domain = new URL(pageUrl).hostname;
        lines.push(`REQUIRED FIX: Your canonical URL uses the wrong domain.`);
        lines.push(`  The canonical URL MUST use the domain: ${domain}`);
        lines.push(`  Do NOT use a different domain.`);
      } catch {
        lines.push('REQUIRED FIX: Your canonical URL is invalid. Use the page\'s own domain.');
      }
    } else if (reasonText.includes('placeholder')) {
      lines.push('REQUIRED FIX: Your output contains placeholder text (e.g. "[your text here]").');
      lines.push('  Replace ALL placeholder text with real, specific content derived from the CONTEXT block.');
      lines.push('  If a value is not in the context, say "not provided" — do NOT use a placeholder.');
    } else if (reasonText.includes('og tag') || reasonText.includes('not addressed')) {
      const missing = rc?.technicalContext?.ogFieldsMissing || [];
      if (missing.length > 0) {
        lines.push(`REQUIRED FIX: You did not address these OG tag fields: ${missing.join(', ')}`);
        lines.push('  Your recommendedVersion and implementationCode MUST include ALL of these fields.');
      }
    } else {
      lines.push('REQUIRED FIX: Revise your response to satisfy the constraint stated above.');
    }

    lines.push('');
    lines.push('YOUR PREVIOUS recommendedVersion WAS:');
    if (previousOutput) {
      try {
        const parsed = typeof previousOutput === 'string' ? JSON.parse(previousOutput) : previousOutput;
        const prev = parsed.recommendedVersion || '(not provided)';
        lines.push(`  "${String(prev).slice(0, 200)}"`);
      } catch {
        lines.push(`  ${String(previousOutput).slice(0, 200)}`);
      }
    }
    lines.push('');
    lines.push('Now generate an improved version that fixes the issues above.');
    lines.push('Return the SAME JSON format — all fields required.');

    return lines.join('\n');
  }

  // ── Group Dispatch ────────────────────────────────────────────────────────

  _buildGroupPrompt(group, rc, ruleMetadata) {
    switch (group) {
      case GROUP.TEXT_OPTIMIZATION:    return this._group1_TextOptimization(rc, ruleMetadata);
      case GROUP.CONTENT_OPTIMIZATION: return this._group2_ContentOptimization(rc, ruleMetadata);
      case GROUP.TECHNICAL_SEO:        return this._group3_TechnicalSEO(rc, ruleMetadata);
      case GROUP.SCHEMA:               return this._group4_Schema(rc, ruleMetadata);
      case GROUP.ACCESSIBILITY:        return this._group5_Accessibility(rc, ruleMetadata);
      case GROUP.AI_VISIBILITY:        return this._group6_AIVisibility(rc, ruleMetadata);
      case GROUP.ENTITY_EEAT:          return this._group7_EntityEEAT(rc, ruleMetadata);
      case GROUP.AEO_VOICE:            return this._group8_AEOVoice(rc, ruleMetadata);
      default:                         return this._group3_TechnicalSEO(rc, ruleMetadata);
    }
  }

  // ── GROUP 1: Text Optimization ────────────────────────────────────────────
  // Handles: title_*, meta_description_*, keyword_not_in_*,
  //          h1_missing, multiple_h1_tags, heading_hierarchy_skipped
  //
  // Primary signal: currentState.rawText is the text to improve.
  // Task: rewrite it to satisfy objective.constraint while preserving intent.

  _group1_TextOptimization(rc, ruleMetadata) {
    const { identity, currentState, expectedState, pageContext, contentContext, missingElementContext, recommendationObjective: obj } = rc;
    const issueId  = identity.issueId;
    const isAbsent = currentState.isAbsent;
    const label    = currentState.label || obj.target || 'content';
    const fw       = pageContext.framework;
    const fwLabel  = fw !== 'unknown' ? fw : (pageContext.cms || 'standard HTML');
    const mec      = isAbsent ? missingElementContext : null;

    // ── Context block ─────────────────────────────────────────────────────
    const lines = [];
    lines.push(`ISSUE: ${issueId}`);
    lines.push(`ACTION: ${obj.action} the ${obj.target}`);
    lines.push(`CONSTRAINT: ${obj.constraint}`);
    lines.push(`SUCCESS: ${obj.successCriteria}`);
    lines.push('');

    if (isAbsent) {
      lines.push(`CURRENT STATE: ${label} is missing — does not exist on this page`);
      lines.push('');
      // Inject detected context for generation grounding
      if (mec) {
        lines.push('DETECTED CONTEXT (use these values to generate page-specific content):');
        if (mec.businessName)  lines.push(`  Business Name: "${mec.businessName}"`);
        if (mec.primaryTopic)  lines.push(`  Primary Topic: "${mec.primaryTopic}"`);
        if (mec.pageIntent)    lines.push(`  Page Intent: ${mec.pageIntent}`);
        if (mec.serviceName)   lines.push(`  Service: "${mec.serviceName}"`);
        if (mec.contentType)   lines.push(`  Content Type: ${mec.contentType}`);
        lines.push('');
      }
    } else {
      if (currentState.listItems?.length) {
        lines.push(`CURRENT ${label.toUpperCase()} ITEMS:`);
        currentState.listItems.forEach(item => lines.push(`  - "${item}"`));
      } else if (currentState.treeNodes?.length) {
        lines.push(`CURRENT ${label.toUpperCase()} HIERARCHY:`);
        currentState.treeNodes.forEach(node => lines.push(`  ${node.level}: "${node.text}"`));
      } else {
        lines.push(`CURRENT ${label.toUpperCase()}: "${currentState.rawText || 'not detected'}"`);
      }
      if (currentState.measurement?.value != null) {
        lines.push(`CURRENT LENGTH: ${currentState.measurement.value} ${currentState.measurement.unit || 'chars'}`);
      }
      if (currentState.measurement?.threshold || currentState.measurement?.maxThreshold) {
        const min = currentState.measurement.threshold;
        const max = currentState.measurement.maxThreshold;
        lines.push(`TARGET RANGE: ${min && max ? `${min}–${max}` : min ? `≥${min}` : `≤${max}`} ${currentState.measurement.unit || 'chars'}`);
      }
      if (currentState.measurement?.shortfall != null) {
        const sf = currentState.measurement.shortfall;
        lines.push(`PROBLEM: ${sf > 0 ? `${sf} chars too short` : `${Math.abs(sf)} chars too long`}`);
      }
      lines.push('');
    }

    if (contentContext) {
      if (contentContext.pageTitle)     lines.push(`PAGE TITLE: "${contentContext.pageTitle}"`);
      if (contentContext.h1Text)        lines.push(`H1 HEADING: "${contentContext.h1Text}"`);
      if (contentContext.primaryKeyword)lines.push(`PRIMARY KEYWORD: "${contentContext.primaryKeyword}"`);
    }
    lines.push(`PAGE TYPE: ${pageContext.pageType}`);
    lines.push(`FRAMEWORK: ${fwLabel}`);
    lines.push(`PAGE URL: ${pageContext.pageUrl}`);
    lines.push('');

    lines.push(`PRESERVE: ${obj.preserveContext}`);

    const context = lines.join('\n');

    // ── Task instruction ──────────────────────────────────────────────────
    let task;
    if (issueId === 'h1_tags' || issueId === 'h1_missing' || issueId === 'multiple_h1_tags') {
      task = [
        `Fix the H1 heading issue for this page.`,
        `You MUST explain the role of H1 tags in content structure and SEO, specifically addressing:`,
        `  - Missing H1 heading (why every page needs exactly one H1)`,
        `  - Multiple H1 tags (why having more than one confuses search engines and ruins hierarchy)`,
        `Provide the corrected HTML heading example for this page.`,
        `For "recommendedVersion": the optimized H1 text content.`,
        `For "implementationCode": the copy-paste ready HTML snippet (e.g., <h1>Optimized Heading</h1>).`
      ].join('\n');
    } else if (isAbsent) {
      if (mec?.isRich) {
        // Build a concrete example based on detected context
        const exampleTopic = mec.primaryTopic || mec.urlSlug || 'page topic';
        const exampleBrand = mec.businessName;
        const exampleParts = exampleBrand
          ? `"${exampleTopic} - ${exampleBrand}"`
          : `"${exampleTopic}"`;

        task = [
          `Generate the exact ${label} for this page using the DETECTED CONTEXT above.`,
          ``,
          `EXAMPLE of expected output quality:`,
          `  If page title is "About Us - Naxonify" → generate: <h1>About Naxonify</h1>`,
          `  If page title is "SEO Services | Acme"  → generate: <h1>SEO Services by Acme</h1>`,
          ``,
          `For THIS page (detected ${exampleParts}):`,
          `  recommendedVersion = the actual ${label} text (no HTML tags in the text value itself)`,
          `  implementationCode = the complete copy-paste ready HTML tag`,
        ].join('\n');
      } else {
        task = `Write a new ${label} for this page. Derive it from the page title, URL, and keyword provided. Do NOT invent information not given.`;
      }
    } else if (obj.action === 'expand') {
      task = `Expand the current ${label} to meet the target range. Add genuine value — a supporting detail, CTA, or qualifying phrase. Do not add filler.`;
    } else if (obj.action === 'shorten') {
      task = `Shorten the current ${label} to meet the target. Cut redundant phrases while keeping the primary keyword and core message intact.`;
    } else {
      task = `Improve the current ${label} to fix the issue. Keep the same core message and brand voice.`;
    }

    // ── Implementation code instruction ──────────────────────────────────
    const codeInstr = _codeInstruction(fw, pageContext.cms, label);

    // ── Before/after instruction ──────────────────────────────────────────
    const baInstr = isAbsent
      ? `beforeAfter.before = "No ${label} found on this page"; beforeAfter.after = your generated ${label} (the actual text, not an instruction)`
      : `beforeAfter.before = exact current value verbatim; beforeAfter.after = your optimized version`;

    const antiHallBlock = isAbsent && mec?.isRich
      ? `${ANTI_HALLUCINATION}\n\n${ANTI_HALLUCINATION_MISSING}`
      : ANTI_HALLUCINATION;

    return `You are an expert SEO copywriter specializing in title tags, meta descriptions, and on-page text optimization.

CONTEXT:
${context}

TASK:
${task}
${antiHallBlock}

BEFORE/AFTER: ${baInstr}

IMPLEMENTATION CODE: ${codeInstr}

${OUTPUT_FORMAT}`;
  }

  // ── GROUP 2: Content Optimization ────────────────────────────────────────
  // Handles: thin_content, service_pages_800_words, short_paragraphs,
  //          semantic_subtopics, faq, step_by_step_content, conversational_tone

  _group2_ContentOptimization(rc, ruleMetadata) {
    const { identity, currentState, expectedState, pageContext, contentContext, missingElementContext, recommendationObjective: obj } = rc;
    const issueId  = identity.issueId;
    const isAbsent = currentState.isAbsent;
    const fw       = pageContext.framework;
    const mec      = isAbsent ? missingElementContext : null;

    const lines = [];
    lines.push(`ISSUE: ${issueId}`);
    lines.push(`ACTION: ${obj.action} ${obj.target}`);
    lines.push(`CONSTRAINT: ${obj.constraint}`);
    lines.push('');

    if (isAbsent) {
      lines.push(`CURRENT STATE: ${obj.target} is missing — does not exist on this page`);
      lines.push('');
      if (mec) {
        lines.push('DETECTED CONTEXT (use to generate page-specific content):');
        if (mec.businessName)  lines.push(`  Business: "${mec.businessName}"`);
        if (mec.primaryTopic)  lines.push(`  Primary Topic: "${mec.primaryTopic}"`);
        if (mec.pageIntent)    lines.push(`  Page Intent: ${mec.pageIntent}`);
        if (mec.serviceName)   lines.push(`  Service: "${mec.serviceName}"`);
        if (mec.contentType)   lines.push(`  Content Type: ${mec.contentType}`);
        lines.push('');
      }
    } else {
      // Word count / metric
      if (currentState.measurement.value != null) {
        lines.push(`CURRENT WORD COUNT: ${currentState.measurement.value} words`);
      }
      if (currentState.measurement.threshold) {
        lines.push(`TARGET MINIMUM: ${currentState.measurement.threshold} words`);
      }

      // Content preview
      if (contentContext?.contentPreview) {
        lines.push(`CONTENT EXCERPT (first ~60 words):\n"${contentContext.contentPreview}"`);
      } else if (currentState.rawText) {
        lines.push(`CONTENT EXCERPT:\n"${currentState.rawText.slice(0, 300)}"`);
      }
      lines.push('');
    }

    if (contentContext?.pageTitle)     lines.push(`PAGE TITLE: "${contentContext.pageTitle}"`);
    if (contentContext?.primaryKeyword)lines.push(`PRIMARY KEYWORD: "${contentContext.primaryKeyword}"`);
    lines.push(`PAGE TYPE: ${pageContext.pageType}`);
    lines.push(`FRAMEWORK: ${fw !== 'unknown' ? fw : pageContext.cms || 'standard HTML'}`);
    lines.push('');
    lines.push(`SUCCESS CRITERIA: ${obj.successCriteria}`);
    lines.push(`PRESERVE: ${obj.preserveContext}`);

    const context = lines.join('\n');

    let taskInstr;
    if (isAbsent && mec?.isRich) {
      const topic = mec.serviceName || mec.primaryTopic || 'the page topic';
      const biz   = mec.businessName ? ` for ${mec.businessName}` : '';
      taskInstr = [
        `Generate the missing ${obj.target}${biz} about "${topic}".`,
        ``,
        `For "recommendedVersion": write the actual content — real sentences, headings, questions/answers, or steps.`,
        `  Do NOT write: "Add a section about [topic]"`,
        `  DO write:     The real content itself, grounded in DETECTED CONTEXT above.`,
        `For "implementationCode": ready-to-paste HTML with actual content (not placeholder text).`,
      ].join('\n');
    } else if (isAbsent) {
      taskInstr = `Generate the missing ${obj.target}. Derive content from the page title, URL, and any page context provided. Do NOT use placeholder text.`;
    } else {
      taskInstr = obj.action === 'expand'
        ? `Provide a specific content expansion plan. Identify exactly which topics, sections, and subtopics to add. Name the actual subtopics to cover based on the page title and keyword.`
        : `Address this content quality issue with a specific, actionable fix.`;
    }

    const antiHallBlock = isAbsent && mec?.isRich
      ? `${ANTI_HALLUCINATION}\n\n${ANTI_HALLUCINATION_MISSING}`
      : ANTI_HALLUCINATION;

    return `You are a content strategist and SEO expert. Your job is to provide concrete, production-ready content.

CONTEXT:
${context}

TASK:
${taskInstr}

For "implementationNotes": provide numbered steps specific to ${fw !== 'unknown' ? fw : 'their CMS'}.

${antiHallBlock}

${OUTPUT_FORMAT}`;
  }

  // ── GROUP 3: Technical SEO ────────────────────────────────────────────────
  // Handles: canonical, OG tags, redirects, orphan pages, click depth,
  //          internal links, broken links, URL structure, robots, https

  _group3_TechnicalSEO(rc, ruleMetadata) {
    const { identity, currentState, expectedState, pageContext, technicalContext, missingElementContext, contentContext, recommendationObjective: obj } = rc;
    const issueId  = identity.issueId;
    const isAbsent = currentState.isAbsent;
    const pm       = obj.promptMode;
    const fw       = pageContext.framework;
    const mec      = isAbsent ? missingElementContext : null;

    const lines = [];
    lines.push(`ISSUE: ${issueId}`);
    lines.push(`ACTION: ${obj.action} ${obj.target}`);
    lines.push(`CONSTRAINT: ${obj.constraint}`);
    lines.push('');

    if (isAbsent) {
      lines.push(`CURRENT STATE: ${obj.target} is absent — not found on this page`);
      lines.push('');
      if (mec) {
        lines.push('DETECTED CONTEXT (use to generate page-specific content):');
        if (mec.businessName)  lines.push(`  Business: "${mec.businessName}"`);
        if (mec.primaryTopic)  lines.push(`  Primary Topic: "${mec.primaryTopic}"`);
        if (mec.pageIntent)    lines.push(`  Page Intent: ${mec.pageIntent}`);
        if (mec.contentType)   lines.push(`  Content Type: ${mec.contentType}`);
        lines.push('');
      }
      if (contentContext?.pageTitle) lines.push(`PAGE TITLE: "${contentContext.pageTitle}"`);
      if (contentContext?.metaDescription) lines.push(`META DESCRIPTION: "${contentContext.metaDescription}"`);
    } else {
      // Inject detected state based on displayType
      if (pm === PROMPT_MODE.COMPARISON_FIX && currentState.tableRows?.length) {
        lines.push('DETECTED STATE (table):');
        for (const row of currentState.tableRows) {
          const vals = Object.entries(row).map(([k, v]) => `${k}: "${v}"`).join(' | ');
          lines.push(`  ${vals}`);
        }
      } else if (currentState.chainHops?.length) {
        lines.push(`CURRENT PATH: ${currentState.chainHops.join(' → ')}`);
        if (currentState.measurement.value != null) {
          lines.push(`CURRENT DEPTH: ${currentState.measurement.value} clicks`);
          if (currentState.measurement.threshold) {
            lines.push(`TARGET MAX: ${currentState.measurement.threshold} clicks`);
          }
        }
      } else if (currentState.listItems?.length) {
        lines.push(`DETECTED ITEMS (${currentState.listItems.length}):`);
        currentState.listItems.slice(0, 8).forEach(item => lines.push(`  - ${item}`));
        if (currentState.listItems.length > 8) lines.push(`  ... +${currentState.listItems.length - 8} more`);
        if (currentState.label) lines.push(`CONTEXT: ${currentState.label}`);
      } else if (currentState.codeContent) {
        lines.push(`CURRENT CODE:\n${currentState.codeContent.slice(0, 600)}`);
      } else if (currentState.rawText) {
        lines.push(`CURRENT VALUE: "${currentState.rawText}"`);
      }
    }
    lines.push('');

    // Technical context
    if (technicalContext) {
      if (technicalContext.canonicalUrl)        lines.push(`CANONICAL URL: ${technicalContext.canonicalUrl}`);
      if (technicalContext.pageUrl)             lines.push(`PAGE URL: ${technicalContext.pageUrl}`);
      if (technicalContext.canonicalMatchStatus)lines.push(`MATCH STATUS: ${technicalContext.canonicalMatchStatus}`);
      if (technicalContext.ogFieldsPresent?.length) lines.push(`OG FIELDS PRESENT: ${technicalContext.ogFieldsPresent.join(', ')}`);
      if (technicalContext.ogFieldsMissing?.length) lines.push(`OG FIELDS MISSING: ${technicalContext.ogFieldsMissing.join(', ')}`);
      if (technicalContext.inboundLinkCount != null) lines.push(`INBOUND LINKS: ${technicalContext.inboundLinkCount}`);
      if (technicalContext.potentialLinkers?.length) lines.push(`POTENTIAL LINKER PAGES: ${technicalContext.potentialLinkers.slice(0, 4).join(', ')}`);
      if (technicalContext.currentInternalLinks?.length) lines.push(`CURRENT INTERNAL LINKS: ${technicalContext.currentInternalLinks.slice(0, 5).join(', ')}`);
      if (technicalContext.actualLinkers?.length) lines.push(`PAGES LINKING HERE: ${technicalContext.actualLinkers.slice(0, 4).join(', ')}`);
    }

    lines.push('');
    lines.push(`PAGE URL: ${pageContext.pageUrl}`);
    lines.push(`PAGE TYPE: ${pageContext.pageType}`);
    lines.push(`FRAMEWORK: ${fw !== 'unknown' ? fw : pageContext.cms || 'standard HTML'}`);
    lines.push('');
    lines.push(`SUCCESS: ${obj.successCriteria}`);
    lines.push(`PRESERVE: ${obj.preserveContext}`);

    const context = lines.join('\n');

    // Task varies by issueId to provide concept-specific explanations and examples
    let task;
    if (issueId === 'security_headers') {
      task = [
        `Fix the missing security headers issue for this server/page.`,
        `You MUST explain the purpose and importance of each missing header:`,
        `  - CSP (Content Security Policy) (explain resource whitelisting and XSS mitigation)`,
        `  - HSTS (Strict-Transport-Security) (explain forcing HTTPS connections)`,
        `  - X-Frame-Options (explain clickjacking protection)`,
        `  - X-Content-Type-Options (explain MIME sniffing protection)`,
        `Provide copy-paste ready server-level implementation examples for Apache (.htaccess), Nginx (server block), IIS (web.config), and Next.js (next.config.js) or Node.js where appropriate.`,
        `For "recommendedVersion": the list of recommended header names and values.`,
        `For "implementationCode": the server-level configuration blocks.`
      ].join('\n');
    } else if (issueId === 'canonical_tags' || issueId === 'canonical_tag_errors') {
      task = [
        `Fix the canonical tag issue for this page.`,
        `You MUST explain:`,
        `  - What canonicalization is and why it matters`,
        `  - How it prevents duplicate URL indexing issues and consolidates link signals`,
        `Provide the exact canonical implementation tag example.`,
        `For "recommendedVersion": ONLY the plain, absolute self-referencing canonical URL as a bare string`,
        `  (e.g. "${pageContext.pageUrl}") — NEVER wrap it in HTML, NEVER include`,
        `  <link rel="canonical" ...> or any markup. This field is stored and used directly as a`,
        `  URL value, not rendered as HTML.`,
        `For "implementationCode": the full HTML <link rel="canonical" href="..."> snippet — this is the`,
        `  ONLY field where the HTML tag belongs.`
      ].join('\n');
    } else if (issueId === 'noindex_key_pages' || issueId === 'noindex_tags') {
      task = [
        `Remove the incorrect noindex directive from this key page.`,
        `You MUST explain why blocking important key pages from search indexing hurts organic visibility and crawlers.`,
        `Provide the robots.txt or meta tag fix to make the page indexable.`,
        `For "recommendedVersion": ONLY one of these exact 4 strings, chosen to reflect the corrected`,
        `  directive state — no other wording, no HTML, no explanation:`,
        `  "index, follow" | "noindex, follow" | "index, nofollow" | "noindex, nofollow".`,
        `  This field is stored and used directly as a machine-parsed directive value, not rendered as HTML —`,
        `  in almost every case for THIS issue the correct value is "index, follow" (remove both restrictions).`,
        `For "implementationCode": the full HTML <meta name="robots" content="..."> tag or robots.txt line —`,
        `  this is the ONLY field where that markup belongs.`
      ].join('\n');
    } else if (
      issueId === 'og_tags' ||
      issueId === 'og_tags_missing' ||
      issueId === 'og_tags_incomplete'
    ) {
      const title   = mec?.primaryTopic || contentContext?.pageTitle || '';
      const biz     = mec?.businessName || '';
      const ogTitle = biz ? `${title} | ${biz}` : title;
      task = [
        `Generate the missing Open Graph (OG) metadata for this page.`,
        `You MUST explain why missing Open Graph tags prevent rich snippets when sharing URLs on social/chat platforms.`,
        `Provide the complete OG implementation example with og:title, og:description, og:url, og:image, and og:type.`,
        `For og:title use: "${ogTitle || 'Page Title'}"`,
        `For og:description: write a page-specific, concise description (120-160 chars)`,
        `For og:url: use the PAGE URL exactly`,
        `For og:type: use "website" (or "article" if a blog page)`,
        `For "recommendedVersion": the list of generated OG tags as HTML.`,
        `For "implementationCode": the HTML snippet containing the meta tags.`
      ].join('\n');
    } else if (
      issueId === 'social_tags' ||
      issueId === 'og_social_tags' ||
      issueId === 'twitter_card_tags_missing'
    ) {
      const title   = mec?.primaryTopic || contentContext?.pageTitle || '';
      const biz     = mec?.businessName || '';
      const ogTitle = biz ? `${title} | ${biz}` : title;
      task = [
        `Generate the missing social metadata (both Open Graph and Twitter Card tags).`,
        `You MUST explain the role of social metadata in driving CTR and branding on platforms like LinkedIn, Facebook, and Twitter/X.`,
        `Provide the complete implementation examples.`,
        `For og:title/twitter:title use: "${ogTitle || 'Page Title'}"`,
        `For og:description/twitter:description: write a page-specific description (120-160 chars)`,
        `For og:url: use the PAGE URL exactly`,
        `For "recommendedVersion": the generated OG and Twitter Card tags.`,
        `For "implementationCode": the HTML snippet containing both og:* and twitter:* tags.`
      ].join('\n');
    } else if (isAbsent && mec?.isRich) {
      task = `Generate the missing ${obj.target} using the DETECTED CONTEXT above. Provide exact, production-ready code — not a description of what to add.`;
    } else if (pm === PROMPT_MODE.COMPARISON_FIX) {
      task = `Diagnose the mismatch and provide the exact corrected value plus implementation steps. For "recommendedVersion" give the exact fixed value. For "beforeAfter" use the exact detected values.`;
    } else if (pm === PROMPT_MODE.LIST_FIX) {
      task = `Provide specific, actionable steps to fix each listed item. For "recommendedVersion" name the exact pages, URLs, or changes needed — not generic advice. For "beforeAfter" describe the before-state and the specific after-state.`;
    } else {
      task = `Diagnose the structural issue and provide the specific fix. For "recommendedVersion" give the concrete solution (not a general principle). Include the exact code needed.`;
    }

    const codeInstr = _codeInstruction(fw, pageContext.cms, obj.target);
    const antiHallBlock = isAbsent && mec?.isRich
      ? `${ANTI_HALLUCINATION}\n\n${ANTI_HALLUCINATION_MISSING}`
      : ANTI_HALLUCINATION;

    return `You are a technical SEO engineer with deep expertise in crawlability, URL structure, and search engine directives.

CONTEXT:
${context}

TASK:
${task}
IMPLEMENTATION CODE: ${codeInstr}
${antiHallBlock}

${OUTPUT_FORMAT}`;
  }

  // ── GROUP 4: Schema ───────────────────────────────────────────────────────
  // Handles: all JSON-LD / structured data issues
  //
  // Schema prompts get the most tokens (2500) because valid JSON-LD can be long.
  // The generated schema MUST be valid, complete, and page-specific.

  _group4_Schema(rc, ruleMetadata) {
    const { identity, currentState, expectedState, pageContext, aiVisibilityContext, missingElementContext, contentContext, schemaEvidence, recommendationObjective: obj } = rc;
    const issueId  = identity.issueId;
    const isAbsent = currentState.isAbsent;
    const fw       = pageContext.framework;
    const mec      = isAbsent ? missingElementContext : null;

    // ── sameas_array / breadcrumblist_schema: single-VALUE fixes, never full
    // JSON-LD — these are the two Schema-group issues wired to Odito's
    // site-scoped Rank Math capabilities (see providerCapabilityRegistry.js).
    // recommendedVersion here is written DIRECTLY via the Bridge's
    // /seo/site route — it must never be a JSON-LD block (that belongs only
    // in implementationCode, for the DIY/manual-fix path — see every other
    // field in this codebase that draws the same distinction: canonical,
    // robots).
    if (issueId === 'sameas_array') {
      return this._sameAsPrompt(rc);
    }
    if (issueId === 'breadcrumblist_schema') {
      return this._breadcrumbPrompt(rc);
    }

    const lines = [];
    lines.push(`ISSUE: ${issueId}`);
    lines.push(`ACTION: ${obj.action} ${obj.target}`);
    lines.push(`CONSTRAINT: ${obj.constraint}`);
    lines.push('');

    // Existing schema code
    if (currentState.codeContent && !isAbsent) {
      // 4000, not 800: a real Organization/LocalBusiness graph is longer than 800
      // chars, and a truncated (invalid) snippet gives the model nothing to merge into.
      lines.push(`CURRENT SCHEMA CODE:\n${currentState.codeContent.slice(0, 4000)}`);
    } else {
      lines.push(`CURRENT SCHEMA: ${isAbsent ? `${currentState.checkedFor || 'schema'} is absent` : 'Not detected'}`);
    }
    lines.push('');

    // Detected context for absent schema — critical for generating real values
    if (isAbsent && mec) {
      lines.push('DETECTED CONTEXT (populate schema @id, name, url, description from these):');
      if (mec.businessName)  lines.push(`  Business Name: "${mec.businessName}"`);
      if (mec.entityName)    lines.push(`  Entity Name: "${mec.entityName}"`);
      if (mec.primaryTopic)  lines.push(`  Primary Topic: "${mec.primaryTopic}"`);
      if (mec.pageIntent)    lines.push(`  Page Type: ${mec.pageIntent}`);
      if (mec.serviceName)   lines.push(`  Service: "${mec.serviceName}"`);
      lines.push('');
    }

    if (aiVisibilityContext?.schemaTypes?.length) {
      lines.push(`DETECTED SCHEMA TYPES: ${aiVisibilityContext.schemaTypes.join(', ')}`);
    }
    if (contentContext?.pageTitle) lines.push(`PAGE TITLE: "${contentContext.pageTitle}"`);

    lines.push(`PAGE TYPE: ${pageContext.pageType}`);
    lines.push(`PAGE URL: ${pageContext.pageUrl}`);
    lines.push(`FRAMEWORK: ${fw !== 'unknown' ? fw : pageContext.cms || 'standard HTML'}`);

    if (pageContext.canonicalUrl) lines.push(`CANONICAL URL: ${pageContext.canonicalUrl}`);
    lines.push('');

    // Schema-specific table data (e.g. faq_schema_matches_content)
    if (currentState.tableRows?.length) {
      lines.push('SCHEMA TABLE STATE:');
      currentState.tableRows.slice(0, 8).forEach(r => {
        lines.push(`  ${Object.entries(r).map(([k, v]) => `${k}: "${v}"`).join(' | ')}`);
      });
    }

    lines.push(`SUCCESS: ${obj.successCriteria}`);
    lines.push(`PRESERVE: ${obj.preserveContext}`);

    // Verified evidence (existing entity, verified logo, canonical URL, real hierarchy, article
    // facts). Replaces "derive it from the title/URL" for everything it covers.
    if (schemaEvidence) {
      lines.push('');
      lines.push(renderSchemaEvidence(schemaEvidence));
    }

    const context = lines.join('\n');

    // Placement guidance only — it belongs in implementationNotes. The
    // implementationCode field itself is ALWAYS the JSON-LD <script> block, never
    // PHP/JSX (a CMS name in the FRAMEWORK line used to make the model write a
    // PHP wp_head() snippet there, which is not JSON-LD and got the whole
    // recommendation rejected).
    const platform = fw !== 'unknown' ? fw : (pageContext.cms || '');
    const schemaImplInstr = platform === 'nextjs'
      ? 'In "implementationNotes" say to render it with the Next.js Script component (type="application/ld+json") in the page component'
      : /wordpress/i.test(platform)
        ? 'In "implementationNotes" say to paste it into the page\'s <head> via the SEO plugin\'s custom-schema / header-scripts field (Rank Math, Yoast) — do NOT write PHP'
        : 'In "implementationNotes" say to place the <script type="application/ld+json"> block in the <head> section';

    const absentSchemaInstr = isAbsent && mec ? [
      ``,
      `CRITICAL FOR ABSENT SCHEMA:`,
      `- Use DETECTED CONTEXT values above to populate the schema fields`,
      `- "name" field must use the actual Business Name or Entity Name from DETECTED CONTEXT`,
      `- "url" must use the PAGE URL exactly`,
      `- Do NOT write: "Your Organization Name", "https://example.com", "[Business Name]"`,
      `- The schema must be production-ready — not a template`,
    ].join('\n') : '';

    const antiHallBlock = isAbsent && mec?.isRich
      ? `${ANTI_HALLUCINATION}\n\n${ANTI_HALLUCINATION_MISSING}`
      : ANTI_HALLUCINATION;

    return `You are a structured data expert. You generate valid, complete Schema.org JSON-LD markup.

CONTEXT:
${context}

TASK:
Generate valid JSON-LD structured data markup for this issue.${absentSchemaInstr}

RULES FOR SCHEMA GENERATION:
1. Use Schema.org vocabulary only (https://schema.org)
2. @context must be "https://schema.org"
3. Use real values from the CONTEXT block — never placeholder values like "Your Brand Name" or "https://example.com"
4. ${schemaEvidence
      ? 'The VERIFIED SCHEMA EVIDENCE block is authoritative: copy its @id, @type, name, URLs, logo and dimensions exactly; never replace an existing value with your own; never output a URL, logo, phone, address or profile that is not listed there'
      : 'If brand/business details are not provided, derive only the name and page URL from the page title and URL — never a logo, contact detail or profile URL'}
5. Include every field of the schema type whose real value is in the CONTEXT block. If a required or recommended field's value is NOT in the CONTEXT (for example a street address or phone number), OMIT it from the JSON-LD — never invent a value or use a placeholder — and name it in "implementationNotes" as "needs your input: <field>"
6. JSON must be valid — properly escaped, no trailing commas
7. Implementation: ${schemaImplInstr}
8. For "recommendedVersion": write the actual JSON-LD object (not instructions)
9. For "beforeAfter": before = current state description, after = the new schema type added
10. For "implementationCode": ONLY the complete JSON-LD inside a <script type="application/ld+json"> ... </script> block — never PHP, JavaScript or any other language
11. If CURRENT SCHEMA CODE is given, start from it: keep every existing property unchanged and only add what is missing
${antiHallBlock}

${OUTPUT_FORMAT}`;
  }

  /**
   * sameas_array — the one real hallucination trap in this whole feature:
   * a REAL business's social media profile URLs are a FACT Claude cannot
   * possibly know just from a business/brand name — "twitter.com/<name>"
   * looks plausible but is exactly the kind of confident-sounding, unverified
   * guess ANTI_HALLUCINATION_STRICT exists to forbid. A wrong URL here is
   * actively worse than no URL: it links the site's own structured data to
   * a URL that may 404 or belong to someone else entirely.
   *
   * Odito's context pipeline currently has NO on-page social-link detection
   * (no footer/header icon extraction) to ground a real URL from, so the
   * honest, correct output in the overwhelming majority of cases is the
   * existing "not provided in context" convention — a real, non-URL string
   * that valueNormalization.normalizeSchemaUrlValue() naturally rejects
   * (fails URL parsing) exactly like any other malformed value, safely
   * refusing to ever write it. This is a valid, complete, non-retryable
   * answer, not a failure — see SchemaValidator's own sameas_array branch.
   */
  _sameAsPrompt(rc) {
    const { pageContext, missingElementContext, contentContext } = rc;
    const businessName = missingElementContext?.businessName || contentContext?.pageTitle || '';

    return `You are reviewing this site's Organization schema "sameAs" property (the array of links to this business's official social media / profile pages).

CONTEXT:
PAGE URL: ${pageContext?.pageUrl || ''}
${businessName ? `BUSINESS/BRAND NAME (from page content): "${businessName}"\n` : ''}
ISSUE: sameas_array — the Organization schema's sameAs property is missing or incomplete.

${ANTI_HALLUCINATION_STRICT}

TASK:
For "recommendedVersion": if — and ONLY if — a REAL, explicitly confirmed social media profile URL for this exact business appears somewhere in the CONTEXT above, output that one bare URL (e.g. "https://linkedin.com/company/example") and nothing else — no quotes, no HTML, no explanation.
If no such confirmed URL is present in the CONTEXT (this will be the normal case today), output the exact literal string: not provided in context
  Do NOT guess a URL from the business name — "https://twitter.com/${businessName || '<name>'}" is exactly the kind of unverified guess that is forbidden, even though it looks plausible.
For "whyThisMatters": explain why sameAs matters for entity/brand recognition in search. If you output "not provided in context", explicitly state that the site owner must supply their own real, verified social profile URLs — Odito does not invent one.
For "implementationCode": a full, illustrative example Organization JSON-LD snippet showing a sameAs array — this field alone may use realistic-looking EXAMPLE profile URLs, clearly for illustration, since it is documentation and is never a value Odito writes automatically.

${OUTPUT_FORMAT}`;
  }

  /**
   * breadcrumblist_schema — unlike sameas_array, this has NO hallucination
   * risk: every current finding means exactly one thing (breadcrumbs are
   * off site-wide), and the fix is a configuration toggle, not a fact about
   * the business. recommendedVersion is the SAME closed-allowlist pattern
   * as robots (see PromptBuilder's noindex_key_pages branch) — one literal
   * string, mirrored by valueNormalization.normalizeBreadcrumbEnableValue.
   */
  _breadcrumbPrompt(rc) {
    const { pageContext } = rc;
    return `You are reviewing this site's breadcrumb navigation schema (BreadcrumbList JSON-LD).

CONTEXT:
PAGE URL: ${pageContext?.pageUrl || ''}
${rc.schemaEvidence ? `${renderSchemaEvidence(rc.schemaEvidence)}\n` : ''}ISSUE: breadcrumblist_schema — BreadcrumbList structured data is missing from this page (and, most likely, the whole site — breadcrumbs are a site-wide setting).

TASK:
Explain why BreadcrumbList schema matters for search result display and site-hierarchy signals.
For "recommendedVersion": output ONLY the exact literal string: enabled
  This is a closed, single-answer field — every current finding for this issue means the same fix (turn breadcrumbs on site-wide). Do not write anything else in this field — no explanation, no JSON.
For "implementationCode": ${rc.schemaEvidence
      ? 'an example BreadcrumbList built ONLY from the verified hierarchy in the evidence block below (exact names, URLs and order; the last item is the page URL given there). If the hierarchy is UNKNOWN, do not write JSON-LD at all.'
      : 'an example rendered BreadcrumbList JSON-LD snippet for THIS page\'s own URL hierarchy, for illustration only.'}

${OUTPUT_FORMAT}`;
  }

  // ── GROUP 5: Accessibility ────────────────────────────────────────────────
  // Handles: contrast, labels, keyboard, focus, ARIA, images alt, tap targets

  _group5_Accessibility(rc, ruleMetadata) {
    const { identity, currentState, expectedState, pageContext, missingElementContext, contentContext, recommendationObjective: obj } = rc;
    const issueId  = identity.issueId;
    const isAbsent = currentState.isAbsent;
    const fw       = pageContext.framework;
    const mec      = isAbsent ? missingElementContext : null;

    const lines = [];
    lines.push(`ISSUE: ${issueId}`);
    lines.push(`ACTION: ${obj.action} ${obj.target}`);
    lines.push(`CONSTRAINT: ${obj.constraint}`);
    lines.push('');

    if (isAbsent) {
      lines.push(`STATE: ${obj.target} is absent — missing from page images`);
      lines.push('');
      // For alt text generation, page topic is essential context
      if (mec) {
        lines.push('DETECTED CONTEXT (use to write contextual alt text):');
        if (mec.primaryTopic)  lines.push(`  Page Topic: "${mec.primaryTopic}"`);
        if (mec.businessName)  lines.push(`  Business: "${mec.businessName}"`);
        if (mec.pageIntent)    lines.push(`  Page Type: ${mec.pageIntent}`);
        if (mec.serviceName)   lines.push(`  Service: "${mec.serviceName}"`);
        lines.push('');
      }
      if (contentContext?.pageTitle) lines.push(`PAGE TITLE: "${contentContext.pageTitle}"`);
    } else if (currentState.tableRows?.length) {
      // For alt text, a tracker is not an image to describe (the resolver already drops it; this keeps the prompt safe on its own).
      const violations = issueId === 'images_missing_alt_text'
        ? currentState.tableRows.filter(r => !r?.Image || altImagesFromContext({ currentState: { tableRows: [r] } }).length > 0)
        : currentState.tableRows;
      lines.push(`DETECTED VIOLATIONS (${violations.length} items):`);
      violations.slice(0, 6).forEach(r => {
        lines.push(`  ${Object.entries(r).map(([k, v]) => `${k}: "${v}"`).join(' | ')}`);
      });
    } else if (currentState.listItems?.length) {
      lines.push(`AFFECTED ELEMENTS:`);
      currentState.listItems.slice(0, 8).forEach(item => lines.push(`  - ${item}`));
    } else if (currentState.rawText) {
      lines.push(`DETECTED: "${currentState.rawText}"`);
    } else {
      lines.push(`STATE: ${currentState.summary}`);
    }
    lines.push('');

    lines.push(`PAGE TYPE: ${pageContext.pageType}`);
    lines.push(`PAGE URL: ${pageContext.pageUrl}`);
    lines.push(`FRAMEWORK: ${fw !== 'unknown' ? fw : pageContext.cms || 'HTML'}`);
    lines.push(`SUCCESS: ${obj.successCriteria}`);

    if (issueId === 'images_missing_alt_text') {
      const listed = altImagesFromContext(rc);
      if (listed.length > 0) lines.push(...['', 'AFFECTED IMAGES (the ONLY images you may write alt text for; copy each URL exactly):', ...listed.map((u, i) => `  [${i + 1}] ${u}`)]);
    }

    const context = lines.join('\n');

    const wcagRef = _wcagReference(issueId);

    let task;
    const altImages = issueId === 'images_missing_alt_text' ? altImagesFromContext(rc) : [];
    if (altImages.length > 0) {
      // One alt text per image, keyed by the image's EXACT URL, returned in a structured field the WordPress fix can reuse.
      task = [
        `Write alt text for EACH image in AFFECTED IMAGES below.`,
        `You cannot see the pictures. Use ONLY what the CONTEXT shows: the image file name, the page title/topic and the business.`,
        `  - Describe what the file name and page context say the image is. Do NOT invent people, products, places or text.`,
        `  - A person's name may appear ONLY if it is in that image's file name or the page title.`,
        `  - Plain text, under 125 characters, no "image of" / "photo of", no file names, no HTML.`,
        `  - If the context does not support a description for an image, give "alt": null for it instead of guessing.`,
        `For "recommendedVersion": the same alt texts, one per line as: <file name> -> <alt text>.`,
        `For "implementationCode": example <img> tags using exactly these alt texts.`,
        `ADDITIONAL REQUIRED FIELD in the same JSON object — "imageAlts": an array with ONE entry per image in AFFECTED IMAGES:`,
        `  { "src": "<copied EXACTLY from AFFECTED IMAGES>", "alt": "<alt text or null>", "basis": "<which context value supports it, e.g. the file name>" }`,
        `  Never include a src that is not listed. Never change a src.`,
        `BE CONCISE: "issueAnalysis" at most 2 sentences, "implementationNotes" at most 4 short steps.`,
      ].join('\n');
    } else if (isAbsent && issueId === 'images_missing_alt_text' && mec?.isRich) {
      const topic = mec.primaryTopic || mec.serviceName || 'the page content';
      task = [
        `Generate contextual alt text for images on this page.`,
        ``,
        `The page is about: "${topic}"`,
        `Alt text must describe what the image likely shows based on the page topic.`,
        `Each alt text must be: descriptive, under 125 characters, and reference the page context.`,
        ``,
        `For "recommendedVersion": provide 3 example alt texts grounded in the page topic`,
        `  BAD:  alt="image"  or  alt="photo"  or  alt="[describe image]"`,
        `  GOOD: alt="Naxonify team reviewing SEO audit results"  (references the actual business/topic)`,
        `For "implementationCode": example <img> tags with generated alt text`,
        ``,
        `BE CONCISE: exactly 3 examples, one short <img> tag each, no repeated content between`,
        `"recommendedVersion" and "implementationCode", "implementationNotes" at most 4 short steps,`,
        `"issueAnalysis" at most 2 sentences.`,
      ].join('\n');
    } else {
      task = [
        `Provide the specific fix for each detected violation.`,
        `- For "recommendedVersion": the exact fixed markup or CSS — not general advice`,
        `- For "implementationCode": ready-to-paste code targeting ${fw !== 'unknown' ? fw : 'standard HTML'}`,
        `- For "beforeAfter": before = the broken state, after = the fixed state`,
        `- Focus on the minimum viable fix — don't redesign the entire component`,
      ].join('\n');
    }

    const antiHallBlock = isAbsent && mec?.isRich
      ? `${ANTI_HALLUCINATION}\n\n${ANTI_HALLUCINATION_MISSING}`
      : ANTI_HALLUCINATION;

    return `You are a web accessibility engineer. You fix WCAG violations and improve inclusive design.

CONTEXT:
${context}
WCAG REFERENCE: ${wcagRef}

TASK:
${task}
${antiHallBlock}

${OUTPUT_FORMAT}`;
  }

  // ── GROUP 6: AI Visibility ────────────────────────────────────────────────
  // Handles: entity signals, citation probability, NAP consistency,
  //          author/E-E-A-T, LLM readiness, AEO, topical authority

  _group6_AIVisibility(rc, ruleMetadata) {
    const { identity, currentState, expectedState, pageContext, contentContext, aiVisibilityContext, missingElementContext, recommendationObjective: obj } = rc;
    const issueId  = identity.issueId;
    const isAbsent = currentState.isAbsent;
    const fw       = pageContext.framework;
    const pm       = obj.promptMode;
    const mec      = isAbsent ? missingElementContext : null;

    const lines = [];
    lines.push(`ISSUE: ${issueId}`);
    lines.push(`CATEGORY: ${identity.category}`);
    lines.push(`ACTION: ${obj.action} ${obj.target}`);
    lines.push(`CONSTRAINT: ${obj.constraint}`);
    lines.push('');

    // Detected state — varies widely across AI visibility rules
    if (isAbsent) {
      lines.push(`STATE: ${currentState.checkedFor || obj.target} is absent`);
      lines.push('');
      if (mec) {
        lines.push('DETECTED CONTEXT (use to generate page-specific element):');
        if (mec.businessName)  lines.push(`  Business: "${mec.businessName}"`);
        if (mec.entityName)    lines.push(`  Entity: "${mec.entityName}"`);
        if (mec.primaryTopic)  lines.push(`  Primary Topic: "${mec.primaryTopic}"`);
        if (mec.pageIntent)    lines.push(`  Page Intent: ${mec.pageIntent}`);
        if (mec.serviceName)   lines.push(`  Service: "${mec.serviceName}"`);
        if (mec.contentType)   lines.push(`  Content Type: ${mec.contentType}`);
        lines.push('');
      }
    } else if (currentState.rawText) {
      lines.push(`CURRENT CONTENT:\n"${currentState.rawText.slice(0, 400)}"`);
    } else if (currentState.tableRows?.length) {
      lines.push('DETECTED STATE:');
      currentState.tableRows.slice(0, 6).forEach(r => {
        lines.push(`  ${Object.entries(r).map(([k, v]) => `${k}: "${v}"`).join(' | ')}`);
      });
    } else if (currentState.listItems?.length) {
      lines.push(`DETECTED ITEMS:`);
      currentState.listItems.slice(0, 6).forEach(item => lines.push(`  - ${item}`));
    } else {
      lines.push(`STATE: ${currentState.summary}`);
    }
    lines.push('');

    if (contentContext?.pageTitle)     lines.push(`PAGE TITLE: "${contentContext.pageTitle}"`);
    if (contentContext?.primaryKeyword)lines.push(`PRIMARY KEYWORD: "${contentContext.primaryKeyword}"`);
    if (contentContext?.h1Text)        lines.push(`H1: "${contentContext.h1Text}"`);
    if (aiVisibilityContext?.entityName) lines.push(`ENTITY: "${aiVisibilityContext.entityName}"`);
    if (aiVisibilityContext?.schemaTypes?.length) lines.push(`DETECTED SCHEMAS: ${aiVisibilityContext.schemaTypes.join(', ')}`);

    lines.push(`PAGE TYPE: ${pageContext.pageType}`);
    lines.push(`PAGE URL: ${pageContext.pageUrl}`);
    lines.push(`FRAMEWORK: ${fw !== 'unknown' ? fw : pageContext.cms || 'HTML'}`);
    lines.push('');
    lines.push(`SUCCESS: ${obj.successCriteria}`);
    lines.push(`PRESERVE: ${obj.preserveContext}`);

    const context = lines.join('\n');

    let taskVariant;
    if (isAbsent && mec?.isRich) {
      const entity = mec.entityName || mec.businessName || 'the organization';
      taskVariant = [
        `Generate the specific ${obj.target} for "${entity}" using DETECTED CONTEXT above.`,
        ``,
        `For "recommendedVersion": the actual generated element — real content, not instructions.`,
        `  Do NOT write: "Add [element] for your business"`,
        `  DO write: The actual element populated with "${entity}" data from DETECTED CONTEXT.`,
        `For "implementationCode": the complete, copy-paste ready implementation.`,
      ].join('\n');
    } else if (pm === PROMPT_MODE.CONTENT_REWRITE) {
      taskVariant = `Improve the existing content to fix this AI visibility issue. The optimized version must be grounded in the existing content — not generic advice.`;
    } else if (pm === PROMPT_MODE.ELEMENT_ADD) {
      taskVariant = `Generate the specific element that is missing. Derive all values from the CONTEXT block — never invent details not provided.`;
    } else {
      taskVariant = `Provide the specific structural fix. Explain exactly what to change and why it increases AI citation probability.`;
    }

    const codeInstr = _codeInstruction(fw, pageContext.cms, obj.target);
    const antiHallBlock = isAbsent && mec?.isRich
      ? `${ANTI_HALLUCINATION}\n\n${ANTI_HALLUCINATION_MISSING}`
      : ANTI_HALLUCINATION;

    return `You are an AI Search Optimization expert specializing in LLM citation probability, entity signals, and E-E-A-T.

CONTEXT:
${context}

TASK:
${taskVariant}

For "issueAnalysis": explain specifically how this issue reduces AI citation probability or LLM readiness — be concrete about the mechanism, not generic.
For "recommendedVersion": the actual optimized content or element — not a description of what to do.
For "implementationCode": ${codeInstr}
${antiHallBlock}

${OUTPUT_FORMAT}`;
  }

  // ── GROUP 7: Entity & E-E-A-T ─────────────────────────────────────────────
  // Handles: NAP consistency, author signals, business registration,
  //          SameAs links, visible author name, E-E-A-T signals.
  //
  // STRICTEST HALLUCINATION GUARD — never invent business details.
  // When entity data is missing: instruct user to gather it, not fabricate it.

  _group7_EntityEEAT(rc, ruleMetadata) {
    const { identity, currentState, expectedState, pageContext, entityContext, missingElementContext, recommendationObjective: obj } = rc;
    const issueId  = identity.issueId;
    const isAbsent = currentState.isAbsent;
    const fw       = pageContext.framework;
    const mec      = isAbsent ? missingElementContext : null;

    const lines = [];
    lines.push(`ISSUE: ${issueId}`);
    lines.push(`ACTION: ${obj.action} ${obj.target}`);
    lines.push(`CONSTRAINT: ${obj.constraint}`);
    lines.push('');

    // ── Current state ─────────────────────────────────────────────────────
    if (isAbsent) {
      lines.push(`STATE: ${currentState.checkedFor || obj.target} is absent — not present on this page`);
      lines.push('');
    } else if (currentState.tableRows?.length) {
      lines.push('DETECTED STATE:');
      currentState.tableRows.slice(0, 6).forEach(r => {
        lines.push(`  ${Object.entries(r).map(([k, v]) => `${k}: "${v}"`).join(' | ')}`);
      });
    } else if (currentState.listItems?.length) {
      lines.push('DETECTED ITEMS:');
      currentState.listItems.slice(0, 5).forEach(i => lines.push(`  - ${i}`));
    } else if (currentState.rawText) {
      lines.push(`CURRENT: "${currentState.rawText.slice(0, 300)}"`);
    } else {
      lines.push(`STATE: ${currentState.summary}`);
    }
    lines.push('');

    // ── Entity context — ONLY supply what was actually provided ───────────
    if (entityContext) {
      lines.push('ENTITY CONTEXT (use ONLY these values — do NOT invent additional details):');
      if (entityContext.businessName)      lines.push(`  Business Name: "${entityContext.businessName}"`);
      if (entityContext.address)           lines.push(`  Address: "${entityContext.address}"`);
      if (entityContext.phone)             lines.push(`  Phone: "${entityContext.phone}"`);
      if (entityContext.authorName)        lines.push(`  Author Name: "${entityContext.authorName}"`);
      if (entityContext.authorCredentials) lines.push(`  Author Credentials: "${entityContext.authorCredentials}"`);
      if (entityContext.entityType)        lines.push(`  Entity Type: ${entityContext.entityType}`);
      if (entityContext.sameasUrls?.length)lines.push(`  SameAs URLs: ${entityContext.sameasUrls.slice(0, 4).join(', ')}`);
      if (!Object.values(entityContext).some(Boolean)) {
        lines.push('  (no entity context provided — instruct user to gather this data)');
      }
    } else if (isAbsent && mec?.businessName) {
      // Inferred business name from title/domain can seed the implementation guidance
      lines.push('INFERRED CONTEXT (derived from page title/URL — verify before use):');
      lines.push(`  Inferred Business Name: "${mec.businessName}"`);
      if (mec.pageIntent) lines.push(`  Page Type: ${mec.pageIntent}`);
      lines.push('  NOTE: Verify these values with the actual business records before implementing.');
    } else {
      lines.push('ENTITY CONTEXT: not available — instruct user to gather NAP and author data');
    }
    lines.push('');

    lines.push(`PAGE URL: ${pageContext.pageUrl}`);
    lines.push(`PAGE TYPE: ${pageContext.pageType}`);
    lines.push(`FRAMEWORK: ${fw !== 'unknown' ? fw : pageContext.cms || 'HTML'}`);
    lines.push('');
    lines.push(`SUCCESS: ${obj.successCriteria}`);
    if (rc.schemaEvidence) {
      lines.push('');
      lines.push(renderSchemaEvidence(rc.schemaEvidence));
    }

    const context = lines.join('\n');

    const codeInstr = _codeInstruction(fw, pageContext.cms, obj.target);

    const taskInstr = isAbsent
      ? (entityContext && Object.values(entityContext).some(Boolean)
        ? `Generate the ${obj.target} using ONLY the values provided in ENTITY CONTEXT above. For any field not in ENTITY CONTEXT, state "gather [field] from your business records" — never invent.`
        : `Explain exactly what entity information needs to be gathered and how to implement ${obj.target}. For each required field, tell the user where to find that data (Google Business Profile, business registration, etc.).`
        )
      : `Fix the detected entity signal issue. Use ONLY the values from ENTITY CONTEXT above. If a required value is missing from context, state "gather [field] from your business records" rather than inventing a value.`;

    return `You are an E-E-A-T and entity SEO specialist. Your expertise is in local business signals, author credibility, and NAP (Name, Address, Phone) consistency.

CONTEXT:
${context}

TASK:
${taskInstr}

For "issueAnalysis": explain how this entity signal gap reduces AI citation probability (LLMs need consistent, verifiable entity data to cite a business).
For "recommendedVersion": the specific fix using ONLY supplied context values. If context is insufficient, write a structured guide: "To implement [element], gather: 1. [field A] from [source], 2. [field B] from [source]…"
For "implementationCode": ${codeInstr}
${ANTI_HALLUCINATION_STRICT}

${OUTPUT_FORMAT}`;
  }

  // ── GROUP 8: AEO & Voice Search ───────────────────────────────────────────
  // Handles: FAQ content, conversational tone, H2 questions, step-by-step,
  //          bullet lists, comparison tables, first-60-words direct answers.

  _group8_AEOVoice(rc, ruleMetadata) {
    const { identity, currentState, expectedState, pageContext, contentContext, aeoContext, missingElementContext, recommendationObjective: obj } = rc;
    const issueId  = identity.issueId;
    const isAbsent = currentState.isAbsent;
    const fw       = pageContext.framework;
    const mec      = isAbsent ? missingElementContext : null;

    const lines = [];
    lines.push(`ISSUE: ${issueId}`);
    lines.push(`ACTION: ${obj.action} ${obj.target}`);
    lines.push(`CONSTRAINT: ${obj.constraint}`);
    lines.push('');

    // ── Current content state ─────────────────────────────────────────────
    if (isAbsent) {
      lines.push(`STATE: ${currentState.checkedFor || obj.target} is absent — does not exist on this page`);
      lines.push('');
      if (mec) {
        lines.push('DETECTED CONTEXT (use to generate page-specific content):');
        if (mec.businessName)  lines.push(`  Business: "${mec.businessName}"`);
        if (mec.primaryTopic)  lines.push(`  Primary Topic: "${mec.primaryTopic}"`);
        if (mec.pageIntent)    lines.push(`  Page Intent: ${mec.pageIntent}`);
        if (mec.serviceName)   lines.push(`  Service: "${mec.serviceName}"`);
        if (mec.contentType)   lines.push(`  Content Type: ${mec.contentType}`);
        lines.push('');
      }
    } else if (currentState.rawText) {
      lines.push(`CURRENT CONTENT:\n"${currentState.rawText.slice(0, 400)}"`);
    } else if (currentState.listItems?.length) {
      lines.push('CURRENT ITEMS:');
      currentState.listItems.slice(0, 5).forEach(i => lines.push(`  - ${i}`));
    } else if (currentState.measurement?.value != null) {
      lines.push(`CURRENT COUNT: ${currentState.measurement.value} ${currentState.measurement.unit || ''}`);
      if (currentState.measurement.threshold) lines.push(`TARGET: ≥${currentState.measurement.threshold}`);
    } else {
      lines.push(`STATE: ${currentState.summary}`);
    }
    lines.push('');

    // ── AEO context ───────────────────────────────────────────────────────
    if (aeoContext) {
      if (aeoContext.faqCount != null) lines.push(`CURRENT FAQ COUNT: ${aeoContext.faqCount}`);
      if (aeoContext.h2List?.length)   lines.push(`CURRENT H2 HEADINGS: ${aeoContext.h2List.slice(0, 5).join(' | ')}`);
      if (aeoContext.hasStepStructure != null) lines.push(`HAS STEP STRUCTURE: ${aeoContext.hasStepStructure}`);
      if (aeoContext.readabilityScore != null) lines.push(`READABILITY SCORE: ${aeoContext.readabilityScore}`);
      if (aeoContext.avgParagraphLength != null) lines.push(`AVG PARAGRAPH LENGTH: ${aeoContext.avgParagraphLength} lines`);
    }

    if (contentContext?.pageTitle)     lines.push(`PAGE TITLE: "${contentContext.pageTitle}"`);
    if (contentContext?.primaryKeyword)lines.push(`PRIMARY KEYWORD: "${contentContext.primaryKeyword}"`);
    if (contentContext?.h1Text)        lines.push(`H1: "${contentContext.h1Text}"`);
    lines.push('');
    lines.push(`PAGE TYPE: ${pageContext.pageType}`);
    lines.push(`FRAMEWORK: ${fw !== 'unknown' ? fw : pageContext.cms || 'HTML'}`);
    lines.push(`PAGE URL: ${pageContext.pageUrl}`);
    lines.push('');
    lines.push(`SUCCESS: ${obj.successCriteria}`);
    lines.push(`PRESERVE: ${obj.preserveContext}`);

    const context = lines.join('\n');

    // Task variant by issue — richer instructions when absent + rich context
    const pageRef = contentContext?.pageTitle
      || (mec?.primaryTopic && mec?.businessName ? `"${mec.primaryTopic} - ${mec.businessName}"` : null)
      || mec?.primaryTopic
      || pageContext.pageUrl;

    let task;
    if (issueId === 'faq_section_5_to_10_questions') {
      const topicRef = mec?.serviceName || mec?.primaryTopic || contentContext?.pageTitle || 'this topic';
      const bizRef   = mec?.businessName ? ` about ${mec.businessName}` : '';
      task = [
        `Generate 5-8 specific FAQ question-and-answer pairs for the page: ${pageRef}`,
        ``,
        `Questions must be:`,
        `  - Phrased naturally (as a real user would ask a voice assistant or Google)`,
        `  - Specific to "${topicRef}"${bizRef} — NOT generic`,
        `  - Covering different angles: what, how, why, cost, process, benefits`,
        ``,
        `Answers must be:`,
        `  - 40-60 words each`,
        `  - Direct — answer in the first sentence`,
        `  - Based ONLY on the page context provided — do NOT invent facts`,
        ``,
        `FORBIDDEN: "What is [service]?", "How can [company] help?" — these are placeholders.`,
        `REQUIRED: The actual service name, business name, and topic from DETECTED CONTEXT.`,
      ].join('\n');
    } else if (issueId === 'question_based_h2_headings') {
      task = `Rewrite the current H2 headings as questions. Each rewritten heading must end with "?" and start with a question word (What, How, Why, When, Where, Who, Which, Can, Is, Are). Keep the same topic as the original heading.`;
    } else if (issueId === 'first_60_words_direct_answer') {
      task = `Write a direct answer opening paragraph (50-70 words) for: ${pageRef}. It must directly answer the page's primary topic in the first sentence, then expand with 2-3 supporting sentences. No preamble — answer first, context second.`;
    } else if (issueId === 'step_by_step_content') {
      const topicRef = mec?.serviceName || mec?.primaryTopic || 'the page topic';
      task = `Structure the content as numbered steps for "${topicRef}". Provide 4-7 specific numbered steps. Each step must have a clear action verb and be concrete — not generic advice like "research your options".`;
    } else {
      task = `Improve this page for Answer Engine Optimization. The fix must be specific to ${pageRef} — not generic AEO advice.`;
    }

    const codeInstr = `Standard HTML — provide the actual content markup ready to copy-paste`;
    const antiHallBlock = isAbsent && mec?.isRich
      ? `${ANTI_HALLUCINATION}\n\n${ANTI_HALLUCINATION_MISSING}`
      : ANTI_HALLUCINATION;

    return `You are an Answer Engine Optimization (AEO) and voice search specialist. You optimize content to be cited by AI assistants and voice search engines.

CONTEXT:
${context}

TASK:
${task}

For "issueAnalysis": explain specifically how this issue reduces the likelihood of being cited in AI-generated answers.
For "recommendedVersion": the actual content to add or replace — real questions/answers/steps, not instructions about what to write.
For "implementationCode": ${codeInstr}
For "beforeAfter": before = current state (absent or existing), after = your specific recommended content snippet
${antiHallBlock}

${OUTPUT_FORMAT}`;
  }
}

// ── Module-level helpers ──────────────────────────────────────────────────────

function _codeInstruction(framework, cms, target) {
  if (framework === 'nextjs') return `Next.js metadata API (export const metadata = {...}) or generateMetadata() — target: ${target}`;
  if (framework === 'wordpress') return `WordPress: Yoast SEO field or functions.php wp_head() hook — target: ${target}`;
  if (framework === 'shopify') return `Shopify: theme.liquid or SEO section schema — target: ${target}`;
  if (framework === 'react') return `React: react-helmet or document.head manipulation — target: ${target}`;
  return `Standard HTML — copy-paste ready <head> snippet for ${target}`;
}

function _wcagReference(issueId) {
  const refs = {
    form_labels:          'WCAG 2.1 SC 1.3.1 (Info and Relationships) + SC 4.1.2 (Name, Role, Value)',
    form_inputs_labels:   'WCAG 2.1 SC 1.3.1 (Info and Relationships) + SC 4.1.2 (Name, Role, Value)',
    keyboard_accessibility:'WCAG 2.1 SC 2.1.1 (Keyboard)',
    focus_indicators:     'WCAG 2.1 SC 2.4.7 (Focus Visible)',
    video_captions:       'WCAG 2.1 SC 1.2.2 (Captions, prerecorded)',
    tap_target_size:      'WCAG 2.5.5 Target Size (AAA) — 44x44px minimum',
    images_missing_alt_text:'WCAG 2.1 SC 1.1.1 (Non-text Content)',
  };
  return refs[issueId] || 'WCAG 2.1 Level AA';
}

export default new PromptBuilder();
