/**
 * MockClaudeCampaignProvider — the test double for ClaudeCampaignProvider.
 *
 * Same interface (`isAvailable`, `generateCampaign`, `retryDelayFor`), zero
 * network. The generation service accepts a `provider` argument, so every
 * unit/integration test injects one of these — the suite NEVER depends on
 * ANTHROPIC_API_KEY, internet access, or a real Claude response.
 *
 * Usage:
 *   new MockClaudeCampaignProvider({ parsed: <campaign object> })     // success
 *   new MockClaudeCampaignProvider({ error: 'CLAUDE_TIMEOUT' })       // provider failure
 *   new MockClaudeCampaignProvider({ parsedFactory: (args) => ... })  // dynamic
 *   provider.calls  // [{ system, user, generationId }, ...] for assertions
 */

export class MockClaudeCampaignProvider {
  /**
   * @param {object} opts
   * @param {object} [opts.parsed]         object returned as `parsed`
   * @param {Function} [opts.parsedFactory] (args) => object, takes precedence
   * @param {string|Error} [opts.error]    thrown from generateCampaign; a
   *        string becomes an Error with `.code` set to that string
   * @param {boolean} [opts.available=true] value of isAvailable()
   * @param {object} [opts.usage]          usage block to report
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.calls = [];
    this._available = opts.available !== false;
  }

  isAvailable() {
    return this._available;
  }

  // Match the real provider's shape so service-level retry logic can be
  // exercised against the mock if a test wants to.
  retryDelayFor() {
    return null;
  }

  async generateCampaign(args) {
    this.calls.push({ system: args?.system, user: args?.user, generationId: args?.generationId });

    if (this.opts.error) {
      if (this.opts.error instanceof Error) throw this.opts.error;
      const err = new Error(String(this.opts.error));
      err.code = String(this.opts.error);
      err.provider = 'CLAUDE';
      throw err;
    }

    const parsed = this.opts.parsedFactory
      ? this.opts.parsedFactory(args)
      : this.opts.parsed;

    if (parsed === undefined) {
      const err = new Error('CLAUDE_BAD_OUTPUT');
      err.code = 'CLAUDE_BAD_OUTPUT';
      throw err;
    }

    return {
      parsed,
      usage: this.opts.usage || { inputTokens: 1234, outputTokens: 2345 },
      model: this.opts.model || 'mock-claude-campaign',
      stopReason: 'tool_use',
      durationMs: 5,
      attempts: 1,
    };
  }
}

/**
 * A canonical, valid generated-campaign object for the Nashik example —
 * shared by tests so the "happy path" fixture lives in one place.
 *
 * Meets Odito's OWN creative-quality bar (RSA_QUALITY_TARGETS —
 * creativeQualityValidator.js), not just Google's raw minimums: 14
 * genuinely distinct headlines and 4 distinct descriptions per ad (every
 * headline <=30 chars, every description <=90 chars), one headline per ad
 * group that verbatim-covers one of that group's own top-5 keywords, plus a
 * full set of campaign-level sitelinks/callouts/structured snippets. Verified
 * clean against validateCreativeQuality/validateCampaignAssets (zero issues)
 * — see the Phase 9 test suite. Any change to either validator's thresholds
 * should be re-checked against this fixture.
 */
export function nashikCampaignFixture() {
  const rsaAd = (shortLabel, keywordHeadline) => ({
    type: 'RESPONSIVE_SEARCH_AD',
    headlines: [
      { text: `${shortLabel} in Nashik`.slice(0, 30) },
      { text: keywordHeadline },
      { text: 'Digital Marketing Experts' },
      { text: 'Grow Qualified Leads Today' },
      { text: 'Turn Clicks Into Customers' },
      { text: 'Data Driven Marketing Team' },
      { text: 'Get Your Free Consultation' },
      { text: 'Boost Your Online Presence' },
      { text: 'Trusted Marketing Partner' },
      { text: 'Expand Your Customer Base' },
      { text: 'Increase Website Conversions' },
      { text: 'Talk To Our Strategists' },
      { text: 'Custom Marketing Plans' },
      { text: 'Reach More Local Customers' },
    ],
    descriptions: [
      { text: 'Digital marketing services for growing businesses in Nashik. Talk to our team today.' },
      { text: 'SEO, ads and online marketing focused on qualified business leads. Get started now.' },
      { text: 'Data driven campaigns designed to turn visitors into paying customers consistently.' },
      { text: 'Custom strategies built around your goals, budget and audience across Nashik.' },
    ],
    path1: 'nashik',
    path2: 'marketing',
  });

  return {
    campaign: {
      name: 'Digital Marketing Leads — Nashik',
      objective: 'LEADS',
      biddingStrategy: 'MAXIMIZE_CONVERSIONS',
      languages: [{ code: 'en', name: 'English' }],
      sitelinks: [
        { text: 'Contact Us', description1: 'Talk to our team', description2: 'Get a free quote' },
        { text: 'Our Services' },
      ],
      callouts: [
        { text: 'Data Driven Strategy' },
        { text: 'Custom Marketing Plans' },
        { text: 'Local Nashik Team' },
      ],
      structuredSnippets: [
        { header: 'Service catalog', values: ['SEO', 'PPC Advertising', 'Social Media Marketing'] },
      ],
    },
    adGroups: [
      {
        name: 'Digital Marketing Agency',
        keywords: [
          { text: 'digital marketing agency nashik', matchType: 'PHRASE' },
          { text: 'digital marketing company nashik', matchType: 'PHRASE' },
          { text: 'online marketing agency nashik', matchType: 'BROAD' },
          { text: 'marketing agency near me', matchType: 'BROAD' },
          { text: 'best digital marketing agency nashik', matchType: 'PHRASE' },
        ],
        negativeKeywords: [
          { text: 'jobs', matchType: 'BROAD' },
          { text: 'course', matchType: 'BROAD' },
          { text: 'salary', matchType: 'BROAD' },
          { text: 'free', matchType: 'BROAD' },
          { text: 'internship', matchType: 'BROAD' },
        ],
        ads: [rsaAd('Agency', 'Marketing Agency Near Me')],
      },
      {
        name: 'SEO Services',
        keywords: [
          { text: 'seo services nashik', matchType: 'PHRASE' },
          { text: 'seo agency nashik', matchType: 'PHRASE' },
          { text: 'seo company nashik', matchType: 'PHRASE' },
          { text: 'search engine optimization nashik', matchType: 'BROAD' },
          { text: 'seo expert nashik', matchType: 'BROAD' },
        ],
        negativeKeywords: [
          { text: 'jobs', matchType: 'BROAD' },
          { text: 'course', matchType: 'BROAD' },
          { text: 'tutorial', matchType: 'BROAD' },
          { text: 'free', matchType: 'BROAD' },
          { text: 'wordpress plugin', matchType: 'BROAD' },
        ],
        ads: [rsaAd('SEO Services', 'SEO Services Nashik')],
      },
      {
        name: 'Local SEO',
        keywords: [
          { text: 'local seo services nashik', matchType: 'PHRASE' },
          { text: 'google my business optimization', matchType: 'BROAD' },
          { text: 'local seo agency', matchType: 'BROAD' },
          { text: 'local business seo nashik', matchType: 'PHRASE' },
          { text: 'gmb optimization services', matchType: 'BROAD' },
        ],
        negativeKeywords: [
          { text: 'jobs', matchType: 'BROAD' },
          { text: 'course', matchType: 'BROAD' },
          { text: 'salary', matchType: 'BROAD' },
          { text: 'free', matchType: 'BROAD' },
          { text: 'definition', matchType: 'BROAD' },
        ],
        ads: [rsaAd('Local SEO', 'Local SEO Agency')],
      },
    ],
  };
}

/**
 * A deliberately THIN campaign — Google-API-valid (meets RSA_LIMITS' raw
 * floor) but below Odito's own creative-quality bar: only 5 headlines / 2
 * descriptions per ad, no campaign-level assets. Fails
 * validateCreativeQuality (TOO_FEW_HEADLINES/TOO_FEW_DESCRIPTIONS) — the
 * exact shape a repair-loop test needs to exercise
 * campaignGenerationService.js's bounded retry (spec §20/§21).
 */
export function thinCampaignFixture() {
  const rsaAd = () => ({
    type: 'RESPONSIVE_SEARCH_AD',
    headlines: [
      { text: 'Digital Marketing Nashik' },
      { text: 'Digital Marketing Experts' },
      { text: 'Grow Qualified Leads' },
      { text: 'Free Consultation Available' },
      { text: 'Local Marketing Specialists' },
    ],
    descriptions: [
      { text: 'Digital marketing services for growing businesses in Nashik. Talk to our team today.' },
      { text: 'SEO, ads and online marketing focused on qualified business leads. Get started now.' },
    ],
    path1: 'nashik',
    path2: 'marketing',
  });

  return {
    campaign: {
      name: 'Digital Marketing Leads — Nashik',
      objective: 'LEADS',
      biddingStrategy: 'MAXIMIZE_CONVERSIONS',
      languages: [{ code: 'en', name: 'English' }],
    },
    adGroups: [
      {
        name: 'Digital Marketing Agency',
        keywords: [
          { text: 'digital marketing agency nashik', matchType: 'PHRASE' },
          { text: 'digital marketing company nashik', matchType: 'PHRASE' },
          { text: 'online marketing agency nashik', matchType: 'BROAD' },
          { text: 'marketing agency near me', matchType: 'BROAD' },
          { text: 'best digital marketing agency nashik', matchType: 'PHRASE' },
        ],
        negativeKeywords: [
          { text: 'jobs', matchType: 'BROAD' },
          { text: 'course', matchType: 'BROAD' },
          { text: 'salary', matchType: 'BROAD' },
          { text: 'free', matchType: 'BROAD' },
          { text: 'internship', matchType: 'BROAD' },
        ],
        ads: [rsaAd()],
      },
      {
        name: 'SEO Services',
        keywords: [
          { text: 'seo services nashik', matchType: 'PHRASE' },
          { text: 'seo agency nashik', matchType: 'PHRASE' },
          { text: 'seo company nashik', matchType: 'PHRASE' },
          { text: 'search engine optimization nashik', matchType: 'BROAD' },
          { text: 'seo expert nashik', matchType: 'BROAD' },
        ],
        negativeKeywords: [
          { text: 'jobs', matchType: 'BROAD' },
          { text: 'course', matchType: 'BROAD' },
          { text: 'tutorial', matchType: 'BROAD' },
          { text: 'free', matchType: 'BROAD' },
          { text: 'wordpress plugin', matchType: 'BROAD' },
        ],
        ads: [rsaAd()],
      },
      {
        name: 'Local SEO',
        keywords: [
          { text: 'local seo services nashik', matchType: 'PHRASE' },
          { text: 'google my business optimization', matchType: 'BROAD' },
          { text: 'local seo agency', matchType: 'BROAD' },
          { text: 'local business seo nashik', matchType: 'PHRASE' },
          { text: 'gmb optimization services', matchType: 'BROAD' },
        ],
        negativeKeywords: [
          { text: 'jobs', matchType: 'BROAD' },
          { text: 'course', matchType: 'BROAD' },
          { text: 'salary', matchType: 'BROAD' },
          { text: 'free', matchType: 'BROAD' },
          { text: 'definition', matchType: 'BROAD' },
        ],
        ads: [rsaAd()],
      },
    ],
  };
}

export default MockClaudeCampaignProvider;
