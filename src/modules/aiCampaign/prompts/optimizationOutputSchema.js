import { OPTIMIZATION_OPERATIONS, RISK_LEVELS } from '../constants/optimizationEnums.js';

/**
 * Structured-output contract for Claude optimization recommendations
 * (Phase 7, spec §15). Same philosophy as Phase 2/4's tool schemas: Claude
 * emits exactly this shape via a forced tool_choice; nothing here is ever
 * trusted as-is — recommendationValidator.js re-checks every field against
 * the real opportunities/entities before anything is persisted as an
 * executable recommendation.
 */

export const OPTIMIZATION_TOOL_NAME = 'emit_optimization_recommendations';

export function buildOptimizationToolSchema() {
  return {
    type: 'object',
    properties: {
      recommendations: {
        type: 'array',
        description: 'Proposed optimization actions, each responding to one or more of the supplied opportunities. Never invent an opportunity or entity not supplied in the input.',
        items: {
          type: 'object',
          properties: {
            opportunityIndexes: {
              type: 'array',
              description: 'Zero-based indexes into the supplied opportunities array that this recommendation responds to. Must reference at least one.',
              items: { type: 'integer', minimum: 0 },
            },
            operation: {
              type: 'string',
              description: 'The proposed action, from the allowed operation vocabulary only.',
              enum: OPTIMIZATION_OPERATIONS,
            },
            reason: {
              type: 'string',
              description: 'Plain-language rationale citing the supplied metrics/baseline. Never a guarantee of outcome — phrase impact as an estimate ("may improve", "worth testing").',
            },
            expectedImpact: {
              type: 'string',
              description: 'A brief, hedged estimate of the likely effect. Never "will" or "guarantees" — always "may"/"likely"/"could".',
            },
            negativeKeywordText: {
              type: 'string',
              description: 'Only for ADD_NEGATIVE_KEYWORD: the exact search term text to exclude, copied verbatim from the supplied negative-keyword candidate.',
            },
          },
          required: ['opportunityIndexes', 'operation', 'reason', 'expectedImpact'],
        },
      },
    },
    required: ['recommendations'],
  };
}

export const ALLOWED_RISK_LEVELS = RISK_LEVELS;

export default { OPTIMIZATION_TOOL_NAME, buildOptimizationToolSchema };
