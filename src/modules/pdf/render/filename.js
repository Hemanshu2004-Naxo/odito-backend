/**
 * Safe, deterministic attachment filename:
 *   odito-full-audit-<project>-audit<N>-<YYYY-MM-DD>.pdf
 * Only [a-z0-9-] survive, so no user input can inject header syntax.
 */
export function slugify(input, max = 40) {
  const s = String(input ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return s || 'project';
}

export function buildPdfFilename({ projectName, domain, auditNumber, date }) {
  const d = date ? new Date(date) : new Date();
  const day = Number.isNaN(d.getTime()) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
  const parts = ['odito-full-audit', slugify(domain || projectName)];
  if (Number.isInteger(auditNumber) && auditNumber > 0) parts.push(`audit${auditNumber}`);
  parts.push(day);
  return `${parts.join('-')}.pdf`;
}
