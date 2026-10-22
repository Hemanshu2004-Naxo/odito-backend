import { describe, test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';

dotenv.config();

import BusinessProfileReview from '../modules/app_user/model/BusinessProfileReview.js';
import BusinessProfileMetadata from '../modules/app_user/model/BusinessProfileMetadata.js';
import {
  parseReviewText, cleanReviewText, foldToken, createKeywordAccumulator, extractKeywords,
} from './businessProfileReviewKeywordService.js';
import { createThemeAccumulator, compileThemes, matchThemes } from './businessProfileReviewThemeService.js';
import { getReviewTextInsights, clearTextInsightsCache, brandTokensFromName } from './businessProfileReviewTextInsightsService.js';
import { getReviewAnalytics } from './businessProfileReviewAnalyticsService.js';
import BusinessProfileReviewSnapshot from '../modules/app_user/model/BusinessProfileReviewSnapshot.js';
import { resolveRange } from './businessProfileReviewMetrics.js';
import { KEYWORD_RULES } from '../config/reviewTextStopWords.js';

const R = (text, sentiment = 'positive') => ({ text, sentiment });
const words = (reviews, rules) => extractKeywords(reviews, rules).words;
const find = (list, term) => list.find((x) => x.term === term);

/** a rule set that lets tiny fixtures through */
const SMALL = { ...KEYWORD_RULES, minTextReviews: 1, minWordReviews: 1, minPhraseReviews: 2, minPhraseReviewsSmallPeriod: 2 };

describe('keywords - normalization and filtering', () => {
  test('1. basic extraction from the spec example, ranked by how many reviews mention each term', () => {
    const w = words([
      R('Excellent doctor and very helpful staff.'),
      R('Doctor explained the treatment very clearly.'),
      R('Staff was professional and friendly.'),
    ], { ...SMALL, minWordReviews: 2 });
    assert.deepEqual(w.map((x) => [x.term, x.reviewCount]), [['doctor', 2], ['staff', 2]]);
  });

  test('2. stop words are removed', () => {
    const k = parseReviewText('The doctor was very good and the staff is with us').words.map((x) => x.key);
    assert.deepEqual(k, ['doctor', 'good', 'staff']);
  });

  test('3. punctuation: "Dr. Patel was GREAT!!!" -> patel, great', () => {
    assert.deepEqual(parseReviewText('Dr. Patel was GREAT!!!').words.map((x) => x.key), ['patel', 'great']);
    assert.deepEqual(parseReviewText('good,,,,service...!!!???').words.map((x) => x.key), ['good', 'service']);
  });

  test('4. case is normalized', () => {
    const w = words([R('Doctor DOCTOR doctor')], SMALL);
    assert.equal(w.length, 1);
    assert.equal(w[0].term, 'doctor');
  });

  test('5/8. repeated words in ONE review are ONE customer mention (mentions keeps the raw count)', () => {
    const w = words([R('Great doctor. The doctor was excellent. Doctor helped us.')], SMALL);
    const doctor = find(w, 'doctor');
    assert.equal(doctor.reviewCount, 1);
    assert.equal(doctor.mentions, 3);
  });

  test('6. phrases: stop words never form phrases; real ones do', () => {
    const r = extractKeywords([
      R('The waiting time was very long'), R('waiting time is too long'), R('Very good doctor, waiting time ok'),
    ], SMALL);
    const phrases = r.phrases.map((p) => p.term);
    assert.ok(phrases.includes('waiting time'));
    for (const bad of ['the doctor', 'very good', 'was very', 'time was']) assert.ok(!phrases.includes(bad), bad);
    assert.equal(find(r.phrases, 'waiting time').reviewCount, 3);
  });

  test('phrases never span a clause boundary (comma / full stop)', () => {
    const r = extractKeywords([R('great staff, doctor kind'), R('great staff, doctor kind')], SMALL);
    assert.ok(!r.phrases.some((p) => p.term === 'staff doctor'));
    assert.ok(r.phrases.some((p) => p.term === 'great staff'));
  });

  test('phrase cohesion: two common words that rarely sit together are not a phrase', () => {
    const rules = { ...SMALL, minPhraseReviews: 2, minPhraseCohesion: 0.5 };
    const reviews = [R('alpha beta'), R('alpha beta')];
    for (let i = 0; i < 8; i++) reviews.push(R('alpha only here'), R('beta only there'));
    assert.ok(!extractKeywords(reviews, rules).phrases.some((p) => p.term === 'alpha beta'));
    assert.ok(extractKeywords([R('alpha beta'), R('alpha beta'), R('alpha beta')], rules).phrases.some((p) => p.term === 'alpha beta'));
  });

  test('7. frequency and percentage use reviews-with-text as the denominator and never exceed 100', () => {
    const r = extractKeywords([R('staff'), R('staff'), R('staff'), R('doctor')], SMALL);
    const staff = find(r.words, 'staff');
    assert.equal(staff.reviewCount, 3);
    assert.equal(staff.percentage, 75);
    assert.ok(r.words.every((x) => x.percentage >= 0 && x.percentage <= 100 && Number.isFinite(x.score)));
  });

  test('9/10. each keyword carries the sentiment of the reviews that mention it', () => {
    const w = words([
      R('staff', 'positive'), R('staff', 'positive'), R('staff slow', 'negative'),
      R('staff okay', 'neutral'), R('doctor', 'positive'),
    ], SMALL);
    const staff = find(w, 'staff');
    assert.deepEqual([staff.reviewCount, staff.positive, staff.neutral, staff.negative], [4, 2, 1, 1]);
    assert.equal(find(w, 'slow').negative, 1);
  });

  test('11. empty / null / whitespace text never throws and yields nothing', () => {
    for (const t of ['', '   ', null, undefined, 42, '\n\n']) {
      const p = parseReviewText(t);
      assert.deepEqual([p.words.length, p.phrases.length, p.tokenSet.size], [0, 0, 0]);
    }
    const acc = createKeywordAccumulator();
    acc.add(parseReviewText(''), 'positive');
    assert.equal(acc.reviewCount, 1);
    assert.deepEqual(acc.finalize(SMALL).words, []);
  });

  test('12. very short text: 1-2 letter tokens dropped, domain short terms (ENT, IV) kept', () => {
    assert.deepEqual(parseReviewText('ok a b').words, []);
    assert.deepEqual(parseReviewText('ENT doctor, IV drip').words.map((x) => x.key), ['ent', 'doctor', 'iv', 'drip']);
  });

  test('13. numbers, URLs and e-mail addresses are ignored', () => {
    const k = parseReviewText('Call 9876543210 or visit https://example.com/a?b=1 www.test.org email me@example.com 5 stars').words.map((x) => x.key);
    assert.deepEqual(k, ['call', 'email', 'star']);
  });

  test('14. special characters and emoji do not produce tokens or break words', () => {
    assert.deepEqual(parseReviewText('Great 👍👍 service ❤️ #best_doctor @@@ ***').words.map((x) => x.key), ['great', 'service', 'best', 'doctor']);
  });

  test('HTML tags / entities are removed', () => {
    assert.deepEqual(parseReviewText('<b>Great</b> staff &amp; doctor<br/>').words.map((x) => x.key), ['great', 'staff', 'doctor']);
  });

  test('plural folding, possessives, contractions and elongation', () => {
    assert.equal(foldToken('doctors'), 'doctor');
    assert.equal(foldToken('surgeries'), 'surgery');
    assert.equal(foldToken('facilities'), 'facility');
    assert.equal(foldToken('lenses'), 'lens');
    assert.equal(foldToken('lens'), 'lens');
    assert.equal(foldToken('process'), 'process');
    assert.equal(foldToken('glasses'), 'glass');
    assert.deepEqual(parseReviewText("doctor's staff").words.map((x) => x.key), ['doctor', 'staff']);
    // regression (found by real-data validation): a possessive on a name ending in -i / -is must not lose the name
    assert.deepEqual(parseReviewText("Dr. Deeksha Rani's care").words.map((x) => x.key), ['deeksha', 'rani', 'care']);
    assert.deepEqual(parseReviewText("the doctors' team, it's fine").words.map((x) => x.key), ['doctor', 'team', 'fine']);
    assert.deepEqual(parseReviewText("didn't wait").words.map((x) => x.key), ['wait']);
    assert.deepEqual(parseReviewText('sooo veryyy good').words.map((x) => x.key), ['good']);
    const w = words([R('doctor'), R('doctors'), R('Doctors rock')], SMALL);
    const doctor = w.filter((x) => /^doctors?$/.test(x.term));
    assert.equal(doctor.length, 1);
    assert.equal(doctor[0].reviewCount, 3); // doctor / doctors / Doctors = one term (shown in its commonest form)
  });

  test('Google "(Translated by Google) ... (Original) ..." keeps the translation, drops the marker words and the duplicate original', () => {
    const p = parseReviewText('(Translated by Google) Very nice staff\n\n(Original)\nखूपच छान स्टाफ');
    assert.deepEqual(p.words.map((x) => x.key), ['nice', 'staff']);
    assert.ok(!cleanReviewText('(Translated by Google) x\n(Original)\ny').includes('original'));
  });

  test('non-Latin text (Hindi / Marathi / Arabic) is preserved, not corrupted, and not run through the English stop list', () => {
    assert.deepEqual(parseReviewText('खूपच छान डॉक्टर').words.map((x) => x.key), ['खूपच', 'छान', 'डॉक्टर']);
    assert.deepEqual(parseReviewText('مستشفى ممتاز').words.map((x) => x.key), ['مستشفى', 'ممتاز']);
  });

  test('ignoreWords hides the business name from keywords but not from theme matching', () => {
    const brand = brandTokensFromName('ASG Krishna Eye Centre - Parel, Mumbai | An ASG Eye Hospital');
    for (const t of ['krishna', 'centre', 'center', 'eye', 'parel', 'hospital']) assert.ok(brand.has(t), t);
    const p = parseReviewText('Krishna Eye Centre staff was great', { ignoreWords: brand });
    assert.deepEqual(p.words.map((x) => x.key), ['staff', 'great']);
    assert.ok(p.tokenSet.has('krishna'));
    assert.equal(brandTokensFromName(null).size, 0);
  });
});

describe('keywords - ranking and thresholds', () => {
  test('score = reviewCount x ln(1 + N / reviewCount); ties by reviews, mentions, then A-Z', () => {
    const r = extractKeywords([R('alpha beta'), R('alpha'), R('alpha beta'), R('gamma delta')], { ...SMALL, minWordReviews: 1 });
    assert.equal(find(r.words, 'alpha').score, Math.round(3 * Math.log(1 + 4 / 3) * 100) / 100);
    const terms = r.words.map((x) => x.term);
    assert.equal(terms[0], 'alpha');
    assert.deepEqual(terms.slice(-2), ['delta', 'gamma']); // equal score/reviews/mentions -> alphabetical
  });
  test('ranks by customers, not by repetition: one rambling review cannot outrank widely-mentioned terms', () => {
    const r = extractKeywords([R('parking parking parking parking parking parking'), R('staff'), R('staff'), R('staff')], { ...SMALL, minWordReviews: 1 });
    assert.equal(r.words[0].term, 'staff');
  });
  test('terms below minWordReviews are not shown; fewer than minTextReviews -> nothing', () => {
    const rules = { ...KEYWORD_RULES, minTextReviews: 3, minWordReviews: 2 };
    assert.deepEqual(extractKeywords([R('staff'), R('doctor')], rules).words, []);
    const r = extractKeywords([R('staff'), R('staff'), R('doctor')], rules);
    assert.deepEqual(r.words.map((x) => x.term), ['staff']);
  });
  test('output is deterministic', () => {
    const reviews = [R('staff doctor'), R('doctor staff kind'), R('kind staff')];
    assert.deepEqual(extractKeywords(reviews, SMALL), extractKeywords([...reviews], SMALL));
  });
  test('maxWords / maxPhrases limits apply', () => {
    const reviews = Array.from({ length: 5 }, () => R('alpha bravo charlie delta echo foxtrot'));
    assert.equal(extractKeywords(reviews, { ...SMALL, maxWords: 3 }).words.length, 3);
    assert.equal(extractKeywords(reviews, { ...SMALL, maxPhrases: 2 }).phrases.length, 2);
  });
});

describe('themes', () => {
  const run = (reviews, minReviews = 1) => {
    const acc = createThemeAccumulator();
    for (const r of reviews) acc.add(parseReviewText(r.text), r.sentiment);
    return acc.finalize(minReviews);
  };
  const theme = (res, id) => res.items.find((i) => i.id === id);

  test('15. a single-topic review', () => {
    const res = run([R('The cost was too high')]);
    assert.deepEqual(res.items.map((i) => i.id), ['pricing']);
  });
  test('16. a review belongs to EVERY topic it mentions', () => {
    const res = run([R('The doctor was excellent but the waiting time was too long', 'negative')]);
    const ids = res.items.map((i) => i.id);
    assert.ok(ids.includes('doctors') && ids.includes('waiting'));
    assert.ok(theme(res, 'doctors').reviewCount === 1 && theme(res, 'waiting').reviewCount === 1);
  });
  test('17. a review with no topic contributes to the baseline only', () => {
    const res = run([R('Nothing special xyz')]);
    assert.deepEqual(res.items, []);
    assert.equal(res.reviewsAnalysed, 1);
    assert.equal(res.baseline.positive, 1);
  });
  test('18/19. topic counts and percentages (of reviews with text)', () => {
    const res = run([R('good staff'), R('staff great'), R('doctor'), R('xyz')]);
    const staff = theme(res, 'staff');
    assert.equal(staff.reviewCount, 2);
    assert.equal(staff.percentage, 50);
    assert.ok(res.items.every((i) => i.percentage >= 0 && i.percentage <= 100));
  });
  test('20/21. topic sentiment from the reviews that mention it (mixed sentiments)', () => {
    const res = run([
      R('waiting too long', 'negative'), R('long wait', 'negative'), R('wait was ok', 'neutral'),
      R('no wait at all', 'positive'), R('great doctor', 'positive'),
    ]);
    const w = theme(res, 'waiting');
    assert.deepEqual([w.reviewCount, w.positive, w.neutral, w.negative], [4, 1, 1, 2]);
    assert.deepEqual([w.positivePercent, w.neutralPercent, w.negativePercent], [25, 25, 50]);
    assert.equal(w.positive + w.neutral + w.negative, w.reviewCount);
    assert.equal(res.baseline.negative, 2);
    assert.equal(res.baseline.positivePercent, 40);
  });
  test('plurals, titles and phrases match: "doctors", "Dr", "on time"', () => {
    const c = compileThemes();
    const ids = (t) => matchThemes(parseReviewText(t), c);
    assert.ok(ids('Both doctors were kind').includes('doctors'));
    assert.ok(ids('Dr Rao explained').includes('doctors'));
    assert.ok(ids('Everything was handled on time').includes('waiting'));
    assert.ok(!ids('Everything was handled in time').includes('waiting'));
  });
  test('themes need >= minReviews to be reported as recurring', () => {
    assert.deepEqual(run([R('cost high'), R('xyz'), R('xyz')], 2).items, []);
    assert.equal(run([R('cost high'), R('cost low')], 2).items.length, 1);
  });
  test('23. zero reviews: no NaN, empty items', () => {
    const res = createThemeAccumulator().finalize();
    assert.deepEqual(res.items, []);
    assert.equal(res.baseline.positivePercent, 0);
    assert.ok(!JSON.stringify(res).includes('NaN'));
  });
  test('the taxonomy is data: a custom taxonomy works without code changes', () => {
    const acc = createThemeAccumulator([{ id: 'parking', name: 'Parking', terms: ['parking', 'valet'] }]);
    acc.add(parseReviewText('Easy parking'), 'positive');
    assert.deepEqual(acc.finalize(1).items.map((i) => i.id), ['parking']);
  });
});

describe('text insights service (streaming, date range, isolation, cache)', () => {
  const NOW = new Date('2026-10-07T06:00:00Z');
  const doc = (text, stars, date, over = {}) => ({ comment: text, star_rating: stars, review_create_time: new Date(date), ...over });
  let dataset, filters;

  beforeEach(() => {
    clearTextInsightsCache();
    filters = [];
    dataset = [
      doc('Great doctor and helpful staff', 5, '2026-10-06T10:00:00Z'),
      doc('Doctor was kind, staff polite', 5, '2026-10-05T10:00:00Z'),
      doc('Long waiting time, staff slow', 1, '2026-10-04T10:00:00Z'),
      doc('Excellent surgery experience', 5, '2026-08-01T10:00:00Z'), // only in wider ranges
      doc('Good staff', 4, '2025-11-15T10:00:00Z'),                    // only in 12m
      doc('', 5, '2026-10-06T10:00:00Z'),
      doc('   ', 5, '2026-10-06T10:00:00Z'),
    ];
    mock.method(BusinessProfileReview, 'find', (filter, projection) => {
      filters.push({ filter, projection });
      const { $gte, $lte } = filter.review_create_time;
      const rows = dataset.filter((d) => d.review_create_time >= $gte && d.review_create_time <= $lte && d.comment);
      return { lean: () => ({ cursor: () => (async function* () { for (const r of rows) yield r; })() }) };
    });
  });
  afterEach(() => mock.restoreAll());

  const run = (rangeKey, extra = {}) => getReviewTextInsights({
    projectId: 'p1', locationId: 'L1', range: resolveRange(rangeKey, NOW, 'UTC'), ...extra,
  });

  test('22. the date range filters the reviews: 7D differs from 12M', async () => {
    const d7 = await run('7d');
    const m12 = await run('12m');
    assert.equal(d7.keywords.basis.reviewsWithText, 3);
    assert.equal(m12.keywords.basis.reviewsWithText, 5);
    assert.equal(d7.themes.reviewsAnalysed, 3);
    assert.notDeepEqual(d7.keywords.words, m12.keywords.words);
    const flt = filters[0].filter.review_create_time;
    assert.ok(flt.$gte instanceof Date && flt.$lte instanceof Date);
  });

  test('whitespace-only comments are not "reviews with text" (same rule as Review Distribution)', async () => {
    const r = await run('7d');
    assert.equal(r.keywords.basis.reviewsWithText, 3);
  });

  test('project + location + non-deleted scope, and only 3 fields are read', async () => {
    await run('7d');
    const { filter, projection } = filters[0];
    assert.equal(filter.project_id, 'p1');
    assert.equal(filter.business_location_id, 'L1');
    assert.equal(filter.is_deleted, false);
    assert.deepEqual(Object.keys(projection).sort(), ['comment', 'sentiment_label', 'star_rating']);
  });

  test('sentiment comes from the shared rule: stars, unless a stored label exists', async () => {
    dataset = [
      doc('slow staff', 5, '2026-10-06T10:00:00Z', { sentiment_label: 'negative' }), // stored label wins
      doc('great staff', 5, '2026-10-06T11:00:00Z'),
      doc('ok staff', 3, '2026-10-06T12:00:00Z'),
      doc('bad staff', 1, '2026-10-06T13:00:00Z'),
    ];
    const r = await run('7d');
    const staff = r.keywords.words.find((w) => w.term === 'staff');
    assert.deepEqual([staff.reviewCount, staff.positive, staff.neutral, staff.negative], [4, 1, 1, 2]);
    const t = r.themes.items.find((i) => i.id === 'staff');
    assert.deepEqual([t.positive, t.neutral, t.negative], [1, 1, 2]);
  });

  test('keyword and theme totals reconcile', async () => {
    const r = await run('12m');
    for (const w of [...r.keywords.words, ...r.keywords.phrases]) {
      assert.equal(w.positive + w.neutral + w.negative, w.reviewCount);
      assert.ok(w.percentage <= 100 && w.reviewCount <= r.keywords.basis.reviewsWithText);
    }
    for (const t of r.themes.items) assert.equal(t.positive + t.neutral + t.negative, t.reviewCount);
  });

  test('23. a period with no reviews: empty states, valid numbers', async () => {
    dataset = [];
    const r = await run('7d');
    assert.equal(r.keywords.status, 'insufficient_text');
    assert.equal(r.themes.status, 'no_themes');
    assert.deepEqual([r.keywords.words, r.keywords.phrases, r.themes.items], [[], [], []]);
    assert.ok(!JSON.stringify(r).includes('NaN'));
  });

  test('"not enough text" is reported instead of fake keywords', async () => {
    dataset = [doc('staff', 5, '2026-10-06T10:00:00Z'), doc('doctor', 5, '2026-10-06T11:00:00Z')];
    const r = await run('7d');
    assert.equal(r.keywords.status, 'insufficient_text');
    assert.deepEqual(r.keywords.words, []);
  });

  test('the business name is excluded from keywords and the exclusion is disclosed', async () => {
    dataset = Array.from({ length: 4 }, () => doc('Krishna Eye Centre staff is great', 5, '2026-10-06T10:00:00Z'));
    const r = await run('7d', { businessName: 'Krishna Eye Centre' });
    assert.deepEqual(r.keywords.words.map((w) => w.term).sort(), ['great', 'staff']);
    assert.ok(r.keywords.basis.excludedBrandTerms.includes('krishna'));
    assert.ok(r.themes.items.some((i) => i.id === 'staff'));
  });

  test('cached per project/location/range/window/sync-stamp; a new sync stamp recomputes', async () => {
    await run('7d', { version: 1 });
    await run('7d', { version: 1 });
    assert.equal(filters.length, 1, 'second identical request is served from cache');
    await run('7d', { version: 2 });
    assert.equal(filters.length, 2, 'a new review sync invalidates');
    await run('30d', { version: 2 });
    assert.equal(filters.length, 3, 'a different range is a different entry');
  });

  test('the analytics response gains keywords + themes and still contains every existing module; a text failure does not break them', async () => {
    mock.method(BusinessProfileReview, 'aggregate', async () => [{ lifetime: [{ total: 2, ratingSum: 9 }], daily: [], recent: undefined }]);
    mock.method(BusinessProfileReviewSnapshot, 'find', () => ({ select: () => ({ sort: () => ({ lean: async () => [] }) }) }));
    mock.method(BusinessProfileReviewSnapshot, 'findOne', () => ({ sort: () => ({ select: () => ({ lean: async () => null }) }) }));
    mock.method(BusinessProfileMetadata, 'findOne', () => ({ lean: async () => ({ business_name: 'Krishna Eye Centre', average_rating: 4.9, total_review_count: 5, reviews_last_synced_at: new Date('2026-10-06') }) }));
    const ok = await getReviewAnalytics({ projectId: '6ac4bf78867ae9b647ec8478', locationId: 'L1', rangeKey: '7d', timezone: 'UTC', now: NOW });
    for (const k of ['overview', 'ratings', 'trends', 'glance', 'response', 'distribution', 'sentiment', 'keywords', 'themes']) assert.ok(k in ok, k);
    assert.equal(ok.keywords.status, 'ok');

    clearTextInsightsCache();
    BusinessProfileReview.find.mock.restore();
    mock.method(BusinessProfileReview, 'find', () => { throw new Error('text store down'); });
    const degraded = await getReviewAnalytics({ projectId: '6ac4bf78867ae9b647ec8478', locationId: 'L1', rangeKey: '7d', timezone: 'UTC', now: NOW });
    assert.equal(degraded.keywords, null);
    assert.equal(degraded.themes, null);
    assert.equal(degraded.overview.lifetime.totalReviews, 2, 'the numeric modules are unaffected');
  });
});
