import React from 'react';
import { Text } from '@react-email/components';
import { BillingLayout, SummaryBlock, CtaButton, InvoiceSection, formatAmount, formatDate } from './BillingLayout.js';

const e = React.createElement;

export function PaymentSuccess({ firstName, planName, amount, currency, date, invoiceUrl, manageUrl }) {
  const greeting = firstName ? `Hi ${firstName},` : 'Hi there,';
  const safePlanName = planName || 'your plan';
  return e(BillingLayout, { title: 'Payment Successful', subtitle: 'Thanks for your payment', previewText: 'Your payment was successful' },
    e(Text, { style: { fontSize: 15, color: '#374151' } }, greeting),
    e(Text, { style: { fontSize: 15, color: '#374151', lineHeight: 1.6 } },
      `We've received your payment for the ${safePlanName} plan. Here's your receipt:`),
    e(SummaryBlock, {
      rows: [
        { label: 'Plan', value: planName },
        { label: 'Amount', value: formatAmount(amount, currency) },
        { label: 'Date', value: date ? formatDate(date) : null },
      ],
    }),
    e(InvoiceSection, { invoiceUrl }),
    e(CtaButton, { href: manageUrl, label: 'View Billing History' })
  );
}
