import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPageProfiles } from './profileExtraction.js';
import { buildCandidates, pageRoleOf } from './profileCandidates.js';
import { discoverSameAsProfiles, selectDiscoveryPages, clearDiscoveryCache } from './sameAsDiscovery.js';

const SITE = 'https://www.acme-agency.com/';
const org = (extra = {}) => ({ '@context': 'https://schema.org', '@graph': [{ '@type': 'Organization', '@id': `${SITE}#organization`, name: 'Acme Digital Agency', url: SITE, ...extra }] });
const jsonLd = (v) => `<script type="application/ld+json">${JSON.stringify(v)}</script>`;

const footerSocial = `
  <footer class="et-l et-l--footer"><div class="et_pb_section"><ul class="et_pb_module et_pb_social_media_follow">
    <li class="et_pb_social_media_follow_network_0_tb_footer"><a href="https://www.facebook.com/acmedigitalagency?utm_source=site&fbclid=zzz" class="follow_button">Follow</a></li>
    <li class="et_pb_social_media_follow_network_1_tb_footer"><a href="https://www.linkedin.com/company/acme-digital-agency">Follow</a></li>
    <li class="et_pb_social_media_follow_network_2_tb_footer"><a href="https://www.instagram.com/acmedigital/">Follow</a></li>
  </ul></div></footer>`;

const home = ({ schema = '', body = '', chrome = footerSocial } = {}) => `<html><head><title>Home</title>${schema}</head><body><header class="et-l--header"><a href="/">Home</a></header><main>${body}</main>${chrome}</body></html>`;

test('extracts footer follow links with placement and the follow-block marker', () => {
  const r = extractPageProfiles(home(), { pageUrl: SITE });
  const fb = r.links.find((l) => l.href.includes('facebook.com'));
  assert.equal(fb.placement, 'footer'); assert.equal(fb.followBlock, true); assert.equal(fb.shareBlock, false); assert.equal(fb.personBlock, false);
  assert.equal(r.links.length, 3);
});

test('share buttons, team members, testimonials and authors are flagged, never treated as follow links', () => {
  const body = `
    <div class="sharedaddy"><a href="https://www.facebook.com/sharer/sharer.php?u=x">Share</a><a href="https://twitter.com/intent/tweet?text=x">Tweet</a></div>
    <div class="et_pb_team_member"><a href="https://www.linkedin.com/in/jane-doe">Jane</a><a href="https://twitter.com/janedoe">x</a></div>
    <div class="et_pb_testimonial"><a href="https://www.facebook.com/happycustomer">Customer</a></div>
    <div class="post-author byline"><a href="https://www.instagram.com/blogwriter">Writer</a></div>
    <p>Read <a href="https://www.youtube.com/watch?v=abc">our video</a></p>`;
  const r = extractPageProfiles(home({ body, chrome: '' }), { pageUrl: SITE });
  const byHref = (s) => r.links.find((l) => l.href.includes(s));
  assert.equal(byHref('sharer').shareBlock, true);
  assert.equal(byHref('intent/tweet').shareBlock, true);
  assert.equal(byHref('jane-doe').personBlock, true);
  assert.equal(byHref('janedoe').personBlock, true);
  assert.equal(byHref('happycustomer').personBlock, true);
  assert.equal(byHref('blogwriter').personBlock, true);
});

test('reads Organization and Person sameAs separately from every JSON-LD block, tolerating broken blocks', () => {
  const html = home({
    schema: `${jsonLd(org({ sameAs: ['https://www.linkedin.com/company/acme-digital-agency'] }))}
      ${jsonLd({ '@type': 'Person', '@id': `${SITE}author/x/`, name: 'Pat', sameAs: ['https://www.acme-agency.com'] })}
      <script type="application/ld+json">{ not json</script>`,
  });
  const r = extractPageProfiles(html, { pageUrl: SITE });
  assert.equal(r.schema.jsonLdBlocks, 3); assert.equal(r.schema.jsonLdErrors, 1);
  assert.deepEqual(r.schema.organizations[0].sameAs, ['https://www.linkedin.com/company/acme-digital-agency']);
  assert.equal(r.schema.persons.length, 1);
});

const pageOf = (url, html) => ({ url, ...extractPageProfiles(html, { pageUrl: url }) });

test('footer profiles on the home page become suggested candidates with provenance, tracking removed', () => {
  const pages = [pageOf(SITE, home())];
  const { candidates, ignored } = buildCandidates({ pages, siteUrl: SITE, organizationNames: ['Acme Digital Agency'] });
  assert.deepEqual(candidates.map((c) => c.platform).sort(), ['facebook', 'instagram', 'linkedin']);
  const fb = candidates.find((c) => c.platform === 'facebook');
  assert.equal(fb.url, 'https://www.facebook.com/acmedigitalagency');
  assert.equal(fb.status, 'suggested'); assert.equal(fb.preselected, true);
  assert.equal(fb.verification, 'linked_from_site'); assert.equal(fb.reachability, 'not_checked');
  assert.deepEqual(fb.sources[0], { method: 'page_link', pageUrl: SITE, placement: 'footer', detail: 'Follow' });
  assert.ok(fb.reasons.length >= 2);
  assert.equal(ignored.UNSUPPORTED_PLATFORM, undefined); // internal links are not even considered
});

test('a chrome link repeated on more pages is stronger; a content-only link is weak and never preselected', () => {
  const a = pageOf(SITE, home());
  const b = pageOf(`${SITE}about-us/`, home());
  const lone = pageOf(`${SITE}blog/post/`, home({ chrome: '', body: '<p>Find us at <a href="https://www.pinterest.com/acmepins">Pinterest</a></p>' }));
  const { candidates } = buildCandidates({ pages: [a, b, lone], siteUrl: SITE, organizationNames: ['Acme Digital Agency'] });
  const li = candidates.find((c) => c.platform === 'linkedin');
  const pin = candidates.find((c) => c.platform === 'pinterest');
  assert.ok(li.score > 85, `score ${li.score}`);
  assert.equal(pin.status, 'weak'); assert.equal(pin.preselected, false);
  assert.ok(candidates.indexOf(li) < candidates.indexOf(pin));
});

test('employee, customer and author accounts are rejected with a reason, share links are only counted', () => {
  const body = `<div class="et_pb_team_member"><a href="https://www.linkedin.com/in/jane-doe">J</a><a href="https://twitter.com/janedoe">t</a></div>
    <div class="sharedaddy"><a href="https://www.facebook.com/sharer/sharer.php?u=x">s</a></div>`;
  const { candidates, rejected, ignored } = buildCandidates({ pages: [pageOf(SITE, home({ body, chrome: '' }))], siteUrl: SITE });
  assert.equal(candidates.length, 0);
  assert.ok(rejected.some((r) => r.url.includes('jane-doe') && r.code === 'PERSONAL_PROFILE'));
  assert.ok(rejected.some((r) => r.url.includes('janedoe') && r.code === 'THIRD_PARTY_CONTEXT'));
  assert.equal(ignored.SHARE_LINK, 1);
  assert.ok(!rejected.some((r) => r.url.includes('sharer')));
});

test('existing Organization sameAs: declared values are strongest, already-present ones are marked, a Person sameAs is not offered', () => {
  const html = home({
    schema: jsonLd({ '@graph': [
      { '@type': 'Organization', '@id': `${SITE}#organization`, name: 'Acme Digital Agency', url: SITE, sameAs: ['https://www.linkedin.com/company/acme-digital-agency'] },
      { '@type': 'Person', '@id': `${SITE}author/x/`, name: 'Pat', sameAs: ['https://twitter.com/patwrites'] },
    ] }),
    chrome: '',
  });
  const { candidates } = buildCandidates({ pages: [pageOf(SITE, html)], existingSameAs: ['https://www.linkedin.com/company/acme-digital-agency'], siteUrl: SITE });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].status, 'already_present'); assert.equal(candidates[0].verification, 'declared_in_schema');
  assert.ok(!candidates.some((c) => c.url.includes('patwrites')));
});

test('two different profiles of one network that nothing declares need confirmation', () => {
  const chrome = '<footer><div class="social"><a href="https://www.facebook.com/acmeone">a</a><a href="https://www.facebook.com/acmetwo">b</a></div></footer>';
  const { candidates, conflicts } = buildCandidates({ pages: [pageOf(SITE, home({ chrome }))], siteUrl: SITE, organizationNames: ['Acme'] });
  assert.equal(conflicts.length, 1);
  assert.ok(candidates.every((c) => c.status !== 'suggested' && c.preselected === false));
  assert.ok(candidates[0].warnings.some((w) => w.code === 'PLATFORM_CONFLICT'));
});

test('crawl-stored social links count, but only as evidence from the pages they were found on', () => {
  const { candidates } = buildCandidates({
    pages: [],
    crawlLinks: [{ platform: 'facebook', url: 'https://www.facebook.com/acmedigitalagency', sourceUrl: `${SITE}contact-us` }, { platform: 'facebook', url: 'https://www.facebook.com/acmedigitalagency', sourceUrl: `${SITE}services` }],
    siteUrl: SITE, organizationNames: ['Acme Digital Agency'],
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].sources.every((s) => s.method === 'crawl_social_link'), true);
  assert.notEqual(candidates[0].status, 'already_present');
});

test('a connected-account profile is offered but needs confirmation unless the site links it too', () => {
  const { candidates } = buildCandidates({ pages: [], integrationProfiles: [{ url: 'https://www.facebook.com/1234567890', label: 'x', detail: 'Connected page: Acme' }], siteUrl: SITE });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].verification, 'integration_connected');
  assert.equal(candidates[0].preselected, false);
});

test('pageRoleOf classifies home, contact and about pages', () => {
  assert.equal(pageRoleOf(SITE), 'home');
  assert.equal(pageRoleOf(`${SITE}contact-us/`), 'contact');
  assert.equal(pageRoleOf(`${SITE}about`), 'about');
  assert.equal(pageRoleOf(`${SITE}blog/x`), 'other');
});

test('selectDiscoveryPages is bounded, same-site only and prefers home, contact, about, then pages with social links', () => {
  const urls = [`${SITE}blog/a`, `${SITE}about-us`, `${SITE}contact-us`, `${SITE}services`, 'https://other.example.org/', `${SITE}wp-admin/x`, `${SITE}search?s=1`, `${SITE}products/x/y/z`, SITE];
  const crawlLinks = [{ sourceUrl: `${SITE}services`, url: 'https://www.facebook.com/a' }];
  const picked = selectDiscoveryPages({ pageUrls: urls, crawlLinks, targetPageUrl: `${SITE}blog/a`, siteUrl: SITE, maxPages: 4 });
  assert.equal(picked.length, 4);
  assert.deepEqual(picked.map((p) => p.url).slice(0, 3), [SITE, `${SITE}contact-us`, `${SITE}about-us`]);
  assert.ok(!picked.some((p) => /other\.example|wp-admin|search/.test(p.url)));
  assert.equal(selectDiscoveryPages({ pageUrls: urls, targetPageUrl: SITE, siteUrl: SITE, maxPages: 1 }).length, 1);
});

// ── orchestration with injected, fixture-based dependencies (no network, no database) ─────────────────────────────

const crawlDoc = (url, structured_data) => ({ url, structured_data });
const fixtureDeps = ({ pages, fetched, links = [], integration = { profiles: [], notes: [] }, failFor = [] }) => {
  const calls = [];
  return {
    calls,
    loadPages: async () => pages,
    loadCrawlLinks: async () => links,
    loadIntegrationProfiles: async () => integration,
    isFetchable: () => true,
    fetchHtml: async (url) => {
      calls.push(url);
      if (failFor.includes(url)) { const e = new Error('The public page could not be fetched (ECONNRESET).'); e.code = 'FETCH_FAILED'; throw e; }
      return { status: 200, html: fetched[url] || '<html></html>' };
    },
    limits: { cacheTtlMs: 0 },
  };
};

test('discovery: homepage footer profiles, absent sameAs → candidates_discovered; fetches are bounded and same-site', async () => {
  clearDiscoveryCache();
  const pages = [crawlDoc(SITE, org()), crawlDoc(`${SITE}contact-us/`, org()), crawlDoc(`${SITE}sitemap/`, org())];
  const deps = fixtureDeps({ pages, fetched: { [SITE]: home(), [`${SITE}contact-us/`]: home() } });
  const r = await discoverSameAsProfiles({ projectId: 'p1', pageUrl: `${SITE}contact-us/` }, { ...deps, limits: { cacheTtlMs: 0, maxPages: 2 } });
  assert.equal(r.state, 'candidates_discovered');
  assert.equal(r.entity.state, 'absent'); assert.equal(r.entity.id, `${SITE}#organization`);
  assert.equal(deps.calls.length, 2);
  assert.ok(deps.calls.every((u) => u.startsWith(SITE)));
  assert.deepEqual(r.candidates.map((c) => c.platform).sort(), ['facebook', 'instagram', 'linkedin']);
  assert.ok(r.candidates.every((c) => c.preselected));
  assert.equal(r.sources.pages.filter((p) => p.status === 'ok').length, 2);
});

test('discovery: nothing found → none_found with the pages that were looked at (add manually)', async () => {
  const pages = [crawlDoc(SITE, org())];
  const r = await discoverSameAsProfiles({ projectId: 'p1', pageUrl: SITE }, fixtureDeps({ pages, fetched: { [SITE]: home({ chrome: '<footer><a href="https://www.acme-agency.com/privacy">Privacy</a></footer>' }) } }));
  assert.equal(r.state, 'none_found'); assert.deepEqual(r.candidates, []);
  assert.equal(r.sources.pages[0].status, 'ok');
});

test('discovery: a failing page is reported, the rest still contribute, nothing throws', async () => {
  const pages = [crawlDoc(SITE, org()), crawlDoc(`${SITE}about-us/`, org())];
  const r = await discoverSameAsProfiles({ projectId: 'p1', pageUrl: SITE }, fixtureDeps({ pages, fetched: { [SITE]: home() }, failFor: [`${SITE}about-us/`] }));
  assert.equal(r.state, 'candidates_discovered');
  const failed = r.sources.pages.find((p) => p.status === 'failed');
  assert.ok(failed && /ECONNRESET/.test(failed.reason));
});

test('discovery: only medium/weak evidence → needs_confirmation, nothing preselected', async () => {
  const pages = [crawlDoc(SITE, org())];
  const body = '<p>We are on <a href="https://www.pinterest.com/acmepins">Pinterest</a></p>';
  const r = await discoverSameAsProfiles({ projectId: 'p1', pageUrl: SITE }, fixtureDeps({ pages, fetched: { [SITE]: home({ chrome: '', body }) } }));
  assert.equal(r.state, 'needs_confirmation');
  assert.ok(r.candidates.every((c) => !c.preselected));
});

test('discovery: existing populated sameAs with every found link already present → existing_present', async () => {
  const same = ['https://www.facebook.com/acmedigitalagency', 'https://www.linkedin.com/company/acme-digital-agency', 'https://www.instagram.com/acmedigital'];
  const pages = [crawlDoc(SITE, org({ sameAs: same }))];
  const r = await discoverSameAsProfiles({ projectId: 'p1', pageUrl: SITE }, fixtureDeps({ pages, fetched: { [SITE]: home() } }));
  assert.equal(r.state, 'existing_present');
  assert.equal(r.entity.state, 'populated');
  assert.ok(r.candidates.every((c) => c.status === 'already_present'));
});

test('discovery: non-public pages are never fetched live (the stored crawl still counts)', async () => {
  const pages = [crawlDoc(SITE, org())];
  const deps = fixtureDeps({ pages, fetched: {}, links: [{ platform: 'facebook', url: 'https://www.facebook.com/acmedigitalagency', sourceUrl: SITE }] });
  const r = await discoverSameAsProfiles({ projectId: 'p1', pageUrl: SITE }, { ...deps, isFetchable: () => false });
  assert.equal(deps.calls.length, 0);
  assert.equal(r.sources.pages[0].status, 'skipped');
  assert.equal(r.candidates.length, 1);
});

test('discovery: the connected Facebook page appears with its provenance', async () => {
  const deps = fixtureDeps({ pages: [crawlDoc(SITE, org())], fetched: {}, integration: { profiles: [{ url: 'https://www.facebook.com/1234567890', label: 'l', detail: 'Connected page: Acme' }], notes: [] } });
  const r = await discoverSameAsProfiles({ projectId: 'p1', pageUrl: SITE }, deps);
  assert.equal(r.candidates[0].verification, 'integration_connected');
});

test('discovery results are memoised per project+page and refresh bypasses the memo', async () => {
  clearDiscoveryCache();
  const pages = [crawlDoc(SITE, org())];
  const deps = fixtureDeps({ pages, fetched: { [SITE]: home() } });
  const withCache = { ...deps, limits: { cacheTtlMs: 60_000 } };
  await discoverSameAsProfiles({ projectId: 'p9', pageUrl: SITE }, withCache);
  const second = await discoverSameAsProfiles({ projectId: 'p9', pageUrl: SITE }, withCache);
  assert.equal(second.cached, true); assert.equal(deps.calls.length, 1);
  await discoverSameAsProfiles({ projectId: 'p9', pageUrl: SITE, refresh: true }, withCache);
  assert.equal(deps.calls.length, 2);
  clearDiscoveryCache();
});

test('a connected page (ID address) next to the same network linked by the site is not a conflict: the site-linked one keeps its rank', () => {
  const pages = [pageOf(SITE, home()), pageOf(`${SITE}about-us/`, home())];
  const { candidates, conflicts } = buildCandidates({
    pages, siteUrl: SITE, organizationNames: ['Acme Digital Agency'],
    integrationProfiles: [{ url: 'https://www.facebook.com/1234567890', label: 'l', detail: 'Connected page: Acme' }],
  });
  assert.deepEqual(conflicts, []);
  const bySite = candidates.find((c) => c.url === 'https://www.facebook.com/acmedigitalagency');
  const byIntegration = candidates.find((c) => c.url === 'https://www.facebook.com/1234567890');
  assert.equal(bySite.status, 'suggested'); assert.equal(bySite.preselected, true);
  assert.equal(byIntegration.preselected, false); assert.equal(byIntegration.verification, 'integration_connected');
  assert.ok(byIntegration.warnings.some((w) => w.code === 'SITE_LINKS_ANOTHER_ADDRESS'));
});
