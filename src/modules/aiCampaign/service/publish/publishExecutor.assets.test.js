import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { executePublishPlan, PublishExecutionError } from './publishExecutor.js';
import { MockGoogleAdsPublishProvider } from '../../providers/mockGoogleAdsPublishProvider.js';

function fakePublishAttemptService(initialResources = []) {
  const resources = [...initialResources];
  return {
    resources,
    recordResource: async (id, entry) => {
      resources.push(entry);
      return { _id: id, resources };
    },
  };
}

const basePlan = {
  customerId: '1234567890',
  campaign: { name: 'Acme Campaign', biddingField: 'maximize_conversions', biddingValue: {} },
  budget: { name: 'Acme Campaign Budget', amountMicros: 5_000_000 },
  targeting: { locations: [{ resourceName: 'geoTargetConstants/1' }], languages: [{ resourceName: 'languageConstants/1000' }] },
  adGroups: [
    {
      oditoId: 'ag1',
      name: 'Group 1',
      keywords: [{ text: 'digital marketing', matchType: 'PHRASE' }],
      negativeKeywords: [],
      ads: [{ oditoId: 'ad1', finalUrl: 'https://acme.example.com/', path1: null, path2: null, headlines: [{ text: 'A' }, { text: 'B' }, { text: 'C' }], descriptions: [{ text: 'D' }, { text: 'E' }] }],
    },
  ],
  assets: {
    sitelinks: [{ oditoId: 's1', text: 'Contact Us', finalUrl: 'https://acme.example.com/contact', description1: null, description2: null }],
    callouts: [{ oditoId: 'c1', text: 'Data Driven Strategy' }],
    structuredSnippets: [{ oditoId: 'sn1', header: 'Service catalog', values: ['SEO', 'PPC'] }],
  },
};

describe('executePublishPlan — Step 6 (campaign assets)', () => {
  test('creates and records sitelinks/callouts/structured snippets', async () => {
    const provider = new MockGoogleAdsPublishProvider({});
    const publishAttemptService = fakePublishAttemptService();
    const attempt = { _id: 'attempt1', resources: [] };

    await executePublishPlan({ provider, publishAttemptService, customer: {}, plan: basePlan, attempt });

    const assetResources = publishAttemptService.resources.filter((r) => ['SITELINK', 'CALLOUT', 'STRUCTURED_SNIPPET'].includes(r.type));
    assert.equal(assetResources.length, 3);
    assert.ok(assetResources.find((r) => r.type === 'SITELINK' && r.oditoId === 's1'));
    assert.ok(assetResources.find((r) => r.type === 'CALLOUT' && r.oditoId === 'c1'));
    assert.ok(assetResources.find((r) => r.type === 'STRUCTURED_SNIPPET' && r.oditoId === 'sn1'));
  });

  test('a campaign with no assets skips Step 6 entirely (no provider call)', async () => {
    const provider = new MockGoogleAdsPublishProvider({});
    const publishAttemptService = fakePublishAttemptService();
    const attempt = { _id: 'attempt1', resources: [] };
    const plan = { ...basePlan, assets: { sitelinks: [], callouts: [], structuredSnippets: [] } };

    await executePublishPlan({ provider, publishAttemptService, customer: {}, plan, attempt });

    assert.ok(!provider.calls.some((c) => c[0] === 'createCampaignAssets'));
  });

  test('reconciliation: an already-recorded asset is never re-created on retry', async () => {
    const provider = new MockGoogleAdsPublishProvider({});
    const alreadyRecorded = [
      { type: 'CAMPAIGN', oditoId: null, googleResourceName: 'customers/1234567890/campaigns/1' },
      { type: 'CAMPAIGN_CRITERION_LOCATION', oditoId: 'geoTargetConstants/1', googleResourceName: 'geoTargetConstants/1' },
      { type: 'CAMPAIGN_CRITERION_LANGUAGE', oditoId: 'languageConstants/1000', googleResourceName: 'languageConstants/1000' },
      { type: 'AD_GROUP', oditoId: 'ag1', googleResourceName: 'customers/1234567890/adGroups/1' },
      { type: 'KEYWORD', oditoId: 'ag1::digital marketing|PHRASE', parentOditoId: 'ag1', googleResourceName: 'customers/1234567890/adGroups/1~criteria~1' },
      { type: 'AD', oditoId: 'ad1', parentOditoId: 'ag1', googleResourceName: 'customers/1234567890/adGroups/1~ads~1' },
      { type: 'SITELINK', oditoId: 's1', googleResourceName: 'customers/1234567890/assets/9' },
    ];
    const publishAttemptService = fakePublishAttemptService(alreadyRecorded);
    const attempt = { _id: 'attempt1', resources: alreadyRecorded };

    await executePublishPlan({ provider, publishAttemptService, customer: {}, plan: basePlan, attempt });

    const createAssetsCalls = provider.calls.filter((c) => c[0] === 'createCampaignAssets');
    assert.equal(createAssetsCalls.length, 1); // only callout + snippet remained to create
    const sitelinkRows = publishAttemptService.resources.filter((r) => r.type === 'SITELINK');
    assert.equal(sitelinkRows.length, 1); // never duplicated
  });

  test('a failure creating assets throws PublishExecutionError with partial=true (earlier resources exist)', async () => {
    const provider = new MockGoogleAdsPublishProvider({ failAt: 'ASSETS' });
    const publishAttemptService = fakePublishAttemptService();
    const attempt = { _id: 'attempt1', resources: [] };

    await assert.rejects(
      executePublishPlan({ provider, publishAttemptService, customer: {}, plan: basePlan, attempt }),
      (err) => {
        assert.ok(err instanceof PublishExecutionError);
        assert.equal(err.partial, true); // campaign/ad group/ad resources were already recorded before Step 6
        return true;
      },
    );
  });
});
