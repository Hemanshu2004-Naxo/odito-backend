import React from 'react';
import { Text } from '@react-email/components';
import { BillingLayout, SummaryBlock, CtaButton, InvoiceSection, formatAmount, formatDate } from './BillingLayout.js';

const e = React.createElement;

// Not currently wired to a webhook trigger — this app has no moment
// distinct from "activated" that represents "purchased." Available for a
// future flow where those two moments diverge (e.g. a pending/delayed
// activation). See SubscriptionActivated.js for what actually fires today.
export function SubscriptionPurchased({ firstName, planName, amount, currency, date, invoiceUrl, manageUrl }) {
  const greeting = firstName ? `Hi ${firstName},` : 'Hi there,';
  const safePlanName = planName || 'your plan';
  return e(BillingLayout, { title: 'Subscription Purchased', subtitle: 'Thanks for your purchase', previewText: `You've purchased the ${safePlanName} plan` },
    e(Text, { style: { fontSize: 15, color: '#374151' } }, greeting),
    e(Text, { style: { fontSize: 15, color: '#374151', lineHeight: 1.6 } },
      `Thanks for purchasing the ${safePlanName} plan. Here's your confirmation:`),
    e(SummaryBlock, {
      rows: [
        { label: 'Plan', value: planName },
        { label: 'Amount', value: formatAmount(amount, currency) },
        { label: 'Date', value: date ? formatDate(date) : null },
      ],
    }),
    e(InvoiceSection, { invoiceUrl }),
    e(CtaButton, { href: manageUrl, label: 'Manage Subscription' })
  );
}
