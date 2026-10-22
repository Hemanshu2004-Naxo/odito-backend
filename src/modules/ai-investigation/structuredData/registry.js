/**
 * Structured-data analyzers: plug-ins that derive verified facts for one schema family from the evidence ledger and validate a proposed
 * markup of that family against them. The engine, the master prompt and the response contract stay universal; adding a schema type means
 * adding an analyzer here.
 *
 * analyzer = {
 *   id, schemaTypes: string[],
 *   appliesTo({ issue, plan }) -> boolean,
 *   analyze({ ledger, issue, siteUrl, fetchUrl, project, deps }) -> Promise<{ status, summary, data, derivedFrom }>,   // becomes a `structured_analysis` evidence item
 *   operation?: string                       // what a fix would write (drives capability resolution), e.g. 'address'
 *   ownsProposal?: boolean                   // the SERVER builds the proposal (shapeProposal); a model's draft of it is discarded
 *   shapeProposal?({ analysis, issueStatus }) -> { status, codeOrConfiguration, proposedChanges, implementationPlan, blockers, bindings }
 *   describeChecks?({ analysis }) -> check records for the checklist
 *   validateProposal({ node, analysis }) -> { checks: [{ name, passed, detail }], requiresReview }
 * }
 */
import { breadcrumbAnalyzer } from './breadcrumbAnalyzer.js';
import { organizationAddressAnalyzer } from './organizationAddressAnalyzer.js';

export const ANALYZERS = [breadcrumbAnalyzer, organizationAddressAnalyzer];

export const analyzerById = (id, analyzers = ANALYZERS) => analyzers.find((a) => a.id === id) || null;

export const applicableAnalyzers = (ctx, analyzers = ANALYZERS) => analyzers.filter((a) => a.appliesTo(ctx));
export const analyzersForTypes = (types, analyzers = ANALYZERS) => analyzers.filter((a) => a.schemaTypes.some((t) => types.includes(t)));

export default { ANALYZERS, applicableAnalyzers, analyzersForTypes };
