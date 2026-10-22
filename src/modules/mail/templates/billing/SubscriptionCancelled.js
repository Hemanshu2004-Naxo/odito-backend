import React from 'react';
import { Text } from '@react-email/components';
import { BillingLayout, CtaButton } from './BillingLayout.js';

const e = React.createElement;

export function SubscriptionCancelled({ firstName, planName, manageUrl }) {
  const greeting = firstName ? `Hi ${firstName},` : 'Hi there,';
  const safePlanName = planName || 'your plan';
  return e(BillingLayout, { title: 'Subscription Cancelled', subtitle: 'Sorry to see you go', previewText: 'Your subscription has been cancelled' },
    e(Text, { style: { fontSize: 15, color: '#374151' } }, greeting),
    e(Text, { style: { fontSize: 15, color: '#374151', lineHeight: 1.6 } },
      `Your ${safePlanName} subscription has been cancelled. You can resubscribe at any time.`),
    e(CtaButton, { href: manageUrl, label: 'View Subscription' })
  );
}
