import { lookupRegistry, REGISTRY_VERSION } from '../config/domainRegistry.js';
import { INDUSTRY_LEXICON } from '../config/industryLexicon.js';
import { distanceMeters } from './competitorIdentity.js';

/**
 * Business relevance of a website to a project: deterministic, evidence-based, and always explained. No model, no network, no randomness:
 * the same evidence always gives the same class, and every class comes with the reasons that produced it.
 *
 *   direct_competitor        a business in the same sector that serves the project's market
 *   indirect_competitor      a business in the same or a close sector, but in another market or only partly the same services
 *   informational_directory  government, education, associations, publishers, directories, marketplaces, review and social platforms
 *   not_relevant             a business in an unrelated sector
 *   needs_review             not enough evidence, or evidence that disagrees: a person should decide
 *
 * Keyword overlap in search NEVER makes a site a direct competitor (shared keywords are not an input here), and a domain suffix such as
 * ".gov" or ".org" is never enough on its own.
 */

export const RULES_VERSION = '2026-11-02.1';
export const CLASSES = Object.freeze(['direct_competitor', 'indirect_competitor', 'informational_directory', 'not_relevant', 'needs_review']);

const STOP = new Set(['the', 'and', 'for', 'of', 'in', 'a', 'an', 'to', 'with', 'centre', 'center']);
const GENERIC_TERMS = new Set(['other', 'business', 'company', 'services', 'service', 'shop', 'store', 'agency']);

const norm = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const stem = (t) => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t);
const tokens = (s) => norm(s).split(' ').filter((t) => t && !STOP.has(t)).map(stem);

/** The project's own words for what it does, strongest first. Generic words ("business", "services") are never a term. */
export function projectTerms(profile) {
  const out = []; const seen = new Set();
  const add = (text, source) => {
    const n = norm(text);
    if (!n || n.length < 3 || GENERIC_TERMS.has(n) || seen.has(n)) return;
    seen.add(n); out.push({ text: String(text).trim(), norm: n, tokens: tokens(text), source });
  };
  add(profile?.subIndustry, 'sub_industry');
  if (profile?.gbp?.trusted) { add(profile.gbp.category, 'gbp_category'); (profile.gbp.secondary ?? []).forEach((c) => add(c, 'gbp_category')); }
  (profile?.services ?? []).forEach((s) => add(s, 'service'));
  add(profile?.businessType, 'business_type');
  return out;
}

const hitsText = (term, hay) => {
  if (!hay.norm) return false;
  if (term.norm.length >= 3 && hay.padded.includes(` ${term.norm} `)) return true;
  return term.tokens.length >= 2 && term.tokens.every((t) => hay.set.has(t));
};
const haystack = (parts) => { const n = norm(parts.filter(Boolean).join(' . ')); return { norm: n, padded: ` ${n} `, set: new Set(n.split(' ').map(stem)) }; };

/** How well the site's own words match the project's: high / medium / low / unknown, with the terms that matched. */
export function sectorMatch(profile, facts) {
  const terms = projectTerms(profile);
  const hasText = Boolean(facts?.fetched && ((facts.textSample?.length ?? 0) > 120 || facts.title));
  if (!hasText) return { level: 'unknown', terms: [], hasProjectTerms: terms.length > 0 };
  const head = haystack([facts.title, facts.description, facts.siteName, ...(facts.h1 ?? []), ...(facts.h2 ?? []), ...(facts.orgNames ?? []), ...(facts.schemaTypes ?? [])]);
  const body = haystack([facts.textSample]);
  const headHits = terms.filter((t) => hitsText(t, head));
  const bodyOnly = terms.filter((t) => !headHits.includes(t) && hitsText(t, body));
  const matched = [...headHits, ...bodyOnly].map((t) => t.text);
  const lexicon = INDUSTRY_LEXICON[profile?.industry] ?? [];
  const lexHeadHits = lexicon.filter((w) => head.padded.includes(` ${norm(w)} `)).length;
  let level;
  if (terms.length === 0) level = lexHeadHits >= 2 ? 'medium' : 'unknown';
  else if (headHits.length >= 2 || (headHits.length >= 1 && headHits.length + bodyOnly.length >= 2)) level = 'high';
  else if (headHits.length === 1 || bodyOnly.length >= 2 || lexHeadHits >= 2) level = 'medium';
  else if (bodyOnly.length === 1) level = 'medium';
  else level = 'low';
  return { level, terms: matched, hasProjectTerms: terms.length > 0 };
}

const BUSINESS_TYPE = /(Hospital|Clinic|MedicalBusiness|MedicalOrganization|Physician|Dentist|LocalBusiness|Optician|Pharmacy|HealthAndBeautyBusiness|BeautySalon|HairSalon|DaySpa|Restaurant|CafeOrCoffeeShop|Bakery|Store|AutoRepair|AutoDealer|LegalService|Attorney|RealEstateAgent|TravelAgency|Hotel|LodgingBusiness|FinancialService|AccountingService|InsuranceAgency|ProfessionalService|HomeAndConstructionBusiness|Plumber|Electrician|GeneralContractor|GymOrHealthClub|SportsActivityLocation|VeterinaryCare|ChildCare)/;
const GOV_TYPE = /(GovernmentOrganization|GovernmentOffice|GovernmentBuilding|GovernmentService)/;
const EDU_TYPE = /(EducationalOrganization|CollegeOrUniversity|University|School|ResearchOrganization)/;
const PUBLISHER_TYPE = /(NewsMediaOrganization|Periodical|Blog|NewsArticle|ScholarlyArticle|Article)/;
const DIRECTORY_TEXT = /\b(directory|find (a |an )?(best )?(doctor|hospital|clinic|lawyer|dentist|specialist)s?|listings?|compare (prices|hospitals|doctors)|top \d+ )\b/;
const CONTACT_TEXT = /\b(book (an )?appointment|appointments?|contact us|our (doctors|services|team|clinic)|visit us|opd|enquire|call us)\b/;
const TLD_HINT = /(^|\.)(gov|edu|mil)(\.[a-z]{2})?$|\.(ac|gov|edu)\.[a-z]{2}$/;

/**
 * What kind of site this is, from the strongest evidence available. Returns { kind, strength, source, text } where kind is
 * business | government | education | publisher | directory | unknown, and `conflict` is true when strong signals disagree.
 */
export function siteKind({ domain, facts, registry, profile }) {
  if (registry) {
    const map = { government: 'government', association: 'government', publisher: 'publisher', directory: 'directory', marketplace: 'directory', review_platform: 'directory', social: 'directory' };
    return { kind: map[registry.kind] ?? 'directory', strength: 'strong', source: 'registry', text: `${registry.domain} ${registry.text} (on Odito's list of well-known non-competitor sites)`, conflict: false, tldHint: false };
  }
  const tldHint = TLD_HINT.test(String(domain ?? ''));
  if (!facts?.fetched) return { kind: 'unknown', strength: 'none', source: 'none', text: 'its website could not be read', conflict: false, tldHint };
  const types = facts.schemaTypes ?? [];
  const educationIsBusiness = profile?.industry === 'education';
  const strong = [];
  if (types.some((t) => BUSINESS_TYPE.test(t))) strong.push(['business', `its website declares itself a ${types.find((t) => BUSINESS_TYPE.test(t))}`]);
  if (types.some((t) => GOV_TYPE.test(t))) strong.push(['government', 'its website declares itself a government organisation']);
  if (types.some((t) => EDU_TYPE.test(t)) && !(educationIsBusiness && types.some((t) => BUSINESS_TYPE.test(t) || /School|EducationalOrganization/.test(t)))) {
    strong.push([educationIsBusiness ? 'business' : 'education', educationIsBusiness ? 'its website declares itself an educational organisation (the same kind of business as yours)' : 'its website declares itself an educational or research organisation']);
  }
  if (types.some((t) => PUBLISHER_TYPE.test(t)) && !strong.some(([k]) => k === 'business')) strong.push(['publisher', 'its website declares itself a news, blog or article publisher']);
  const kinds = [...new Set(strong.map(([k]) => k))];
  if (kinds.length > 1) return { kind: 'unknown', strength: 'conflict', source: 'schema', text: `its structured data disagrees about what it is (${kinds.join(' and ')})`, conflict: true, tldHint };
  if (kinds.length === 1) return { kind: kinds[0], strength: 'strong', source: 'schema', text: strong[0][1], conflict: false, tldHint };

  // No decisive structured data: weaker evidence from the page itself.
  const text = `${facts.title ?? ''} ${facts.description ?? ''} ${(facts.h1 ?? []).join(' ')}`.toLowerCase();
  const weak = [];
  if (DIRECTORY_TEXT.test(text)) weak.push(['directory', 'its homepage reads like a directory or listing of many providers']);
  if (facts.hasArticleMarkup && !facts.hasTelLink && !facts.address) weak.push(['publisher', 'its homepage is made of articles and has no business contact details']);
  if (facts.address || facts.hasTelLink || CONTACT_TEXT.test(`${text} ${(facts.textSample ?? '').slice(0, 1200)}`)) weak.push(['business', 'its homepage has business contact details (address, phone or appointment wording)']);
  const weakKinds = [...new Set(weak.map(([k]) => k))];
  if (weakKinds.length > 1) return { kind: 'unknown', strength: 'conflict', source: 'text', text: `its homepage gives mixed signals (${weakKinds.join(' and ')})`, conflict: true, tldHint };
  if (weakKinds.length === 1) return { kind: weakKinds[0], strength: 'weak', source: 'text', text: weak[0][1], conflict: false, tldHint };
  return { kind: 'unknown', strength: 'none', source: 'none', text: 'nothing on its homepage says what kind of site it is', conflict: false, tldHint };
}

const countryName = (() => { try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch { return null; } })();
const sameCountry = (a, iso2) => {
  if (!a || !iso2) return null;
  const x = norm(a); const code = norm(iso2); const name = norm(countryName?.of(String(iso2).toUpperCase()) ?? '');
  if (x === code || (name && x === name)) return true;
  if (/^[a-z]{2}$/.test(x)) return false;
  return name ? x === name : null;
};
const mentions = (text, place) => { const p = norm(place); return Boolean(p) && ` ${norm(text)} `.includes(` ${p} `); };

/** How the site's location relates to the project's target market. */
export function geoRelation(profile, facts) {
  const addr = facts?.address; const geo = facts?.geo;
  const mine = profile?.coords;
  const nearbyM = 25_000;
  if (geo && mine) {
    const d = distanceMeters(mine, geo);
    if (d !== null) {
      if (d <= nearbyM && profile?.city && (mentions(`${addr?.locality ?? ''} ${addr?.street ?? ''}`, profile.city))) return { relation: 'same_city', text: `its address is in ${profile.city}`, distanceKm: Math.round(d / 100) / 10 };
      if (d <= nearbyM) return { relation: 'nearby', text: `its location is about ${(d / 1000).toFixed(1)} km from yours`, distanceKm: Math.round(d / 100) / 10 };
    }
  }
  if (!addr || !(addr.locality || addr.region || addr.country || addr.street)) return { relation: 'unknown', text: 'its location could not be found on its website' };
  const where = [addr.street, addr.locality, addr.region, addr.country].filter(Boolean).join(', ');
  if (profile?.city && mentions(`${addr.locality ?? ''} ${addr.street ?? ''}`, profile.city)) return { relation: 'same_city', text: `its address (${where}) is in ${profile.city}` };
  const countryMatch = sameCountry(addr.country, profile?.countryIso2);
  if (countryMatch === false) return { relation: 'different_country', text: `its address (${where}) is in another country` };
  if (profile?.state && mentions(`${addr.region ?? ''} ${addr.locality ?? ''}`, profile.state)) return { relation: 'same_state', text: `its address (${where}) is in ${profile.state}` };
  // Only the country is known (many sites publish just "IN" in their markup): that says nothing about the CITY, so it must not be read as
  // "outside your city". A different country is still a fact; the same country on its own is not enough to place the business.
  if (countryMatch === true && !(addr.locality || addr.region || addr.street)) return { relation: 'unknown', text: `its website gives only its country (${addr.country}), so its city could not be told` };
  if (countryMatch === true) return { relation: 'same_country', text: `its address (${where}) is in your country, outside your city` };
  if (!addr.country && !profile?.countryIso2) return { relation: 'unknown', text: 'its location could not be compared with yours' };
  return { relation: addr.country ? 'same_country' : 'unknown', text: addr.country ? `its address (${where}) is in your country, outside your city` : 'its location could not be compared with yours' };
}

const level = (c) => (c >= 0.8 ? 'high' : c >= 0.6 ? 'medium' : 'low');
const clamp = (n) => Math.max(0.2, Math.min(0.97, Math.round(n * 100) / 100));

/**
 * @param {{ domain: string, facts: object|null, profile: object, registry?: object|null }} input
 * @returns {{ class: string, confidence: number, level: string, reasons: Array<{code:string,text:string,source:string}>, signals: object }}
 */
export function classifyDomain({ domain, facts, profile, registry = lookupRegistry(domain) }) {
  const reasons = [];
  const why = (code, text, source) => reasons.push({ code, text: text.charAt(0).toUpperCase() + text.slice(1), source });
  const kind = siteKind({ domain, facts, registry, profile });
  const sector = sectorMatch(profile, facts);
  const geo = geoRelation(profile, facts);
  const scope = profile?.scope === 'national' ? 'national' : 'local';
  const signals = { kind: kind.kind, kindStrength: kind.strength, kindSource: kind.source, sector: sector.level, sectorTerms: sector.terms, geo: geo.relation, scope, registryKind: registry?.kind ?? null };
  const done = (cls, confidence) => ({ class: cls, confidence: clamp(confidence), level: level(clamp(confidence)), reasons, signals, registryVersion: REGISTRY_VERSION, rulesVersion: RULES_VERSION });

  // 1. Well-known non-competitor sites (curated, explained).
  if (registry) {
    why('registry', kind.text, 'registry');
    why('keyword_overlap_only', 'It ranks for some of your keywords, but that alone does not make it a business competitor.', 'seo');
    return done('informational_directory', 0.95);
  }

  if (kind.conflict) {
    why('conflicting_signals', kind.text, kind.source === 'schema' ? 'website' : 'website');
    why('needs_person', 'Because the evidence disagrees, a person should decide.', 'rules');
    return done('needs_review', 0.35);
  }

  if (!facts?.fetched) {
    why('site_unreadable', `Its website could not be read (${facts?.error ?? 'no response'}), so its type, services and location are unknown.`, 'website');
    if (kind.tldHint) why('tld_not_enough', `Its address ends in a government or education suffix, but a suffix alone is not used to classify a site.`, 'rules');
    return done('needs_review', 0.3);
  }

  why('kind', `${kind.text}.`, 'website');

  // 2. Not a business (decided from strong evidence only).
  if (['government', 'education', 'publisher', 'directory'].includes(kind.kind)) {
    if (kind.strength === 'strong') {
      why('not_a_competing_business', 'A site like this informs or lists rather than competing for the same customers, even where it ranks for the same searches.', 'rules');
      if (kind.tldHint) why('tld_corroborates', 'Its address suffix is consistent with this, but was not used to decide.', 'rules');
      return done('informational_directory', 0.85);
    }
    why('weak_evidence', 'This rests on the look of its homepage only, which is not enough on its own.', 'rules');
    return done('needs_review', 0.45);
  }

  if (kind.kind === 'unknown') {
    if (kind.tldHint) why('tld_not_enough', 'Its address ends in a government or education suffix, but nothing else confirms what it is, and a suffix alone is not used to classify a site.', 'rules');
    if (sector.level !== 'unknown') why('sector', sectorText(sector), 'project');
    return done('needs_review', 0.35);
  }

  // 3. A business: compare its sector and its market with the project's.
  if (!sector.hasProjectTerms && sector.level === 'unknown') {
    why('no_project_terms', 'Your project has no sub-industry, services or connected Business Profile category to compare with, so its sector cannot be judged.', 'project');
    return done('needs_review', 0.35);
  }
  why('sector', sectorText(sector), 'project');
  why('geo', `${geo.text.charAt(0).toUpperCase()}${geo.text.slice(1)}.`, 'website');
  const base = 0.5 + (kind.strength === 'strong' ? 0.2 : 0.1);
  const geoKnown = geo.relation !== 'unknown';

  if (sector.level === 'unknown') return done('needs_review', 0.35);
  if (sector.level === 'low') {
    why('different_sector', 'Nothing on its homepage matches what your business does.', 'project');
    return done('not_relevant', base + 0.1);
  }
  if (sector.level === 'medium') {
    why('partly_same_sector', 'It overlaps with what you do only in part.', 'project');
    return done('indirect_competitor', base);
  }
  // Same sector (high)
  const near = geo.relation === 'same_city' || geo.relation === 'nearby';
  if (scope === 'national') {
    why('scope', 'Your project targets the whole country, so where it is based matters less.', 'project');
    if (geo.relation === 'different_country') { why('other_market', 'It serves another country.', 'website'); return done('indirect_competitor', base + 0.2); }
    return done('direct_competitor', base + 0.2 + (geoKnown ? 0.05 : 0));
  }
  why('scope', `Your project targets a local market${profile?.city ? ` (${profile.city})` : ''}.`, 'project');
  if (near) return done('direct_competitor', base + 0.3);
  if (!geoKnown) { why('needs_location', 'Because its location is unknown, it cannot be confirmed as serving your area.', 'rules'); return done('needs_review', 0.5); }
  why('other_market', geo.relation === 'same_state' ? 'It is in your state but not your city.' : geo.relation === 'same_country' ? 'It is in your country but a different city and state.' : 'It is in another country.', 'website');
  return done('indirect_competitor', base + 0.2);
}

function sectorText(sector) {
  if (sector.level === 'unknown') return 'Its sector could not be judged because its website had too little text.';
  const t = sector.terms.slice(0, 4).join(', ');
  if (sector.level === 'high') return `Its website matches what your business does (${t}).`;
  if (sector.level === 'medium') return sector.terms.length ? `Its website matches part of what your business does (${t}).` : 'Its website uses some words from your industry.';
  return 'Its website does not mention what your business does.';
}
