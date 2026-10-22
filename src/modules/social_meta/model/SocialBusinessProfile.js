import mongoose from 'mongoose';

/**
 * SocialBusinessProfile — the USER-ENTERED half of the Social Media AI
 * business profile. One small document per project.
 *
 * It deliberately stores NOTHING that another part of Odito already owns.
 * Google-managed business facts (name, phone, address, category, hours,
 * rating, reviews, photos, Google ids) live in BusinessProfileMetadata /
 * BusinessProfileReview / BusinessProfileMedia / GoogleConnection, and the
 * project's own data lives on SeoProject. socialBusinessProfileResolver.js
 * reads all of those at request time and layers THIS document on top.
 *
 * `overrides` is the one place a business fact is stored here, and only
 * because the user typed it on purpose ("use this phone number for social
 * content"). An override never touches Google and never touches SeoProject;
 * it only changes what the Social AI resolver returns, and it is labelled
 * `social_override` so nobody mistakes it for Google data.
 *
 * Bounds (array sizes / string lengths) are enforced by
 * socialBusinessProfileService.js before anything reaches this schema; the
 * schema's own maxlength values are a second line of defence.
 */
const offerSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  description: { type: String, default: '', trim: true, maxlength: 500 },
  url: { type: String, default: null, trim: true, maxlength: 500 },
}, { _id: false });

const competitorSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  website: { type: String, default: null, trim: true, maxlength: 500 },
}, { _id: false });

export const BUSINESS_MODELS = Object.freeze(['service', 'product']);
export const SERVICE_STATUSES = Object.freeze(['active', 'draft', 'archived']);

// A service the business provides. Embedded (a business has a handful, not thousands) and given a stable `_id`
// so a future content-calendar item can reference it as `serviceId`. Products are different: they carry images
// and can number in the dozens, so they live in their own collection (SocialProduct).
const serviceSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 150 },
  description: { type: String, default: '', trim: true, maxlength: 1000 },
  category: { type: String, default: null, trim: true, maxlength: 100 },
  features: { type: [String], default: [] },
  benefits: { type: [String], default: [] },
  serviceUrl: { type: String, default: null, trim: true, maxlength: 500 },
  tags: { type: [String], default: [] },
  status: { type: String, enum: SERVICE_STATUSES, default: 'active' },
}, { timestamps: false });

const socialBusinessProfileSchema = new mongoose.Schema({
  project_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SeoProject',
    required: true,
    unique: true,
  },

  // What the business primarily is. null = "not chosen yet" — never guessed. It only decides whether the
  // Services or the Product Catalog experience is offered and what the AI is told; a service business may
  // still mention products and vice versa.
  businessModel: { type: String, enum: [...BUSINESS_MODELS, null], default: null },

  services: { type: [serviceSchema], default: [] },

  audience: {
    primary: { type: String, default: null, trim: true, maxlength: 500 },
    secondary: { type: [String], default: [] },
  },

  toneOfVoice: {
    primary: { type: String, default: null, trim: true, maxlength: 200 },
    secondary: { type: [String], default: [] },
  },

  goals: { type: [String], default: [] },
  uniqueSellingPoints: { type: [String], default: [] },
  offers: { type: [offerSchema], default: [] },
  competitors: { type: [competitorSchema], default: [] },

  // The Brand Kit the user defines by hand. null / [] = "the user has not chosen one" — never a made-up default.
  // (Tone of voice, unique selling points and phrases to avoid are the top-level fields of this document; the
  // Brand Kit screens edit those same fields rather than keeping a second copy.)
  brand: {
    primaryColor: { type: String, default: null },
    secondaryColor: { type: String, default: null },
    accentColor: { type: String, default: null },
    fontHeading: { type: String, default: null, maxlength: 60 },
    fontBody: { type: String, default: null, maxlength: 60 },
    name: { type: String, default: null, maxlength: 100 },
    description: { type: String, default: null, maxlength: 500 },
    voice: { type: String, default: null, maxlength: 300 },
    personality: { type: [String], default: [] },
    tagline: { type: String, default: null, maxlength: 150 },
    keyMessages: { type: [String], default: [] },
    preferredWords: { type: [String], default: [] },
    additionalInstructions: { type: String, default: null, maxlength: 1000 },
    // The logo the user uploaded (written only by the logo upload endpoint, never by the profile PUT). The file
    // lives in the shared social media storage; `storageKey` is internal and is never returned by the API.
    logo: {
      url: { type: String, default: null, maxlength: 600 },
      storageKey: { type: String, default: null, maxlength: 200 },
      mimeType: { type: String, default: null, maxlength: 40 },
      width: { type: Number, default: null },
      height: { type: Number, default: null },
      size: { type: Number, default: null },
      updatedAt: { type: Date, default: null },
    },
  },

  prohibitedPhrases: { type: [String], default: [] },
  contentPillars: { type: [String], default: [] },
  additionalInstructions: { type: String, default: '', maxlength: 2000 },

  overrides: {
    businessName: { type: String, default: null, maxlength: 150 },
    description: { type: String, default: null, maxlength: 1000 },
    category: { type: String, default: null, maxlength: 150 },
    phone: { type: String, default: null, maxlength: 40 },
    website: { type: String, default: null, maxlength: 500 },
    address: { type: String, default: null, maxlength: 300 },
    city: { type: String, default: null, maxlength: 100 },
    region: { type: String, default: null, maxlength: 100 },
    country: { type: String, default: null, maxlength: 100 },
    postalCode: { type: String, default: null, maxlength: 20 },
    secondaryCategories: { type: [String], default: undefined },
    // string (e.g. "Greater Manchester") or a short list of place names
    serviceArea: { type: mongoose.Schema.Types.Mixed, default: null },
  },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, {
  timestamps: true,
  // Never let an unknown key (e.g. a Google id) be persisted by accident.
  strict: true,
});

const SocialBusinessProfile = mongoose.model('SocialBusinessProfile', socialBusinessProfileSchema);
export default SocialBusinessProfile;
