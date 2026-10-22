import mongoose from 'mongoose';

// A short-lived, single-use credential minted only after a FORGOT_PASSWORD
// OTP has been verified (see passwordResetSessionService.js). The OTP
// itself never authorizes a password change directly — this session is the
// only thing that does, and it carries no email/PII in its identifier (the
// token is a random 256-bit value, never the user's email).
const passwordResetSessionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  // SHA-256 hash of the random token handed to the client — the plaintext
  // token is never persisted, mirroring how Otp.otpHash never stores the
  // raw code.
  tokenHash: {
    type: String,
    required: true,
    unique: true,
  },
  expiresAt: {
    type: Date,
    required: true,
  },
  usedAt: {
    type: Date,
    default: null,
  },
  ipAddress: {
    type: String,
    default: null,
  },
  userAgent: {
    type: String,
    default: null,
  },
  isUsed: {
    type: Boolean,
    default: false,
  },
}, {
  timestamps: { createdAt: true, updatedAt: false },
});

// The lookup every validate/consume call runs first.
passwordResetSessionSchema.index({ tokenHash: 1 }, { unique: true });

// Auto-purge once a session expires — a safety net for sessions that were
// never used; successful consumption deletes its own row immediately
// (see consumeResetSession in the service), it doesn't wait for this.
passwordResetSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const PasswordResetSession = mongoose.model('PasswordResetSession', passwordResetSessionSchema);
export default PasswordResetSession;
