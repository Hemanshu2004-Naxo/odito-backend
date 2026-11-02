/**
 * The curated registry of well-known websites that are NOT business competitors for a local or regional business, even when they rank for
 * the same keywords: government, education, associations, publishers, directories, marketplaces, review and social platforms.
 *
 * It is the ONE place such knowledge lives (no domain conditions anywhere else), it is versioned, and every classification it produces
 * carries its explanation. Entries are explicit registrable domains - a top-level domain is never enough to classify a site. Add an entry
 * only when you are sure what the site is: a wrong entry hides a real competitor. A site that is a real business (a hospital that happens
 * to have a large website) must NOT be listed; the classifier judges it from its own evidence instead.
 *
 * Matching: the exact domain or any subdomain of it (blog.practo.com matches practo.com). Bump REGISTRY_VERSION on every change: stored
 * assessments from an older version are refreshed.
 */
export const REGISTRY_VERSION = '2026-11-02.1';

export const REGISTRY_KINDS = Object.freeze({
  government: { label: 'Government / public body', text: 'is a government or public-health body' },
  association: { label: 'Professional association / non-profit', text: 'is a professional association or non-profit organisation' },
  publisher: { label: 'Publisher / reference site', text: 'is a publisher or reference site that explains topics rather than selling a service' },
  directory: { label: 'Directory / listing site', text: 'is a directory that lists many businesses rather than being one' },
  marketplace: { label: 'Marketplace', text: 'is a marketplace that sells or lists on behalf of many sellers' },
  review_platform: { label: 'Review platform', text: 'is a review platform' },
  social: { label: 'Social / community platform', text: 'is a social or community platform' },
});

// [registrable domain, kind]. Grouped for readability only.
const ENTRIES = [
  // Government and public health
  // (nhs.uk is the health information service; hospitals that treat patients are judged from their own evidence, not listed here.)
  ['nih.gov', 'government'], ['cdc.gov', 'government'], ['medlineplus.gov', 'government'], ['nhs.uk', 'government'], ['who.int', 'government'],
  // Associations and professional bodies
  ['aao.org', 'association'], ['aoa.org', 'association'], ['rcophth.ac.uk', 'association'],
  // Publishers and reference
  ['eyewiki.org', 'publisher'], ['wikipedia.org', 'publisher'], ['webmd.com', 'publisher'], ['healthline.com', 'publisher'], ['medicalnewstoday.com', 'publisher'],
  ['verywellhealth.com', 'publisher'], ['news-medical.net', 'publisher'], ['britannica.com', 'publisher'], ['medscape.com', 'publisher'],
  // Directories and listing sites
  ['practo.com', 'directory'], ['justdial.com', 'directory'], ['lybrate.com', 'directory'], ['sulekha.com', 'directory'], ['yellowpages.com', 'directory'],
  ['yellowpages.in', 'directory'], ['healthgrades.com', 'directory'], ['zocdoc.com', 'directory'], ['docprime.com', 'directory'], ['credihealth.com', 'directory'],
  // Marketplaces
  ['amazon.com', 'marketplace'], ['amazon.in', 'marketplace'], ['flipkart.com', 'marketplace'], ['indiamart.com', 'marketplace'], ['ebay.com', 'marketplace'],
  ['alibaba.com', 'marketplace'], ['etsy.com', 'marketplace'],
  // Review platforms
  ['tripadvisor.com', 'review_platform'], ['yelp.com', 'review_platform'], ['trustpilot.com', 'review_platform'], ['glassdoor.com', 'review_platform'], ['ambitionbox.com', 'review_platform'],
  // Social and community platforms
  ['facebook.com', 'social'], ['instagram.com', 'social'], ['youtube.com', 'social'], ['linkedin.com', 'social'], ['quora.com', 'social'], ['reddit.com', 'social'],
  ['pinterest.com', 'social'], ['x.com', 'social'], ['twitter.com', 'social'], ['medium.com', 'social'],
];

const BY_DOMAIN = new Map(ENTRIES);
export const REGISTRY_SIZE = BY_DOMAIN.size;

/**
 * The registry entry for a domain (exact or subdomain), or null. Never matches on a suffix such as ".gov" or ".org" alone.
 * @returns {{ domain: string, kind: string, label: string, text: string }|null}
 */
export function lookupRegistry(domain) {
  const host = String(domain ?? '').trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  if (!host) return null;
  const parts = host.split('.');
  for (let i = 0; i < parts.length - 1; i += 1) {
    const candidate = parts.slice(i).join('.');
    const kind = BY_DOMAIN.get(candidate);
    if (kind) return { domain: candidate, kind, ...REGISTRY_KINDS[kind] };
  }
  return null;
}
