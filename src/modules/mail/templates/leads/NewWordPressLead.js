import React from 'react';
import { Text } from '@react-email/components';
// Same shared shell as the audit/billing templates — see BillingLayout.js.
// SummaryBlock renders `value` as ordinary React children, so visitor-
// submitted text (name/email/phone/message) is escaped the same way any
// other React-rendered text is — no dangerouslySetInnerHTML anywhere in
// this template or the shell it's built on.
import { BillingLayout, SummaryBlock, CtaButton } from '../billing/BillingLayout.js';

const e = React.createElement;

/**
 * Props are exactly wordPressNotificationService.buildLeadNotificationPayload()'s
 * output — never a raw Lead document. See that function for which fields
 * are intentionally included/excluded.
 */
export function NewWordPressLead({ firstName, projectName, name, email, phone, company, message, formName, pageUrl, receivedAt, dashboardUrl }) {
  const greeting = firstName ? `Hi ${firstName},` : 'Hi there,';
  const safeProjectName = projectName || 'your website';
  return e(BillingLayout, { title: 'New Lead Received', subtitle: 'Someone just contacted you through your website', previewText: `New lead from ${safeProjectName}` },
    e(Text, { style: { fontSize: 15, color: '#374151' } }, greeting),
    e(Text, { style: { fontSize: 15, color: '#374151', lineHeight: 1.6 } },
      `A new lead came in through a form on ${safeProjectName}. Here are the details:`),
    e(SummaryBlock, {
      rows: [
        { label: 'Name', value: name },
        { label: 'Email', value: email },
        { label: 'Phone', value: phone },
        { label: 'Company', value: company },
        { label: 'Message', value: message },
        { label: 'Form', value: formName },
        { label: 'Page', value: pageUrl },
        { label: 'Source', value: 'WordPress' },
        { label: 'Received', value: receivedAt },
      ],
    }),
    e(CtaButton, { href: dashboardUrl, label: 'View Lead in Odito' })
  );
}
