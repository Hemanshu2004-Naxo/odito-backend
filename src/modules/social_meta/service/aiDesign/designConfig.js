/**
 * AI design (image) generation - configuration. Every knob lives here (env overrides, non-positive /
 * non-finite values rejected); nothing is hardcoded in the service or provider. Read once at import,
 * like the other Social AI configs.
 *
 *   model:  SOCIAL_AI_DESIGN_MODEL -> DEFAULT_DESIGN_MODEL   (an OpenAI `gpt-image-*` model)
 *   key:    OPENAI_IMAGE_API_KEY -> OPENAI_POST_API_KEY -> OPENAI_API_KEY   (server-side only; see the provider)
 */

const num = (v, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

/** Fallback only when SOCIAL_AI_DESIGN_MODEL is unset. Image models are retired/renamed often: set it explicitly in production. */
export const DEFAULT_DESIGN_MODEL = 'gpt-image-1';
export const DESIGN_MODEL = process.env.SOCIAL_AI_DESIGN_MODEL || DEFAULT_DESIGN_MODEL;
/** low | medium | high | auto. Medium is the cost/quality balance; the provider rejects anything else. */
export const DESIGN_QUALITY = ['low', 'medium', 'high', 'auto'].includes(process.env.SOCIAL_AI_DESIGN_QUALITY) ? process.env.SOCIAL_AI_DESIGN_QUALITY : 'medium';
/** Image generation is much slower than text: a 60 s text timeout would cut healthy requests off. */
export const DESIGN_TIMEOUT_MS = num(process.env.SOCIAL_AI_DESIGN_TIMEOUT_MS, 120_000);
/** Transient provider failures only (timeout / overloaded / rate-limit / network). Each retry is another paid image. */
export const DESIGN_PROVIDER_RETRIES = num(process.env.SOCIAL_AI_DESIGN_PROVIDER_RETRIES, 1);
/** An `active` generation older than this is treated as interrupted and failed. Must exceed timeout x (retries + 1) + processing. */
export const DESIGN_STALE_MS = num(process.env.SOCIAL_AI_DESIGN_STALE_MS, 8 * 60 * 1000);
/** Finished generation records are bookkeeping only (the media on the publication is the product) and expire after this many days. */
export const DESIGN_RECORD_TTL_DAYS = num(process.env.SOCIAL_AI_DESIGN_RECORD_TTL_DAYS, 30);

/** Image models are far more expensive than text: a tighter default budget than the text limiter. */
export const DESIGN_RATE_LIMIT = Object.freeze({
  windowMs: num(process.env.SOCIAL_AI_DESIGN_RATE_WINDOW_MS, 15 * 60 * 1000),
  max: num(process.env.SOCIAL_AI_DESIGN_RATE_MAX, 10),
});

/**
 * What Odito asks the provider for, per platform, and what it accepts back. Meta's own rules (kept here,
 * because the publishing adapters only forward the URL and let Meta judge it):
 *  - Instagram feed: ONE JPEG image, aspect ratio between 4:5 and 1.91:1, public HTTPS URL, <= 8 MB.
 *  - Facebook photo: any ratio, <= 8 MB (Odito's own upload ceiling).
 * Output is always re-encoded as JPEG, which both accept.
 */
export const PLATFORM_DESIGN = Object.freeze({
  instagram: Object.freeze({ size: '1024x1024', minAspect: 0.8, maxAspect: 1.91 }),
  facebook: Object.freeze({ size: '1536x1024', minAspect: 0.5, maxAspect: 2.5 }),
});
export const MIN_IMAGE_SIDE = 320;
/** Real product photos sent to the provider as references (the hero of a product design). More adds cost, not fidelity. */
export const MAX_REFERENCE_IMAGES = num(process.env.SOCIAL_AI_DESIGN_MAX_REFERENCES, 2);
/** The logo is composited at most this share of the picture's width / height (subtle, never dominant). */
export const LOGO_MAX_WIDTH_RATIO = 0.14;
export const LOGO_MAX_HEIGHT_RATIO = 0.08;
export const LOGO_MARGIN_RATIO = 0.04;
/** Refuse absurd decoded sizes before sharp allocates for them. */
export const MAX_IMAGE_PIXELS = 40_000_000;
/** Largest base64 payload accepted from the provider (~ 12 MB of image). */
export const MAX_PROVIDER_B64_CHARS = 16 * 1024 * 1024;
export const JPEG_QUALITY = 90;
