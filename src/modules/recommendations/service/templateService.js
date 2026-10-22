import RecommendationTemplate from '../model/RecommendationTemplate.js';

/**
 * Template Service
 * 
 * Template-first architecture: resolves pre-written recommendations
 * with interpolation for dynamic context values.
 * 
 * Fallback chain:
 * 1. Exact match: ruleId + pageType + framework
 * 2. Rule + pageType + _default framework
 * 3. Rule + _default + _default (generic for that rule)
 * 4. null (triggers Claude generation)
 * 
 * Interpolation slots supported:
 * {{pageType}}, {{framework}}, {{cms}}, {{ruleId}}, {{wordCount}}
 */

class TemplateService {

  /**
   * Resolve a template for the given rule + context.
   * Returns null if no template exists (caller should fall through to Claude).
   * 
   * @param {string} ruleId - Rule ID
   * @param {Object} context - { pageType, framework, cms }
   * @returns {Promise<Object|null>} Resolved sections or null
   */
  async resolve(ruleId, context = {}) {
    const { pageType = 'Unknown', framework = 'unknown' } = context;

    const template = await RecommendationTemplate.findBestMatch(ruleId, pageType, framework);
    if (!template) return null;

    // Deep-clone sections and interpolate
    const resolved = this._interpolate(template.sections, context, ruleId);
    return {
      sections: resolved,
      templateVersion: template.version,
      source: 'template',
    };
  }

  /**
   * Interpolate template slots with actual context values.
   * @private
   */
  _interpolate(sections, context, ruleId) {
    const vars = {
      '{{pageType}}': context.pageType || 'page',
      '{{framework}}': context.framework || 'your framework',
      '{{cms}}': context.cms || 'your CMS',
      '{{ruleId}}': ruleId,
      '{{wordCount}}': String(context.wordCount || 0),
    };

    const result = {};

    for (const [key, value] of Object.entries(sections.toObject ? sections.toObject() : sections)) {
      result[key] = this._replaceInValue(value, vars);
    }

    return result;
  }

  /**
   * Recursively replace interpolation vars in a value.
   * Handles strings, arrays, and objects.
   * @private
   */
  _replaceInValue(value, vars) {
    if (typeof value === 'string') {
      let result = value;
      for (const [slot, replacement] of Object.entries(vars)) {
        result = result.replaceAll(slot, replacement);
      }
      return result;
    }

    if (Array.isArray(value)) {
      return value.map(item => this._replaceInValue(item, vars));
    }

    if (value && typeof value === 'object') {
      const result = {};
      for (const [k, v] of Object.entries(value)) {
        result[k] = this._replaceInValue(v, vars);
      }
      return result;
    }

    return value;
  }

  /**
   * Get the template version for a rule (used in hash computation).
   * Returns 1 if no template exists.
   * 
   * @param {string} ruleId
   * @returns {Promise<number>}
   */
  async getTemplateVersion(ruleId) {
    const template = await RecommendationTemplate.findOne({
      ruleId,
      isActive: true,
    }).sort({ version: -1 }).select('version').lean();

    return template ? template.version : 1;
  }
}

export default new TemplateService();
