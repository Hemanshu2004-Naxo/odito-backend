import test from 'node:test';
import assert from 'node:assert/strict';
import { extractBreadcrumbFacts } from './breadcrumbExtraction.js';
import { classifyBreadcrumbPage, labelsMatch, titleWithoutSite } from './breadcrumbTrails.js';
import { discoverBreadcrumbs, inspectPagesBreadcrumbs, parentCandidates, clearBreadcrumbDiscoveryCache } from './breadcrumbDiscovery.js';
import { analyzeBreadcrumbs, flattenJsonLd } from '../schemaGraph.js';

const ROOT = 'https://www.acme.test/';
const PAGE = 'https://www.acme.test/local-seo/';
const jsonLd = (v) => `<script type="application/ld+json">${JSON.stringify(v)}</script>`;
const crumbList = (...items) => ({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: items.map(([name, item], i) => ({ '@type': 'ListItem', position: i + 1, name, ...(item ? { item } : {}) })) });

const MENU = `<header id="main-header"><nav id="top-menu-nav"><ul id="top-menu">
  <li><a href="/become-a-partner/">Become A Partner</a></li>
  <li><a href="/about-us/">About Us</a></li>
  <li><a href="#">White Label Services</a><ul class="sub-menu">
     <li><a href="/local-seo/">Local SEO</a></li><li><a href="/national-seo/">National SEO</a></li></ul></li>
  <li><a href="/blog/">Blog</a></li>
</ul></nav></header>`;
const html = ({ head = '', body = '', menu = MENU, title = 'Local SEO Services | Acme', h1 = 'Local SEO' } = {}) => `<html><head><title>${title}</title><link rel="canonical" href="${PAGE}">${head}</head><body>${menu}<main><h1>${h1}</h1>${body}</main></body></html>`;
const facts = (h, pageUrl = PAGE) => extractBreadcrumbFacts(h, { pageUrl });
const display = { url: PAGE, trusted: true };
const classify = (over = {}) => classifyBreadcrumbPage({ pageUrl: 'https://www.acme.test/local-seo', display, siteRoot: ROOT, crawlBreadcrumbs: { count: 0, lists: [] }, live: facts(html()), homeFacts: facts(html(), ROOT), parents: [], ...over });
const names = (t) => t.items.map((i) => i.name);

test('extraction: JSON-LD, microdata, visible breadcrumb, navigation tree and internal links are all read', () => {
  const f = facts(html({
    head: jsonLd(crumbList(['Home', ROOT], ['Local SEO', PAGE])),
    body: `<nav aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li><li><a href="/services/">Services</a></li><li aria-current="page">Local SEO</li></ol></nav>
      <div itemscope itemtype="https://schema.org/BreadcrumbList"><span itemprop="itemListElement" itemscope itemtype="https://schema.org/ListItem"><a itemprop="item" href="/"><span itemprop="name">Home</span></a></span><span itemprop="itemListElement" itemscope itemtype="https://schema.org/ListItem"><a itemprop="item" href="/x/"><span itemprop="name">X</span></a></span></div>`,
  }));
  assert.equal(f.jsonLd.count, 1);
  assert.deepEqual(f.dom[0].items.map((i) => [i.name, i.url, i.current]), [['Home', ROOT, false], ['Services', 'https://www.acme.test/services/', false], ['Local SEO', null, true]]);
  assert.deepEqual(f.microdata[0].items.map((i) => i.name), ['Home', 'X']);
  const menu = f.navigation.find((n) => n.name === 'White Label Services');
  assert.equal(menu.url, null); assert.deepEqual(menu.children.map((c) => c.name), ['Local SEO', 'National SEO']);
  assert.ok(f.internalLinks.includes('https://www.acme.test/blog/'));
  assert.equal(f.canonical, PAGE); assert.equal(f.h1, 'Local SEO');
});

test('extraction: a Rank Math style paragraph breadcrumb (links + trailing text) is parsed; broken JSON-LD is counted, never thrown', () => {
  const f = facts(html({ head: '<script type="application/ld+json">{bad</script>', body: '<nav class="rank-math-breadcrumb"><p><a href="/">Home</a><span class="separator"> &raquo; </span><a href="/blog/">Blog</a><span class="separator"> &raquo; </span><span class="last">A great post</span></p></nav>' }));
  assert.equal(f.jsonLd.errors, 1);
  assert.deepEqual(f.dom[0].items.map((i) => i.name), ['Home', 'Blog', 'A great post']);
  assert.equal(f.dom[0].items[2].url, null);
});

test('already_valid: the page outputs a valid BreadcrumbList; the finding is stale and nothing is offered', () => {
  const live = facts(html({ head: jsonLd(crumbList(['Home', ROOT], ['Local SEO', PAGE])) }));
  const r = classify({ live });
  assert.equal(r.status, 'already_valid'); assert.equal(r.staleFinding, true);
  assert.deepEqual(names(r.trails[0]), ['Home', 'Local SEO']);
  assert.equal(r.trails[0].items[1].url, PAGE); // a last item without its own URL stands for the page itself
});

test('conflict: an invalid or duplicated BreadcrumbList is never answered with a second one', () => {
  const bad = classify({ live: facts(html({ head: jsonLd(crumbList(['Home', '/relative'], ['Local SEO', PAGE])) })) });
  assert.equal(bad.status, 'conflict'); assert.equal(bad.conflict.kind, 'existing_invalid'); assert.deepEqual(bad.trails, []);
  const two = classify({ live: facts(html({ head: jsonLd(crumbList(['Home', ROOT], ['Local SEO', PAGE])) + jsonLd(crumbList(['Home', ROOT], ['A', 'https://www.acme.test/a'], ['Local SEO', PAGE])) })) });
  assert.equal(two.status, 'conflict'); assert.equal(two.conflict.kind, 'multiple_lists');
});

test('verified: a visible breadcrumb with a URL for every parent and a matching last item is reused as it is', () => {
  const live = facts(html({ body: '<nav aria-label="breadcrumb"><ol><li><a href="/">Home</a></li><li><a href="/services/">Services</a></li><li>Local SEO</li></ol></nav>' }));
  const r = classify({ live });
  assert.equal(r.status, 'verified');
  assert.deepEqual(names(r.trails[0]), ['Home', 'Services', 'Local SEO']);
  assert.deepEqual(r.trails[0].items.map((i) => i.url), [ROOT, 'https://www.acme.test/services/', PAGE]);
  assert.deepEqual(r.trails[0].items.map((i) => i.origin), ['markup', 'markup', 'current']);
});

test('markup: a last item that does not look like this page is only a suggestion with a warning; a parent without a URL makes it incomplete', () => {
  const odd = classify({ live: facts(html({ body: '<nav aria-label="breadcrumb"><ol><li><a href="/">Home</a></li><li>Completely different</li></ol></nav>' })) });
  assert.equal(odd.status, 'suggested'); assert.match(odd.trails[0].warnings[0], /does not clearly match/);
  const inc = classify({ live: facts(html({ body: '<nav aria-label="breadcrumb"><ol><li><a href="/">Home</a></li><li>Services</li><li>Local SEO</li></ol></nav>' })) });
  assert.equal(inc.status, 'incomplete'); assert.equal(inc.trails[0].items[1].needsUrl, true);
});

test('markup: off-site, credentialed and tracking URLs are dropped or cleaned — never repaired into something the page did not say', () => {
  const live = facts(html({ body: '<nav aria-label="breadcrumb"><ol><li><a href="/">Home</a></li><li><a href="https://evil.example/x">Elsewhere</a></li><li><a href="/news/?utm_source=a&fbclid=z">News</a></li><li>Local SEO</li></ol></nav>' }));
  const r = classify({ live });
  const t = r.trails[0];
  assert.equal(t.items.find((i) => i.name === 'Elsewhere').url, null);
  assert.equal(t.items.find((i) => i.name === 'News').url, 'https://www.acme.test/news/');
  assert.equal(r.status, 'incomplete'); assert.match(t.warnings.join(' '), /another website/);
});

test('https page: an http parent on the same host is upgraded, never published as http', () => {
  const live = facts(html({ body: '<nav aria-label="breadcrumb"><ol><li><a href="http://www.acme.test/">Home</a></li><li>Local SEO</li></ol></nav>' }));
  assert.equal(classify({ live }).trails[0].items[0].url, ROOT);
});

test('suggested: the navigation menu gives a parent chain; the home page is offered but flagged for confirmation', () => {
  const r = classify({ live: facts(html({ menu: `<header><nav id="top-menu-nav"><ul><li><a href="/about-us/">About</a></li><li><a href="/services/">Services</a><ul><li><a href="/local-seo/">Local SEO</a></li></ul></li></ul></nav></header>` })), homeFacts: null });
  assert.equal(r.status, 'suggested');
  const t = r.trails[0];
  assert.equal(t.source, 'navigation');
  assert.deepEqual(names(t), ['Home', 'Services', 'Local SEO']);
  assert.equal(t.items[0].needsConfirmation, true); assert.equal(t.items[0].origin, 'home');
  assert.deepEqual(t.items.map((i) => i.url), [ROOT, 'https://www.acme.test/services/', PAGE]);
});

test('incomplete: a menu heading with no page of its own is shown, asked for a URL, and never given an invented one', () => {
  const r = classify(); // Local SEO sits under "White Label Services" (href="#")
  assert.equal(r.status, 'incomplete');
  const t = r.trails[0];
  assert.deepEqual(names(t), ['Home', 'White Label Services', 'Local SEO']);
  assert.equal(t.items[1].url, null); assert.equal(t.items[1].needsUrl, true); assert.equal(t.items[1].origin, 'navigation');
  assert.match(t.warnings[0], /no page URL/);
});

test('suggested: a top-level menu item gives Home › Page, again only as a suggestion', () => {
  const r = classify({ pageUrl: 'https://www.acme.test/blog', display: { url: 'https://www.acme.test/blog/', trusted: true }, live: facts(html({ title: 'Blog | Acme', h1: 'Blog' }), 'https://www.acme.test/blog/') });
  assert.equal(r.status, 'suggested'); assert.deepEqual(names(r.trails[0]), ['Home', 'Blog']);
});

test('suggested: a path parent counts ONLY when it is shown linking to the page', () => {
  const post = 'https://www.acme.test/blog/my-post/';
  const parent = (linksToCurrent) => ({ url: 'https://www.acme.test/blog/', depth: 0, name: 'Blog', facts: facts(html({ h1: 'Blog' })), linksToCurrent });
  const base = { pageUrl: 'https://www.acme.test/blog/my-post', display: { url: post, trusted: true }, live: facts(html({ title: 'My post | Acme', h1: 'My post', menu: '' }), post), homeFacts: null };
  const linked = classify({ ...base, parents: [parent(true)] });
  assert.equal(linked.status, 'suggested'); assert.equal(linked.trails[0].source, 'internal_links');
  assert.deepEqual(names(linked.trails[0]), ['Home', 'Blog', 'My post']);
  const notLinked = classify({ ...base, parents: [parent(false)] });
  assert.equal(notLinked.status, 'not_found'); assert.deepEqual(notLinked.trails, []); // /blog/ in the path is NOT proof
});

test('not_found: nothing reliable → an honest not_found with no invented trail', () => {
  const r = classify({ live: facts(html({ menu: '' })), homeFacts: null });
  assert.equal(r.status, 'not_found'); assert.deepEqual(r.trails, []);
});

test('the same trail from two sources is one trail carrying both pieces of evidence', () => {
  const menu = '<header><nav id="top-menu-nav"><ul><li><a href="/services/">Services</a><ul><li><a href="/local-seo/">Local SEO</a></li></ul></li></ul></header>';
  const live = facts(html({ menu, body: '<nav aria-label="breadcrumb"><ol><li><a href="/">Home</a></li><li><a href="/services/">Services</a></li><li>Local SEO</li></ol></nav>' }));
  const r = classify({ live, homeFacts: facts(html({ menu }), ROOT) });
  assert.equal(r.trails.length, 1); assert.equal(r.status, 'verified');
  assert.deepEqual(r.trails[0].sources.sort(), ['dom', 'navigation']);
});

test('label helpers: lenient matching for warnings only', () => {
  assert.equal(labelsMatch('Local SEO', 'Local SEO Services'), true);
  assert.equal(labelsMatch('Blog', 'Completely different'), false);
  assert.equal(titleWithoutSite('Local SEO Services | Sapphire Digital Agency'), 'Local SEO Services');
});

test('parentCandidates: only crawled same-path ancestors, shallowest first, bounded', () => {
  const crawl = ['/', '/blog', '/blog/2026', '/blog/2026/post', '/about-us'].map((p) => ({ url: `https://www.acme.test${p}` }));
  assert.deepEqual(parentCandidates('https://www.acme.test/blog/2026/post', crawl).map((c) => c.url), ['https://www.acme.test/blog', 'https://www.acme.test/blog/2026']);
  assert.deepEqual(parentCandidates('https://www.acme.test/about-us', crawl), []);
  assert.deepEqual(parentCandidates('https://www.acme.test/', crawl), []);
});

// ── orchestration with injected, fixture-based dependencies (no network, no database) ─────────────────────────────

const crawlDoc = (over = {}) => ({ url: 'https://www.acme.test/local-seo', canonical: PAGE, title: 'Local SEO Services | Acme', structured_data: [{ '@graph': [{ '@type': 'WebPage' }] }], ...over });
const fixture = ({ pages = {}, doc = crawlDoc(), crawlPages, saved = null, fail = [], fetchable = true } = {}) => {
  const calls = [];
  return {
    calls,
    loadPage: async () => doc,
    loadPages: async () => crawlPages || [{ url: 'https://www.acme.test/' }, { url: doc.url }],
    loadSaved: async () => saved,
    isFetchable: () => fetchable,
    fetchHtml: async (url, opts) => {
      calls.push([url, opts]);
      if (fail.includes(url)) { const e = new Error('The public page could not be fetched (ECONNRESET).'); e.code = 'FETCH_FAILED'; throw e; }
      const h = pages[url] ?? pages[url.replace(/\/$/, '')];
      if (h == null) { const e = new Error('The public page returned HTTP 404.'); e.code = 'BAD_STATUS'; throw e; }
      return { status: 200, html: h };
    },
    limits: { cacheTtlMs: 0 },
  };
};
const run = (deps, pageUrl = 'https://www.acme.test/local-seo') => discoverBreadcrumbs({ projectId: 'p1', pageUrl }, deps);

test('discovery: fetches the page (cache-busted) and the home page only — bounded, same-site — and reports the menu-based incomplete trail', async () => {
  clearBreadcrumbDiscoveryCache();
  const deps = fixture({ pages: { 'https://www.acme.test/local-seo': html(), [ROOT]: html({ title: 'Home | Acme', h1: 'Welcome' }) } });
  const r = await run(deps);
  assert.equal(r.status, 'incomplete'); assert.equal(r.recommended.source, 'navigation');
  assert.deepEqual(deps.calls.map((c) => c[0]), ['https://www.acme.test/local-seo', ROOT]);
  assert.equal(deps.calls[0][1].cacheBust, true);
  assert.equal(r.canonical.url, PAGE); assert.equal(r.canonical.trusted, true);
  assert.equal(r.existing.count, 0);
});

test('discovery: an already valid live BreadcrumbList marks the finding stale even though the stored crawl had none', async () => {
  const deps = fixture({ pages: { 'https://www.acme.test/local-seo': html({ head: jsonLd(crumbList(['Home', ROOT], ['Local SEO', PAGE])) }), [ROOT]: html() } });
  const r = await run(deps);
  assert.equal(r.status, 'already_valid'); assert.equal(r.staleFinding, true);
  assert.equal(r.existing.origin, 'live');
});

test('discovery: when the page cannot be fetched the stored crawl is used and says so; a stored valid list is already_valid', async () => {
  const stored = crawlDoc({ structured_data: [{ '@graph': [crumbList(['Home', ROOT], ['Local SEO', PAGE])] }] });
  const r = await run(fixture({ doc: stored, fail: ['https://www.acme.test/local-seo', ROOT] }));
  assert.equal(r.status, 'already_valid'); assert.ok(r.notes.some((n) => /could not be fetched/.test(n)));
  const none = await run(fixture({ fail: ['https://www.acme.test/local-seo', ROOT] }));
  assert.equal(none.status, 'not_found'); assert.ok(none.sources.fetched.every((f) => f.status === 'failed'));
});

test('discovery: parent candidates are fetched only when the crawl has them, and only count when they link to the page', async () => {
  const post = 'https://www.acme.test/blog/my-post';
  const deps = fixture({
    doc: crawlDoc({ url: post, canonical: `${post}/`, title: 'My post | Acme' }),
    crawlPages: [{ url: ROOT }, { url: 'https://www.acme.test/blog', title: 'Blog | Acme' }, { url: post }],
    pages: {
      [post]: html({ title: 'My post | Acme', h1: 'My post', menu: '' }),
      [ROOT]: html({ menu: '' }),
      'https://www.acme.test/blog': html({ title: 'Blog | Acme', h1: 'Blog', menu: '', body: `<a href="${post}/">My post</a>` }),
    },
  });
  const r = await run(deps, post);
  assert.equal(r.status, 'suggested'); assert.deepEqual(r.recommended.items.map((i) => i.name), ['Home', 'Blog', 'My post']);
  assert.deepEqual(r.sources.parentCandidates, ['https://www.acme.test/blog']);
  assert.equal(deps.calls.length, 3);
});

test('discovery: the number of fetches is bounded and non-public pages are never fetched', async () => {
  const many = ['/a', '/a/b', '/a/b/c'].map((p) => ({ url: `https://www.acme.test${p}` }));
  const deps = fixture({ doc: crawlDoc({ url: 'https://www.acme.test/a/b/c/d' }), crawlPages: [{ url: ROOT }, ...many], pages: {} });
  deps.limits = { cacheTtlMs: 0, maxFetches: 2 };
  await run(deps, 'https://www.acme.test/a/b/c/d');
  assert.equal(deps.calls.length, 2);
  const blocked = fixture({ fetchable: false });
  const r = await run(blocked);
  assert.equal(blocked.calls.length, 0); assert.ok(r.sources.fetched.every((f) => f.status === 'skipped'));
});

test('discovery: the home page has no trail to offer and says why; an owner-confirmed trail is reported back', async () => {
  const home = await run(fixture({ doc: crawlDoc({ url: 'https://www.acme.test', canonical: ROOT }), pages: { 'https://www.acme.test': html() } }), 'https://www.acme.test');
  assert.equal(home.isHomePage, true); assert.equal(home.status, 'not_found'); assert.match(home.notes[0], /home page/);
  const saved = { items: [{ position: 1, name: 'Home', url: ROOT }, { position: 2, name: 'Local SEO', url: PAGE }], evidenceHash: 'h', canonicalSource: 'canonical_tag', submittedAt: new Date('2026-10-01') };
  const r = await run(fixture({ saved, pages: { 'https://www.acme.test/local-seo': html(), [ROOT]: html() } }));
  assert.equal(r.saved.items.length, 2);
});

test('discovery is memoised per project and page; refresh bypasses the memo', async () => {
  clearBreadcrumbDiscoveryCache();
  const deps = fixture({ pages: { 'https://www.acme.test/local-seo': html(), [ROOT]: html() } });
  deps.limits = { cacheTtlMs: 60_000 };
  await run(deps);
  assert.equal((await run(deps)).cached, true); assert.equal(deps.calls.length, 2);
  await discoverBreadcrumbs({ projectId: 'p1', pageUrl: 'https://www.acme.test/local-seo', refresh: true }, deps);
  assert.equal(deps.calls.length, 4);
  clearBreadcrumbDiscoveryCache();
});

test('inspectPagesBreadcrumbs: every page is judged on its own live markup', async () => {
  const pages = {
    'https://www.acme.test/a': html({ head: jsonLd(crumbList(['Home', ROOT], ['A', 'https://www.acme.test/a'])) }),
    'https://www.acme.test/b': html(),
    'https://www.acme.test/c': html({ head: jsonLd(crumbList(['Home', '/rel'], ['C', 'https://www.acme.test/c'])) }),
    'https://www.acme.test/d': html({ head: jsonLd(crumbList(['Home', ROOT], ['D', 'https://www.acme.test/d'])) + jsonLd(crumbList(['Home', ROOT], ['D', 'https://www.acme.test/d'])) }),
  };
  const r = await inspectPagesBreadcrumbs({ urls: [...Object.keys(pages), 'https://www.acme.test/gone', 'https://www.acme.test/a'] }, { ...fixture({ pages }), limits: { cacheTtlMs: 0 } });
  assert.deepEqual(r.map((x) => [x.url.split('/').pop(), x.status]), [['a', 'valid'], ['b', 'missing'], ['c', 'invalid'], ['d', 'duplicate'], ['gone', 'unreachable']]);
  assert.equal(r[0].items.length, 2);
});

test('analyzeBreadcrumbs agrees with the classifier on a page JSON-LD (shared parser, no second definition of "valid")', () => {
  const f = facts(html({ head: jsonLd(crumbList(['Home', ROOT], ['Local SEO', PAGE])) }));
  const direct = analyzeBreadcrumbs(flattenJsonLd([crumbList(['Home', ROOT], ['Local SEO', PAGE])]), { pageUrl: PAGE });
  assert.equal(f.jsonLd.lists[0].problems.length, direct.lists[0].problems.length);
});

test('navigation: a heading that only repeats the entry below it is dropped', () => {
  const menu = '<header><nav id="top-menu-nav"><ul><li><a href="#">Pay Per Click</a><ul><li><a href="/local-seo/">Pay Per Click</a></li></ul></li></ul></nav></header>';
  const r = classify({ live: facts(html({ menu, h1: 'Pay Per Click', title: 'Pay Per Click | Acme' })), homeFacts: null });
  assert.deepEqual(names(r.trails[0]), ['Home', 'Pay Per Click']);
  assert.equal(r.status, 'suggested');
});

test('navigation: a menu heading with no URL gets a URL SUGGESTION only from a crawled page titled exactly like it, and stays unresolved', () => {
  const crawlPages = [{ url: 'https://www.acme.test/white-label-services', canonical: 'https://www.acme.test/white-label-services/', title: 'White Label Services | Acme' }, { url: 'https://www.acme.test/blog', title: 'Blog | Acme' }];
  const r = classify({ crawlPages });
  const heading = r.trails[0].items.find((i) => i.name === 'White Label Services');
  assert.equal(heading.url, null); assert.equal(heading.needsUrl, true);
  assert.equal(heading.urlSuggestion.url, 'https://www.acme.test/white-label-services/');
  assert.match(heading.urlSuggestion.evidence, /titled "White Label Services"/);
  assert.equal(r.status, 'incomplete', 'a suggestion is not a confirmation');
  // ambiguous (two pages with that title) or no page at all: nothing is suggested
  const two = classify({ crawlPages: [...crawlPages, { url: 'https://www.acme.test/wls-2', title: 'White Label Services - Acme' }] });
  assert.equal(two.trails[0].items.find((i) => i.name === 'White Label Services').urlSuggestion, undefined);
  assert.equal(classify().trails[0].items.find((i) => i.name === 'White Label Services').urlSuggestion, undefined);
});

test('discovery: a parent is named by the site\'s own menu label, not by the first heading of a listing page', async () => {
  const post = 'https://www.acme.test/blog/my-post';
  const menu = '<header><nav id="top-menu-nav"><ul><li><a href="/blog/">Our Blog</a></li></ul></nav></header>';
  const deps = fixture({
    doc: crawlDoc({ url: post, canonical: `${post}/`, title: 'My post | Acme' }),
    crawlPages: [{ url: ROOT }, { url: 'https://www.acme.test/blog', title: 'Blog | Acme' }, { url: post }],
    pages: { [post]: html({ title: 'My post | Acme', h1: 'My post', menu: '' }), [ROOT]: html({ menu }), 'https://www.acme.test/blog': html({ title: 'Blog | Acme', h1: 'Some listed post title', menu: '', body: `<a href="${post}/">x</a>` }) },
  });
  const r = await run(deps, post);
  assert.deepEqual(r.recommended.items.map((i) => i.name), ['Home', 'Our Blog', 'My post']);
});
