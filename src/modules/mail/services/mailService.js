import React from 'react';
import { render } from '@react-email/render';
import * as resendProvider from '../providers/resendProvider.js';
import { VerifyEmail } from '../templates/auth/VerifyEmail.js';
import { ForgotPassword } from '../templates/auth/ForgotPassword.js';
import { DeleteAccount } from '../templates/auth/DeleteAccount.js';
import { SubscriptionPurchased } from '../templates/billing/SubscriptionPurchased.js';
import { SubscriptionActivated } from '../templates/billing/SubscriptionActivated.js';
import { PaymentSuccess } from '../templates/billing/PaymentSuccess.js';
import { PaymentFailed } from '../templates/billing/PaymentFailed.js';
import { SubscriptionRenewed } from '../templates/billing/SubscriptionRenewed.js';
import { SubscriptionCancelled } from '../templates/billing/SubscriptionCancelled.js';
import { SubscriptionResumed } from '../templates/billing/SubscriptionResumed.js';
import { InvoiceAvailable } from '../templates/billing/InvoiceAvailable.js';
import { CreditsPurchased } from '../templates/billing/CreditsPurchased.js';
import { AdditionalPagesPurchased } from '../templates/billing/AdditionalPagesPurchased.js';
import { AuditCompleted } from '../templates/audit/AuditCompleted.js';
import { NewWordPressLead } from '../templates/leads/NewWordPressLead.js';
import { CustomPlanRequestReceived } from '../templates/sales/CustomPlanRequestReceived.js';
import { CustomPlanRequestAdminNotification } from '../templates/sales/CustomPlanRequestAdminNotification.js';
import { AuditIqRequestAdminNotification } from '../templates/sales/AuditIqRequestAdminNotification.js';
import { MAIL_TYPES } from '../constants/emailTypes.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

// Resend's own sandbox sender — used only if EMAIL_FROM_ADDRESS isn't set.
// In production EMAIL_FROM_ADDRESS must be an address on a domain verified
// in the Resend dashboard, or delivery will fail.
const FROM_ADDRESS = process.env.EMAIL_FROM_ADDRESS || 'onboarding@resend.dev';

// The single provider currently wired up. Callers never import
// resendProvider (or the `resend` package) directly — only this file does.
// Swapping providers means changing this one assignment.
const provider = resendProvider;

// type -> {subject, Component}. This is the only place that knows which
// template a type maps to, or what shape of `data` that template expects
// (VerifyEmail/ForgotPassword both happen to take {firstName, otp}, but
// mailService itself never references "otp" or "firstName" — it just
// forwards `data` as props). Adding a new mail type is adding one entry
// here, never touching sendMail() itself.
const TEMPLATE_REGISTRY = {
  [MAIL_TYPES.VERIFY_EMAIL]: { subject: 'Verify your email — Odito', Component: VerifyEmail },
  [MAIL_TYPES.FORGOT_PASSWORD]: { subject: 'Reset your password — Odito', Component: ForgotPassword },

  // Billing & transactional (Phase 2)
  [MAIL_TYPES.SUBSCRIPTION_PURCHASED]: { subject: 'Subscription purchased — Odito', Component: SubscriptionPurchased },
  [MAIL_TYPES.SUBSCRIPTION_ACTIVATED]: { subject: 'Your plan is now active — Odito', Component: SubscriptionActivated },
  [MAIL_TYPES.PAYMENT_SUCCESS]: { subject: 'Payment successful — Odito', Component: PaymentSuccess },
  [MAIL_TYPES.PAYMENT_FAILED]: { subject: 'Action needed: payment failed — Odito', Component: PaymentFailed },
  [MAIL_TYPES.SUBSCRIPTION_RENEWED]: { subject: 'Your subscription has renewed — Odito', Component: SubscriptionRenewed },
  [MAIL_TYPES.SUBSCRIPTION_CANCELLED]: { subject: 'Your subscription has been cancelled — Odito', Component: SubscriptionCancelled },
  [MAIL_TYPES.SUBSCRIPTION_RESUMED]: { subject: 'Your subscription has resumed — Odito', Component: SubscriptionResumed },
  [MAIL_TYPES.INVOICE_AVAILABLE]: { subject: 'A new invoice is available — Odito', Component: InvoiceAvailable },
  [MAIL_TYPES.CREDITS_PURCHASED]: { subject: 'Credits purchased — Odito', Component: CreditsPurchased },
  [MAIL_TYPES.ADDITIONAL_PAGES_PURCHASED]: { subject: 'Additional pages purchased — Odito', Component: AdditionalPagesPurchased },

  // Audit (Phase 3)
  [MAIL_TYPES.AUDIT_COMPLETED]: { subject: 'Your website audit is complete — Odito', Component: AuditCompleted },

  // WordPress Lead Capture (Phase 3C)
  [MAIL_TYPES.NEW_WORDPRESS_LEAD]: { subject: 'New lead received from your website — Odito', Component: NewWordPressLead },

  // Custom Plan requests (Upgrade unification, Phase 4)
  [MAIL_TYPES.CUSTOM_PLAN_REQUEST_RECEIVED]: { subject: 'We received your custom plan request — Odito', Component: CustomPlanRequestReceived },
  [MAIL_TYPES.CUSTOM_PLAN_REQUEST_ADMIN_NOTIFICATION]: { subject: 'New Custom Plan Request', Component: CustomPlanRequestAdminNotification },

  // AuditIQ service requests
  [MAIL_TYPES.AUDITIQ_REQUEST_ADMIN_NOTIFICATION]: { subject: 'New AuditIQ service request', Component: AuditIqRequestAdminNotification },

  // Account deletion
  [MAIL_TYPES.DELETE_ACCOUNT_OTP]: { subject: 'Confirm account deletion — Odito', Component: DeleteAccount },
};

/**
 * The single send path for every transactional email this module knows
 * about. Callers (e.g. authService.js) only ever provide a type, a
 * recipient, and template data — no provider detail, no subject line, no
 * business logic about what the email is for.
 * @param {string} type - one of MAIL_TYPES
 * @param {string} to - recipient email address
 * @param {object} data - template-specific display fields, passed through
 *   untouched as the template component's props
 * @returns {Promise<boolean>} whether the email was actually sent
 */
export async function sendMail(type, to, data = {}) {
  const entry = TEMPLATE_REGISTRY[type];
  if (!entry) {
    LoggerUtil.error('sendMail: unknown mail type', new Error(`Unknown mail type "${type}"`), { type, to });
    return false;
  }

  const html = await render(React.createElement(entry.Component, data));

  try {
    await provider.send({ to, subject: entry.subject, html, from: FROM_ADDRESS });
    LoggerUtil.info('Email sent', { type, to });
    return true;
  } catch (error) {
    LoggerUtil.error('Failed to send email', error, { type, to });
    return false;
  }
}
