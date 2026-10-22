import React from 'react';
import { Text } from '@react-email/components';
import { BillingLayout, SummaryBlock, CtaButton, formatAmount } from './BillingLayout.js';

const e = React.createElement;

// Future-ready — deliberately not wired to any webhook event today
// (invoice.paid / invoice.payment_failed already produce their own
// receipt-style emails). Ready for a future "resend invoice" or "view
// latest invoice" action.
export function InvoiceAvailable({ firstName, planName, amount, currency, invoiceUrl, manageUrl }) {
  const greeting = firstName ? `Hi ${firstName},` : 'Hi there,';
  const safePlanName = planName || 'your plan';
  return e(BillingLayout, { title: 'Invoice Available', subtitle: 'Your latest invoice is ready', previewText: 'A new invoice is available' },
    e(Text, { style: { fontSize: 15, color: '#374151' } }, greeting),
    e(Text, { style: { fontSize: 15, color: '#374151', lineHeight: 1.6 } },
      `A new invoice is available for your ${safePlanName} plan.`),
    e(SummaryBlock, {
      rows: [
        { label: 'Plan', value: planName },
        { label: 'Amount', value: formatAmount(amount, currency) },
      ],
    }),
    e(CtaButton, { href: invoiceUrl || manageUrl, label: 'View Invoice' })
  );
}
