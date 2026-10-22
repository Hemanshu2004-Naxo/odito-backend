import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { RankingParserService } from './RankingParserService.js';
import { scanKeywordDevices, buildDeviceResult } from './deviceSerpScan.js';

/**
 * Organic domain matching, using sanitized SERP payloads (domains/URLs/positions only).
 * The first block reproduces the real top-20 organic items from the
 * "best software company near me" scan (rank_group / rank_absolute / domain / url as logged).
 *
 * Run from backend/:  node --test src/modules/ranking/services/RankingParserService.organicMatch.test.js
 */

const TARGET = 'wowinfotech.com';

// Real items from the logged desktop response (positions 1-20 of 99).
const LOGGED_TOP20 = [
  [1, 4, 'justdial.com', 'https://www.justdial.com/Pune/Software-Companies-in-Pimpri-Chinchwad-New-Town/nct-10443565'],
  [2, 5, 'justdial.com', 'https://www.justdial.com/Navsari/Software-Companies/nct-10443565'],
  [3, 7, 'justdial.com', 'https://www.justdial.com/Navi-Mumbai/Software-Companies-in-Vashi/nct-10443565'],
  [4, 8, 'smartinfologiks.com', 'https://www.smartinfologiks.com/'],
  [5, 9, 'eiosys.com', 'https://www.eiosys.com/'],
  [6, 10, 'justdial.com', 'https://www.justdial.com/Pune/Software-Companies-in-Nighoje/nct-10443565'],
  [7, 11, 'vasai-virar.idbf.in', 'https://vasai-virar.idbf.in/software-companies'],
  [8, 12, 'softthenext.com', 'https://softthenext.com/'],
  [9, 13, 'justdial.com', 'https://www.justdial.com/Mumbai/Software-Companies-in-Andheri-West/nct-10443565'],
  [10, 15, 'builtindelhi.in', 'https://builtindelhi.in/articles/software-company-in-delhi'],
  [11, 16, 'syansoft.com', 'https://www.syansoft.com/'],
  [12, 17, 'goodfirms.co', 'https://www.goodfirms.co/directory/city/top-software-development-companies/pune'],
  [13, 18, 'justdial.com', 'https://www.justdial.com/Aurangabad-Maharashtra/Software-Companies/nct-10443565'],
  [14, 19, 'justdial.com', 'https://www.justdial.com/Pune/Software-Companies-in-Aundh/nct-10443565'],
  [15, 20, 'ascentindia.dev', 'https://www.ascentindia.dev/'],
  [16, 21, 'justdial.com', 'https://www.justdial.com/Pune/Software-Companies-in-Lohegaon/nct-10443565'],
  [17, 22, 'justdial.com', 'https://www.justdial.com/Solapur/Software-Companies-in-Solapur-Market/nct-10443565'],
  [18, 23, 'justdial.com', 'https://www.justdial.com/Mumbai/Software-Companies-in-Malad-West/nct-10443565'],
  [19, 24, 'justdial.com', 'https://www.justdial.com/Indore/Software-Companies-in-Indore-Industrial-Estate/nct-10443565'],
  [20, 26, 'justdial.com', 'https://www.justdial.com/Pune/Software-Companies-in-Chinchwad-Midc/nct-10443565'],
].map(([g, a, domain, url]) => ({ type: 'organic', rank_group: g, rank_absolute: a, domain, url, title: 't' }));

const serp = (items) => ({ tasks: [{ status_code: 20000, result: [{ items }] }] });
const org = (rank, url, domain) => ({ type: 'organic', rank_group: rank, rank_absolute: rank + 3, ...(domain !== undefined ? { domain } : {}), ...(url !== undefined ? { url } : {}) });
/** the logged top 20 padded with unrelated results up to `n`, plus `extra` items at the given positions */
const padded = (n, extra = []) => {
  const items = [...LOGGED_TOP20];
  for (let i = 21; i <= n; i++) items.push(org(i, `https://filler${i}.example/page`, `filler${i}.example`));
  for (const e of extra) items[e.rank_group - 1] = e;
  return items;
};
const parse = (items) => RankingParserService.parseOrganic(serp(items), TARGET);

describe('parseOrganic — the logged SERP', () => {
  test('the real top 20 contain no wowinfotech.com result: a confirmed no-match, not a parser failure', () => {
    const r = parse(LOGGED_TOP20);
    assert.equal(r.best_rank, null);
    assert.deepEqual(r.ranking_urls, []);
  });

  test('a wowinfotech.com result ANYWHERE in the 99 returned items (not only the first 20) is found', () => {
    const items = padded(99, [org(57, 'https://www.wowinfotech.com/services/software-development', 'www.wowinfotech.com')]);
    const r = parse(items);
    assert.equal(r.best_rank, 57);
    assert.equal(r.ranking_urls[0].url, 'https://www.wowinfotech.com/services/software-development');
    assert.equal(RankingParserService.observedOrganicDepth(serp(items)), 99);
  });

  test('position uses rank_group (organic-only position), not rank_absolute', () => {
    const r = parse(padded(30, [org(25, 'https://wowinfotech.com/', 'wowinfotech.com')]));
    assert.equal(r.best_rank, 25);
  });
});

describe('parseOrganic — domain matching', () => {
  const cases = [
    ['direct domain match', 'https://wowinfotech.com/', 'wowinfotech.com', true],
    ['www variant', 'https://www.wowinfotech.com/about', 'www.wowinfotech.com', true],
    ['http scheme', 'http://wowinfotech.com/x', 'wowinfotech.com', true],
    ['uppercase host', 'https://WWW.WowInfoTech.COM/', 'WWW.WowInfoTech.COM', true],
    ['subdomain', 'https://blog.wowinfotech.com/post', 'blog.wowinfotech.com', true],
    ['mobile subdomain', 'https://m.wowinfotech.com/', 'm.wowinfotech.com', true],
    ['port in URL', 'https://wowinfotech.com:443/', 'wowinfotech.com', true],
    ['trailing dot host', 'https://wowinfotech.com./', 'wowinfotech.com.', true],
    ['query string only', 'https://wowinfotech.com?utm=1', 'wowinfotech.com', true],
    ['target embedded in a longer, unrelated domain', 'https://wowinfotech.com.example.org/', 'wowinfotech.com.example.org', false],
    ['unrelated domain that merely ends with the target text', 'https://notwowinfotech.com/', 'notwowinfotech.com', false],
    ['unrelated domain that is a tail fragment of the target (infotech.com)', 'https://infotech.com/', 'infotech.com', false],
    ['unrelated short domain that is a tail fragment of the target (tech.com)', 'https://www.tech.com/', 'tech.com', false],
    ['absent target', 'https://example.org/', 'example.org', false],
    ['path mentions the target but host is different', 'https://directory.example/wowinfotech.com', 'directory.example', false],
  ];
  for (const [name, url, domain, expected] of cases) {
    test(`${expected ? 'matches' : 'does NOT match'}: ${name}`, () => {
      const r = parse([org(3, url, domain)]);
      assert.equal(r.best_rank, expected ? 3 : null, `url=${url}`);
    });
  }

  test('missing url falls back to the provider domain field', () => {
    assert.equal(parse([org(4, undefined, 'www.wowinfotech.com')]).best_rank, 4);
  });

  test('missing or malformed url/domain never matches (and never throws)', () => {
    for (const item of [org(2), org(2, '', ''), org(2, 'not a url at all', ''), org(2, null, null), { type: 'organic', rank_group: 2 }]) {
      assert.doesNotThrow(() => parse([item]));
      assert.equal(parse([item]).best_rank, null);
    }
  });

  test('non-organic items (local_pack / maps / ads) never count as an organic ranking', () => {
    const items = [
      { type: 'local_pack', rank_group: 1, items: [{ type: 'local_pack_element', url: 'https://wowinfotech.com/', rank_group: 2 }] },
      { type: 'paid', rank_group: 1, domain: 'wowinfotech.com', url: 'https://wowinfotech.com/' },
      { type: 'maps_search', rank_group: 17, domain: 'www.wowinfotech.com', url: 'https://www.wowinfotech.com/' },
    ];
    assert.equal(parse(items).best_rank, null);
  });

  test('several URLs of the target: all are kept, best rank is the lowest, duplicates collapsed', () => {
    const r = parse([
      org(9, 'https://wowinfotech.com/b', 'wowinfotech.com'),
      org(4, 'https://wowinfotech.com/a', 'wowinfotech.com'),
      org(12, 'https://wowinfotech.com/a', 'wowinfotech.com'),
    ]);
    assert.equal(r.best_rank, 4);
    assert.deepEqual(r.ranking_urls.map((u) => u.rank), [4, 9]);
  });

  test('a project domain stored as a full URL still matches after normalisation', () => {
    const target = RankingParserService.normalizeDomain('https://www.wowinfotech.com/');
    assert.equal(target, 'wowinfotech.com');
    assert.equal(RankingParserService.parseOrganic(serp([org(6, 'https://wowinfotech.com/', 'wowinfotech.com')]), target).best_rank, 6);
  });
});

describe('desktop and mobile are parsed separately and keep their own result', () => {
  test('target found on mobile only: mobile has the rank, desktop is a confirmed no-match (not an error)', async () => {
    const desktopItems = padded(99);
    const mobileItems = padded(55, [org(9, 'https://m.wowinfotech.com/', 'm.wowinfotech.com')]);
    const serpFetcher = async (_k, _l, _lang, { device }) => serp(device === 'desktop' ? desktopItems : mobileItems);
    const { desktop, mobile } = await scanKeywordDevices({ keyword: 'k', locationCode: 9040235, languageCode: 'en', serpFetcher, mobileEnabled: true });
    const d = buildDeviceResult(desktop, TARGET);
    const m = buildDeviceResult(mobile, TARGET);
    assert.equal(d.scan_error, null);
    assert.equal(d.best_rank, null);
    assert.equal(d.tracked_depth, 99);
    assert.equal(m.best_rank, 9);
    assert.equal(m.tracked_depth, 55);
  });

  test('empty or error-shaped provider responses are scan errors upstream, never silently "no match"', async () => {
    const serpFetcher = async () => { throw new Error('DataForSEO task error: x (code 40501)'); };
    const { desktop } = await scanKeywordDevices({ keyword: 'k', locationCode: 1, languageCode: 'en', serpFetcher, mobileEnabled: false });
    assert.match(buildDeviceResult(desktop, TARGET).scan_error, /task error/);
  });
});

describe('live/advanced response shape (SERP features mixed in with organic items)', () => {
  // Item shapes follow the advanced response: non-organic types carry their own rank_group/rank_absolute.
  const advanced = [
    { type: 'ai_overview', rank_group: 1, rank_absolute: 1, references: [{ url: 'https://wowinfotech.com/', domain: 'wowinfotech.com' }] },
    { type: 'featured_snippet', rank_group: 1, rank_absolute: 2, domain: 'wowinfotech.com', url: 'https://wowinfotech.com/snippet' },
    { type: 'people_also_ask', rank_group: 1, rank_absolute: 3, items: [{ type: 'people_also_ask_element', url: 'https://wowinfotech.com/faq' }] },
    { type: 'local_pack', rank_group: 1, rank_absolute: 4, items: [{ type: 'local_pack_element', rank_group: 2, domain: 'www.wowinfotech.com', url: 'https://www.wowinfotech.com/' }] },
    { type: 'organic', rank_group: 1, rank_absolute: 5, domain: 'techbehemoths.com', url: 'https://techbehemoths.com/companies/nashik' },
    { type: 'video', rank_group: 1, rank_absolute: 6, url: 'https://youtube.com/watch?v=1' },
    { type: 'organic', rank_group: 2, rank_absolute: 7, domain: 'microstopindia.com', url: 'https://www.microstopindia.com/' },
    { type: 'organic', rank_group: 3, rank_absolute: 9, domain: 'wowinfotech.com', url: 'https://www.wowinfotech.com/' },
    { type: 'related_searches', rank_group: 1, rank_absolute: 10, items: ['x'] },
    { type: 'organic', rank_group: 4, rank_absolute: 12, domain: 'justdial.com', url: 'https://www.justdial.com/Nashik' },
  ];

  test('only type=organic items count: the organic position is rank_group, never a feature block or rank_absolute', () => {
    const r = parse(advanced);
    assert.equal(r.best_rank, 3);
    assert.deepEqual(r.ranking_urls.map((u) => u.url), ['https://www.wowinfotech.com/']);
  });

  test('a target that only appears inside SERP features (no organic item) is not an organic ranking', () => {
    const r = parse(advanced.filter((i) => i.type !== 'organic' || i.domain !== 'wowinfotech.com'));
    assert.equal(r.best_rank, null);
  });

  test('the tracked depth is measured on organic items only', () => {
    assert.equal(RankingParserService.observedOrganicDepth(serp(advanced)), 4);
  });

  test('a local-pack entry still yields the local-pack rank used only as the Maps fallback', () => {
    assert.equal(parse(advanced).maps_rank, 2);
  });
});
