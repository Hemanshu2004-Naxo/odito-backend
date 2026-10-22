import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import 'dotenv/config';
import mongoose from 'mongoose';
import User from '../model/User.js';
import Otp from '../../otp/model/Otp.js';
import { normalizeAuthEmail } from '../utils/authEmail.js';
import {
  register,
  login,
  forgotPassword,
  changePassword,
  verifyResetOtp,
  resetPasswordWithToken,
} from './authService.js';

/**
 * End-to-end (service + real Mongo) proof for the hardening items that only
 * mean something across multiple code paths:
 *   H3 — one canonical email form on write AND every read
 *   M1 — password `select:false` doesn't break the save-heavy flows
 *   §13 — password change / reset bump tokenVersion
 *
 * Each case early-returns (no-op pass) if Mongo is unreachable.
 */
let mongoAvailable = false;
const created = [];

before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
  } catch { mongoAvailable = false; }
});

after(async () => {
  if (!mongoAvailable) return;
  const emails = created.map(normalizeAuthEmail);
  await User.deleteMany({ email: { $in: emails } });
  await Otp.deleteMany({ email: { $in: emails } });
  await mongoose.connection.close();
});

const uniq = (tag) => `${tag}.Dotted+tag-${Date.now()}${Math.random().toString(36).slice(2, 6)}@GMAIL.com`;

describe('H3 — email is stored and looked up with ONE canonical form', () => {
  test('a dotted/+tagged Gmail address registered with odd casing is reachable by every later lookup', async () => {
    if (!mongoAvailable) return;
    const raw = uniq('jane');
    created.push(raw);
    const canonical = normalizeAuthEmail(raw); // trim+lowercase, dots/+tag preserved

    await register({ firstName: 'Jane', lastName: 'Doe', email: `   ${raw} `, password: 'password123', termsAccepted: true });

    // Stored verbatim-canonical (NOT dot-stripped the way normalizeEmail() would have).
    const user = await User.findOne({ email: canonical });
    assert.ok(user, 'user is stored under the canonical email');
    assert.equal(user.email, canonical);
    assert.ok(canonical.includes('.') && canonical.includes('+'), 'dots and +tag were NOT stripped');

    // forgot-password lookup (a different-casing variant) resolves the same user
    // and actually issues a FORGOT_PASSWORD OTP for the canonical address.
    await forgotPassword(raw.toUpperCase());
    const otp = await Otp.findOne({ email: canonical, purpose: 'FORGOT_PASSWORD', isUsed: false });
    assert.ok(otp, 'forgot-password matched the account and issued a code for the canonical email');

    // login lookup (yet another variant) resolves the same account.
    // (email is unverified, so login stops at that check — but reaching it
    // proves the user was found; a wrong email would throw the generic
    // "Invalid email or password." first.)
    await assert.rejects(
      login(`  ${raw.toLowerCase()} `, 'password123'),
      /verify your email/i,
      'login found the account (got the verification gate, not "invalid email or password")',
    );
  });

  test('two registrations that differ only by casing collide on the same account', async () => {
    if (!mongoAvailable) return;
    const raw = uniq('bob');
    created.push(raw);
    await register({ firstName: 'Bob', lastName: 'A', email: raw.toLowerCase(), password: 'password123', termsAccepted: true });
    await assert.rejects(
      register({ firstName: 'Bob', lastName: 'B', email: raw.toUpperCase(), password: 'password123', termsAccepted: true }),
      /already exists/i,
    );
  });
});

describe('M1 — password select:false does not break the save-heavy flows', () => {
  test('findById hides the hash; +password reveals it; a save that never loaded it keeps it intact', async () => {
    if (!mongoAvailable) return;
    const raw = uniq('mia');
    created.push(raw);
    await register({ firstName: 'Mia', lastName: 'X', email: raw, password: 'password123', termsAccepted: true });
    const canonical = normalizeAuthEmail(raw);

    const plain = await User.findOne({ email: canonical });
    assert.equal(plain.password, undefined, 'default query does not load the hash');

    const withPw = await User.findOne({ email: canonical }).select('+password');
    assert.ok(withPw.password && withPw.password.startsWith('$2'), '+password loads the bcrypt hash');

    // Mirrors markEmailVerified() / profile / avatar updates: load without the
    // hash, mutate an unrelated field, save.
    plain.isEmailVerified = true;
    await plain.save();
    const after = await User.findOne({ email: canonical }).select('+password');
    assert.equal(after.password, withPw.password, 'hash survived a save() that never selected it');
    assert.equal(after.isEmailVerified, true);
  });
});

describe('§13 — password change and reset invalidate older tokens via tokenVersion', () => {
  test('changePassword increments tokenVersion', async () => {
    if (!mongoAvailable) return;
    const raw = uniq('cv');
    created.push(raw);
    await register({ firstName: 'Cv', lastName: 'X', email: raw, password: 'password123', termsAccepted: true });
    const canonical = normalizeAuthEmail(raw);
    const before = await User.findOne({ email: canonical });
    assert.equal(before.tokenVersion, 0);

    await changePassword(before._id, 'password123', 'newpassword456');

    const afterDoc = await User.findOne({ email: canonical });
    assert.equal(afterDoc.tokenVersion, 1, 'every previously-issued token for this user is now stale');
  });

  test('resetPasswordWithToken increments tokenVersion (full OTP -> resetToken -> reset flow)', async () => {
    if (!mongoAvailable) return;
    const raw = uniq('rv');
    created.push(raw);
    await register({ firstName: 'Rv', lastName: 'X', email: raw, password: 'password123', termsAccepted: true });
    const canonical = normalizeAuthEmail(raw);
    const u = await User.findOne({ email: canonical });

    // issueOtp is what forgotPassword() calls internally; call it directly
    // only because a test can't read the plaintext code out of an email.
    const { issueOtp } = await import('../../otp/service/otpService.js');
    const code = await issueOtp({ userId: u._id, email: canonical, purpose: 'FORGOT_PASSWORD' });

    // Real service path, with a different-casing email variant on purpose.
    const { resetToken } = await verifyResetOtp(raw.toUpperCase(), code);
    await resetPasswordWithToken(resetToken, 'brandnewpass789');

    const afterDoc = await User.findOne({ email: canonical });
    assert.equal(afterDoc.tokenVersion, 1, 'reset also kills other live sessions');

    // and the new password actually works
    const withPw = await User.findOne({ email: canonical }).select('+password');
    assert.equal(await withPw.comparePassword('brandnewpass789'), true);
  });
});
