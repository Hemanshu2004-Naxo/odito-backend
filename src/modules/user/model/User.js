import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { PASSWORD_MIN_LENGTH } from '../../../config/passwordPolicy.js';
import { buildDefaultAvatarUrl } from '../utils/defaultAvatar.js';

const userSchema = new mongoose.Schema({
  firstName: {
    type: String,
    required: [true, 'Please provide a first name'],
    trim: true,
  },
  lastName: {
    type: String,
    required: [true, 'Please provide a last name'],
    trim: true,
  },
  email: {
    type: String,
    required: [true, 'Please provide an email'],
    unique: true,
    lowercase: true,
  },
  password: {
    type: String,
    required: function () {
      return !this.oauthProvider;
    },
    // Single source of truth for the minimum length — see
    // config/passwordPolicy.js. Was 6, out of sync with the frontend's own
    // 8-character check; unified to 8 here (Phase 2 of the Profile module).
    minlength: [PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`],
    // Never loaded unless a query explicitly asks for it with
    // `.select('+password')`. Before this, a bare `User.findById()` (the
    // auth middleware runs one on every authenticated request) pulled the
    // bcrypt hash into memory / onto `req.user`, one careless
    // `res.json(req.user)` away from leaking every active user's hash.
    // The password-verifying paths (authService.login / changePassword,
    // accountDeletionService) already opt back in with `.select('+password')`.
    // Mongoose does not validate an unselected path on `.save()`, so
    // markEmailVerified()/profile/avatar updates that never load the hash
    // still save fine and never touch it.
    select: false,
  },
  roleId: {
    type: Number,
    required: true,
    enum: [1, 2, 3, 4, 5], // 1: systemadmin, 2: superadmin, 3: admin, 4: agency admin, 5: user
    default: 5,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  avatar: {
    type: String,
    // Same URL format as before (Phase 3 extracted it into
    // utils/defaultAvatar.js so DELETE /auth/avatar can regenerate the
    // identical default without duplicating this string) — schema shape
    // and field name are unchanged.
    default: function() {
      return buildDefaultAvatarUrl(this.firstName, this.lastName);
    }
  },
  lastLogin: {
    type: Date,
  },
  isEmailVerified: {
    type: Boolean,
    default: false,
  },
  oauthProvider: {
    type: String,
    default: null
  },
  oauthProviderId: {
    type: String,
    default: null
  },
  // Session-invalidation counter (NOT the refresh-token architecture — that
  // is a later phase). Every auth JWT carries the value this had at sign
  // time (see tokenService.signAuthToken); the auth middleware rejects a
  // token whose value no longer matches. Bumped by a password change and by
  // a password reset, so those actions kill previously-issued tokens.
  //
  // Backwards compatible on deploy: a document created before this field
  // existed reads back `undefined`, which tokenService.resolveUserTokenVersion()
  // treats as 0 — and every JWT already in the wild has no `tokenVersion`
  // claim, which resolveTokenVersion() also treats as 0. 0 === 0, so no
  // existing web session is invalidated by shipping this. No migration
  // script is required; the default is applied lazily on the next save of
  // each user, and the "absent === 0" rule covers everyone until then.
  tokenVersion: {
    type: Number,
    default: 0,
  },
  // Long-term profile fields (Profile module, Phase 1 — data foundation
  // only). All optional/additive: no existing field renamed or removed.
  // Display name is deliberately NOT a separate field — firstName/lastName
  // remain the single source of truth for how a user is displayed.
  phone: {
    type: String,
    trim: true,
    default: null,
  },
  organization: {
    type: String,
    trim: true,
    default: null,
  },
  website: {
    type: String,
    trim: true,
    default: null,
  },
  // ISO 3166-1 alpha-2 (e.g. "US") — validated at the route layer
  // (profileValidator.js), not here. Unrelated to SeoProject.country,
  // which is a project's SEO target market, not a user's own locale.
  country: {
    type: String,
    trim: true,
    uppercase: true,
    default: null,
  },
  // IANA timezone name (e.g. "America/New_York") — validated at the route
  // layer against Intl.supportedValuesOf('timeZone').
  timezone: {
    type: String,
    trim: true,
    default: null,
  },
  // BCP 47 locale (e.g. "en", "en-US") — validated at the route layer.
  // Unrelated to SeoProject.language, which is a project's SEO target
  // language, not a user's own UI/locale preference.
  language: {
    type: String,
    trim: true,
    default: null,
  },
  // Subscription: plan + status + the two independent usage quotas
  // (credits, pages). `remaining` is never stored — always derive it as
  // `limit - used`. See odito_backend/src/config/plans.js for the single
  // source of truth on plan pricing/limits/features; nothing here hardcodes
  // a credit or page count.
  //
  // Phase 15.6 — Starter is a PAID plan, not a free tier. A newly created
  // user has NO subscription at all: plan=null, status='inactive',
  // credits/pages both {limit:0, used:0}. The ONLY writer of plan/status/
  // quota is the Stripe webhook (subscriptionWebhookService.js's
  // checkout.session.completed handler) plus the explicit admin override
  // tool (adminSubscriptionController.js) — no registration path, no
  // controller, ever grants quota directly. See that webhook service for
  // the activation flow.
  subscription: {
    plan: {
      // `null` must be listed explicitly in the enum — Mongoose's enum
      // validator only skips `undefined`, not `null`, so a bare
      // `default: null` against `enum: ['starter', 'pro', 'premium']` would
      // fail validation on every single user creation.
      type: String,
      enum: ['starter', 'pro', 'premium', null],
      default: null
    },
    status: {
      // 'inactive' = registered, never subscribed (or subscription fully
      // lapsed with nothing left to resume) — distinct from 'canceled'
      // (a subscription that existed and was then cancelled) and from
      // 'past_due' (a real Stripe webhook state, invoice.payment_failed).
      type: String,
      enum: ['inactive', 'active', 'paused', 'canceled', 'past_due'],
      default: 'inactive'
    },
    // Correlates this user to Stripe for webhook event processing — set by
    // checkout.session.completed / customer.subscription.* handlers, read by
    // invoice.paid / invoice.payment_failed to find the right user. Null
    // until the user's first successful checkout.
    // unique+sparse: two Users must never share a Stripe id, but `sparse`
    // excludes documents where the field is still null (every user before
    // their first checkout) from that constraint — otherwise the very
    // first duplicate-null insert would violate a plain unique index.
    // No `default: null` — deliberately. Mongoose persists an explicit
    // `default: null` as a real `null` value in MongoDB, and a sparse index
    // only excludes documents where the field is truly ABSENT, not merely
    // null-valued. With a default, the very first never-subscribed user
    // would claim the index's one-and-only allowed null slot, and every
    // subsequent never-subscribed user's creation would fail with an
    // E11000 duplicate-key error. Omitting the default leaves the field
    // genuinely unset until a webhook handler first $set's a real Stripe
    // id — which is what sparse+unique here actually needs to work.
    stripeCustomerId: {
      type: String,
      unique: true,
      sparse: true,
      index: true
    },
    stripeSubscriptionId: {
      type: String,
      unique: true,
      sparse: true,
      index: true
    },
    // No free quota — a never-subscribed user starts at zero everything.
    // The only place these limits are ever raised from zero is
    // allocateQuotaFromPlan() (creditService.js), called exclusively from
    // the checkout.session.completed webhook handler.
    credits: {
      limit: {
        type: Number,
        default: 0,
        min: 0
      },
      used: {
        type: Number,
        default: 0,
        min: 0
      }
    },
    pages: {
      limit: {
        type: Number,
        default: 0,
        min: 0
      },
      used: {
        type: Number,
        default: 0,
        min: 0
      }
    },
    // Manual Recrawl allowance — same {limit, used} shape as credits/pages,
    // allocated and reset by allocateQuotaFromPlan() (creditService.js).
    // Consumed only by a user-triggered full Recrawl (run source
    // 'manual_recrawl'); Weekly Rechecks and Quick Rechecks never touch it.
    recrawls: {
      limit: {
        type: Number,
        default: 0,
        min: 0
      },
      used: {
        type: Number,
        default: 0,
        min: 0
      }
    }
  },
}, {
  timestamps: true,
});

// System Admin user list (Phase 2C) sorts by name and searches firstName/
// lastName/email via $regex — this compound index speeds up the name-sort
// path and prefix-anchored matches. email already has its own unique index.
userSchema.index({ firstName: 1, lastName: 1 });

userSchema.pre('save', async function(next) {
  // Hash password if modified
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Method to update last login
userSchema.methods.updateLastLogin = async function() {
  this.lastLogin = new Date();
  return this.save();
};

// Method to mark email as verified
userSchema.methods.markEmailVerified = async function() {
  this.isEmailVerified = true;
  return this.save();
};

const User = mongoose.model('User', userSchema);
export default User;
