import React from 'react';
import { Text } from '@react-email/components';
// Reuses the same shared shell/blocks as the billing templates — same
// design philosophy, zero duplicated layout HTML. See BillingLayout.js.
import { BillingLayout, SummaryBlock, CtaButton, formatDate } from '../billing/BillingLayout.js';

const e = React.createElement;

export function AuditCompleted({ firstName, projectName, websiteUrl, auditStatus, pagesCrawled, pagesAnalyzed, issuesFound, auditDate, dashboardUrl }) {
  const greeting = firstName ? `Hi ${firstName},` : 'Hi there,';
  const safeProjectName = projectName || 'your website';
  return e(BillingLayout, { title: 'Website Audit Completed', subtitle: 'Your report is ready', previewText: `Your audit for ${safeProjectName} has completed` },
    e(Text, { style: { fontSize: 15, color: '#374151' } }, greeting),
    e(Text, { style: { fontSize: 15, color: '#374151', lineHeight: 1.6 } },
      `Your website audit for ${safeProjectName} has completed. Here's a summary:`),
    e(SummaryBlock, {
      rows: [
        { label: 'Website', value: websiteUrl },
        { label: 'Audit Status', value: auditStatus },
        { label: 'Pages Crawled', value: pagesCrawled != null ? `${pagesCrawled}` : null },
        { label: 'Pages Analyzed', value: pagesAnalyzed != null ? `${pagesAnalyzed}` : null },
        { label: 'Issues Found', value: issuesFound != null ? `${issuesFound}` : null },
        { label: 'Audit Date', value: auditDate ? formatDate(auditDate) : null },
      ],
    }),
    e(CtaButton, { href: dashboardUrl, label: 'Open Audit Dashboard' })
  );
}
