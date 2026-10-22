/**
 * Draft statuses AI conversational editing (Phase 4) is allowed to touch.
 *
 * Mirrors the frontend's EDITABLE_STATUSES (frontend/lib/aiCampaignConstants.js)
 * — a draft still `generating`, already `publishing`/`published`, or
 * `failed` cannot be edited (manually in Phase 3, or by Claude in Phase 4).
 * Kept as its own tiny constants file (not added to aiCampaignEnums.js) so
 * it's obvious this is a Phase 4-introduced policy, not a Phase 1 domain
 * enum.
 */
export const EDITABLE_DRAFT_STATUSES = ['draft', 'ready', 'validated'];
