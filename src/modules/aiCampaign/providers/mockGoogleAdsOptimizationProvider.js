/**
 * MockGoogleAdsOptimizationProvider — test double for
 * googleAdsOptimizationProvider.js. Zero network, zero real Google Ads
 * client. Every Phase 7 test that reaches campaignOptimizationService's
 * execution path injects one of these via setProviderOverride — no test
 * may ever mutate a real Google Ads account.
 *
 * `currentStates` lets a test simulate Layer 2 staleness (spec §18): the
 * live state the executor re-reads before mutating can be made to differ
 * from what a recommendation assumed.
 */
export class MockGoogleAdsOptimizationProvider {
  constructor(opts = {}) {
    this.opts = opts;
    this.calls = [];
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

  async buildOptimizationCustomer(googleConnection, { customerId }) {
    this.calls.push(['buildOptimizationCustomer', customerId]);
    if (this.opts.buildCustomerError) throw this.opts.buildCustomerError;
    return { __mock: true, customerId };
  }

  async readKeywordCurrentState(customer, { criterionId }) {
    this.calls.push(['readKeywordCurrentState', criterionId]);
    return this.opts.currentStates?.[`KEYWORD:${criterionId}`] ?? this.opts.defaultCurrentStatus ?? 'ENABLED';
  }

  async readAdCurrentState(customer, { adId }) {
    this.calls.push(['readAdCurrentState', adId]);
    return this.opts.currentStates?.[`AD:${adId}`] ?? this.opts.defaultCurrentStatus ?? 'ENABLED';
  }

  async readCampaignBudgetCurrentState(customer, { campaignBudgetResourceName }) {
    this.calls.push(['readCampaignBudgetCurrentState', campaignBudgetResourceName]);
    return this.opts.currentBudgetMicros ?? null;
  }

  async updateKeywordStatus(customer, { adGroupId, criterionId, status }) {
    this.calls.push(['updateKeywordStatus', criterionId, status]);
    this._fail('KEYWORD_UPDATE');
    return { resourceName: `customers/${customer.customerId}/adGroupCriteria/${adGroupId}~${criterionId}` };
  }

  async createNegativeKeyword(customer, { adGroupId, text }) {
    this.calls.push(['createNegativeKeyword', adGroupId, text]);
    this._fail('NEGATIVE_KEYWORD_CREATE');
    return { resourceName: `customers/${customer.customerId}/adGroupCriteria/${adGroupId}~${Date.now()}` };
  }

  async updateAdStatus(customer, { adGroupId, adId, status }) {
    this.calls.push(['updateAdStatus', adId, status]);
    this._fail('AD_UPDATE');
    return { resourceName: `customers/${customer.customerId}/adGroupAds/${adGroupId}~${adId}` };
  }

  async updateCampaignBudget(customer, { campaignBudgetResourceName, amountMicros }) {
    this.calls.push(['updateCampaignBudget', campaignBudgetResourceName, amountMicros]);
    this._fail('BUDGET_UPDATE');
    return { resourceName: campaignBudgetResourceName };
  }
}

export default MockGoogleAdsOptimizationProvider;
