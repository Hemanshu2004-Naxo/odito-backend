import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { buildGoogleAdsPublishPlan, summarizePlan, PublishPlanError } from './publishPlanBuilder.js';

function baseDraft(overrides = {}) {
  return {
    campaign: {
      name: 'Acme Campaign',
      dailyBudgetMicros: 5_000_000,
      biddingStrategy: 'MAXIMIZE_CONVERSIONS',
      ...overrides.campaign,
    },
    adGroups: overrides.adGroups ?? [
      {
        id: 'ag1',
        name: 'Group 1',
        keywords: [{ text: 'digital marketing', matchType: 'PHRASE' }],
        negativeKeywords: [],
        ads: [{
          id: 'ad1',
          finalUrl: 'https://acme.example.com/',
          headlines: [{ text: 'A' }, { text: 'B' }, { text: 'C' }],
          descriptions: [{ text: 'D' }, { text: 'E' }],
        }],
      },
    ],
  };
}

const account = { customerId: '1234567890' };
const targeting = { locations: [{ resourceName: 'geoTargetConstants/1' }], languages: [{ resourceName: 'languageConstants/1000' }] };

describe('buildGoogleAdsPublishPlan — campaign-level assets', () => {
  test('maps well-formed sitelinks/callouts/structured snippets into the plan', () => {
    const draft = baseDraft({
      campaign: {
        sitelinks: [
          { id: 's1', text: 'Contact Us', finalUrl: 'https://acme.example.com/contact' },
          { id: 's2', text: 'Our Services', description1: 'See what we offer', finalUrl: 'https://acme.example.com/services' },
        ],
        callouts: [{ id: 'c1', text: 'Data Driven Strategy' }],
        structuredSnippets: [{ id: 'sn1', header: 'Service catalog', values: ['SEO', 'PPC', 'Social Media'] }],
      },
    });
    const plan = buildGoogleAdsPublishPlan(draft, account, targeting);
    assert.equal(plan.assets.sitelinks.length, 2);
    assert.equal(plan.assets.sitelinks[0].finalUrl, 'https://acme.example.com/contact');
    assert.equal(plan.assets.callouts.length, 1);
    assert.equal(plan.assets.structuredSnippets[0].values.length, 3);
  });

  test('a campaign with no assets still builds a valid plan (all-optional)', () => {
    const plan = buildGoogleAdsPublishPlan(baseDraft(), account, targeting);
    assert.deepEqual(plan.assets, { sitelinks: [], callouts: [], structuredSnippets: [] });
  });

  test('rejects a sitelink with no text', () => {
    const draft = baseDraft({ campaign: { sitelinks: [{ id: 's1', text: '', finalUrl: 'https://acme.example.com/contact' }] } });
    assert.throws(() => buildGoogleAdsPublishPlan(draft, account, targeting), PublishPlanError);
  });

  test('rejects a sitelink with an invalid destination URL', () => {
    const draft = baseDraft({ campaign: { sitelinks: [{ id: 's1', text: 'Contact Us', finalUrl: 'not-a-url' }] } });
    assert.throws(() => buildGoogleAdsPublishPlan(draft, account, targeting), PublishPlanError);
  });

  test('rejects two sitelinks with the same text', () => {
    const draft = baseDraft({
      campaign: {
        sitelinks: [
          { id: 's1', text: 'Contact Us', finalUrl: 'https://acme.example.com/a' },
          { id: 's2', text: 'Contact Us', finalUrl: 'https://acme.example.com/b' },
        ],
      },
    });
    assert.throws(() => buildGoogleAdsPublishPlan(draft, account, targeting), PublishPlanError);
  });

  test('rejects two sitelinks pointing at the same URL', () => {
    const draft = baseDraft({
      campaign: {
        sitelinks: [
          { id: 's1', text: 'Contact Us', finalUrl: 'https://acme.example.com/a' },
          { id: 's2', text: 'Get In Touch', finalUrl: 'https://acme.example.com/a' },
        ],
      },
    });
    assert.throws(() => buildGoogleAdsPublishPlan(draft, account, targeting), PublishPlanError);
  });

  test('rejects a structured snippet with no header', () => {
    const draft = baseDraft({ campaign: { structuredSnippets: [{ id: 'sn1', header: '', values: ['A', 'B', 'C'] }] } });
    assert.throws(() => buildGoogleAdsPublishPlan(draft, account, targeting), PublishPlanError);
  });

  test('rejects a structured snippet with no values', () => {
    const draft = baseDraft({ campaign: { structuredSnippets: [{ id: 'sn1', header: 'Service catalog', values: [] }] } });
    assert.throws(() => buildGoogleAdsPublishPlan(draft, account, targeting), PublishPlanError);
  });

  test('rejects two structured snippets using the same header', () => {
    const draft = baseDraft({
      campaign: {
        structuredSnippets: [
          { id: 'sn1', header: 'Service catalog', values: ['A', 'B', 'C'] },
          { id: 'sn2', header: 'Service catalog', values: ['D', 'E', 'F'] },
        ],
      },
    });
    assert.throws(() => buildGoogleAdsPublishPlan(draft, account, targeting), PublishPlanError);
  });

  test('rejects a callout with no text', () => {
    const draft = baseDraft({ campaign: { callouts: [{ id: 'c1', text: '' }] } });
    assert.throws(() => buildGoogleAdsPublishPlan(draft, account, targeting), PublishPlanError);
  });

  test('summarizePlan reports asset counts', () => {
    const draft = baseDraft({
      campaign: {
        sitelinks: [{ id: 's1', text: 'Contact Us', finalUrl: 'https://acme.example.com/contact' }],
        callouts: [{ id: 'c1', text: 'Data Driven Strategy' }, { id: 'c2', text: 'Custom Plans' }],
        structuredSnippets: [{ id: 'sn1', header: 'Service catalog', values: ['A', 'B', 'C'] }],
      },
    });
    const plan = buildGoogleAdsPublishPlan(draft, account, targeting);
    const summary = summarizePlan(plan);
    assert.equal(summary.sitelinkCount, 1);
    assert.equal(summary.calloutCount, 2);
    assert.equal(summary.structuredSnippetCount, 1);
  });
});
