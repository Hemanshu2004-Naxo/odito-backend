/**
 * Claude Service
 * 
 * Claude API integration for recommendation generation.
 * 
 * CRITICAL DESIGN PRINCIPLE:
 * Claude returns PARTIAL intelligence only.
 * It NEVER returns the final DB-ready shape.
 * 
 * Claude output → recommendationNormalizer → final sections
 * 
 * This service handles:
 * - Prompt construction (context-aware)
 * - API call with retry + timeout
 * - Structured JSON output parsing
 * - Token usage tracking
 * - Error handling (graceful degradation)
 */

import PromptBuilder from '../prompts/PromptBuilder.js';
import { setGlobalDispatcher, Agent } from 'undici';

// ── TCP keep-alive for all outbound fetch() calls ──────────────────────────────
// Without this, NAT/firewall devices silently drop TCP connections that carry
// no data for ~60-70 seconds.  The Claude API holds the TCP connection open
// while the model generates tokens (20-70s) with zero bytes flowing.
// NAT sees an idle session → tears it down → fetch throws "fetch failed" (ECONNRESET).
// TCP keep-alive probes (every 10s) prove the connection is alive and prevent this.
setGlobalDispatcher(new Agent({
  connect: {
    keepAlive:              true,
    keepAliveInitialDelay:  10_000,  // first probe after 10s of silence
    keepAliveMaxFailureCount: 3,     // drop after 3 missed probe responses
  },
}));

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL   = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const MAX_TOKENS     = 1500;   // legacy path default; context-aware path uses GroupRegistry values
const TIMEOUT_MS     = 90000;  // 90s: covers Sonnet 4.6 worst-case queue + inference + network

// Minimum delay before a timeout retry (ms). Jitter ±500ms is added at call site.
const RETRY_DELAY_MS = 1500;

class ClaudeService {

  constructor() {
    // DO NOT read env here — module singleton is created at import time
    // before dotenv may have finished loading.
    this._apiKey = null;
    this._keyChecked = false;
  }

  /**
   * Lazy-load API key on first access (ensures .env is loaded).
   * @private
   */
  _getApiKey() {
    if (!this._keyChecked) {
      this._apiKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || null;
      this._keyChecked = true;
      if (this._apiKey) {
        console.log('[CLAUDE_SERVICE] API key loaded successfully');
      } else {
        console.warn('[CLAUDE_SERVICE] ⚠ No ANTHROPIC_API_KEY or CLAUDE_API_KEY found in environment');
      }
    }
    return this._apiKey;
  }

  /**
   * Check if Claude is available (API key configured).
   * @returns {boolean}
   */
  isAvailable() {
    return !!this._getApiKey();
  }

  /**
   * Generate partial recommendation intelligence from Claude.
   * Returns raw AI output (NOT the final DB shape).
   *
   * @param {string} ruleId        - The rule that triggered the issue
   * @param {Object} context       - { pageType, framework, cms, detectedSchemas, wordCount }
   * @param {Object} ruleMetadata  - { title, description, recommendation } from catalog
   * @param {Object} [issueContext] - Live IssueContext from the Issue Context Engine:
   *                                   { currentState, expectedState, pageContext }
   * @returns {Promise<Object>} { rawOutput, tokensUsed, modelUsed, generationTimeMs }
   */
  /**
   * @param {string} ruleId
   * @param {Object} context
   * @param {Object} ruleMetadata
   * @param {Object|null} issueContext
   * @param {Object|null} recommendationContext
   * @param {Object|null} repairHint  — { previousOutput: string, failureReasons: string[] }
   *   When provided, a repair prompt is used instead of the base prompt.
   * @param {number|null} maxTokensOverride — when provided, used instead of the
   *   group's static budget. Set by the caller on a retry that followed a
   *   CLAUDE_TRUNCATED failure, so the retry actually has more room instead
   *   of hitting the exact same ceiling again.
   */
  async generate(ruleId, context, ruleMetadata = {}, issueContext = null, recommendationContext = null, repairHint = null, maxTokensOverride = null) {
    if (!this.isAvailable()) {
      console.error('[CLAUDE_SERVICE] Cannot generate — API key not configured');
      throw new Error('CLAUDE_NOT_CONFIGURED');
    }

    // ── Route to context-aware prompt when RecommendationContext is available ──
    let prompt, maxTokens, builtGroup;
    if (recommendationContext?.builderMeta?.hasRichContext) {
      // Repair path: use targeted repair prompt on retry
      const built = repairHint
        ? PromptBuilder.buildRepair(
            recommendationContext,
            ruleMetadata,
            repairHint.previousOutput,
            repairHint.failureReasons
          )
        : PromptBuilder.build(recommendationContext, ruleMetadata);

      prompt     = built.prompt;
      maxTokens  = maxTokensOverride || built.maxTokens;
      builtGroup = built.group;
      console.log(`[CLAUDE_SERVICE] ${repairHint ? 'Repair' : 'Context-aware'} path | group=${built.group} | maxTokens=${maxTokens}${maxTokensOverride ? ' (boosted)' : ''} | rule=${ruleId}`);
    } else {
      // Legacy fallback: use existing prompt builders (displayType-based routing)
      prompt     = this._buildPrompt(ruleId, context, ruleMetadata, issueContext);
      maxTokens  = maxTokensOverride || MAX_TOKENS;
      builtGroup = null;
      console.log(`[CLAUDE_SERVICE] Legacy path | rule=${ruleId} | richContext=${recommendationContext?.builderMeta?.hasRichContext ?? 'none'}`);
    }

    const startTime = Date.now();
    const requestId = `rec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    try {
      const response = await this._callAPI(prompt, maxTokens, requestId);
      const generationTimeMs = Date.now() - startTime;

      let parsed;
      try {
        parsed = this._parseResponse(response);
      } catch (parseError) {
        // A response that stopped because it ran out of room (stop_reason
        // === 'max_tokens') is a DIFFERENT failure class than genuinely
        // malformed JSON (e.g. Claude wrote prose instead of JSON) — the
        // former is fixable by retrying with more room, the latter is not.
        // Distinguishing them here is what lets recommendationService.js's
        // retry loop decide whether a bigger maxTokens budget is worth
        // trying, instead of every JSON parse failure being a dead end.
        if (response.stop_reason === 'max_tokens') {
          const err = new Error('CLAUDE_TRUNCATED');
          err.claudeErrorCode = 'CLAUDE_TRUNCATED';
          err.attemptedMaxTokens = maxTokens;
          throw err;
        }
        throw parseError;
      }

      return {
        rawOutput: parsed.content,
        tokensUsed: {
          input: response.usage?.input_tokens || 0,
          output: response.usage?.output_tokens || 0,
        },
        modelUsed:        CLAUDE_MODEL,
        generationTimeMs,
        promptGroup:      builtGroup ?? null,   // null on legacy path
        promptPath:       builtGroup != null ? 'context_aware' : (issueContext?.currentState?.rawValue ? 'legacy_content' : 'legacy_structural'),
      };
    } catch (error) {
      console.error(`[CLAUDE_SERVICE] Generation failed for rule=${ruleId}:`, error.message);
      throw error;
    }
  }

  /**
   * Route to the appropriate prompt builder.
   *
   * Content improvement issues (displayType=text with rawValue) get a specialized
   * prompt that asks Claude to improve the existing text — not produce generic advice.
   * All other issues get the standard structural recommendation prompt.
   * @private
   */
  _buildPrompt(ruleId, context, ruleMetadata, issueContext) {
    const cs = issueContext?.currentState;
    if (cs?.displayType === 'text' && cs?.rawValue) {
      return this._buildContentImprovementPrompt(ruleId, context, ruleMetadata, issueContext);
    }
    return this._buildStructuralPrompt(ruleId, context, ruleMetadata);
  }

  /**
   * Prompt for content improvement issues (meta description, title, H1, opening paragraphs).
   *
   * Claude must improve the EXISTING text — not generate a replacement with unrelated content.
   * Output includes optimizedText + characterCount + changeExplanation for before/after rendering.
   * @private
   */
  _buildContentImprovementPrompt(ruleId, context, ruleMetadata, issueContext) {
    const { pageType, framework, cms } = context;
    const { title: issueTitle } = ruleMetadata;
    const cs = issueContext.currentState;
    const es = issueContext.expectedState;
    const pc = issueContext.pageContext || {};

    const rawValue    = cs.rawValue;
    const label       = cs.label || 'Content';
    const currentLen  = cs.measurement?.value ?? rawValue.length;
    const minTarget   = cs.measurement?.threshold ?? es?.measurement?.min ?? null;
    const maxTarget   = cs.measurement?.maxThreshold ?? es?.measurement?.max ?? null;
    const unit        = cs.measurement?.unit || 'characters';
    const pageTitle   = cs.relatedContent?.pageTitle || null;
    const pageUrl     = pc.pageUrl || null;
    const targetDesc  = es?.description || `${label} within the target range`;

    const rangeStr = minTarget && maxTarget
      ? `${minTarget}–${maxTarget} ${unit}`
      : minTarget ? `at least ${minTarget} ${unit}` : `at most ${maxTarget} ${unit}`;

    const shortfall = minTarget && currentLen < minTarget
      ? `${minTarget - currentLen} ${unit} too short`
      : maxTarget && currentLen > maxTarget
        ? `${currentLen - maxTarget} ${unit} too long`
        : null;

    return `You are an expert SEO copywriter. Your job is to improve an existing piece of page content.

DETECTED ISSUE: ${ruleId}
ISSUE TITLE: ${issueTitle || ruleId}

CURRENT ${label.toUpperCase()}:
"${rawValue}"

MEASUREMENT:
- Current: ${currentLen} ${unit}
- Target: ${rangeStr}${shortfall ? `\n- Problem: ${shortfall}` : ''}

PAGE CONTEXT:
- Page Title: ${pageTitle || 'Unknown'}
- Page URL: ${pageUrl || 'Unknown'}
- Page Type: ${pageType}
- Framework: ${framework}
- CMS: ${cms || 'Unknown'}

TASK:
Improve the existing ${label.toLowerCase()} to fix the issue.

RULES:
1. Keep the same core message and brand voice as the original
2. Do NOT replace with unrelated content — improve what exists
3. The optimized version MUST satisfy: ${targetDesc}
4. If too short: expand naturally (add value, a CTA, or qualifying detail)
5. If too long: trim without losing meaning (cut redundant phrases)
6. Never use generic padding like "Learn more", "Click here", or "Find out more"
7. The final character count must be within the target range

Generate a JSON response with EXACTLY these fields:
1. "whyThisMatters" — 1-2 sentences explaining the SEO and AI visibility impact of this specific issue
2. "optimizedText" — The improved ${label.toLowerCase()} (must be within target range)
3. "characterCount" — Exact character count of optimizedText as a number
4. "changeExplanation" — One sentence: what specifically was changed and why
5. "recommendedFix" — Where and how to update this in their ${framework !== 'unknown' ? framework : 'CMS/HTML'}
6. "implementationCode" — Ready-to-paste code containing the optimized text (${framework === 'nextjs' ? 'Next.js metadata API' : framework === 'wordpress' ? 'WordPress/Yoast field value' : 'HTML tag'})
7. "impacts" — Array of 2-3 specific impact bullets for this improvement
8. "recovery" — { "aiVisibility": number, "semanticTrust": number, "freshness": number, "accessibility": number } (0-100)
9. "difficulty" — "easy"
10. "estimatedFixTime" — "5 minutes"

IMPORTANT: optimizedText must be the actual improved content, not a placeholder or instruction.

Respond with JSON only:`;
  }

  /**
   * Standard structural recommendation prompt (missing elements, broken links, schema issues, etc.)
   * @private
   */
  _buildStructuralPrompt(ruleId, context, ruleMetadata) {
    const { pageType, framework, cms, detectedSchemas, wordCount } = context;
    const { title, description, recommendation } = ruleMetadata;

    return `You are an enterprise SEO and AI visibility expert. Generate a recommendation for fixing an issue.

ISSUE CONTEXT:
- Rule: ${ruleId}
- Issue Title: ${title || ruleId}
- Issue Description: ${description || 'Not available'}
- Existing Recommendation Hint: ${recommendation || 'None'}

PAGE CONTEXT:
- Page Type: ${pageType}
- Framework: ${framework}
- CMS: ${cms || 'Unknown'}
- Detected Schemas: ${(detectedSchemas || []).join(', ') || 'None'}
- Word Count: ${wordCount || 'Unknown'}

INSTRUCTIONS:
Generate a JSON response with EXACTLY these fields:
1. "whyThisMatters" — 2-3 sentences explaining why this issue hurts AI visibility specifically. Be concrete, not generic.
2. "recommendedFix" — Clear, actionable fix steps. Be specific to the framework/CMS.
3. "implementationCode" — Actual code/markup to implement the fix. Target the framework (${framework}). If WordPress, give plugin instructions or functions.php snippet. If Next.js, give JSX/component code. If generic, give HTML.
4. "impacts" — Array of 3-5 specific impact bullets (strings). Example: "Increases AI citation probability by 20-35%"
5. "recovery" — Object with numeric scores (0-100): { "aiVisibility": number, "semanticTrust": number, "freshness": number, "accessibility": number }
6. "difficulty" — One of: "easy", "medium", "hard"
7. "estimatedFixTime" — Human readable time estimate. Example: "10 minutes"

IMPORTANT RULES:
- Be specific to ${framework} and ${pageType} pages
- Code must be copy-paste ready
- Do NOT include markdown formatting in code
- Keep whyThisMatters under 400 characters
- Keep recommendedFix under 700 characters
- Keep implementationCode under 1500 characters
- Return ONLY valid JSON, no surrounding text

Respond with JSON only:`;
  }

  /**
   * Call the Claude API with timeout, structured logging, and classified errors.
   *
   * Errors thrown use a machine-readable code as the message so callers can
   * branch on error type without string-matching stack traces:
   *   CLAUDE_TIMEOUT        — AbortController fired after TIMEOUT_MS
   *   CLAUDE_RATE_LIMITED   — HTTP 429; retry-after header forwarded as error.retryAfter
   *   CLAUDE_OVERLOADED     — HTTP 529 Anthropic overloaded
   *   CLAUDE_HTTP_<STATUS>  — any other non-2xx response
   *   CLAUDE_NETWORK_ERROR  — fetch() threw before receiving a response
   * @private
   */
  async _callAPI(prompt, maxTokens = MAX_TOKENS, requestId = null, options = {}) {
    const reqId      = requestId || Math.random().toString(36).slice(2, 9);
    const apiKey     = this._getApiKey();
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const callStart  = Date.now();

    // ── Build payload once so we can log its size and reuse the string ────────
    const payload = JSON.stringify({
      model:      CLAUDE_MODEL,
      max_tokens: maxTokens,
      messages:   [{ role: 'user', content: prompt }],
      // Optional system prompt (used by the investigation engine's master prompt). Absent for every legacy caller.
      ...(options.system ? { system: options.system } : {}),
    });
    const payloadBytes        = Buffer.byteLength(payload, 'utf8');
    const promptTokenEstimate = Math.ceil(prompt.length / 4);

    console.log(
      `[CLAUDE] call.start | reqId=${reqId} | model=${CLAUDE_MODEL}` +
      ` | maxTokens=${maxTokens}` +
      ` | promptChars=${prompt.length}` +
      ` | payloadKB=${(payloadBytes / 1024).toFixed(1)}` +
      ` | estimatedInputTokens≈${promptTokenEstimate}` +
      ` | timeoutMs=${TIMEOUT_MS}`
    );

    try {
      const response = await fetch(CLAUDE_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         apiKey,
          'anthropic-version': '2023-06-01',
        },
        body:   payload,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      const durationMs = Date.now() - callStart;

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');

        if (response.status === 429) {
          const retryAfter = parseInt(response.headers.get('retry-after') || '60', 10);
          console.error(
            `[CLAUDE] call.rate_limited | reqId=${reqId} | status=429` +
            ` | retryAfter=${retryAfter}s | durationMs=${durationMs}`
          );
          const err = new Error('CLAUDE_RATE_LIMITED');
          err.retryAfter = retryAfter;
          err.claudeErrorCode = 'CLAUDE_RATE_LIMITED';
          throw err;
        }

        if (response.status === 529) {
          console.error(
            `[CLAUDE] call.overloaded | reqId=${reqId} | status=529 | durationMs=${durationMs}`
          );
          const err = new Error('CLAUDE_OVERLOADED');
          err.claudeErrorCode = 'CLAUDE_OVERLOADED';
          throw err;
        }

        console.error(
          `[CLAUDE] call.http_error | reqId=${reqId} | status=${response.status}` +
          ` | body=${errorBody.slice(0, 200)} | durationMs=${durationMs}`
        );
        const err = new Error(`CLAUDE_HTTP_${response.status}`);
        err.claudeErrorCode = `CLAUDE_HTTP_${response.status}`;
        err.httpStatus = response.status;
        throw err;
      }

      const data = await response.json();
      const inputTokens  = data.usage?.input_tokens  || 0;
      const outputTokens = data.usage?.output_tokens || 0;

      console.log(
        `[CLAUDE] call.success | reqId=${reqId} | status=${response.status}` +
        ` | inputTokens=${inputTokens} | outputTokens=${outputTokens}` +
        ` | maxTokens=${maxTokens} | utilizationPct=${Math.round((outputTokens / maxTokens) * 100)}%` +
        ` | stopReason=${data.stop_reason}` +
        ` | durationMs=${durationMs} | payloadKB=${(payloadBytes / 1024).toFixed(1)}`
      );

      if (data.stop_reason === 'max_tokens') {
        console.warn(`[CLAUDE] ⚠ Response truncated by max_tokens | reqId=${reqId} | maxTokens=${maxTokens} — output was cut off mid-generation, likely to fail JSON parsing`);
      }

      return data;

    } catch (error) {
      clearTimeout(timeoutId);
      const durationMs = Date.now() - callStart;

      if (error.claudeErrorCode) {
        throw error;
      }

      if (error.name === 'AbortError') {
        console.error(
          `[CLAUDE] call.timeout | reqId=${reqId}` +
          ` | timeoutMs=${TIMEOUT_MS} | durationMs=${durationMs}` +
          ` | maxTokens=${maxTokens} | payloadKB=${(payloadBytes / 1024).toFixed(1)}`
        );
        const err = new Error('CLAUDE_TIMEOUT');
        err.claudeErrorCode = 'CLAUDE_TIMEOUT';
        err.timeoutMs = TIMEOUT_MS;
        throw err;
      }

      // ── Full error-chain extraction ──────────────────────────────────────
      // Node 22 / undici: error.message = "fetch failed"
      //                   error.cause   = SocketError | ConnectTimeoutError | …
      //                   error.cause.code = "ECONNRESET" | "ENOTFOUND" | "ETIMEDOUT" …
      const cause      = error.cause;
      const causeCode  = cause?.code    || cause?.constructor?.name || 'n/a';
      const causeMsg   = cause?.message || 'n/a';
      const causeDeep  = cause?.cause?.code || cause?.cause?.message || 'n/a';

      console.error(
        `[CLAUDE] call.network_error | reqId=${reqId}` +
        ` | error.name=${error.name}` +
        ` | error.message=${error.message}` +
        ` | cause.code=${causeCode}` +
        ` | cause.message=${causeMsg}` +
        ` | cause.cause=${causeDeep}` +
        ` | durationMs=${durationMs}` +
        ` | payloadKB=${(payloadBytes / 1024).toFixed(1)}`
      );

      const err = new Error('CLAUDE_NETWORK_ERROR');
      err.claudeErrorCode = 'CLAUDE_NETWORK_ERROR';
      err.networkCode = causeCode;  // "ECONNRESET", "ETIMEDOUT", etc.
      err.cause = error;
      throw err;
    }
  }

  /**
   * Returns delay in ms before a retry given the error type and attempt number.
   * Returns null if the error should not be retried.
   * @param {Error} error
   * @param {number} attempt  1-based attempt number that just failed
   * @returns {number|null}
   */
  retryDelayFor(error, attempt) {
    const code = error.claudeErrorCode || error.message;
    const base = RETRY_DELAY_MS * Math.pow(2, attempt - 1); // exponential: 1.5s, 3s, 6s
    const jitter = Math.floor(Math.random() * 500);

    switch (code) {
      case 'CLAUDE_TIMEOUT':       return base + jitter;           // 1.5–2s, 3–3.5s
      case 'CLAUDE_OVERLOADED':    return Math.max(10000, base) + jitter;  // min 10s
      case 'CLAUDE_RATE_LIMITED':  return (error.retryAfter || 60) * 1000; // honour header
      case 'CLAUDE_NETWORK_ERROR': return 1000 + jitter;           // fast retry
      case 'CLAUDE_TRUNCATED':     return 500 + jitter;             // not a capacity issue — retry fast with more room
      default:                     return null;                    // don't retry (genuinely malformed JSON, auth)
    }
  }

  /**
   * Parse Claude's response, extracting JSON content.
   * @private
   */
  _parseResponse(response) {
    if (!response.content || !response.content.length) {
      throw new Error('CLAUDE_EMPTY_RESPONSE');
    }

    const textBlock = response.content.find(c => c.type === 'text');
    if (!textBlock || !textBlock.text) {
      throw new Error('CLAUDE_NO_TEXT_BLOCK');
    }

    let text = textBlock.text.trim();

    // Strip markdown code fences if Claude wraps it
    if (text.startsWith('```')) {
      text = text.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();
    }

    try {
      const parsed = JSON.parse(text);
      return { content: parsed, raw: text };
    } catch (parseError) {
      // Try to extract JSON from the response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          return { content: parsed, raw: jsonMatch[0] };
        } catch {
          throw new Error('CLAUDE_INVALID_JSON');
        }
      }
      throw new Error('CLAUDE_INVALID_JSON');
    }
  }
}

export default new ClaudeService();
