import React from 'react';
import { Text } from '@react-email/components';
import { BillingLayout, SummaryBlock, CtaButton, InvoiceSection, formatAmount, formatDate } from './BillingLayout.js';

const e = React.createElement;

export function SubscriptionRenewed({ firstName, planName, amount, currency, date, credits, pages, invoiceUrl, manageUrl }) {
  const greeting = firstName ? `Hi ${firstName},` : 'Hi there,';
  const safePlanName = planName || 'your plan';
  return e(BillingLayout, { title: 'Renewal Successful', subtitle: 'Your quota has been refreshed', previewText: 'Your subscription has renewed' },
    e(Text, { style: { fontSize: 15, color: '#374151' } }, greeting),
    e(Text, { style: { fontSize: 15, color: '#374151', lineHeight: 1.6 } },
      `Your ${safePlanName} subscription has renewed and your quota has been refreshed:`),
    e(SummaryBlock, {
      rows: [
        { label: 'Plan', value: planName },
        { label: 'Amount', value: formatAmount(amount, currency) },
        { label: 'Date', value: date ? formatDate(date) : null },
        { label: 'Credits', value: credits != null ? `${credits}` : null },
        { label: 'Pages', value: pages != null ? `${pages}` : null },
      ],
    }),
    e(InvoiceSection, { invoiceUrl }),
    e(CtaButton, { href: manageUrl, label: 'View Billing History' })
  );
}
