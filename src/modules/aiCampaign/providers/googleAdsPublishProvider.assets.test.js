import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { enums } from 'google-ads-api';

import { createCampaignAssets } from './googleAdsPublishProvider.js';

/** A fake Customer handle recording every mutateResources call and returning a synthetic response. */
function fakeCustomer({ throwError } = {}) {
  const calls = [];
  return {
    calls,
    async mutateResources(operations) {
      calls.push(operations);
      if (throwError) throw throwError;
      const mutate_operation_responses = operations.map((op, i) => {
        if (op.entity === 'asset') return { asset_result: { resource_name: `customers/1234567890/assets/${i}` } };
        return { campaign_asset_result: { resource_name: `customers/1234567890/campaignAssets/${i}` } };
      });
      return { mutate_operation_responses };
    },
  };
}

const campaignResourceName = 'customers/1234567890/campaigns/1';

describe('createCampaignAssets', () => {
  test('returns [] and never calls mutateResources when there are no assets', async () => {
    const customer = fakeCustomer();
    const result = await createCampaignAssets(customer, campaignResourceName, { customerId: '1234567890', assets: { sitelinks: [], callouts: [], structuredSnippets: [] } });
    assert.deepEqual(result, []);
    assert.equal(customer.calls.length, 0);
  });

  test('builds one atomic asset+campaign_asset pair per sitelink/callout/snippet', async () => {
    const customer = fakeCustomer();
    const plan = {
      customerId: '1234567890',
      assets: {
        sitelinks: [{ oditoId: 's1', text: 'Contact Us', finalUrl: 'https://acme.example.com/contact', description1: null, description2: null }],
        callouts: [{ oditoId: 'c1', text: 'Data Driven Strategy' }],
        structuredSnippets: [{ oditoId: 'sn1', header: 'Service catalog', values: ['SEO', 'PPC'] }],
      },
    };
    const result = await createCampaignAssets(customer, campaignResourceName, plan);

    assert.equal(customer.calls.length, 1); // one atomic mutateResources batch
    const operations = customer.calls[0];
    assert.equal(operations.length, 6); // 3 assets x (asset + campaign_asset)
    assert.deepEqual(operations.map((o) => o.entity), ['asset', 'campaign_asset', 'asset', 'campaign_asset', 'asset', 'campaign_asset']);

    assert.equal(result.length, 3);
    const sitelinkResult = result.find((r) => r.oditoId === 's1');
    assert.equal(sitelinkResult.assetType, 'SITELINK');
    assert.ok(sitelinkResult.assetResourceName);
    assert.ok(sitelinkResult.campaignAssetResourceName);
  });

  test('sitelink asset resource carries link_text + final_urls + the correct field_type', async () => {
    const customer = fakeCustomer();
    const plan = {
      customerId: '1234567890',
      assets: { sitelinks: [{ oditoId: 's1', text: 'Contact Us', finalUrl: 'https://acme.example.com/contact', description1: null, description2: null }], callouts: [], structuredSnippets: [] },
    };
    await createCampaignAssets(customer, campaignResourceName, plan);

    const [assetOp, campaignAssetOp] = customer.calls[0];
    assert.equal(assetOp.resource.sitelink_asset.link_text, 'Contact Us');
    assert.deepEqual(assetOp.resource.final_urls, ['https://acme.example.com/contact']);
    assert.equal(campaignAssetOp.resource.field_type, enums.AssetFieldType.SITELINK);
    assert.equal(campaignAssetOp.resource.campaign, campaignResourceName);
    assert.equal(campaignAssetOp.resource.asset, assetOp.resource.resource_name); // links via the temp resource name
  });

  test('sitelink description1/description2 are included only when BOTH are present (Google requires both-or-neither)', async () => {
    const customer = fakeCustomer();
    const planBothMissing = { customerId: '1234567890', assets: { sitelinks: [{ oditoId: 's1', text: 'Contact Us', finalUrl: 'https://acme.example.com/', description1: null, description2: null }], callouts: [], structuredSnippets: [] } };
    await createCampaignAssets(customer, campaignResourceName, planBothMissing);
    assert.equal(customer.calls[0][0].resource.sitelink_asset.description1, undefined);

    const customer2 = fakeCustomer();
    const planOneOnly = { customerId: '1234567890', assets: { sitelinks: [{ oditoId: 's1', text: 'Contact Us', finalUrl: 'https://acme.example.com/', description1: 'Talk to us', description2: null }], callouts: [], structuredSnippets: [] } };
    await createCampaignAssets(customer2, campaignResourceName, planOneOnly);
    assert.equal(customer2.calls[0][0].resource.sitelink_asset.description1, undefined);
    assert.equal(customer2.calls[0][0].resource.sitelink_asset.description2, undefined);

    const customer3 = fakeCustomer();
    const planBoth = { customerId: '1234567890', assets: { sitelinks: [{ oditoId: 's1', text: 'Contact Us', finalUrl: 'https://acme.example.com/', description1: 'Talk to us', description2: 'Get a quote' }], callouts: [], structuredSnippets: [] } };
    await createCampaignAssets(customer3, campaignResourceName, planBoth);
    assert.equal(customer3.calls[0][0].resource.sitelink_asset.description1, 'Talk to us');
    assert.equal(customer3.calls[0][0].resource.sitelink_asset.description2, 'Get a quote');
  });

  test('callout asset resource carries callout_text + the correct field_type', async () => {
    const customer = fakeCustomer();
    const plan = { customerId: '1234567890', assets: { sitelinks: [], callouts: [{ oditoId: 'c1', text: 'Data Driven Strategy' }], structuredSnippets: [] } };
    await createCampaignAssets(customer, campaignResourceName, plan);
    const [assetOp, campaignAssetOp] = customer.calls[0];
    assert.equal(assetOp.resource.callout_asset.callout_text, 'Data Driven Strategy');
    assert.equal(campaignAssetOp.resource.field_type, enums.AssetFieldType.CALLOUT);
  });

  test('structured snippet asset resource carries header + values + the correct field_type', async () => {
    const customer = fakeCustomer();
    const plan = { customerId: '1234567890', assets: { sitelinks: [], callouts: [], structuredSnippets: [{ oditoId: 'sn1', header: 'Service catalog', values: ['SEO', 'PPC'] }] } };
    await createCampaignAssets(customer, campaignResourceName, plan);
    const [assetOp, campaignAssetOp] = customer.calls[0];
    assert.equal(assetOp.resource.structured_snippet_asset.header, 'Service catalog');
    assert.deepEqual(assetOp.resource.structured_snippet_asset.values, ['SEO', 'PPC']);
    assert.equal(campaignAssetOp.resource.field_type, enums.AssetFieldType.STRUCTURED_SNIPPET);
  });

  test('a Google Ads mutation failure is wrapped, never thrown raw', async () => {
    const rawError = new Error('mock google ads failure');
    const customer = fakeCustomer({ throwError: rawError });
    const plan = { customerId: '1234567890', assets: { sitelinks: [{ oditoId: 's1', text: 'Contact Us', finalUrl: 'https://acme.example.com/', description1: null, description2: null }], callouts: [], structuredSnippets: [] } };
    await assert.rejects(createCampaignAssets(customer, campaignResourceName, plan), (err) => {
      assert.notEqual(err, rawError); // wrapped, not the raw provider error
      return true;
    });
  });
});
