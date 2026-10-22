import React from 'react';
import { Text } from '@react-email/components';
// Reuses the same shared shell/blocks as the billing templates — same
// design philosophy, zero duplicated layout HTML. See BillingLayout.js.
import { BillingLayout, SummaryBlock, CtaButton } from '../billing/BillingLayout.js';

const e = React.createElement;

export function CustomPlanRequestReceived({ firstName, companyName, teamSize, projectCount, manageUrl }) {
  const greeting = firstName ? `Hi ${firstName},` : 'Hi there,';
  return e(BillingLayout, {
    title: 'Request Received',
    subtitle: 'Our team will be in touch shortly',
    previewText: `We received your custom plan request for ${companyName || 'your team'}`,
  },
    e(Text, { style: { fontSize: 15, color: '#374151' } }, greeting),
    e(Text, { style: { fontSize: 15, color: '#374151', lineHeight: 1.6 } },
      `Thanks for telling us about your needs. Our sales team will review your request and reach out within one business day.`),
    e(SummaryBlock, {
      rows: [
        { label: 'Company', value: companyName },
        { label: 'Team size', value: teamSize },
        { label: 'Projects', value: projectCount != null ? `${projectCount}` : null },
      ],
    }),
    e(Text, { style: { fontSize: 13, color: '#6b7280', lineHeight: 1.6 } },
      `In the meantime, you can keep using your current plan — nothing about your account changes until your custom plan is finalized.`),
    e(CtaButton, { href: manageUrl, label: 'View Subscription' })
  );
}
