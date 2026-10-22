import React from 'react';
import { Text } from '@react-email/components';
import { BillingLayout, CtaButton } from './BillingLayout.js';

const e = React.createElement;

export function SubscriptionResumed({ firstName, planName, manageUrl }) {
  const greeting = firstName ? `Hi ${firstName},` : 'Hi there,';
  const safePlanName = planName || 'your plan';
  return e(BillingLayout, { title: 'Subscription Resumed', subtitle: 'Welcome back!', previewText: 'Your subscription has resumed' },
    e(Text, { style: { fontSize: 15, color: '#374151' } }, greeting),
    e(Text, { style: { fontSize: 15, color: '#374151', lineHeight: 1.6 } },
      `Good news — your ${safePlanName} subscription is active again.`),
    e(CtaButton, { href: manageUrl, label: 'Manage Subscription' })
  );
}
