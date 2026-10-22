/**
 * evidenceBasis — how well each material statement of a diagnosis is supported, decided by the SERVER from the ledger (the model's own
 * `basis` label is only a claim and is recorded as `claimedBasis`).
 *
 *   observed      directly seen in at least one successfully retrieved evidence item
 *   corroborated  seen independently in two or more retrieved items from different sources or views (raw HTML vs rendered DOM, page vs homepage...)
 *   inferred      a reasonable conclusion the evidence suggests but does not show (or the model labelled it so)
 *   unknown       no usable support, or an ABSENCE claim whose relevant source was unavailable/incomplete
 *
 * A statement that something is missing ("absence") is only supported when the cited evidence actually covers where it would appear:
 * a live observation of the page/site (a stored crawl or the detector alone cannot show absence), and — if the page's markup may be altered
 * by JavaScript — the rendered DOM as well.
 */

import { EVIDENCE_STATUS } from '../evidence/evidenceLedger.js';

export const BASIS = Object.freeze({ OBSERVED: 'observed', CORROBORATED: 'corroborated', INFERRED: 'inferred', UNKNOWN: 'unknown' });
const OBSERVING_KINDS = new Set(['page', 'rendered_dom', 'homepage', 'sibling', 'robots_txt', 'sitemap', 'llms_txt', 'response_headers', 'hierarchy_url', 'structured_analysis', 'raw_vs_rendered']);

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Does the rendered state matter, and do we have it? */
export function renderedStateGap(ledger) {
  const decision = ledger.first('render_decision')?.data;
  if (!decision?.render) return null;
  if (ledger.first('rendered_dom')) return null;
  const attempt = ledger.find('rendered_dom')[0];
  return attempt
    ? `Rendering was needed (${decision.reasons.join('; ')}) but did not complete (${attempt.error?.code || attempt.status}), so what JavaScript adds or changes is unknown.`
    : `Rendering was needed (${decision.reasons.join('; ')}) but was not performed, so what JavaScript adds or changes is unknown.`;
}

/** Can an ABSENCE claim citing `ids` be trusted? */
export function absenceSupport(ledger, ids) {
  const cited = ids.map((id) => ledger.items.find((i) => i.id === id)).filter((i) => i && i.status === EVIDENCE_STATUS.OK);
  if (!cited.some((i) => OBSERVING_KINDS.has(i.kind))) {
    return { supported: false, reason: 'Absence needs a live observation of the page or site; the cited evidence (stored crawl / detector) cannot show that something is missing now.' };
  }
  const gap = renderedStateGap(ledger);
  if (gap && !cited.some((i) => i.kind === 'rendered_dom')) return { supported: false, reason: gap };
  if (cited.some((i) => i.kind === 'rendered_dom' && i.data?.htmlTruncated)) return { supported: false, reason: 'The rendered DOM was truncated, so something may exist beyond what was inspected.' };
  return { supported: true, reason: null };
}

/**
 * @param {Array} rawFindings model-provided findings (or evidence entries mapped to findings)
 * @returns {{ findings: Array, downgrades: string[] }}
 */
export function assessFindings(rawFindings, ledger) {
  const ok = new Map(ledger.ok.map((i) => [i.id, i]));
  const downgrades = [];
  const findings = [];
  for (const f of (Array.isArray(rawFindings) ? rawFindings : []).slice(0, 20)) {
    const statement = str(f?.statement ?? f?.finding, 400);
    if (!statement) continue;
    const claimed = Object.values(BASIS).includes(f?.basis) ? f.basis : BASIS.OBSERVED;
    const requested = [...new Set((Array.isArray(f?.evidenceIds) ? f.evidenceIds : [f?.evidenceId]).map((x) => str(x, 20)).filter(Boolean))];
    const valid = requested.filter((id) => ok.has(id));
    const dropped = requested.filter((id) => !ok.has(id));
    if (dropped.length) downgrades.push(`Finding "${statement.slice(0, 60)}…" cited evidence that does not exist or failed: ${dropped.join(', ')}.`);
    const absence = !!f?.absence;

    let basis; let note = null;
    if (!valid.length) {
      basis = claimed === BASIS.UNKNOWN ? BASIS.UNKNOWN : (claimed === BASIS.INFERRED ? BASIS.INFERRED : BASIS.INFERRED);
      note = claimed === BASIS.UNKNOWN ? null : 'No retrieved evidence supports this statement; it is the model\'s inference.';
      if (claimed === BASIS.OBSERVED || claimed === BASIS.CORROBORATED) downgrades.push(`"${statement.slice(0, 60)}…" was claimed as ${claimed} without supporting evidence; treated as an inference.`);
    } else if (absence) {
      const s = absenceSupport(ledger, valid);
      if (!s.supported) { basis = BASIS.UNKNOWN; note = s.reason; downgrades.push(`Absence claim "${statement.slice(0, 60)}…" is not established: ${s.reason}`); }
      else basis = independentCount(valid.map((id) => ok.get(id))) >= 2 ? BASIS.CORROBORATED : BASIS.OBSERVED;
    } else if (claimed === BASIS.INFERRED) {
      basis = BASIS.INFERRED;
    } else if (claimed === BASIS.UNKNOWN) {
      basis = BASIS.UNKNOWN;
    } else {
      basis = independentCount(valid.map((id) => ok.get(id))) >= 2 ? BASIS.CORROBORATED : BASIS.OBSERVED;
      if (claimed === BASIS.CORROBORATED && basis !== BASIS.CORROBORATED) downgrades.push(`"${statement.slice(0, 60)}…" was claimed as corroborated but only one independent source supports it.`);
    }
    // true when the model presented it as established (observed/corroborated) but the evidence does not support that
    const overclaimed = (claimed === BASIS.OBSERVED || claimed === BASIS.CORROBORATED) && (basis === BASIS.UNKNOWN || basis === BASIS.INFERRED);
    findings.push({ statement, basis, claimedBasis: claimed, overclaimed, absence, evidenceIds: valid, sources: [...new Set(valid.map((id) => ok.get(id).source))], note });
  }
  return { findings, downgrades };
}

/** Independent sources = distinct (source, kind-family, view) combinations; raw vs rendered DOM count as different views. */
function independentCount(items) {
  return new Set(items.map((i) => `${i.source}|${i.kind === 'rendered_dom' ? 'rendered' : i.kind === 'page' ? 'raw' : i.kind}`)).size;
}

export default { assessFindings, absenceSupport, renderedStateGap, BASIS };
