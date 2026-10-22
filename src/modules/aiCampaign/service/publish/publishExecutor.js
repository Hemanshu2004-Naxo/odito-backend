/**
 * publishExecutor — Phase 6. Drives one publish plan through the Google Ads
 * mutation boundary (`provider`, normally googleAdsPublishProvider.js) in
 * the fixed dependency order from spec §14, persisting every confirmed
 * resource mapping IMMEDIATELY via publishAttemptService (spec §15/§42 —
 * durable, incremental, crash-safe).
 *
 * RECONCILIATION (spec §8/§17/§18/§42): before doing any work, every step
 * first checks whether it was already completed on a PRIOR attempt at this
 * same draft version (the attempt's own persisted `resources[]` — see
 * `alreadyRecorded`). For the two levels Google Ads enforces a unique name
 * on (CAMPAIGN, AD_GROUP), it additionally asks Google directly by name
 * (`provider.findExistingCampaignByName`/`findExistingAdGroupByName`)
 * before creating — this is what makes a retry after an ambiguous network
 * failure safe: even if this exact process never recorded the resource it
 * just created, the NEXT attempt will find it by name instead of creating a
 * duplicate. Keywords/negative keywords/ads are not globally unique in
 * Google Ads, so they rely on the persisted mapping alone; if a failure at
 * that level is ambiguous, this function stops the whole run rather than
 * guessing (see the thrown `PublishExecutionError`'s `partial` flag).
 *
 * Never calls anything but the injected `provider` — no direct Google Ads
 * import here, so this file can be fully unit-tested with a mock provider
 * and zero network/Mongo.
 */

export class PublishExecutionError extends Error {
  constructor(message, { code, partial, cause } = {}) {
    super(message);
    this.name = 'PublishExecutionError';
    this.code = code || 'GOOGLE_UNKNOWN';
    this.partial = !!partial;
    this.cause = cause;
  }
}

function alreadyRecorded(attempt, type, oditoId) {
  return (attempt.resources || []).find((r) => r.type === type && r.oditoId === oditoId) || null;
}

function hasAnyResources(attempt) {
  return (attempt.resources || []).length > 0;
}

/**
 * @param {object} args
 * @param {object} args.provider - googleAdsPublishProvider-shaped object (or a mock)
 * @param {object} args.publishAttemptService - injected so this stays Mongo-free at the call boundary in tests
 * @param {object} args.customer - opaque handle from provider.buildPublishCustomer
 * @param {object} args.plan - output of buildGoogleAdsPublishPlan
 * @param {object} args.attempt - the current (already `publishing`) AiCampaignPublishAttempt, kept up to date as resources are recorded
 * @returns {Promise<{campaignResourceName: string}>}
 */
export async function executePublishPlan({ provider, publishAttemptService, customer, plan, attempt }) {
  let current = attempt;

  async function record(entry) {
    current = await publishAttemptService.recordResource(current._id, entry);
    return current;
  }

  // ── Step 1: campaign budget + campaign (atomic pair) ─────────────────────
  let campaignEntry = alreadyRecorded(current, 'CAMPAIGN', null);
  let campaignResourceName = campaignEntry?.googleResourceName || null;

  if (!campaignResourceName) {
    try {
      const existing = await provider.findExistingCampaignByName(customer, plan.campaign.name);
      if (existing) {
        campaignResourceName = existing;
        await record({ type: 'CAMPAIGN', googleResourceName: existing });
      } else {
        const created = await provider.createCampaignBudgetAndCampaign(customer, plan);
        await record({ type: 'CAMPAIGN_BUDGET', googleResourceName: created.budgetResourceName });
        await record({ type: 'CAMPAIGN', googleResourceName: created.campaignResourceName });
        campaignResourceName = created.campaignResourceName;
      }
    } catch (err) {
      throw new PublishExecutionError('Failed to create the campaign.', {
        code: provider.isAmbiguousGoogleAdsFailure(err) ? 'GOOGLE_NETWORK' : classifyToPublishCode(err),
        partial: hasAnyResources(current),
        cause: err,
      });
    }
  }

  // ── Step 2: campaign criteria (locations + languages) ────────────────────
  const targetingItems = [
    ...plan.targeting.locations.map((l) => ({ kind: 'CAMPAIGN_CRITERION_LOCATION', resourceName: l.resourceName })),
    ...plan.targeting.languages.map((l) => ({ kind: 'CAMPAIGN_CRITERION_LANGUAGE', resourceName: l.resourceName })),
  ];
  const remainingTargeting = targetingItems.filter((t) => !alreadyRecorded(current, t.kind, t.resourceName));
  if (remainingTargeting.length > 0) {
    try {
      const planForStep = {
        targeting: {
          locations: remainingTargeting.filter((t) => t.kind === 'CAMPAIGN_CRITERION_LOCATION').map((t) => ({ resourceName: t.resourceName })),
          languages: remainingTargeting.filter((t) => t.kind === 'CAMPAIGN_CRITERION_LANGUAGE').map((t) => ({ resourceName: t.resourceName })),
        },
      };
      await provider.createCampaignCriteria(customer, campaignResourceName, planForStep);
      for (const t of remainingTargeting) {
        // eslint-disable-next-line no-await-in-loop -- small, bounded list (locations+languages per campaign); sequential keeps the persisted record strictly ordered
        await record({ type: t.kind, oditoId: t.resourceName, googleResourceName: t.resourceName });
      }
    } catch (err) {
      throw new PublishExecutionError('Failed to set the campaign\'s target locations/languages.', {
        code: provider.isAmbiguousGoogleAdsFailure(err) ? 'GOOGLE_NETWORK' : classifyToPublishCode(err),
        partial: hasAnyResources(current),
        cause: err,
      });
    }
  }

  // ── Step 3: ad groups ──────────────────────────────────────────────────
  const adGroupResourceNameByOditoId = new Map();
  for (const r of current.resources) {
    if (r.type === 'AD_GROUP') adGroupResourceNameByOditoId.set(r.oditoId, r.googleResourceName);
  }
  const missingAdGroups = plan.adGroups.filter((ag) => !adGroupResourceNameByOditoId.has(ag.oditoId));
  if (missingAdGroups.length > 0) {
    const stillMissing = [];
    for (const ag of missingAdGroups) {
      try {
        // eslint-disable-next-line no-await-in-loop -- ad-group-name reconciliation must happen one at a time (each check is independent, but the campaign has at most CAMPAIGN_LIMITS.adGroupsMax=20 ad groups, so this stays bounded)
        const existing = await provider.findExistingAdGroupByName(customer, campaignResourceName, ag.name);
        if (existing) {
          adGroupResourceNameByOditoId.set(ag.oditoId, existing);
          // eslint-disable-next-line no-await-in-loop
          await record({ type: 'AD_GROUP', oditoId: ag.oditoId, googleResourceName: existing });
        } else {
          stillMissing.push(ag);
        }
      } catch (err) {
        throw new PublishExecutionError('Failed to check for an existing ad group before creating it.', {
          code: provider.isAmbiguousGoogleAdsFailure(err) ? 'GOOGLE_NETWORK' : classifyToPublishCode(err),
          partial: hasAnyResources(current),
          cause: err,
        });
      }
    }

    if (stillMissing.length > 0) {
      try {
        const created = await provider.createAdGroups(customer, campaignResourceName, { adGroups: stillMissing });
        for (const c of created) {
          adGroupResourceNameByOditoId.set(c.oditoId, c.resourceName);
          // eslint-disable-next-line no-await-in-loop -- ordering preserved for a deterministic recorded list; bounded by CAMPAIGN_LIMITS.adGroupsMax
          await record({ type: 'AD_GROUP', oditoId: c.oditoId, googleResourceName: c.resourceName });
        }
      } catch (err) {
        throw new PublishExecutionError('Failed to create the ad groups.', {
          code: provider.isAmbiguousGoogleAdsFailure(err) ? 'GOOGLE_NETWORK' : classifyToPublishCode(err),
          partial: hasAnyResources(current),
          cause: err,
        });
      }
    }
  }

  // ── Step 4: keywords + negative keywords ─────────────────────────────────
  const remainingAdGroupsForKeywords = plan.adGroups
    .map((ag) => ({
      ...ag,
      keywords: ag.keywords.filter((k) => !alreadyRecorded(current, 'KEYWORD', `${ag.oditoId}::${k.text}|${k.matchType}`)),
      negativeKeywords: ag.negativeKeywords.filter((k) => !alreadyRecorded(current, 'NEGATIVE_KEYWORD', `${ag.oditoId}::${k.text}|${k.matchType}`)),
    }))
    .filter((ag) => ag.keywords.length > 0 || ag.negativeKeywords.length > 0);

  if (remainingAdGroupsForKeywords.length > 0) {
    try {
      const created = await provider.createKeywordsAndNegatives(customer, adGroupResourceNameByOditoId, { adGroups: remainingAdGroupsForKeywords });
      for (const c of created) {
        // eslint-disable-next-line no-await-in-loop -- bounded by CAMPAIGN_LIMITS (<=20 ad groups x <=100 keywords+negatives)
        await record({
          type: c.isNegative ? 'NEGATIVE_KEYWORD' : 'KEYWORD',
          oditoId: `${c.adGroupOditoId}::${c.key}`,
          parentOditoId: c.adGroupOditoId,
          googleResourceName: c.resourceName,
        });
      }
    } catch (err) {
      throw new PublishExecutionError('Failed to create keywords/negative keywords.', {
        code: provider.isAmbiguousGoogleAdsFailure(err) ? 'GOOGLE_NETWORK' : classifyToPublishCode(err),
        partial: hasAnyResources(current),
        cause: err,
      });
    }
  }

  // ── Step 5: responsive search ads ─────────────────────────────────────────
  const remainingAdGroupsForAds = plan.adGroups
    .map((ag) => ({ ...ag, ads: ag.ads.filter((ad) => !alreadyRecorded(current, 'AD', ad.oditoId)) }))
    .filter((ag) => ag.ads.length > 0);

  if (remainingAdGroupsForAds.length > 0) {
    try {
      const created = await provider.createAds(customer, adGroupResourceNameByOditoId, { adGroups: remainingAdGroupsForAds });
      for (const c of created) {
        // eslint-disable-next-line no-await-in-loop -- bounded by CAMPAIGN_LIMITS (<=20 ad groups x <=3 ads)
        await record({ type: 'AD', oditoId: c.oditoId, parentOditoId: c.adGroupOditoId, googleResourceName: c.resourceName });
      }
    } catch (err) {
      throw new PublishExecutionError('Failed to create the ads.', {
        code: provider.isAmbiguousGoogleAdsFailure(err) ? 'GOOGLE_NETWORK' : classifyToPublishCode(err),
        partial: hasAnyResources(current),
        cause: err,
      });
    }
  }

  // ── Step 6: campaign-level extension assets (sitelinks/callouts/structured
  // snippets — Phase 9, RSA/Ad-Strength quality work). Not globally unique in
  // Google Ads (unlike CAMPAIGN/AD_GROUP names), so — like keywords/ads —
  // reconciliation relies solely on this attempt's own persisted `resources[]`,
  // never a by-name lookup against Google. All-optional: an empty plan.assets
  // is a normal, fully-valid campaign. ──────────────────────────────────────
  const remainingSitelinks = (plan.assets?.sitelinks || []).filter((sl) => !alreadyRecorded(current, 'SITELINK', sl.oditoId));
  const remainingCallouts = (plan.assets?.callouts || []).filter((co) => !alreadyRecorded(current, 'CALLOUT', co.oditoId));
  const remainingSnippets = (plan.assets?.structuredSnippets || []).filter((sn) => !alreadyRecorded(current, 'STRUCTURED_SNIPPET', sn.oditoId));

  if (remainingSitelinks.length > 0 || remainingCallouts.length > 0 || remainingSnippets.length > 0) {
    try {
      const created = await provider.createCampaignAssets(customer, campaignResourceName, {
        customerId: plan.customerId,
        assets: { sitelinks: remainingSitelinks, callouts: remainingCallouts, structuredSnippets: remainingSnippets },
      });
      for (const c of created) {
        // eslint-disable-next-line no-await-in-loop -- bounded by ASSET_TARGETS (<=6 sitelinks + <=4 callouts + <=2 snippets per campaign)
        await record({ type: c.assetType, oditoId: c.oditoId, googleResourceName: c.assetResourceName });
      }
    } catch (err) {
      throw new PublishExecutionError('Failed to create the campaign\'s sitelinks/callouts/structured snippets.', {
        code: provider.isAmbiguousGoogleAdsFailure(err) ? 'GOOGLE_NETWORK' : classifyToPublishCode(err),
        partial: hasAnyResources(current),
        cause: err,
      });
    }
  }

  return { campaignResourceName, attempt: current };
}

/** Maps a wrapped Google Ads error (.category from classifyGoogleAdsError, via wrapGoogleAdsError) onto Phase 6's own PUBLISH_ERROR_CODES. */
function classifyToPublishCode(err) {
  switch (err?.category) {
    case 'quota': return 'GOOGLE_QUOTA';
    case 'authentication':
    case 'authorization': return 'AUTHORIZATION_FAILED';
    case 'invalid_request':
    case 'invalid_customer': return 'GOOGLE_VALIDATION';
    case 'internal': return 'GOOGLE_NETWORK';
    default: return 'GOOGLE_UNKNOWN';
  }
}

export default { executePublishPlan, PublishExecutionError };
