/**
 * Shared value-comparison normalization (Phase 3 verification audit).
 *
 * WHY THIS EXISTS: WordPress's rendering pipeline (`wptexturize`, applied to
 * `the_title()`/post content output) converts plain ASCII quotes/apostrophes
 * and double-hyphens into their typographic ("curly quote"/en-dash)
 * equivalents, and the Python crawler (BeautifulSoup) decodes any literal
 * HTML entities back to natural Unicode when it parses `<title>`/meta text.
 * An AI-recommended value seeded with plain ASCII punctuation can therefore
 * round-trip through WordPress and a real recrawl differing from the
 * original by *only* a quote/dash style — not any actual content change —
 * which would otherwise register as a false "reopened" in
 * TaskVerificationService. Canonical URLs have a second, unrelated
 * normalization need: WordPress frequently adds/omits a trailing slash on
 * permalinks regardless of what was written.
 *
 * Used by BOTH TaskVerificationService.js (the authoritative post-recrawl
 * check, comparing against `seo_page_data`) and wordPressSeoFixService.js
 * (the immediate, non-authoritative check, comparing against a live
 * WordPress read) so the two can never silently disagree about what counts
 * as "the same value."
 *
 * Deliberately conservative — this ONLY folds together characters that are
 * typographically equivalent and tolerates a trailing slash on URLs; it
 * never changes actual wording, and every value that compared equal before
 * this normalization existed still compares equal after (strictly more
 * lenient, never less — see the "preserve exact-value verification" rule
 * this was reviewed against).
 */

const ENTITY_REPLACEMENTS = [
  [/&amp;/gi, '&'],
  [/&lt;/gi, '<'],
  [/&gt;/gi, '>'],
  [/&quot;/gi, '"'],
  [/&#0?39;/gi, "'"],
  [/&apos;/gi, "'"],
  [/&nbsp;/gi, ' '],
  [/&#8217;/gi, '’'],
  [/&#8216;/gi, '‘'],
  [/&#8220;/gi, '“'],
  [/&#8221;/gi, '”'],
  [/&#8211;/gi, '–'],
  [/&#8212;/gi, '—'],
];

// Typographic ("curly") punctuation -> plain ASCII equivalent.
const TYPOGRAPHIC_REPLACEMENTS = [
  [/[‘’‚‛]/g, "'"],
  [/[“”„‟]/g, '"'],
  [/[–—]/g, '-'],
  [/ /g, ' '],
];

function decodeEntities(value) {
  let out = value;
  for (const [pattern, replacement] of ENTITY_REPLACEMENTS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function foldTypography(value) {
  let out = value;
  for (const [pattern, replacement] of TYPOGRAPHIC_REPLACEMENTS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * General text-field comparison normalization (title, meta description, H1,
 * image alt text). Case-insensitive, whitespace-collapsed, HTML-entity-
 * decoded, and typographically folded. Non-string input is returned as-is
 * (matching every existing call site's own null/undefined handling).
 */
export function normalizeTextValue(value) {
  if (typeof value !== 'string') return value;
  const decoded = foldTypography(decodeEntities(value));
  return decoded.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Canonical URL comparison: same text normalization as above, plus
 * trailing-slash tolerance. Deliberately does NOT reorder query parameters,
 * strip default ports, or otherwise rewrite the URL — a genuinely different
 * path, host, or query string still compares as different. Returns false
 * (never throws) for empty/missing input on either side, matching every
 * existing canonical comparison's own "no value means no match" behavior.
 */
export function canonicalValuesMatch(a, b) {
  const normalize = (value) => {
    const text = normalizeTextValue(value);
    return typeof text === 'string' ? text.replace(/\/+$/, '') : text;
  };
  const normA = normalize(a);
  const normB = normalize(b);
  if (!normA || !normB) return false;
  return normA === normB;
}

/**
 * Validates and normalizes a value intended to be WRITTEN or compared as a
 * canonical URL. Defensively unwraps a `<link rel="canonical" href="...">`
 * tag down to just the href if given one — a value shaped like that should
 * never reach this point by design (see PromptBuilder.js's
 * canonical_tag_errors prompt, which explicitly asks for a bare URL, never
 * markup), but this exists as an independent second safety net: a
 * pre-existing bad recommendation, or a future generation regression, must
 * never silently get WRITTEN to WordPress as a literal HTML string instead
 * of a URL (the exact production bug this function was added to close —
 * Rank Math accepted the malformed string into `rank_math_canonical_url`
 * without complaint, then declined to render an invalid `<link>` tag from
 * it, so the write "succeeded" while the public page had no canonical tag
 * at all).
 *
 * Returns null (never throws) if the result isn't a safe, well-formed
 * absolute http(s) URL — callers must treat null exactly like any other
 * missing/empty value (no usable value to write or compare), never as a
 * value to sanitize further or pass through anyway.
 */
export function extractCanonicalUrlValue(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  let candidate = trimmed;

  // Only unwrap when the ENTIRE trimmed input is exactly one clean
  // <link ...> tag — anchored to start (^) and end ($) so a <link> tag
  // nested or embedded inside other markup (e.g. "<div><link .../></div>",
  // or any unrelated text/tags surrounding it) is never opportunistically
  // unwrapped. Extracting "the URL" out of arbitrary surrounding HTML would
  // be guessing which part of an untrusted string is the real value —
  // exactly the kind of silent HTML acceptance this function must not do.
  const linkTagMatch = trimmed.match(/^<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>$/i);
  if (linkTagMatch) {
    candidate = linkTagMatch[1].trim();
  }

  // Anything still containing markup (either the input never matched a
  // clean standalone <link> tag, or the unwrapped href itself contains
  // markup) is not salvageable — never guess at extracting a URL from
  // arbitrary embedded HTML.
  if (!candidate || candidate.includes('<') || candidate.includes('>')) return null;

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  return candidate;
}

/**
 * Robots meta (noindex_key_pages / noindex_tags) — strict internal
 * representation and wire format, mirroring the same "one shared boundary,
 * never invented ad hoc per call site" approach as canonical above.
 *
 * Internal representation: `{ index: boolean, follow: boolean }`. Only the
 * RESTRICTIVE directives (noindex, nofollow) are ever meaningful to store —
 * their ABSENCE is what "index"/"follow" mean, per the HTML robots meta
 * spec and Rank Math's own storage model (an empty/absent
 * `rank_math_robots` meta means the site default, index+follow). This
 * object form is used everywhere in the Node codebase (recommendation
 * validation, TaskHistoryService, TaskVerificationService,
 * wordPressSeoFixService); only the Bridge wire format (a plain string) and
 * the human-readable recommendedVersion text are ever serialized forms of
 * it, converted at the edges — never a third, ad hoc shape in between.
 */

// The ONLY 4 strings a recommendedVersion for a robots-type issue may ever
// contain — a closed allowlist, not a free-form parser, so there is no
// ambiguity a future issue type could exploit to smuggle an unsupported
// directive (e.g. "noarchive", "max-snippet") through as if it were safe.
const ROBOTS_DIRECTIVE_STRINGS = {
  'index, follow': { index: true, follow: true },
  'noindex, follow': { index: false, follow: true },
  'index, nofollow': { index: true, follow: false },
  'noindex, nofollow': { index: false, follow: false },
};

/**
 * Strict parse for a recommendedVersion/expectedAfterValue robots string —
 * must be an exact (case/whitespace-insensitive) match to one of the 4
 * allowed directive-combination strings. Returns null (never throws, never
 * guesses) for anything else, including free-form prose a validator failure
 * might otherwise let through.
 */
export function normalizeRobotsValue(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase().replace(/\s+/g, ' ');
  const match = ROBOTS_DIRECTIVE_STRINGS[key];
  return match ? { ...match } : null;
}

/**
 * Lenient parse for a robots value read back FROM WordPress — either the
 * Bridge's own wire string (e.g. "noindex", "", "noindex, nofollow" — see
 * robotsValueToWireString) or the crawler's actual rendered
 * `<meta name="robots" content="...">` attribute text, which real themes
 * render in varying styles (some omit "index"/"follow" entirely when not
 * restricted, some spell them out explicitly, tokens may be separated by
 * "," or ", "). Unlike normalizeRobotsValue, this never rejects input —
 * every string has a well-defined reading: a directive is only "off"
 * (noindex/nofollow present) if that literal token appears; anything else,
 * including an empty string or unrelated directives like "max-snippet",
 * means that axis stays at its default (index/follow). Returns null only
 * for non-string input (nothing to read at all — distinct from "read an
 * empty/default value").
 */
export function parseRobotsDirectives(value) {
  if (typeof value !== 'string') return null;
  const lower = value.toLowerCase();
  return {
    index: !/\bnoindex\b/.test(lower),
    follow: !/\bnofollow\b/.test(lower),
  };
}

/**
 * The Bridge's wire format: only ever lists the RESTRICTIVE directives that
 * are actually present, comma-space-joined, alphabetically ordered for
 * determinism — "" for {index:true, follow:true} (no restriction — the
 * Bridge deletes the underlying meta entirely for this case, matching Rank
 * Math's own "uncheck both boxes" behavior), up to "nofollow, noindex" for
 * both restricted (alphabetical: "nofollow" sorts before "noindex"). Never
 * includes the literal words "index"/"follow" — a provider that only knows
 * how to store restrictive flags (Rank Math's `rank_math_robots` meta
 * array) can consume this directly.
 */
export function robotsValueToWireString({ index, follow } = {}) {
  const directives = [];
  if (index === false) directives.push('noindex');
  if (follow === false) directives.push('nofollow');
  return directives.sort().join(', ');
}

/** Type-aware equality for two `{index, follow}` objects — null/non-object never matches anything, including another null (mirrors canonicalValuesMatch's "no value means no match" convention). */
export function robotsValuesMatch(a, b) {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  return a.index === b.index && a.follow === b.follow;
}

/**
 * Organization/site schema (organization_schema, sameas_array issues) — added
 * alongside the site-level Rank Math Knowledge Graph capability. Validates a
 * plain text field (name/description) intended for Organization schema:
 * non-empty, trimmed, no HTML markup (the same "this is a data value, never
 * rendered as HTML" principle as every other field here — Organization
 * schema is JSON-LD, so a value containing `<`/`>` could not have been
 * legitimately authored by an SEO recommendation and is rejected outright
 * rather than guessed at).
 */
export function normalizeSchemaTextValue(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('<') || trimmed.includes('>')) return null;
  return trimmed;
}

/**
 * Validates a value intended for an Organization schema URL field (url,
 * logo) or a sameAs entry — same strict rules as canonical's
 * extractCanonicalUrlValue (absolute http(s) only, no markup, no
 * javascript:/data:), but WITHOUT canonical's `<link>`-tag-unwrapping
 * special case, since nothing in the Organization/sameAs data flow ever
 * legitimately produces an HTML-wrapped value to salvage — any markup here
 * is unconditionally rejected, never unwrapped.
 */
export function normalizeSchemaUrlValue(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('<') || trimmed.includes('>')) return null;

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  return trimmed;
}

/**
 * Breadcrumbs (breadcrumblist_schema issue) — the only capability whose
 * "recommendedVersion" is a fix DIRECTION, not a value. Every current
 * breadcrumblist_schema finding means "BreadcrumbList schema is missing" —
 * there is no "disable breadcrumbs" issue in Odito's audit system — so the
 * closed allowlist is deliberately a single accepted string, mirroring
 * robots' closed-allowlist strictness rather than accepting an arbitrary
 * boolean-ish value ("yes"/"1"/"true"/...) that would need its own guessing
 * rules.
 */
export function normalizeBreadcrumbEnableValue(value) {
  if (typeof value !== 'string') return null;
  return value.trim().toLowerCase() === 'enabled' ? true : null;
}

export default {
  normalizeTextValue,
  canonicalValuesMatch,
  extractCanonicalUrlValue,
  normalizeRobotsValue,
  parseRobotsDirectives,
  robotsValueToWireString,
  robotsValuesMatch,
  normalizeSchemaTextValue,
  normalizeSchemaUrlValue,
  normalizeBreadcrumbEnableValue,
};
