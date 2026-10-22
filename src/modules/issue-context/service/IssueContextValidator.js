/**
 * IssueContextValidator
 *
 * Checks an IssueContext object for completeness and sets:
 *   - readinessScore  : 0–100
 *   - missingSignals  : string[]
 *   - warnings        : string[]
 *   - recommendationReady: boolean
 */
export class IssueContextValidator {
  validate(context) {
    const missing = [];
    const warnings = [];
    let score = 100;

    const { identity, currentState, expectedState, pageContext } = context;

    // Identity checks
    if (!identity?.issueId) { missing.push('issueId'); score -= 20; }
    if (!identity?.category) { warnings.push('category not set'); score -= 5; }

    // Page context checks
    if (!pageContext?.pageUrl) { missing.push('pageUrl'); score -= 15; }
    if (!pageContext?.pageType || pageContext.pageType === 'Unknown') {
      warnings.push('pageType unknown — recommendation may be less specific'); score -= 5;
    }

    // Current state checks
    if (!currentState) {
      missing.push('currentState');
      score -= 25;
    } else {
      if (currentState.isAbsent === undefined) { warnings.push('currentState.isAbsent not set'); }
      if (!currentState.displayType) { missing.push('currentState.displayType'); score -= 10; }

      // For non-absent issues, we expect a rawValue
      if (!currentState.isAbsent && currentState.rawValue == null) {
        warnings.push('currentState.rawValue is null — detected value may be missing');
        score -= 10;
      }
    }

    // Expected state checks
    if (!expectedState?.description) {
      missing.push('expectedState.description');
      score -= 10;
    }

    score = Math.max(0, Math.min(100, score));
    const recommendationReady = missing.length === 0 && score >= 50;

    return {
      readinessScore: score,
      missingSignals: missing,
      warnings,
      recommendationReady,
    };
  }
}

export default new IssueContextValidator();
