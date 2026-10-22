import { Resend } from 'resend';

let client = null;

function getClient() {
  if (!client) {
    if (!process.env.RESEND_API_KEY) {
      throw new Error('RESEND_API_KEY is not configured');
    }
    client = new Resend(process.env.RESEND_API_KEY);
  }
  return client;
}

/**
 * Provider abstraction boundary. mailService.js only ever calls this with
 * a plain {to, subject, html, from} shape — no Resend-specific field (e.g.
 * a raw React element) ever crosses this boundary. Swapping providers
 * later means writing a new file with this same send() signature and
 * pointing mailService.js at it — nothing above mailService ever imports
 * a provider directly.
 * @returns {Promise<{id: string}>}
 */
export async function send({ to, subject, html, from }) {
  const resend = getClient();
  const { data, error } = await resend.emails.send({ from, to, subject, html });

  if (error) {
    const err = new Error(error.message || 'Failed to send email via Resend');
    err.cause = error;
    throw err;
  }

  return { id: data?.id };
}
