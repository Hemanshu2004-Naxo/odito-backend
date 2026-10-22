import React from 'react';
import { Text } from '@react-email/components';
import { BillingLayout, SummaryBlock, CtaButton, formatAmount } from './BillingLayout.js';

const e = React.createElement;

export function PaymentFailed({ firstName, planName, amount, currency, manageUrl }) {
  const greeting = firstName ? `Hi ${firstName},` : 'Hi there,';
  const safePlanName = planName || 'your plan';
  return e(BillingLayout, { title: 'Payment Failed', subtitle: 'We could not process your payment', previewText: 'Action needed: payment failed' },
    e(Text, { style: { fontSize: 15, color: '#374151' } }, greeting),
    e(Text, { style: { fontSize: 15, color: '#374151', lineHeight: 1.6 } },
      `We weren't able to process your payment for the ${safePlanName} plan. Please update your payment method to avoid interruption.`),
    e(SummaryBlock, {
      rows: [
        { label: 'Plan', value: planName },
        { label: 'Amount due', value: formatAmount(amount, currency) },
      ],
    }),
    e(CtaButton, { href: manageUrl, label: 'Update Payment Method' })
  );
}
