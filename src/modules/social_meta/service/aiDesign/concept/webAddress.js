/**
 * Web addresses never appear as words on a design (live report, Nov 2026: "https://…/" was printed on an image). Every text the brief
 * wants drawn is cleaned here before it is composed; when the brief did want the website shown, its BARE domain ("oditoai.com") is
 * returned so the renderer can put it, small, in the footer - only on a single image or a carousel's CTA slide (once per post).
 */

// a full URL, a www. address, or a bare domain with a common TLD (optionally with a path)
const URL_RE = /\b(?:https?:\/\/[^\s]+|www\.[^\s]+|(?:[a-z0-9-]+\.)+(?:com|in|io|ai|co|net|org|app|dev|biz|info|uk|us|au|ca|de|shop|store|agency|digital)\b(?:\/[^\s]*)?)/gi;
// words left dangling once the address is gone ("Visit", "at", "on", "to", ":")
const DANGLING_RE = /(?:\s*(?:visit|at|on|to|via|go to|see|check out|find us at|find us on|learn more at)\s*)+$/i;

/** The bare domain of an address: no scheme, no www., no path, lowercase. */
export function bareDomain(address) {
  const host = String(address || '').trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').split(/[/?#\s]/)[0].replace(/[.,;:!?)\]]+$/, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host) ? host.toLowerCase() : null;
}

/** One text without its web addresses (and the words that only pointed at them); null in, '' out stays as it was. */
export function withoutWebAddresses(text) {
  if (!text) return { text, found: [] };
  const found = String(text).match(URL_RE) || [];
  if (!found.length) return { text, found };
  // a connector word right before an address points only at it ("audit at www.x.com today" -> "audit today")
  const withConnector = new RegExp(`(?:\\b(?:visit|at|on|via|see)\\s+)?${URL_RE.source}`, 'gi');
  let out = String(text).replace(withConnector, ' ').replace(/\s{2,}/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim();
  out = out.replace(/[\s:,\-–—]+$/, '').replace(DANGLING_RE, '').replace(/[\s:,\-–—]+$/, '').trim();
  return { text: out, found };
}

/** The brief with every drawn text cleaned: { brief, domain } (domain = the first address the brief wanted shown, bare; else null). */
export function stripWebAddresses(brief) {
  const found = [];
  const clean = (t) => { const r = withoutWebAddresses(t); found.push(...r.found); return r.text; };
  const out = { ...brief };
  for (const key of ['hook_headline', 'subline', 'cta', 'kicker']) if (typeof out[key] === 'string') out[key] = clean(out[key]);
  if (Array.isArray(out.labels)) out.labels = out.labels.map(clean).filter(Boolean);
  if (Array.isArray(out.image_labels)) out.image_labels = out.image_labels.map((l) => ({ ...l, text: clean(l.text) })).filter((l) => l.text);
  const domain = found.map(bareDomain).find(Boolean) || null;
  return { brief: out, domain };
}
