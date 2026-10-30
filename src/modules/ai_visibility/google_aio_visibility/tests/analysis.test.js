import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeOverview, isOwnedHost } from '../analysis/overviewAnalysis.js';
import { computeRunMetrics } from '../analysis/metrics.js';
import { extractAiOverview } from '../provider/responseParser.js';
import { aioItem } from './fixtures.js';

const target = { brandNames: ['ASG Eye Hospital'], brandMatchReliable: true, competitors: ['Sankara Eye Care', 'Vasan Eye Care'], targetHost: 'asgeye.example', ownedHosts: ['asgeye.example'] };
const overview = (text, refs = []) => ({ text, markdown: null, references: refs.map((url) => ({ url, normalizedUrl: url, host: new URL(url).hostname.replace(/^www\./, ''), title: null, source: null, kind: 'reference' })) });

describe('mention vs citation are separate signals', () => {
  test('mentioned in prose, not cited', () => {
    const a = analyzeOverview(overview('ASG Eye Hospital offers LASIK in Nashik.', ['https://practo.example/x']), target);
    assert.equal(a.mention.mentioned, true);
    assert.equal(a.ownedCited, false);
    assert.equal(a.referencesStatus, 'available');
  });
  test('cited but not mentioned', () => {
    const a = analyzeOverview(overview('Several hospitals offer LASIK in Nashik.', ['https://www.asgeye.example/lasik']), target);
    assert.equal(a.mention.mentioned, false);
    assert.equal(a.ownedCited, true);
    assert.deepEqual(a.ownedPages, ['https://www.asgeye.example/lasik']);
  });
  test('a URL containing the brand does not count as a prose mention', () => {
    const a = analyzeOverview(overview('Read more at https://practo.example/asg-eye-hospital for details about LASIK.', ['https://practo.example/asg-eye-hospital']), target);
    assert.equal(a.mention.mentioned, false);
  });
  test('lookalike brand names do not match', () => {
    const t = { ...target, brandNames: ['Apollo'] };
    assert.equal(analyzeOverview(overview('Apollonia Clinic is nearby.'), t).mention.mentioned, false);
    assert.equal(analyzeOverview(overview('Apollo Hospitals is nearby.'), t).mention.mentioned, true);
  });
  test('an unreliable (generic) business name is ambiguous, never a confirmed mention', () => {
    const a = analyzeOverview(overview('Eye Hospital services are available.'), { ...target, brandNames: ['Eye Hospital'], brandMatchReliable: false });
    assert.equal(a.mention.status, 'ambiguous');
    assert.equal(a.mention.mentioned, false);
  });
});

describe('owned-domain matching', () => {
  test('exact host and www are owned; lookalikes and subdomains are not', () => {
    for (const host of ['asgeye.example', 'www.asgeye.example', 'ASGEYE.example']) assert.equal(isOwnedHost(host, ['asgeye.example']), true, host);
    for (const host of ['asgeye.example.attacker.test', 'notasgeye.example', 'blog.asgeye.example', 'asgeye.example.evil', null]) assert.equal(isOwnedHost(host, ['asgeye.example']), false, String(host));
  });
  test('a subdomain is owned only when the verified domain policy lists it', () => {
    assert.equal(isOwnedHost('blog.asgeye.example', ['asgeye.example', 'blog.asgeye.example']), true);
  });
  test('path or query containing the domain on another host is not owned', () => {
    const a = analyzeOverview(overview('Text.', ['https://maps.example/search?q=asgeye.example', 'https://asgeye.example.attacker.test/x']), target);
    assert.equal(a.ownedCited, false);
  });
});

describe('references', () => {
  test('no references => ownedCited is null (unknown), never false', () => {
    const a = analyzeOverview(overview('ASG Eye Hospital offers LASIK.'), target);
    assert.equal(a.referencesStatus, 'unavailable');
    assert.equal(a.ownedCited, null);
  });
  test('parser output flows through: the same page cited as link and reference counts once', () => {
    const parsed = extractAiOverview(aioItem());
    const a = analyzeOverview(parsed, target);
    assert.equal(a.ownedCited, true);
    assert.deepEqual(a.ownedPages, ['https://asgeye.example/cataract']);
    assert.equal(a.mention.mentioned, true);
    assert.equal(a.competitors.find((c) => c.name === 'Sankara Eye Care').mentioned, true);
    assert.equal(a.competitors.find((c) => c.name === 'Sankara Eye Care').cited, true);
    assert.equal(a.competitors.find((c) => c.name === 'Vasan Eye Care').mentioned, false);
    assert.equal(a.competitors.find((c) => c.name === 'Vasan Eye Care').cited, false);
  });
  test('competitor mention and competitor citation are independent', () => {
    const a = analyzeOverview({ text: 'Vasan Eye Care is also popular.', markdown: null, references: [{ url: 'https://www.sankaraeyecare.example/x', normalizedUrl: 'https://sankaraeyecare.example/x', host: 'sankaraeyecare.example', source: null, title: null }] }, target);
    const byName = Object.fromEntries(a.competitors.map((c) => [c.name, c]));
    assert.deepEqual([byName['Vasan Eye Care'].mentioned, byName['Vasan Eye Care'].cited], [true, false]);
    assert.deepEqual([byName['Sankara Eye Care'].mentioned, byName['Sankara Eye Care'].cited], [false, true]);
  });
  test('an overview with no text is not analysable for mentions', () => {
    const a = analyzeOverview({ text: null, markdown: null, references: [] }, target);
    assert.equal(a.contentStatus, 'no_content');
    assert.equal(a.mention.mentioned, null);
    assert.ok(a.competitors.every((c) => c.mentioned === null));
  });
});

// ── metrics ──
const ev = (questionId, o = {}) => ({ questionId, status: 'succeeded', cost: 0.01, aiOverview: { present: false }, analysis: null, ...o });
const withAio = (questionId, { mentioned = false, cited = null, pages = [], occ = 0, refs = 'available', content = 'analysed', competitors = [] } = {}) => ev(questionId, {
  aiOverview: { present: true },
  analysis: { contentStatus: content, mention: { mentioned: content === 'analysed' ? mentioned : null, status: mentioned ? 'mentioned' : 'not_mentioned' }, referencesStatus: refs, ownedCited: refs === 'available' ? cited : null, ownedPages: pages, ownedCitationCount: occ, competitors },
});

describe('run metrics (from persisted evidence)', () => {
  test('rates use the right denominators', () => {
    const docs = [
      withAio('q1', { mentioned: true, cited: true, pages: ['https://a.example/1'], occ: 2 }),
      withAio('q2', { mentioned: true, cited: false }),
      withAio('q3', { mentioned: false, cited: null, refs: 'unavailable' }), // overview without references: excluded from the citation denominator
      ev('q4'), // no overview
      { questionId: 'q5', status: 'failed', cost: null }, // failed request: not in any denominator
    ];
    const m = computeRunMetrics(docs, target);
    assert.deepEqual([m.aiOverview.count, m.aiOverview.denominator, m.aiOverview.rate], [3, 4, 0.75]);
    assert.deepEqual([m.brandMention.count, m.brandMention.denominator, m.brandMention.rate], [2, 3, 0.6667]);
    assert.deepEqual([m.websiteCitation.count, m.websiteCitation.denominator, m.websiteCitation.rate, m.websiteCitation.excluded], [1, 2, 0.5, 1]);
    assert.equal(m.partial, true);
    assert.deepEqual(m.questions, { planned: 5, answered: 4, failed: 1, skipped: 0, cancelled: 0, pending: 0 });
    assert.ok(m.limitations.includes('SOME_OVERVIEWS_HAVE_NO_SOURCE_REFERENCES'));
  });
  test('unique cited pages counts distinct URLs, not occurrences', () => {
    const docs = [
      withAio('q1', { cited: true, pages: ['https://a.example/1', 'https://a.example/2'], occ: 3 }),
      withAio('q2', { cited: true, pages: ['https://a.example/1'], occ: 1 }),
      withAio('q3', { cited: false }), withAio('q4', { cited: false }), withAio('q5', { cited: false }),
    ];
    const m = computeRunMetrics(docs, target);
    assert.deepEqual([m.uniqueCitedPages.count, m.uniqueCitedPages.citationOccurrences], [2, 4]);
    assert.deepEqual([m.websiteCitation.count, m.websiteCitation.denominator], [2, 5]);
  });
  test('no overviews: rates that cannot be computed are null, not 0', () => {
    const m = computeRunMetrics([ev('q1'), ev('q2'), ev('q3'), ev('q4'), ev('q5')], target);
    assert.equal(m.aiOverview.rate, 0);
    assert.equal(m.brandMention.rate, null);
    assert.equal(m.websiteCitation.rate, null);
    assert.equal(m.partial, false);
    assert.ok(m.limitations.includes('NO_AI_OVERVIEWS_RETURNED'));
  });
  test('nothing succeeded: appearance rate is null', () => {
    const m = computeRunMetrics([{ questionId: 'q1', status: 'failed' }], target);
    assert.equal(m.aiOverview.rate, null);
  });
  test('competitor mentions and citations are reported separately over their own denominators', () => {
    const comp = (mentioned, cited) => [{ name: 'Sankara Eye Care', mentioned, cited }, { name: 'Vasan Eye Care', mentioned: false, cited: false }];
    const docs = [withAio('q1', { competitors: comp(true, false) }), withAio('q2', { competitors: comp(false, true) }), withAio('q3', { competitors: comp(true, true), refs: 'unavailable' })];
    const m = computeRunMetrics(docs, target);
    const s = m.competitors.find((c) => c.name === 'Sankara Eye Care');
    assert.deepEqual([s.mentions.count, s.mentions.denominator], [2, 3]);
    assert.deepEqual([s.citations.count, s.citations.denominator], [1, 2]);
    assert.equal(computeRunMetrics(docs, { ...target, competitors: [] }).competitors.length, 0);
  });
  test('an unreliable brand name suppresses the mention rate and says why', () => {
    const m = computeRunMetrics([withAio('q1', { mentioned: true })], { ...target, brandMatchReliable: false });
    assert.equal(m.brandMention.rate, null);
    assert.ok(m.limitations.includes('BRAND_NAME_UNRELIABLE'));
  });
  test('unknown cost is never counted as zero', () => {
    const m = computeRunMetrics([ev('q1', { cost: null }), ev('q2', { cost: 0.02 })], target);
    assert.deepEqual([m.cost.amount, m.cost.unknownCount], [0.02, 1]);
    assert.equal(computeRunMetrics([ev('q1', { cost: null })], target).cost.amount, null);
  });
});
