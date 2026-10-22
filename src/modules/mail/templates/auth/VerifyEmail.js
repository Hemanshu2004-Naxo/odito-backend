import React from 'react';
import { Html, Head, Preview, Body, Container, Heading, Text, Section } from '@react-email/components';

// Written with React.createElement rather than JSX: this backend is plain
// Node ESM ("type":"module", no bundler/Babel/esbuild pipeline), which
// cannot parse .jsx syntax at runtime. createElement produces the exact
// same element tree JSX would compile to, so the rendered email is
// identical — this file is a React Email template in every functional
// sense, just without a JSX transform dependency added to the server.
const e = React.createElement;

const BRAND_COLOR = '#4f46e5';

export function VerifyEmail({ firstName, otp }) {
  const greeting = firstName ? `Hi ${firstName},` : 'Hi there,';

  return e(Html, null,
    e(Head, null),
    e(Preview, null, `Your Odito verification code is ${otp}`),
    e(Body, { style: { backgroundColor: '#f4f4f4', fontFamily: 'sans-serif', margin: 0, padding: '20px 0' } },
      e(Container, { style: { backgroundColor: '#ffffff', borderRadius: 10, padding: 30, maxWidth: 480, margin: '0 auto' } },
        e(Heading, { style: { color: BRAND_COLOR, fontSize: 20, margin: '0 0 16px' } }, 'Odito'),
        e(Text, { style: { fontSize: 16, color: '#1f2937' } }, greeting),
        e(Text, { style: { fontSize: 15, color: '#374151', lineHeight: 1.6 } },
          'Use the code below to verify your email address:'),
        e(Section, { style: { backgroundColor: '#f9fafb', borderRadius: 8, padding: '20px', textAlign: 'center', margin: '20px 0' } },
          e(Text, { style: { fontSize: 32, fontWeight: 700, letterSpacing: 8, color: BRAND_COLOR, margin: 0 } }, otp)
        ),
        e(Text, { style: { fontSize: 13, color: '#6b7280' } },
          'This code expires in 10 minutes. If you did not request this, you can safely ignore this email.')
      )
    )
  );
}
