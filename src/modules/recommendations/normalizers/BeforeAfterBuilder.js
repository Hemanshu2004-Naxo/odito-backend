/**
 * BeforeAfterBuilder
 *
 * Builds BeforeState and AfterState deterministically.
 *
 * DESIGN RULE:
 *   BeforeState — derived entirely from RecommendationContext.currentState.
 *                 Claude never provides it.  Zero ambiguity.
 *   AfterState  — derived from Claude's recommendedVersion output, normalized
 *                 against RecommendationContext.expectedState for constraint
 *                 satisfaction.  Claude provides the content; the system
 *                 computes the measurement and satisfiesConstraint flag.
 *
 * Both shapes mirror the `currentState` vocabulary from BaseResolver so the
 * frontend can render them with the same component.
 */

// Max text lengths for display
const PREVIEW_MAX   = 500;  // BeforeState rawText — the CURRENT (already-short) content, a genuine preview
const FULL_MAX       = 8000; // AfterState rawText for text/absent — the actual rewritten content the frontend renders as the full diff (RecommendationDiffViewer), NOT a preview
const SUMMARY_MAX   = 200;  // summary string

export class BeforeAfterBuilder {

  /**
   * Build both states from a RecommendationContext and Claude's raw output.
   *
   * @param {object} rc        — RecommendationContext
   * @param {object} rawOutput — Claude's parsed JSON output
   * @returns {{ beforeState: object, afterState: object }}
   */
  build(rc, rawOutput) {
    const beforeState = this._buildBeforeState(rc);
    const afterState  = this._buildAfterState(rc, rawOutput);
    return { beforeState, afterState };
  }

  // ── BeforeState ───────────────────────────────────────────────────────────

  _buildBeforeState(rc) {
    const cs = rc?.currentState || {};
    const es = rc?.expectedState || {};
    const dT = cs.displayType || 'absent';

    const base = {
      displayType:  dT,
      label:        cs.label || rc?.recommendationObjective?.target || null,
      summary:      _truncate(cs.summary || this._deriveSummary(cs, dT), SUMMARY_MAX),
      rawText:      null,
      measurement:  { value: cs.measurement?.value ?? null, unit: cs.measurement?.unit ?? null },
      tableRows:    null,
      listItems:    null,
      chainHops:    null,
      codeContent:  null,
      isAbsent:     cs.isAbsent ?? false,
    };

    switch (dT) {
      case 'text':
        base.rawText = cs.rawText ? _truncate(cs.rawText, PREVIEW_MAX) : null;
        break;
      case 'metric':
        // rawText is label for metric; measurement carries the value
        base.rawText = cs.label || null;
        break;
      case 'table':
        base.tableRows = (cs.tableRows || []).slice(0, 10);
        break;
      case 'list':
        base.listItems = (cs.listItems || []).slice(0, 10);
        break;
      case 'chain':
      case 'tree':
        base.chainHops = (cs.chainHops || []).slice(0, 8);
        break;
      case 'code':
        base.codeContent = cs.codeContent ? _truncate(cs.codeContent, 800) : null;
        break;
      case 'absent': {
        base.isAbsent = true;
        base.rawText  = cs.checkedFor || null;
        // Surface inferred context so the frontend can show what was detected
        const mec = rc?.missingElementContext;
        if (mec) {
          const parts = [];
          if (mec.primaryTopic) parts.push(`Topic: ${mec.primaryTopic}`);
          if (mec.businessName) parts.push(`Business: ${mec.businessName}`);
          if (mec.pageIntent)   parts.push(`Intent: ${mec.pageIntent}`);
          if (parts.length) base.detectedContextLabel = parts.join(' · ');
        }
        break;
      }
    }

    return base;
  }

  // ── AfterState ────────────────────────────────────────────────────────────

  _buildAfterState(rc, rawOutput) {
    const cs  = rc?.currentState  || {};
    const es  = rc?.expectedState || {};
    const dT  = cs.displayType || 'absent';
    const obj = rc?.recommendationObjective || {};

    // Primary content source from Claude
    const recommendedVersion = rawOutput?.recommendedVersion || null;
    const implCode           = rawOutput?.implementationCode || null;

    const base = {
      displayType:         dT,
      label:               cs.label || obj.target || null,
      summary:             null,
      rawText:             null,
      measurement:         { value: null, unit: cs.measurement?.unit ?? null },
      tableRows:           null,
      listItems:           null,
      chainHops:           null,
      codeContent:         null,
      isAbsent:            false,
      satisfiesConstraint: false,
      targetRange:         es.targetRange || null,
    };

    switch (dT) {
      case 'text': {
        const text = recommendedVersion || null;
        // FULL_MAX, not PREVIEW_MAX — this is the actual rewritten content
        // RecommendationDiffViewer renders as the full diff, not a preview.
        base.rawText  = text ? _truncate(text, FULL_MAX) : null;
        if (text) {
          const trimmed = text.trim();
          // es.unit is frequently 'words' (e.g. thin_content's "at least 300
          // words") — measuring .length there silently reports a character
          // count mislabeled as a word count. Count words when the unit says
          // words; otherwise character length is correct as before.
          base.measurement.value = (es.unit || '').toLowerCase() === 'words'
            ? trimmed.split(/\s+/).filter(Boolean).length
            : trimmed.length;
          base.satisfiesConstraint = _checkRange(
            base.measurement.value, es.targetMin, es.targetMax
          );
        }
        base.isAbsent = !text;
        base.summary  = text
          ? `"${_preview(text, 80)}" (${base.measurement.value} ${es.unit || 'chars'})`
          : 'Not provided';
        break;
      }

      case 'metric': {
        // AfterState for metric: we describe the target, not an exact value
        base.rawText  = obj.constraint || es.description || 'Target range';
        base.measurement.value = es.targetMin ?? es.targetMax ?? null;
        base.satisfiesConstraint = Boolean(recommendedVersion || implCode);
        base.summary  = obj.successCriteria || es.description || 'Fixed';
        base.isAbsent = !recommendedVersion && !implCode;
        break;
      }

      case 'table': {
        // Extract the fixed table state from Claude's output
        base.tableRows = this._parseAfterTableRows(cs.tableRows, recommendedVersion, implCode);
        base.satisfiesConstraint = base.tableRows != null && base.tableRows.length > 0;
        base.summary  = base.tableRows?.length
          ? `${base.tableRows.length} field${base.tableRows.length !== 1 ? 's' : ''} addressed`
          : recommendedVersion ? 'Fix provided' : 'Not provided';
        base.isAbsent = !base.tableRows?.length && !recommendedVersion;
        break;
      }

      case 'list': {
        base.listItems = this._parseAfterListItems(cs.listItems, recommendedVersion, implCode);
        base.satisfiesConstraint = Boolean(recommendedVersion || implCode);
        base.summary   = base.listItems?.length
          ? `${base.listItems.length} item${base.listItems.length !== 1 ? 's' : ''} addressed`
          : recommendedVersion ? 'Fix provided' : 'Not provided';
        base.isAbsent  = !base.listItems?.length && !recommendedVersion;
        break;
      }

      case 'chain':
      case 'tree': {
        base.chainHops = this._parseAfterChain(recommendedVersion);
        const depth    = base.chainHops ? base.chainHops.length - 1 : null;
        base.measurement.value = depth;
        base.satisfiesConstraint = depth != null && depth <= (cs.measurement?.threshold ?? 3);
        base.summary   = base.chainHops?.length
          ? `${base.chainHops.join(' → ')} (${depth} clicks)`
          : 'Path restructure required';
        base.isAbsent  = !base.chainHops?.length;
        break;
      }

      case 'code': {
        const code = implCode || recommendedVersion;
        base.codeContent     = code ? _truncate(code, 800) : null;
        base.satisfiesConstraint = Boolean(code);
        base.summary         = code ? 'Updated code provided' : 'No code provided';
        base.isAbsent        = !code;
        break;
      }

      case 'absent': {
        // Element was missing — AfterState represents the generated element
        // (e.g. a full FAQ section), which can be substantial — FULL_MAX,
        // not PREVIEW_MAX, for the same reason as the 'text' case above.
        const content = recommendedVersion || implCode;
        base.rawText  = content ? _truncate(content, FULL_MAX) : null;
        base.isAbsent = !content;
        base.satisfiesConstraint = Boolean(typeof content === 'string' && content.trim().length > 10);

        // Build a richer summary using the element label and a preview
        const elementLabel = cs.checkedFor || obj.target || 'element';
        if (content) {
          const preview = _preview(content, 60);
          base.summary = `${elementLabel} generated: "${preview}"`;
        } else {
          base.summary = `${elementLabel} — not generated`;
        }
        break;
      }

      default: {
        const content = recommendedVersion || implCode;
        base.rawText  = content ? _truncate(content, PREVIEW_MAX) : null;
        base.isAbsent = !content;
        base.satisfiesConstraint = Boolean(content);
        base.summary  = content ? 'Fix provided' : 'Not provided';
      }
    }

    return base;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _deriveSummary(cs, dT) {
    if (cs.summary) return cs.summary;
    if (cs.isAbsent) {
      const label = cs.checkedFor || 'element';
      return `No ${label} found on this page`;
    }
    if (dT === 'text' && cs.rawText) return `"${_preview(cs.rawText, 60)}" (${cs.measurement?.value} ${cs.measurement?.unit || 'chars'})`;
    if (dT === 'metric') return `${cs.measurement?.value} ${cs.measurement?.unit || ''}`;
    return 'See detected issue';
  }

  /**
   * Parse the after-state for table displayType.
   * We can't reliably parse HTML/JSON tables from Claude output,
   * so we return a descriptive representation.
   */
  _parseAfterTableRows(beforeRows, recommendedVersion, implCode) {
    if (!beforeRows?.length) return null;

    // Attempt to describe what changed based on missing rows
    const missing = beforeRows.filter(r => {
      const status = String(r.status || r.Status || '');
      return status === '✗' || String(r.value || r.Value || '').toLowerCase() === 'missing';
    });

    if (missing.length === 0) return beforeRows; // nothing to fix

    // If we have output, assume all missing rows were addressed
    if (recommendedVersion || implCode) {
      return beforeRows.map(r => {
        const isMissing = missing.some(m => (m.field || m.Field) === (r.field || r.Field));
        return isMissing
          ? { ...r, status: '✓', value: '(provided in implementation)' }
          : r;
      });
    }

    return null;
  }

  /**
   * Parse after-state for list displayType.
   * Returns the list items that were in the recommendation, or null.
   */
  _parseAfterListItems(beforeItems, recommendedVersion, implCode) {
    if (!recommendedVersion && !implCode) return null;
    // We can't reliably extract a structured list from prose output,
    // so return a single descriptive entry
    const content = recommendedVersion || implCode;
    const lines = content.split(/\n/).map(l => l.trim()).filter(Boolean);
    return lines.length > 1 ? lines.slice(0, 6) : null;
  }

  /**
   * Parse a chain from Claude's recommendedVersion.
   * Looks for patterns like "Homepage → Services → Pricing".
   */
  _parseAfterChain(recommendedVersion) {
    if (!recommendedVersion) return null;
    const arrowChain = recommendedVersion.match(/.+→.+/);
    if (arrowChain) {
      const hops = arrowChain[0].split('→').map(s => s.trim()).filter(Boolean);
      if (hops.length >= 2) return hops;
    }
    return null;
  }
}

// ── Module helpers ────────────────────────────────────────────────────────────

function _truncate(str, max) {
  if (!str || typeof str !== 'string') return str;
  return str.length <= max ? str : str.slice(0, max - 1) + '…';
}

function _preview(text, max) {
  if (!text) return '';
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

function _checkRange(value, min, max) {
  if (value == null) return false;
  if (min != null && value < min) return false;
  if (max != null && value > max) return false;
  return true;
}

export default new BeforeAfterBuilder();
