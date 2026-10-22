/**
 * Single source of truth for the STRUCTURED OUTPUT contract of a campaign
 * EDIT proposal (Phase 4, spec §15). Sibling of campaignOutputSchema.js
 * (Phase 2) — same idea, different shape: this describes a small set of
 * domain-level CHANGES to an existing campaign, not a whole campaign.
 *
 * The tool schema intentionally keeps `before`/`after` loosely typed (their
 * real shape depends on `target`) — proposalValidator.js is the actual
 * authority on shape, exactly like Phase 2's mapper/strict-validator relate
 * to campaignOutputSchema.js. A `tool_use` result is never trusted just
 * because it matched this schema.
 */

import { PROPOSAL_OPERATIONS, PROPOSAL_TARGETS, PROPOSAL_MAX_CHANGES } from '../constants/proposalEnums.js';

export const EDIT_TOOL_NAME = 'propose_campaign_changes';

export function buildProposalToolSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['explanation', 'changes'],
    properties: {
      explanation: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
        description: 'One or two sentences describing what you are proposing and why, in plain language for a business owner.',
      },
      changes: {
        type: 'array',
        maxItems: PROPOSAL_MAX_CHANGES,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['operation', 'target', 'after', 'reason'],
          properties: {
            operation: { type: 'string', enum: PROPOSAL_OPERATIONS },
            target: { type: 'string', enum: PROPOSAL_TARGETS },
            // Parent identifiers — required for ad-group/ad-scoped targets,
            // omit (or null) for campaign-scalar targets and for AD_GROUP add.
            adGroupId: { type: ['string', 'null'], description: 'Existing ad group id this change applies to, when relevant.' },
            adId: { type: ['string', 'null'], description: 'Existing ad id this change applies to, when relevant (headline/description/finalUrl targets).' },
            // Required for remove/replace (the exact current value to match)
            // — the server rejects a change whose `before` does not match
            // the draft's actual current value.
            before: { description: 'The CURRENT value being removed or replaced. Omit for `add`.' },
            after: { description: 'The NEW value for `add`/`replace`. Omit (null) for `remove`.' },
            reason: { type: 'string', maxLength: 300, description: 'One sentence: why this change helps.' },
          },
        },
      },
    },
  };
}

/** Compact, human-readable rendering of the same contract for the prompt. */
export function renderProposalContractForPrompt() {
  return [
    `Return your result by calling the ${EDIT_TOOL_NAME} tool. Its input MUST be an object with exactly two keys: "explanation" and "changes".`,
    ``,
    `explanation: one or two plain-language sentences summarising the proposal.`,
    ``,
    `changes: an array of up to ${PROPOSAL_MAX_CHANGES} objects, each:`,
    `  - operation: one of ${PROPOSAL_OPERATIONS.join(' | ')}`,
    `  - target: one of ${PROPOSAL_TARGETS.join(' | ')}`,
    `  - adGroupId: the existing ad group id this change belongs to (required for AD_GROUP_NAME/KEYWORD/NEGATIVE_KEYWORD/AD targets and for AD_GROUP "remove"; omit for AD_GROUP "add" and for campaign-level targets)`,
    `  - adId: the existing ad id this change belongs to (required for AD_HEADLINE/AD_DESCRIPTION/AD_FINAL_URL targets)`,
    `  - before: the EXACT current value you are removing or replacing (required for "remove" and "replace"; must match the campaign context exactly — do not paraphrase it)`,
    `  - after: the new value (required for "add" and "replace"; omit/null for "remove")`,
    `  - reason: one sentence explaining the change`,
    ``,
    `Only reference adGroupId / adId values that appear in the campaign context below. Never invent an id.`,
  ].join('\n');
}
