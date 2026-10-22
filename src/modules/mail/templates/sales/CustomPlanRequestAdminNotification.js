import React from 'react';
import { Text } from '@react-email/components';
import { BillingLayout, SummaryBlock } from '../billing/BillingLayout.js';

const e = React.createElement;

const FEATURE_LABELS = {
  white_label: 'White-label reports',
  api_access: 'API access',
  sso_saml: 'SSO / SAML',
  dedicated_account_manager: 'Dedicated account manager',
  custom_integrations: 'Custom integrations',
};

const BUDGET_LABELS = {
  not_sure: 'Not sure yet',
  '500_1000': '$500 - $1,000/mo',
  '1000_5000': '$1,000 - $5,000/mo',
  '5000_plus': '$5,000+/mo',
};

const TIMELINE_LABELS = {
  immediately: 'Immediately',
  within_30_days: 'Within 30 days',
  exploring: 'Just exploring',
};

export function CustomPlanRequestAdminNotification({
  companyName, companyWebsite, contactName, contactEmail, contactPhone,
  teamSize, projectCount, requiredCredits, requiredPages,
  featureRequirements, budgetRange, timeline, additionalRequirements,
}) {
  const features = (featureRequirements || []).map((f) => FEATURE_LABELS[f] || f).join(', ');

  return e(BillingLayout, {
    title: 'New Custom Plan Request',
    subtitle: companyName || 'A new lead came in',
    previewText: `New custom plan request from ${companyName || contactName || 'a user'}`,
  },
    e(SummaryBlock, {
      rows: [
        { label: 'Company', value: companyName },
        { label: 'Website', value: companyWebsite },
        { label: 'Contact', value: contactName },
        { label: 'Email', value: contactEmail },
        { label: 'Phone', value: contactPhone },
        { label: 'Team size', value: teamSize },
        { label: 'Projects', value: projectCount != null ? `${projectCount}` : null },
        { label: 'Credits needed', value: requiredCredits != null ? `${requiredCredits}` : null },
        { label: 'Pages needed', value: requiredPages != null ? `${requiredPages}` : null },
        { label: 'Feature requirements', value: features || null },
        { label: 'Budget', value: BUDGET_LABELS[budgetRange] || null },
        { label: 'Timeline', value: TIMELINE_LABELS[timeline] || null },
      ],
    }),
    additionalRequirements
      ? e(Text, { style: { fontSize: 14, color: '#374151', lineHeight: 1.6, marginTop: 12 } },
        e('strong', null, 'Additional notes: '), additionalRequirements)
      : null
  );
}
