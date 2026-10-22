import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import campaignDraftService from './campaignDraftService.js';
import AiCampaignDraft from '../model/AiCampaignDraft.js';

let mongoAvailable = false;

before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
  } catch {
    mongoAvailable = false;
  }
});

after(async () => {
  if (mongoAvailable) await mongoose.connection.close();
});

function baseCampaign(overrides = {}) {
  return {
    name: 'Acme Campaign',
    objective: 'LEADS',
    dailyBudget: 500,
    currency: 'USD',
    biddingStrategy: 'MAXIMIZE_CONVERSIONS',
    locations: [{ name: 'Nashik', countryCode: 'IN', type: 'CITY' }],
    ...overrides,
  };
}

describe('campaignDraftService — sitelinks/callouts/structuredSnippets round-trip (Phase 9)', () => {
  let projectId;
  let userId;

  beforeEach(() => {
    projectId = new mongoose.Types.ObjectId();
    userId = new mongoose.Types.ObjectId();
  });

  test('createDraft persists well-formed campaign-level assets', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const draft = await campaignDraftService.createDraft({
      projectId,
      userId,
      googleAdsCustomerId: '1234567890',
      campaign: baseCampaign({
        sitelinks: [{ text: 'Contact Us', finalUrl: 'https://acme.example.com/contact' }],
        callouts: [{ text: 'Data Driven Strategy' }],
        structuredSnippets: [{ header: 'Service catalog', values: ['SEO', 'PPC', 'Social Media'] }],
      }),
      adGroups: [],
    });

    assert.equal(draft.campaign.sitelinks.length, 1);
    assert.equal(draft.campaign.sitelinks[0].text, 'Contact Us');
    assert.ok(draft.campaign.sitelinks[0].id); // stable id auto-assigned
    assert.equal(draft.campaign.callouts.length, 1);
    assert.equal(draft.campaign.structuredSnippets[0].values.length, 3);

    // Persisted for real, not just in the returned object.
    const reloaded = await AiCampaignDraft.findById(draft._id);
    assert.equal(reloaded.campaign.sitelinks.length, 1);
  });

  test('createDraft defaults every asset array to [] when omitted', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const draft = await campaignDraftService.createDraft({
      projectId, userId, googleAdsCustomerId: '1234567890', campaign: baseCampaign(), adGroups: [],
    });
    assert.deepEqual(draft.campaign.sitelinks, []);
    assert.deepEqual(draft.campaign.callouts, []);
    assert.deepEqual(draft.campaign.structuredSnippets, []);
  });

  test('updateDraft REPLACES the whole campaign sub-document — omitting assets in the payload clears them', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const draft = await campaignDraftService.createDraft({
      projectId,
      userId,
      googleAdsCustomerId: '1234567890',
      campaign: baseCampaign({ sitelinks: [{ text: 'Contact Us', finalUrl: 'https://acme.example.com/contact' }] }),
      adGroups: [],
    });
    assert.equal(draft.campaign.sitelinks.length, 1);

    // A caller that forgets to carry assets through (the exact bug this
    // test guards the FRONTEND against — see aiCampaignWorkspace.js) drops
    // them. This is expected backend behavior (campaign is always a full
    // replace) — the frontend fix is what prevents it from happening
    // silently on a real user's save.
    const updated = await campaignDraftService.updateDraft(draft._id, {
      updates: { campaign: baseCampaign({ name: 'Renamed Campaign' }) },
      userId,
    });
    assert.deepEqual(updated.campaign.sitelinks, []);
  });

  test('updateDraft round-trips assets when the caller includes them (the frontend now does this)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const draft = await campaignDraftService.createDraft({
      projectId, userId, googleAdsCustomerId: '1234567890', campaign: baseCampaign(), adGroups: [],
    });

    const updated = await campaignDraftService.updateDraft(draft._id, {
      updates: {
        campaign: baseCampaign({
          sitelinks: [{ text: 'Contact Us', finalUrl: 'https://acme.example.com/contact' }],
          callouts: [{ text: 'Data Driven Strategy' }],
        }),
      },
      userId,
    });
    assert.equal(updated.campaign.sitelinks.length, 1);
    assert.equal(updated.campaign.callouts.length, 1);
  });

  test('_internals.normalizeSitelink allow-lists fields (mass-assignment defence)', () => {
    const result = campaignDraftService._internals.normalizeSitelink({
      text: '  Contact Us  ',
      finalUrl: 'https://acme.example.com/contact',
      __proto__: { polluted: true },
      status: 'ENABLED', // not a real sitelink field — must be dropped
    });
    assert.equal(result.text, 'Contact Us');
    assert.equal(result.finalUrl, 'https://acme.example.com/contact');
    assert.equal(result.status, undefined);
    assert.equal(({}).polluted, undefined); // no prototype pollution
  });

  test('_internals.normalizeStructuredSnippet drops empty values', () => {
    const result = campaignDraftService._internals.normalizeStructuredSnippet({
      header: 'Service catalog',
      values: ['SEO', '', '  ', 'PPC'],
    });
    assert.deepEqual(result.values, ['SEO', 'PPC']);
  });
});
