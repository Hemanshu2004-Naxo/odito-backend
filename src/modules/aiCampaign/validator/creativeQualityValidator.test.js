import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isNearDuplicate,
  findDuplicatePairs,
  findTemplateRepetition,
  validateCreativeQuality,
  validateCampaignAssets,
} from './creativeQualityValidator.js';

describe('isNearDuplicate', () => {
  test('exact match is a duplicate', () => {
    assert.equal(isNearDuplicate('Grow Your Business', 'Grow Your Business'), true);
  });

  test('case/punctuation-only differences are duplicates', () => {
    assert.equal(isNearDuplicate('Grow Your Business!', 'grow your business'), true);
  });

  test('mostly-overlapping word sets (Jaccard >= 0.8) are a near-duplicate', () => {
    // 4 shared words + 1 extra = intersection 4 / union 5 = 0.8 (the threshold).
    assert.equal(isNearDuplicate('Grow Your Business Online', 'Grow Your Business Online Today'), true);
  });

  test('a single word swapped out of four (Jaccard 0.6) is NOT a near-duplicate', () => {
    assert.equal(isNearDuplicate('Grow Your Business Online', 'Grow Your Business Digitally'), false);
  });

  test('genuinely different sentences are not duplicates', () => {
    assert.equal(isNearDuplicate('Digital Marketing Experts', 'Get Your Free Consultation'), false);
  });

  test('empty strings never match', () => {
    assert.equal(isNearDuplicate('', ''), false);
    assert.equal(isNearDuplicate('Something', ''), false);
  });
});

describe('findDuplicatePairs', () => {
  test('finds every near-duplicate pair by index', () => {
    const pairs = findDuplicatePairs(['Grow Your Business Online', 'Grow Your Business Online Today', 'Totally Different Headline']);
    assert.equal(pairs.length, 1);
    assert.deepEqual([pairs[0].a, pairs[0].b], [0, 1]);
  });

  test('no pairs when every text is distinct', () => {
    assert.equal(findDuplicatePairs(['Alpha One Two', 'Beta Three Four', 'Gamma Five Six']).length, 0);
  });
});

describe('findTemplateRepetition', () => {
  test('flags the spec example: same 2-word prefix repeated across >30% of headlines', () => {
    const headlines = [
      'Grow Your Business Online',
      'Grow Your Business Digitally',
      'Grow Your Business With Marketing',
      'Something Else Entirely',
    ];
    const result = findTemplateRepetition(headlines);
    assert.ok(result);
    assert.equal(result.prefix, 'grow your');
    assert.equal(result.count, 3);
  });

  test('does not flag a genuinely diverse set', () => {
    const headlines = [
      'Digital Marketing Experts',
      'Grow Qualified Leads Today',
      'Turn Clicks Into Customers',
      'Data Driven Marketing Team',
      'Get Your Free Consultation',
    ];
    assert.equal(findTemplateRepetition(headlines), null);
  });

  test('returns null for fewer than 4 texts (too small to judge)', () => {
    assert.equal(findTemplateRepetition(['A B C', 'A B D', 'A B E']), null);
  });
});

describe('validateCreativeQuality', () => {
  function adGroup({ headlines, descriptions, keywords = [{ text: 'digital marketing agency', matchType: 'PHRASE' }] }) {
    return {
      id: 'ag1',
      name: 'Test Group',
      keywords,
      ads: [{ headlines: headlines.map((text) => ({ text })), descriptions: descriptions.map((text) => ({ text })) }],
    };
  }

  const GOOD_HEADLINES = [
    'Digital Marketing Agency', 'Digital Marketing Experts', 'Grow Qualified Leads Today',
    'Turn Clicks Into Customers', 'Data Driven Marketing Team', 'Get Your Free Consultation',
    'Boost Your Online Presence', 'Trusted Marketing Partner', 'Expand Your Customer Base',
    'Increase Website Conversions', 'Talk To Our Strategists', 'Custom Marketing Plans',
  ];
  const GOOD_DESCRIPTIONS = [
    'Digital marketing services for growing businesses. Talk to our team today.',
    'SEO, ads and online marketing focused on qualified business leads.',
    'Data driven campaigns designed to turn visitors into paying customers.',
    'Custom strategies built around your goals, budget and audience.',
  ];

  test('a fully diverse, well-covered ad group passes with zero issues', () => {
    const result = validateCreativeQuality({ adGroups: [adGroup({ headlines: GOOD_HEADLINES, descriptions: GOOD_DESCRIPTIONS })] });
    assert.equal(result.valid, true);
    assert.equal(result.issues.length, 0);
    assert.equal(result.metrics.totalHeadlines, 12);
    assert.equal(result.metrics.totalDescriptions, 4);
  });

  test('too few headlines is flagged (below headlinesQualityMin)', () => {
    const result = validateCreativeQuality({ adGroups: [adGroup({ headlines: GOOD_HEADLINES.slice(0, 5), descriptions: GOOD_DESCRIPTIONS })] });
    assert.equal(result.valid, false);
    assert.ok(result.issues.some((i) => i.code === 'TOO_FEW_HEADLINES'));
  });

  test('too few descriptions is flagged', () => {
    const result = validateCreativeQuality({ adGroups: [adGroup({ headlines: GOOD_HEADLINES, descriptions: GOOD_DESCRIPTIONS.slice(0, 2) })] });
    assert.equal(result.valid, false);
    assert.ok(result.issues.some((i) => i.code === 'TOO_FEW_DESCRIPTIONS'));
  });

  test('near-duplicate headlines are flagged even with enough total count', () => {
    const headlines = [...GOOD_HEADLINES.slice(0, 10), 'Grow Your Business Online', 'Grow Your Business Online Today'];
    const result = validateCreativeQuality({ adGroups: [adGroup({ headlines, descriptions: GOOD_DESCRIPTIONS })] });
    assert.ok(result.issues.some((i) => i.code === 'DUPLICATE_HEADLINES'));
  });

  test('template repetition is flagged (same 2-word prefix on >30% of headlines)', () => {
    const headlines = [
      'Grow Your Business Online', 'Grow Your Business Digitally', 'Grow Your Business With Marketing',
      'Talk To Our Strategists', 'Custom Marketing Plans Today', 'Reach More Local Customers',
    ];
    const result = validateCreativeQuality({ adGroups: [adGroup({ headlines, descriptions: GOOD_DESCRIPTIONS })] });
    assert.ok(result.issues.some((i) => i.code === 'TEMPLATE_REPETITION'));
  });

  test('missing keyword coverage is flagged when no headline contains any top-5 keyword', () => {
    const headlines = GOOD_HEADLINES.map((h) => h.replace(/Marketing/g, 'Promotion'));
    const result = validateCreativeQuality({
      adGroups: [adGroup({ headlines, descriptions: GOOD_DESCRIPTIONS, keywords: [{ text: 'digital marketing agency', matchType: 'PHRASE' }] })],
    });
    assert.ok(result.issues.some((i) => i.code === 'NO_KEYWORD_COVERAGE'));
  });

  test('keyword coverage does not require every keyword to appear (no stuffing forced)', () => {
    const result = validateCreativeQuality({
      adGroups: [adGroup({
        headlines: GOOD_HEADLINES,
        descriptions: GOOD_DESCRIPTIONS,
        keywords: [
          { text: 'digital marketing agency', matchType: 'PHRASE' },
          { text: 'something totally unrelated to any headline', matchType: 'BROAD' },
        ],
      })],
    });
    assert.equal(result.valid, true);
  });
});

describe('validateCampaignAssets', () => {
  const trustedUrls = ['https://acme.example.com/contact', 'https://acme.example.com/services'];

  test('well-formed sitelinks/callouts/snippets pass with zero issues', () => {
    const result = validateCampaignAssets({
      sitelinks: [
        { text: 'Contact Us', finalUrl: trustedUrls[0] },
        { text: 'Our Services', finalUrl: trustedUrls[1] },
      ],
      callouts: [{ text: 'Data Driven Strategy' }, { text: 'Custom Marketing Plans' }],
      structuredSnippets: [{ header: 'Service catalog', values: ['SEO', 'PPC', 'Social Media'] }],
    }, { trustedUrls });
    assert.equal(result.valid, true);
    assert.equal(result.issues.length, 0);
  });

  test('a sitelink URL outside the trusted list is rejected (UNTRUSTED_URL)', () => {
    const result = validateCampaignAssets({
      sitelinks: [{ text: 'Contact Us', finalUrl: 'https://not-verified.example.com/' }],
    }, { trustedUrls });
    assert.equal(result.valid, false);
    assert.ok(result.issues.some((i) => i.code === 'UNTRUSTED_URL'));
  });

  test('missing trustedUrls option rejects every sitelink by default (never optional-away)', () => {
    const result = validateCampaignAssets({ sitelinks: [{ text: 'Contact Us', finalUrl: trustedUrls[0] }] });
    assert.equal(result.valid, false);
    assert.ok(result.issues.some((i) => i.code === 'UNTRUSTED_URL'));
  });

  test('duplicate sitelink URLs are rejected', () => {
    const result = validateCampaignAssets({
      sitelinks: [
        { text: 'Contact Us', finalUrl: trustedUrls[0] },
        { text: 'Get In Touch', finalUrl: trustedUrls[0] },
      ],
    }, { trustedUrls });
    assert.ok(result.issues.some((i) => i.code === 'DUPLICATE_SITELINK_URL'));
  });

  test('an invalid structured-snippet header is rejected', () => {
    const result = validateCampaignAssets({
      structuredSnippets: [{ header: 'Not A Real Header', values: ['A', 'B', 'C'] }],
    });
    assert.ok(result.issues.some((i) => i.code === 'INVALID_HEADER'));
  });

  test('too few structured-snippet values is rejected', () => {
    const result = validateCampaignAssets({
      structuredSnippets: [{ header: 'Service catalog', values: ['A'] }],
    });
    assert.ok(result.issues.some((i) => i.code === 'TOO_FEW_VALUES'));
  });

  test('near-duplicate callouts are rejected', () => {
    const result = validateCampaignAssets({
      callouts: [{ text: 'Data Driven Marketing Strategy' }, { text: 'Data Driven Marketing Strategy Today' }],
    });
    assert.ok(result.issues.some((i) => i.code === 'NEAR_DUPLICATE_CALLOUT'));
  });

  test('empty campaign object yields zero issues (all assets optional)', () => {
    const result = validateCampaignAssets({});
    assert.equal(result.valid, true);
  });
});
