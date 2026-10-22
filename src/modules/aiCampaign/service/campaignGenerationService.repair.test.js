import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import { generateCampaign, CampaignGenerationError } from './campaignGenerationService.js';
import { MockClaudeCampaignProvider, nashikCampaignFixture, thinCampaignFixture } from '../providers/mockClaudeCampaignProvider.js';

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

const brief = {
  businessName: 'Acme Digital',
  businessDescription: 'A digital marketing agency helping local businesses grow online.',
  campaignGoal: 'LEADS',
  dailyBudget: 1000,
  currency: 'INR',
  landingPageUrl: 'https://acme.example.com/',
  location: { name: 'Nashik', countryCode: 'IN', type: 'CITY' },
};
const project = { project_name: 'Acme Digital', main_url: 'https://www.acme.example.com/' };

function args(provider) {
  return {
    projectId: new mongoose.Types.ObjectId().toString(),
    userId: new mongoose.Types.ObjectId().toString(),
    project,
    brief,
    googleAdsCustomerId: '1234567890',
    provider,
  };
}

describe('generateCampaign — bounded creative-quality repair loop (spec §20/§21)', () => {
  test('a campaign that already meets the quality bar reaches ready on the FIRST attempt (no repair)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const provider = new MockClaudeCampaignProvider({ parsed: nashikCampaignFixture() });
    const { draft, generation } = await generateCampaign(args(provider));

    assert.equal(draft.status, 'ready');
    assert.equal(generation.repairAttempts, 0);
    assert.equal(provider.calls.length, 1);
  });

  test('a thin first attempt is repaired: second call succeeds and reaches ready', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const provider = new MockClaudeCampaignProvider({
      parsedFactory: (callArgs) => (callArgs.user.includes('<previous_attempt_feedback>') ? nashikCampaignFixture() : thinCampaignFixture()),
    });
    const { draft, generation } = await generateCampaign(args(provider));

    assert.equal(draft.status, 'ready');
    assert.equal(generation.repairAttempts, 1);
    assert.equal(provider.calls.length, 2);
    // The repair feedback sent on the second call must be Odito's own
    // structured issue messages, not raw Claude output or user data.
    assert.ok(provider.calls[1].user.includes('TOO_FEW_HEADLINES') === false); // messages, not codes, are what's sent
    assert.ok(/headlines/i.test(provider.calls[1].user));
  });

  test('a persistently thin campaign exhausts the repair budget and fails with CREATIVE_QUALITY_INVALID', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const provider = new MockClaudeCampaignProvider({ parsed: thinCampaignFixture() }); // always thin, even after feedback
    await assert.rejects(
      generateCampaign(args(provider)),
      (err) => {
        assert.ok(err instanceof CampaignGenerationError);
        assert.equal(err.code, 'CREATIVE_QUALITY_INVALID');
        assert.equal(err.httpStatus, 422);
        return true;
      },
    );
    // 1 initial attempt + MAX_CREATIVE_REPAIR_ATTEMPTS (default 2) retries = 3 calls, never more (bounded, never infinite).
    assert.equal(provider.calls.length, 3);
  });

  test('a draft that exhausts repair is left in `failed`, never stuck in `generating`', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const { default: campaignDraftService } = await import('./campaignDraftService.js');
    const provider = new MockClaudeCampaignProvider({ parsed: thinCampaignFixture() });
    let failedDraftId = null;
    try {
      await generateCampaign(args(provider));
      assert.fail('expected generateCampaign to throw');
    } catch (err) {
      failedDraftId = err.draftId;
    }
    assert.ok(failedDraftId);
    const draft = await campaignDraftService.getDraft(failedDraftId);
    assert.equal(draft.status, 'failed');
  });

  test('a structurally invalid response (bad shape) is NEVER retried through the creative repair loop', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    // Missing required "objective"/keywords entirely -> fails Phase 1 shape
    // validation, a different failure class than "valid but thin".
    const provider = new MockClaudeCampaignProvider({ parsed: { campaign: {}, adGroups: [] } });
    await assert.rejects(
      generateCampaign(args(provider)),
      (err) => {
        assert.equal(err.code, 'CAMPAIGN_STRUCTURE_INVALID');
        return true;
      },
    );
    assert.equal(provider.calls.length, 1); // structural failures are not retried
  });
});
