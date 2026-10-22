import React from 'react';
import { Text } from '@react-email/components';
import { BillingLayout, SummaryBlock, CtaButton, InvoiceSection, formatAmount } from './BillingLayout.js';

const e = React.createElement;

export function AdditionalPagesPurchased({ firstName, pagesPurchased, amount, currency, invoiceUrl, manageUrl }) {
  const greeting = firstName ? `Hi ${firstName},` : 'Hi there,';
  const previewText = pagesPurchased != null ? `${pagesPurchased} pages added to your account` : 'Your pages have been added';
  return e(BillingLayout, { title: 'Additional Pages Purchased', subtitle: 'Your pages are ready to use', previewText },
    e(Text, { style: { fontSize: 15, color: '#374151' } }, greeting),
    e(Text, { style: { fontSize: 15, color: '#374151', lineHeight: 1.6 } },
      `Your page purchase was successful. Here's your receipt:`),
    e(SummaryBlock, {
      rows: [
        { label: 'Pages purchased', value: pagesPurchased != null ? `${pagesPurchased}` : null },
        { label: 'Amount', value: formatAmount(amount, currency) },
      ],
    }),
    e(InvoiceSection, { invoiceUrl }),
    e(CtaButton, { href: manageUrl, label: 'View Billing History' })
  );
}
