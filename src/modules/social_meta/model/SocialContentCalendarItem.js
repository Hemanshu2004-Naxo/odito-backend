import mongoose from 'mongoose';

/**
 * SocialContentCalendarItem — ONE planned post of a content calendar version. Planning data: what the post is about
 * (topic, angle, hook, objective, KPI, CTA, creative direction, assets, review notes) plus, optionally, a person's own
 * planning copy (caption, hashtags, per-platform copy) and chosen product images. The AI plan never writes those; the
 * real caption of a post and its design are made later, from an approved item, by the existing content / design
 * generation and approval workflow, and live on the SocialPublication - never here.
 *
 * `status` is the PLANNING state. It deliberately does not duplicate SocialPublication: once an item becomes a real
 * publication it points at it through `publicationIds`, and the publication's own state is the source of truth for
 * review / scheduled / published.
 *
 * An item can target more than one platform (`platforms`); each platform later becomes its own publication.
 * `serviceName` / `productName` are copied at planning time purely for display, so an item still reads correctly
 * if the service or product is later renamed or deleted; `serviceId` / `productId` are the references.
 */
// `status` is the PLANNING state of the item: planned (as generated) -> edited (the user changed it) -> plan_approved (the
// user approved the PLAN) -> content_generated (a draft publication exists). Everything after that (content / design
// review, approved, scheduled, published) belongs to the linked SocialPublication; the API derives `effectiveStatus` from it.
// Approving the plan never approves content or design and never makes a publication publishable.
export const CALENDAR_ITEM_STATUSES = ['planned', 'edited', 'plan_approved', 'draft', 'content_generated', 'content_review', 'design_review', 'approved', 'scheduled', 'published', 'cancelled'];
export const CALENDAR_FORMATS = ['static_post', 'carousel', 'reel', 'video', 'text_post'];
export const ASSET_TYPES = ['product_image', 'logo', 'team_photo', 'customer_photo', 'testimonial', 'screenshot', 'stock_photo', 'video_clip', 'infographic'];

const socialContentCalendarItemSchema = new mongoose.Schema({
  project_id: { type: mongoose.Schema.Types.ObjectId, ref: 'SeoProject', required: true },
  calendar_id: { type: mongoose.Schema.Types.ObjectId, ref: 'SocialContentCalendar', required: true },

  // pinned provenance (denormalised from the calendar so an item is self-describing)
  strategyId: { type: mongoose.Schema.Types.ObjectId, ref: 'SocialAIStrategy', required: true },
  strategyVersion: { type: Number, required: true },
  profileSnapshotHash: { type: String, default: null },

  order: { type: Number, required: true, min: 0 },
  // The planner's slot number of a GENERATED item (absent on a hand-added one). Together with calendar_id it is unique, which is
  // what makes saving a batch idempotent: a retried batch can never create a second item for a slot.
  slot: { type: Number, min: 0 },
  contentDate: { type: String, required: true }, // YYYY-MM-DD
  dayOfWeek: { type: String, required: true },
  platforms: { type: [String], required: true },
  format: { type: String, enum: CALENDAR_FORMATS, required: true },
  deliverable: { type: String, default: '', maxlength: 100 },

  contentPillar: { type: String, required: true, maxlength: 100 },
  contentType: { type: String, required: true, maxlength: 40 }, // a strategy content-mix type; what the post generator calls its "objective"
  objective: { type: String, required: true, maxlength: 40 }, // the marketing objective
  primaryKpi: { type: String, required: true, maxlength: 40 },
  targetAudience: { type: String, default: '', maxlength: 160 },

  serviceId: { type: mongoose.Schema.Types.ObjectId, default: null },
  serviceName: { type: String, default: null, maxlength: 150 },
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'SocialProduct', default: null },
  productName: { type: String, default: null, maxlength: 150 },

  occasion: { type: String, default: '', maxlength: 120 },
  topic: { type: String, required: true, maxlength: 150 },
  angle: { type: String, default: '', maxlength: 200 },
  hook: { type: String, default: '', maxlength: 200 },
  hookRef: { type: Number, default: null },
  onCreativeText: { type: String, default: '', maxlength: 120 },
  creativeDirection: { type: String, default: '', maxlength: 360 },
  contentBrief: { type: String, default: '', maxlength: 380 },
  captionDirection: { type: String, default: '', maxlength: 260 },
  primaryCta: { type: String, default: '', maxlength: 80 },
  engagementPrompt: { type: String, default: '', maxlength: 160 },
  requiredAssets: { type: [String], default: [] },

  requiresReview: { type: Boolean, default: false },
  approvalNotes: { type: String, default: '', maxlength: 260 },
  footerDisclaimer: { type: String, default: '', maxlength: 200 },

  // The user's own planned copy. Optional: the AI plan only carries a caption DIRECTION. The caption of an actual post
  // is written later by the content generator into a SocialPublication; this is the user's planning copy.
  caption: { type: String, default: '', maxlength: 3000 },
  hashtags: { type: [String], default: [] }, // '#tag' form, validated by the item service
  // Platform-specific copy for the platforms this item targets. A blank field falls back to the shared one.
  platformContent: {
    type: [new mongoose.Schema({
      platform: { type: String, required: true },
      caption: { type: String, default: '', maxlength: 3000 },
      primaryCta: { type: String, default: '', maxlength: 80 },
      hashtags: { type: [String], default: [] },
    }, { _id: false })],
    default: [],
  },
  // Product images (SocialProduct.images[].mediaId) chosen for the later design step. References only - never a copy of a file.
  selectedMediaIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },

  status: { type: String, enum: CALENDAR_ITEM_STATUSES, default: 'planned' },
  planApprovedAt: { type: Date, default: null },
  planApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  // Which fields a person has changed (so an AI regeneration never silently overwrites them).
  editedFields: { type: [String], default: [] },
  isManual: { type: Boolean, default: false },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  // Optimistic concurrency: every write names the revision it was based on and bumps it.
  revision: { type: Number, default: 0, min: 0 },
  publicationIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
}, {
  timestamps: true,
  strict: true,
  collection: 'social_content_calendar_items',
});

// one generated item per slot of a calendar (partial: hand-added items have no slot)
socialContentCalendarItemSchema.index({ calendar_id: 1, slot: 1 }, { unique: true, partialFilterExpression: { slot: { $type: 'number' } }, name: 'unique_calendar_item_slot' });
// the calendar view: one calendar's items in date order
socialContentCalendarItemSchema.index({ project_id: 1, calendar_id: 1, order: 1 }, { name: 'calendar_item_by_calendar' });
// "what is planned on / around a date" across versions
socialContentCalendarItemSchema.index({ project_id: 1, contentDate: 1 }, { name: 'calendar_item_by_date' });
// the plan in date order (an edited date moves an item), and "which item produced this publication"
socialContentCalendarItemSchema.index({ project_id: 1, calendar_id: 1, contentDate: 1, order: 1 }, { name: 'calendar_item_by_calendar_date' });
socialContentCalendarItemSchema.index({ project_id: 1, publicationIds: 1 }, { name: 'calendar_item_by_publication' });

const SocialContentCalendarItem = mongoose.model('SocialContentCalendarItem', socialContentCalendarItemSchema);
export default SocialContentCalendarItem;
