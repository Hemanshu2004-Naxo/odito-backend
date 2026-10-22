import React from 'react';
import { Text } from '@react-email/components';
import { BillingLayout, SummaryBlock, CtaButton } from './BillingLayout.js';

const e = React.createElement;

export function SubscriptionActivated({ firstName, planName, credits, pages, manageUrl }) {
  const greeting = firstName ? `Hi ${firstName},` : 'Hi there,';
  const safePlanName = planName || 'your plan';
  return e(BillingLayout, { title: 'Subscription Activated', subtitle: 'Welcome aboard!', previewText: `Your ${safePlanName} plan is now active` },
    e(Text, { style: { fontSize: 15, color: '#374151' } }, greeting),
    e(Text, { style: { fontSize: 15, color: '#374151', lineHeight: 1.6 } },
      `Your ${safePlanName} subscription is now active. Here's what's included this billing period:`),
    e(SummaryBlock, {
      rows: [
        { label: 'Plan', value: planName },
        { label: 'Credits', value: credits != null ? `${credits}` : null },
        { label: 'Pages', value: pages != null ? `${pages}` : null },
      ],
    }),
    e(CtaButton, { href: manageUrl, label: 'Manage Subscription' })
  );
}
