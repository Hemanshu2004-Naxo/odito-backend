import React from 'react';
import { Text } from '@react-email/components';
import { BillingLayout, SummaryBlock } from '../billing/BillingLayout.js';

const e = React.createElement;

const TYPE_LABELS = {
  express_fix: 'Express Fix',
  technical_audit_fix: 'Technical Audit + Fix',
  expert_fix: 'Expert Fix',
};

// Every value is rendered as React text (escaped) — user-written fields never become markup.
export function AuditIqRequestAdminNotification({
  requestType, issueTitle, issueKey, issueCategory, affectedPageCount, pageUrl,
  projectName, projectUrl, contactName, contactEmail, message, requestId,
}) {
  const typeLabel = TYPE_LABELS[requestType] || requestType;

  return e(BillingLayout, {
    title: `New AuditIQ request: ${typeLabel}`,
    subtitle: issueTitle || issueKey || 'A user asked for help with an issue',
    previewText: `${typeLabel} requested for ${issueTitle || issueKey || 'an issue'}`,
  },
    e(SummaryBlock, {
      rows: [
        { label: 'Request type', value: typeLabel },
        { label: 'Issue', value: issueTitle },
        { label: 'Issue key', value: issueKey },
        { label: 'Category', value: issueCategory || null },
        { label: 'Affected pages (as shown to the user)', value: affectedPageCount != null ? `${affectedPageCount}` : null },
        { label: 'Selected page', value: pageUrl || null },
        { label: 'Project', value: projectName },
        { label: 'Website', value: projectUrl },
        { label: 'Contact', value: contactName || null },
        { label: 'Email', value: contactEmail },
        { label: 'Request id', value: requestId },
      ],
    }),
    message
      ? e(Text, { style: { fontSize: 14, color: '#374151', lineHeight: 1.6, marginTop: 12, whiteSpace: 'pre-wrap' } },
        e('strong', null, 'Message from the user: '), message)
      : null
  );
}
