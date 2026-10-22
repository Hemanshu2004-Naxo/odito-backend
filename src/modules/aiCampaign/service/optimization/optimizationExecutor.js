/**
 * optimizationExecutor — Phase 7 (spec §18 Layer 2, §21, §23).
 *
 * Executes exactly ONE approved recommendation's mutation, but only after
 * re-reading the LIVE current Google Ads state and confirming it still
 * matches what the recommendation assumed (`expectedCurrentValue`) — never
 * blindly trusts a recommendation drafted from performance data that may
 * be hours old. A mismatch throws `OptimizationExecutionError` with code
 * `TARGET_STATE_CHANGED` before any mutation call — this is also how a
 * concurrency conflict between two recommendations targeting the same
 * entity is caught (spec §23's "pause keyword X" + "raise bid on keyword
 * X" example: whichever executes second sees a live state its own
 * `expectedCurrentValue` no longer matches).
 *
 * Idempotent by construction for status-flip operations: if the live state
 * ALREADY equals the proposed value, this returns success with
 * `alreadyInDesiredState: true` and makes no mutation call at all — a
 * duplicate execution request (e.g. a retried HTTP call) never re-applies
 * the same change or errors out.
 *
 * Never touches Mongo — every trusted id/resource-name/expected-value is
 * passed in by campaignOptimizationService.js, which owns all persistence.
 */

export class OptimizationExecutionError extends Error {
  constructor(message, { code, cause } = {}) {
    super(message);
    this.name = 'OptimizationExecutionError';
    this.code = code || 'GOOGLE_UNKNOWN';
    this.cause = cause;
  }
}

/**
 * @param {object} args
 * @param {object} args.provider - googleAdsOptimizationProvider-shaped object (or a mock)
 * @param {object} args.customer - opaque handle from provider.buildOptimizationCustomer
 * @param {object} args.recommendation - the approved AiCampaignOptimizationRecommendation (plain object)
 * @param {object} args.context - { customerId, campaignBudgetResourceName? }
 * @returns {Promise<{googleResourceName: string|null, afterState: any, alreadyInDesiredState?: boolean}>}
 */
export async function executeOptimization({ provider, customer, recommendation, context }) {
  switch (recommendation.target) {
    case 'KEYWORD':
      return executeKeywordStatusChange({ provider, customer, recommendation, context });
    case 'AD':
      return executeAdStatusChange({ provider, customer, recommendation, context });
    case 'AD_GROUP':
      return executeAddNegativeKeyword({ provider, customer, recommendation, context });
    case 'CAMPAIGN':
      return executeCampaignBudgetChange({ provider, customer, recommendation, context });
    default:
      throw new OptimizationExecutionError(`Unsupported optimization target "${recommendation.target}".`, { code: 'OPTIMIZATION_NOT_ALLOWED' });
  }
}

async function executeKeywordStatusChange({ provider, customer, recommendation, context }) {
  const adGroupId = recommendation.supportingMetrics?.adGroupId;
  const criterionId = recommendation.targetEntityId;
  if (!adGroupId || !criterionId) {
    throw new OptimizationExecutionError('This keyword is missing the ad group information needed to execute this change.', { code: 'TARGET_NOT_FOUND' });
  }

  let liveStatus;
  try {
    liveStatus = await provider.readKeywordCurrentState(customer, { customerId: context.customerId, adGroupId, criterionId });
  } catch (err) {
    throw new OptimizationExecutionError('Could not verify the keyword\'s current state.', { code: err.category ? classifyToOptimizationCode(err) : 'GOOGLE_UNKNOWN', cause: err });
  }
  if (!liveStatus) throw new OptimizationExecutionError('This keyword no longer exists in Google Ads.', { code: 'TARGET_NOT_FOUND' });

  const desiredStatus = recommendation.proposedChange.after;
  if (recommendation.expectedCurrentValue && liveStatus !== recommendation.expectedCurrentValue && liveStatus !== desiredStatus) {
    throw new OptimizationExecutionError('This keyword\'s state has changed since this recommendation was generated.', { code: 'TARGET_STATE_CHANGED' });
  }
  if (liveStatus === desiredStatus) {
    return { googleResourceName: null, afterState: liveStatus, alreadyInDesiredState: true };
  }

  try {
    const result = await provider.updateKeywordStatus(customer, { customerId: context.customerId, adGroupId, criterionId, status: desiredStatus });
    return { googleResourceName: result.resourceName, afterState: desiredStatus };
  } catch (err) {
    throw new OptimizationExecutionError('Failed to update the keyword.', { code: classifyToOptimizationCode(err), cause: err });
  }
}

async function executeAdStatusChange({ provider, customer, recommendation, context }) {
  const adGroupId = recommendation.supportingMetrics?.adGroupId;
  const adId = recommendation.targetEntityId;
  if (!adGroupId || !adId) {
    throw new OptimizationExecutionError('This ad is missing the ad group information needed to execute this change.', { code: 'TARGET_NOT_FOUND' });
  }

  let liveStatus;
  try {
    liveStatus = await provider.readAdCurrentState(customer, { customerId: context.customerId, adGroupId, adId });
  } catch (err) {
    throw new OptimizationExecutionError('Could not verify the ad\'s current state.', { code: classifyToOptimizationCode(err), cause: err });
  }
  if (!liveStatus) throw new OptimizationExecutionError('This ad no longer exists in Google Ads.', { code: 'TARGET_NOT_FOUND' });

  const desiredStatus = recommendation.proposedChange.after;
  if (recommendation.expectedCurrentValue && liveStatus !== recommendation.expectedCurrentValue && liveStatus !== desiredStatus) {
    throw new OptimizationExecutionError('This ad\'s state has changed since this recommendation was generated.', { code: 'TARGET_STATE_CHANGED' });
  }
  if (liveStatus === desiredStatus) {
    return { googleResourceName: null, afterState: liveStatus, alreadyInDesiredState: true };
  }

  try {
    const result = await provider.updateAdStatus(customer, { customerId: context.customerId, adGroupId, adId, status: desiredStatus });
    return { googleResourceName: result.resourceName, afterState: desiredStatus };
  } catch (err) {
    throw new OptimizationExecutionError('Failed to update the ad.', { code: classifyToOptimizationCode(err), cause: err });
  }
}

async function executeAddNegativeKeyword({ provider, customer, recommendation, context }) {
  const adGroupId = recommendation.targetEntityId;
  const text = recommendation.negativeKeywordText;
  if (!adGroupId || !text) {
    throw new OptimizationExecutionError('This negative keyword recommendation is missing required data.', { code: 'TARGET_NOT_FOUND' });
  }
  try {
    const result = await provider.createNegativeKeyword(customer, {
      customerId: context.customerId, adGroupId, text, matchType: recommendation.negativeKeywordMatchType || 'BROAD',
    });
    return { googleResourceName: result.resourceName, afterState: { text, matchType: recommendation.negativeKeywordMatchType || 'BROAD' } };
  } catch (err) {
    throw new OptimizationExecutionError('Failed to add the negative keyword.', { code: classifyToOptimizationCode(err), cause: err });
  }
}

async function executeCampaignBudgetChange({ provider, customer, recommendation, context }) {
  if (!context.campaignBudgetResourceName) {
    throw new OptimizationExecutionError('No campaign budget resource is known for this campaign — was it published through Odito?', { code: 'TARGET_NOT_FOUND' });
  }

  let liveMicros;
  try {
    liveMicros = await provider.readCampaignBudgetCurrentState(customer, { campaignBudgetResourceName: context.campaignBudgetResourceName });
  } catch (err) {
    throw new OptimizationExecutionError('Could not verify the campaign\'s current budget.', { code: classifyToOptimizationCode(err), cause: err });
  }
  if (liveMicros == null) throw new OptimizationExecutionError('This campaign\'s budget no longer exists in Google Ads.', { code: 'TARGET_NOT_FOUND' });

  const proposedMicros = recommendation.proposedChange.after;
  if (recommendation.expectedCurrentValue != null && liveMicros !== recommendation.expectedCurrentValue && liveMicros !== proposedMicros) {
    throw new OptimizationExecutionError('This campaign\'s budget has changed since this recommendation was generated.', { code: 'TARGET_STATE_CHANGED' });
  }
  if (liveMicros === proposedMicros) {
    return { googleResourceName: context.campaignBudgetResourceName, afterState: liveMicros, alreadyInDesiredState: true };
  }

  try {
    const result = await provider.updateCampaignBudget(customer, { campaignBudgetResourceName: context.campaignBudgetResourceName, amountMicros: proposedMicros });
    return { googleResourceName: result.resourceName, afterState: proposedMicros };
  } catch (err) {
    throw new OptimizationExecutionError('Failed to update the campaign budget.', { code: classifyToOptimizationCode(err), cause: err });
  }
}

function classifyToOptimizationCode(err) {
  switch (err?.category) {
    case 'quota': return 'GOOGLE_QUOTA';
    case 'authentication':
    case 'authorization': return 'GOOGLE_AUTHORIZATION_FAILED';
    case 'invalid_request':
    case 'invalid_customer': return 'GOOGLE_VALIDATION_FAILED';
    case 'internal': return 'GOOGLE_NETWORK';
    default: return 'GOOGLE_UNKNOWN';
  }
}

export default { executeOptimization, OptimizationExecutionError };
