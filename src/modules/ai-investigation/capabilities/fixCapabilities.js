/**
 * fixCapabilities — what Odito can ACTUALLY do about an issue, from its own registries.
 *
 * Two independent facts are combined; the model never decides either:
 *   1. static support   — providerCapabilityRegistry says whether Odito has a complete write -> read-back -> verify
 *                         implementation for this issue at all
 *   2. site integration — whether this project has a connected WordPress site (and, for typed/field fixes, the
 *                         Bridge capability that issue needs)
 *
 * Output is the single source for `automaticFixEligibility` and `requiredCapabilities`; the response contract
 * overrides any model claim that disagrees with it.
 */

import { getCapabilityForIssue } from '../../external_integration/service/providerCapabilityRegistry.js';

export const ELIGIBILITY = Object.freeze({
  ELIGIBLE: 'eligible',                       // an approved adapter can apply it now
  REQUIRES_SETUP: 'requires_integration_setup', // supported in principle, this site lacks the connection/plugin
  NOT_SUPPORTED: 'not_supported',             // Odito has no safe automation for this issue
  UNKNOWN: 'unknown',                         // capability could not be determined
});

const BRIDGE_FLAG_BY_FIELD = { faq_schema: 'faqSchemaSupported', aggregate_rating: 'ratingSchemaSupported' };

/**
 * @param {{ issueId: string, projectId: string }} args
 * @param {{ loadIntegration?: (projectId: string) => Promise<object|null>, getRegistryEntry?: Function }} [deps]
 */
export async function resolveFixCapabilities({ issueId, projectId, operation = null }, { loadIntegration = defaultLoadIntegration, loadSiteSchema = defaultLoadSiteSchema, getRegistryEntry = getCapabilityForIssue } = {}) {
  const entry = getRegistryEntry(issueId);
  if (!entry) {
    return {
      eligibility: ELIGIBILITY.NOT_SUPPORTED, adapterId: null, field: null, scope: null, typedFix: false,
      requiredCapabilities: [], missingCapabilities: [], operations: [],
      reason: 'Odito has no automatic-fix adapter for this issue type. A manual implementation plan is provided instead.',
      integration: null,
    };
  }
  const { field, capability } = entry;
  if (!capability.supported) {
    return {
      eligibility: ELIGIBILITY.NOT_SUPPORTED, adapterId: null, field, scope: capability.scope || 'post', typedFix: !!capability.typedFix,
      requiredCapabilities: [], missingCapabilities: [], operations: [],
      reason: capability.unsupportedReason || 'This fix is not automated.', integration: null,
    };
  }

  const required = ['wordpress_connection', 'odito_seo_bridge'];
  // An OPERATION (what exactly would be written, e.g. the Organization `address`) can need more than the issue's base capability.
  const bridgeNeed = operation ? capability.fieldMinBridgeCapability?.[operation] : null;
  if (bridgeNeed === 'organization_address') required.push('odito_seo_bridge_organization_address');
  if (operation && capability.provider) required.push(`seo_plugin_${capability.provider}`);
  if (operation === 'address') required.push('rank_math_local_seo_module');
  if (BRIDGE_FLAG_BY_FIELD[field]) required.push(BRIDGE_FLAG_BY_FIELD[field]);
  const operations = [operation ? `write:${field}.${operation}` : `write:${field}`, 'read_back', 'crawler_verification'];

  let integration = null;
  try { integration = await loadIntegration(projectId); } catch { integration = null; }
  if (!integration) {
    return {
      eligibility: ELIGIBILITY.UNKNOWN, adapterId: 'wordpress_seo_bridge', field, scope: capability.scope || 'post', typedFix: !!capability.typedFix,
      requiredCapabilities: required, missingCapabilities: [], operations,
      reason: 'The WordPress connection state could not be read, so eligibility is unknown.', integration: null,
    };
  }

  const missing = [];
  if (!integration.connected) missing.push('wordpress_connection');
  else {
    if (integration.ambiguous) missing.push('single_active_seo_plugin');
    if (!integration.bridgeInstalled) missing.push('odito_seo_bridge');
    const flag = BRIDGE_FLAG_BY_FIELD[field];
    if (flag && integration[flag] === false) missing.push(flag);
    if (!BRIDGE_FLAG_BY_FIELD[field] && !capability.typedFix && integration.capabilities && integration.capabilities[field]?.write === false) {
      missing.push(`seo_plugin_write:${field}`);
    }
    // Operation-specific: "WordPress is connected" is not enough. The adapter must be able to write THIS change on THIS site.
    if (bridgeNeed === 'organization_address' && integration.bridgeInstalled && integration.organizationAddressSupported !== true) missing.push('odito_seo_bridge_organization_address');
    if (operation && capability.provider && integration.provider && integration.provider !== 'none' && integration.provider !== capability.provider) missing.push(`seo_plugin_${capability.provider}`);
    if (operation === 'address' && missing.length === 0 && capability.provider === 'rank_math') {
      // Rank Math only publishes the Local SEO address while its Local SEO module is on: read the live settings. Unreadable = unverified = not eligible.
      let schema = null;
      try { schema = await loadSiteSchema(projectId); } catch { schema = null; }
      if (!schema?.supported || !schema.organization) missing.push('rank_math_site_settings_unreadable');
      else if (schema.organization.kind && schema.organization.kind !== 'company') missing.push('rank_math_company_entity');
      else if (schema.organization.localSeoActive !== true) missing.push('rank_math_local_seo_module');
    }
  }
  return {
    eligibility: missing.length ? ELIGIBILITY.REQUIRES_SETUP : ELIGIBILITY.ELIGIBLE,
    adapterId: 'wordpress_seo_bridge', field, scope: capability.scope || 'post', typedFix: !!capability.typedFix,
    requiredCapabilities: required, missingCapabilities: missing, operations,
    reason: missing.length ? `Missing on this site: ${missing.join(', ')}.` : 'A trusted adapter can apply this after your approval.',
    integration: { connected: !!integration.connected, provider: integration.provider || null, bridgeInstalled: !!integration.bridgeInstalled },
  };
}

async function defaultLoadSiteSchema(projectId) {
  const { default: dataService } = await import('../../external_integration/service/wordPressSeoDataService.js');
  return dataService.getSiteSchema(projectId);
}

async function defaultLoadIntegration(projectId) {
  const { default: dataService } = await import('../../external_integration/service/wordPressSeoDataService.js');
  return dataService.getCapabilities(projectId);
}

export default { resolveFixCapabilities, ELIGIBILITY };
