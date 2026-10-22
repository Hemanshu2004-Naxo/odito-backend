import React from 'react';
import { Html, Head, Preview, Body, Container, Img, Heading, Text, Section, Hr, Button } from '@react-email/components';

// See auth/VerifyEmail.js for why this uses React.createElement instead of
// JSX (plain Node ESM backend, no JSX transform pipeline).
const e = React.createElement;

export const BRAND_COLOR = '#4f46e5';
export const BRAND_COLOR_DARK = '#4338ca';

// Same CORS_ORIGIN-as-frontend-URL idiom already used elsewhere in this
// codebase (subscriptionWebhookService.js's MANAGE_SUBSCRIPTION_URL,
// oauth.routes.js, puppeteerPdfService.js). frontend/public/logo/odito-logo-on-light.png
// is served at this exact path by Next.js's static-file convention.
const FRONTEND_URL = process.env.CORS_ORIGIN || '';
const LOGO_URL = `${FRONTEND_URL}/logo/odito-logo-on-light.png`; // white email body -> deep-colour wordmark

// Stripe amounts are always the currency's smallest unit (cents) — same
// convention as Transaction.js / BillingHistoryCard.jsx.
export function formatAmount(amountInSmallestUnit, currency) {
  if (typeof amountInSmallestUnit !== 'number') return null;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: (currency || 'usd').toUpperCase(),
    }).format(amountInSmallestUnit / 100);
  } catch {
    return `${(amountInSmallestUnit / 100).toFixed(2)} ${(currency || '').toUpperCase()}`;
  }
}

export function formatDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

// rows: [{ label, value }] — rows with a null/undefined/empty value are
// dropped, so callers can pass optional fields unconditionally.
export function SummaryBlock({ rows }) {
  const visibleRows = (rows || []).filter((r) => r.value !== null && r.value !== undefined && r.value !== '');
  if (visibleRows.length === 0) return null;

  return e(Section, { style: { backgroundColor: '#f9fafb', borderRadius: 8, padding: '16px 20px', margin: '20px 0' } },
    e('table', { width: '100%', cellPadding: 0, cellSpacing: 0 },
      e('tbody', null,
        visibleRows.map((row, i) =>
          e('tr', { key: i },
            e('td', { style: { padding: '6px 0', color: '#6b7280', fontSize: 14 } }, row.label),
            e('td', { style: { padding: '6px 0', color: '#1f2937', fontWeight: 600, fontSize: 14, textAlign: 'right' } }, row.value)
          )
        )
      )
    )
  );
}

export function CtaButton({ href, label }) {
  if (!href || !label) return null;
  return e(Section, { style: { textAlign: 'center', margin: '24px 0' } },
    e(Button, {
      href,
      style: {
        backgroundColor: BRAND_COLOR, color: '#ffffff', padding: '12px 30px',
        borderRadius: 6, fontWeight: 600, textDecoration: 'none', fontSize: 14, display: 'inline-block',
      },
    }, label)
  );
}

// Shown only on templates that pass an invoiceUrl (Stripe's own
// hosted_invoice_url — the same customer-facing link already surfaced by
// GET /subscription/history — never a raw Stripe id).
export function InvoiceSection({ invoiceUrl }) {
  if (!invoiceUrl) return null;
  return e(Section, { style: { textAlign: 'center', margin: '4px 0 20px' } },
    e('a', { href: invoiceUrl, style: { color: BRAND_COLOR, fontSize: 13, fontWeight: 600, textDecoration: 'underline' } }, 'View Invoice')
  );
}

/**
 * The one shared shell every billing template renders through — logo,
 * title/subtitle header, a support footer, and a security footer. No
 * template in this folder writes its own <Html>/<Body> structure.
 */
export function BillingLayout({ title, subtitle, previewText, children }) {
  return e(Html, null,
    e(Head, null),
    e(Preview, null, previewText || title),
    e(Body, { style: { backgroundColor: '#f4f4f4', fontFamily: 'sans-serif', margin: 0, padding: '20px 0' } },
      e(Container, { style: { backgroundColor: '#ffffff', borderRadius: 10, padding: 30, maxWidth: 600, margin: '0 auto' } },
        e(Section, { style: { textAlign: 'center', marginBottom: 24 } },
          e(Img, { src: LOGO_URL, alt: 'Odito', width: 120, height: 42, style: { margin: '0 auto 16px' } }),
          e(Heading, { style: { fontSize: 22, color: '#1f2937', margin: '0 0 6px' } }, title),
          subtitle ? e(Text, { style: { fontSize: 14, color: '#6b7280', margin: 0 } }, subtitle) : null
        ),
        e(Section, null, children),
        e(Hr, { style: { borderColor: '#e5e7eb', margin: '30px 0 16px' } }),
        e(Section, { style: { textAlign: 'center' } },
          e(Text, { style: { fontSize: 12, color: '#6b7280', margin: '0 0 4px' } }, 'Need help? Contact our support team.'),
          e(Text, { style: { fontSize: 11, color: '#9ca3af', margin: 0 } },
            'This is an automated billing notification. For your security, we will never ask for your password by email.'),
          e(Text, { style: { fontSize: 11, color: '#9ca3af', margin: '8px 0 0' } }, `© ${new Date().getFullYear()} Odito. All rights reserved.`)
        )
      )
    )
  );
}
