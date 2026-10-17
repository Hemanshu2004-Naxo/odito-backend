export const MAIL_TYPES = {
  VERIFY_EMAIL: 'verify_email',
  FORGOT_PASSWORD: 'forgot_password',

  // Billing & transactional (Phase 2) — see mailService.js's
  // TEMPLATE_REGISTRY for which template each of these renders.
  SUBSCRIPTION_PURCHASED: 'subscription_purchased',
  SUBSCRIPTION_ACTIVATED: 'subscription_activated',
  PAYMENT_SUCCESS: 'payment_success',
  PAYMENT_FAILED: 'payment_failed',
  SUBSCRIPTION_RENEWED: 'subscription_renewed',
  SUBSCRIPTION_CANCELLED: 'subscription_cancelled',
  SUBSCRIPTION_RESUMED: 'subscription_resumed',
  INVOICE_AVAILABLE: 'invoice_available',
  CREDITS_PURCHASED: 'credits_purchased',
  ADDITIONAL_PAGES_PURCHASED: 'additional_pages_purchased',

  // Audit (Phase 3)
  AUDIT_COMPLETED: 'audit_completed',

  // Custom Plan requests (Upgrade unification, Phase 4)
  CUSTOM_PLAN_REQUEST_RECEIVED: 'custom_plan_request_received',
  CUSTOM_PLAN_REQUEST_ADMIN_NOTIFICATION: 'custom_plan_request_admin_notification',

  // AuditIQ service requests (issue detail page, AuditIQ tab) — staff notification only
  AUDITIQ_REQUEST_ADMIN_NOTIFICATION: 'auditiq_request_admin_notification',

  // Account deletion (Profile module, Delete Account) — OAuth-only accounts
  // (no password) verify via this OTP instead.
  DELETE_ACCOUNT_OTP: 'delete_account_otp',

  // WordPress Lead Capture (Phase 3C)
  NEW_WORDPRESS_LEAD: 'new_wordpress_lead',
};
