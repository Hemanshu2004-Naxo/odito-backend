import React from 'react';
import { Text } from '@react-email/components';
import { BillingLayout, SummaryBlock, CtaButton, InvoiceSection, formatAmount } from './BillingLayout.js';

const e = React.createElement;

export function CreditsPurchased({ firstName, creditsPurchased, amount, currency, invoiceUrl, manageUrl }) {
  const greeting = firstName ? `Hi ${firstName},` : 'Hi there,';
  const previewText = creditsPurchased != null ? `${creditsPurchased} credits added to your account` : 'Your credits have been added';
  return e(BillingLayout, { title: 'Credits Purchased', subtitle: 'Your credits are ready to use', previewText },
    e(Text, { style: { fontSize: 15, color: '#374151' } }, greeting),
    e(Text, { style: { fontSize: 15, color: '#374151', lineHeight: 1.6 } },
      `Your credit purchase was successful. Here's your receipt:`),
    e(SummaryBlock, {
      rows: [
        { label: 'Credits purchased', value: creditsPurchased != null ? `${creditsPurchased}` : null },
        { label: 'Amount', value: formatAmount(amount, currency) },
      ],
    }),
    e(InvoiceSection, { invoiceUrl }),
    e(CtaButton, { href: manageUrl, label: 'View Billing History' })
  );
}
