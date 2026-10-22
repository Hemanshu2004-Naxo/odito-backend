import mongoose from 'mongoose';

// Reused across every OTP-driven flow in the app — not just auth. Adding a
// new purpose (e.g. LOGIN_2FA) never requires a new collection or a new
// service, only a new entry here and a new caller.
export const OTP_PURPOSES = [
  'EMAIL_VERIFICATION',
  'FORGOT_PASSWORD',
  'LOGIN_2FA',
  'CHANGE_EMAIL',
  'DELETE_ACCOUNT',
];

const otpSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  email: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
  },
  purpose: {
    type: String,
    required: true,
    enum: OTP_PURPOSES,
  },
  otpHash: {
    type: String,
    required: true,
  },
  expiresAt: {
    type: Date,
    required: true,
  },
  attempts: {
    type: Number,
    default: 0,
  },
  cooldownUntil: {
    type: Date,
    default: null,
  },
  isUsed: {
    type: Boolean,
    default: false,
  },
}, {
  timestamps: { createdAt: true, updatedAt: false },
});

// The query every issueOtp()/verifyOtp() call runs first: "give me the
// newest not-yet-used code for this email+purpose".
otpSchema.index({ email: 1, purpose: 1, createdAt: -1 });

// Auto-purge once a code has expired — no separate cleanup job to maintain.
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const Otp = mongoose.model('Otp', otpSchema);
export default Otp;
