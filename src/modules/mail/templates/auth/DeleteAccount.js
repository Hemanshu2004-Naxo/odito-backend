import React from 'react';
import { Html, Head, Preview, Body, Container, Heading, Text, Section } from '@react-email/components';

// See VerifyEmail.js for why this uses React.createElement instead of JSX.
const e = React.createElement;

const BRAND_COLOR = '#4f46e5';
const DANGER_COLOR = '#dc2626';

export function DeleteAccount({ firstName, otp }) {
  const greeting = firstName ? `Hi ${firstName},` : 'Hi there,';

  return e(Html, null,
    e(Head, null),
    e(Preview, null, `Your Odito account deletion code is ${otp}`),
    e(Body, { style: { backgroundColor: '#f4f4f4', fontFamily: 'sans-serif', margin: 0, padding: '20px 0' } },
      e(Container, { style: { backgroundColor: '#ffffff', borderRadius: 10, padding: 30, maxWidth: 480, margin: '0 auto' } },
        e(Heading, { style: { color: BRAND_COLOR, fontSize: 20, margin: '0 0 16px' } }, 'Odito'),
        e(Text, { style: { fontSize: 16, color: '#1f2937' } }, greeting),
        e(Text, { style: { fontSize: 15, color: '#374151', lineHeight: 1.6 } },
          'We received a request to permanently delete your Odito account and all associated data. Use the code below to confirm:'),
        e(Section, { style: { backgroundColor: '#fef2f2', border: `1px solid #fecaca`, borderRadius: 8, padding: '20px', textAlign: 'center', margin: '20px 0' } },
          e(Text, { style: { fontSize: 32, fontWeight: 700, letterSpacing: 8, color: DANGER_COLOR, margin: 0 } }, otp)
        ),
        e(Text, { style: { fontSize: 15, fontWeight: 600, color: DANGER_COLOR, lineHeight: 1.6 } },
          'This action is permanent and cannot be undone.'),
        e(Text, { style: { fontSize: 13, color: '#6b7280' } },
          'This code expires in 10 minutes. If you did not request account deletion, ignore this email and your account will remain unchanged — no action will be taken without this code.')
      )
    )
  );
}
