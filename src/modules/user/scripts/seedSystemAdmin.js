/**
 * Development seed: default System Admin account.
 *
 * Creates ONE roleId=1 (System Admin) user for local testing. Standalone
 * utility only — never imported or invoked by server.js, auth.js,
 * authService.js, or any registration/login code path. Registration still
 * always hardcodes roleId:5 (see authService.js's register()); this script
 * is the only place a roleId=1 account is ever created outside a manual DB
 * edit.
 *
 * Idempotent: looks the account up by email first and does nothing if it
 * already exists (never overwrites password/role/anything on a second
 * run). Password is hashed by User.js's own pre('save') hook
 * (bcrypt, cost 12) — the exact same code path every normal user's
 * password goes through, not a re-implementation.
 *
 * Refuses to run when NODE_ENV=production. Never runs automatically —
 * invoke it explicitly:
 *   npm run seed:system-admin
 *   node src/modules/user/scripts/seedSystemAdmin.js
 */

import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import connectDB from '../../../config/database.js';
import User from '../model/User.js';

const SYSTEM_ADMIN_EMAIL = 'systemadmin@gmail.com';

async function seedSystemAdmin() {
  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to run: NODE_ENV=production. This seed script is for local development only.');
    process.exit(1);
  }

  await connectDB();

  try {
    const existing = await User.findOne({ email: SYSTEM_ADMIN_EMAIL });

    if (existing) {
      console.log('System Admin already exists.');
      return;
    }

    // subscription is deliberately omitted — User.js's own schema defaults
    // (plan:null, status:'inactive', credits/pages {limit:0,used:0}) are
    // already the "never consumes credits" safe minimum, the same state
    // every newly-registered user starts in. No need to restate them here.
    await User.create({
      firstName: 'System',
      lastName: 'Administrator',
      email: SYSTEM_ADMIN_EMAIL,
      password: '12345678', // hashed by the pre('save') hook — never stored plaintext
      roleId: 1,
      isActive: true,
      isEmailVerified: true,
    });

    console.log('✓ Default System Admin created');
    console.log('');
    console.log('Email:');
    console.log(SYSTEM_ADMIN_EMAIL);
  } finally {
    await mongoose.disconnect();
  }
}

seedSystemAdmin().catch((error) => {
  console.error('Failed to seed System Admin:', error);
  process.exit(1);
});
