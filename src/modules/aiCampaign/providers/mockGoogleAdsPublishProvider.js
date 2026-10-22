/**
 * MockGoogleAdsPublishProvider — test double for the combined
 * (googleAdsPublishProvider + targetingResolver) surface campaignPublishService
 * injects as `provider`. Zero network, zero real Google Ads client. Every
 * Phase 6 test that reaches campaignPublishService.publishDraft() injects
 * one of these via setProviderOverride — no test may ever create a real
 * Google Ads campaign (spec §44).
 *
 * Configurable failure injection covers every scenario spec §36/§37 name:
 *   - `failAt: 'CAMPAIGN' | 'CAMPAIGN_CRITERIA' | 'AD_GROUPS' | 'KEYWORDS' | 'ADS' | 'ASSETS'`
 *     throws a definite (non-ambiguous) Google-style error at that step.
 *   - `ambiguousAt` — same, but the thrown error is classified ambiguous
 *     (isAmbiguousGoogleAdsFailure returns true), simulating a lost response
 *     after Google may have already processed the mutation.
 *   - `existingCampaignResourceName` / `existingAdGroupResourceNames` (a
 *     Map<name, resourceName>) simulate `findExistingXByName` already
 *     finding a resource — the reconciliation path.
 *   - `targetingError` / `buildCustomerError` simulate preflight failures.
 */
export class MockGoogleAdsPublishProvider {
  constructor(opts = {}) {
    this.opts = opts;
    this.calls = [];
    this._campaignSeq = 0;
    this._adGroupSeq = 0;
    this._criterionSeq = 0;
    this._adSeq = 0;
    this._assetSeq = 0;
  }

  _fail(step) {
    if (this.opts.failAt === step) {
      const err = new Error(`Mock Google Ads failure at ${step}`);
      err.errors = [{ error_code: { ads_api_error: 'MOCK' }, message: `Mock Google Ads failure at ${step}` }];
      throw err;
    }
    if (this.opts.ambiguousAt === step) {
      const err = new Error(`Mock ambiguous network failure at ${step}`);
      err.__ambiguous = true;
      throw err;
    }
  }

  isAmbiguousGoogleAdsFailure(err) {
    return err?.__ambiguous === true;
  }

  async buildPublishCustomer(googleConnection, { customerId }) {
    this.calls.push(['buildPublishCustomer', customerId]);
    if (this.opts.buildCustomerError) throw this.opts.buildCustomerError;
    return { __mock: true, customerId };
  }

  async resolveTargeting(customer, { locations = [], languages = [] }) {
    this.calls.push(['resolveTargeting', locations.length, languages.length]);
    if (this.opts.targetingError) throw this.opts.targetingError;
    return {
      locations: locations.map((l, i) => ({ ...l, resourceName: `geoTargetConstants/${9000 + i}` })),
      languages: languages.map((l, i) => ({ ...l, resourceName: `languageConstants/${1000 + i}` })),
    };
  }

  async findExistingCampaignByName(customer, name) {
    this.calls.push(['findExistingCampaignByName', name]);
    return this.opts.existingCampaignResourceName || null;
  }

  async findExistingAdGroupByName(customer, campaignResourceName, name) {
    this.calls.push(['findExistingAdGroupByName', name]);
    return this.opts.existingAdGroupResourceNames?.get(name) || null;
  }

  async createCampaignBudgetAndCampaign(customer, plan) {
    this.calls.push(['createCampaignBudgetAndCampaign', plan.campaign.name]);
    this._fail('CAMPAIGN');
    this._campaignSeq += 1;
    return {
      budgetResourceName: `customers/${plan.customerId}/campaignBudgets/${this._campaignSeq}`,
      campaignResourceName: `customers/${plan.customerId}/campaigns/${this._campaignSeq}`,
    };
  }

  async createCampaignCriteria(customer, campaignResourceName, plan) {
    this.calls.push(['createCampaignCriteria', plan.targeting.locations.length, plan.targeting.languages.length]);
    this._fail('CAMPAIGN_CRITERIA');
    const count = plan.targeting.locations.length + plan.targeting.languages.length;
    const results = [];
    for (let i = 0; i < count; i += 1) {
      this._criterionSeq += 1;
      results.push({ resource_name: `${campaignResourceName}~criteria~${this._criterionSeq}` });
    }
    return { results };
  }

  async createAdGroups(customer, campaignResourceName, plan) {
    this.calls.push(['createAdGroups', plan.adGroups.map((a) => a.name)]);
    this._fail('AD_GROUPS');
    return plan.adGroups.map((ag) => {
      this._adGroupSeq += 1;
      return { oditoId: ag.oditoId, resourceName: `${campaignResourceName.split('/campaigns/')[0]}/adGroups/${this._adGroupSeq}` };
    });
  }

  async createKeywordsAndNegatives(customer, adGroupResourceNameByOditoId, plan) {
    this.calls.push(['createKeywordsAndNegatives']);
    this._fail('KEYWORDS');
    const items = [];
    for (const ag of plan.adGroups) {
      for (const kw of ag.keywords) items.push({ adGroupOditoId: ag.oditoId, key: `${kw.text}|${kw.matchType}`, isNegative: false });
      for (const kw of ag.negativeKeywords) items.push({ adGroupOditoId: ag.oditoId, key: `${kw.text}|${kw.matchType}`, isNegative: true });
    }
    return items.map((item) => {
      this._criterionSeq += 1;
      return { ...item, resourceName: `${adGroupResourceNameByOditoId.get(item.adGroupOditoId)}~criteria~${this._criterionSeq}` };
    });
  }

  async createAds(customer, adGroupResourceNameByOditoId, plan) {
    this.calls.push(['createAds']);
    this._fail('ADS');
    const items = [];
    for (const ag of plan.adGroups) {
      for (const ad of ag.ads) items.push({ adGroupOditoId: ag.oditoId, oditoId: ad.oditoId });
    }
    return items.map((item) => {
      this._adSeq += 1;
      return { ...item, resourceName: `${adGroupResourceNameByOditoId.get(item.adGroupOditoId)}~ads~${this._adSeq}` };
    });
  }

  async createCampaignAssets(customer, campaignResourceName, plan) {
    this.calls.push(['createCampaignAssets']);
    this._fail('ASSETS');
    const items = [
      ...(plan.assets?.sitelinks || []).map((sl) => ({ oditoId: sl.oditoId, assetType: 'SITELINK' })),
      ...(plan.assets?.callouts || []).map((co) => ({ oditoId: co.oditoId, assetType: 'CALLOUT' })),
      ...(plan.assets?.structuredSnippets || []).map((sn) => ({ oditoId: sn.oditoId, assetType: 'STRUCTURED_SNIPPET' })),
    ];
    return items.map((item) => {
      this._assetSeq += 1;
      return {
        ...item,
        assetResourceName: `customers/${plan.customerId}/assets/${this._assetSeq}`,
        campaignAssetResourceName: `customers/${plan.customerId}/campaignAssets/${campaignResourceName.split('/campaigns/')[1]}~${this._assetSeq}~0`,
      };
    });
  }
}

export default MockGoogleAdsPublishProvider;
