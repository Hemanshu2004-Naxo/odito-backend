// Why does address search fail? Calls Google Places (New) with GOOGLE_PLACES_API_KEY from .env and prints the status and reason.
// Never prints the key. Costs two tiny billed requests at most.   Run: node scripts/diagnose-places-key.mjs
import 'dotenv/config';
import axios from 'axios';

const key = process.env.GOOGLE_PLACES_API_KEY;
console.log('GOOGLE_PLACES_API_KEY present:', Boolean(key), key ? `(length ${key.length})` : '');
if (!key) process.exit(1);

const scrub = (s) => String(s).split(key).join('[key]');
async function call(label, url, body, mask) {
  try {
    const r = await axios.post(url, body, { headers: { 'X-Goog-Api-Key': key, 'Content-Type': 'application/json', 'X-Goog-FieldMask': mask }, timeout: 15000 });
    console.log(`${label}: OK (${r.status})`);
  } catch (e) {
    const g = e.response?.data?.error;
    const reasons = (g?.details ?? []).map((d) => d.reason).filter(Boolean);
    console.log(`${label}: FAILED HTTP ${e.response?.status ?? e.code} ${g?.status ?? ''} reasons=${JSON.stringify(reasons)} message="${scrub(g?.message ?? e.message).slice(0, 200)}"`);
  }
}
await call('Places API (New) autocomplete', 'https://places.googleapis.com/v1/places:autocomplete', { input: 'krishna eye centre nashik', sessionToken: 'diagnose0123456789abcdef', languageCode: 'en' }, 'suggestions.placePrediction.placeId');
await call('Places API (New) text search', 'https://places.googleapis.com/v1/places:searchText', { textQuery: 'krishna eye centre nashik', maxResultCount: 1 }, 'places.id');
console.log('\nHTTP 403 PERMISSION_DENIED with no reason  = "Places API (New)" is not enabled on the key\'s Google Cloud project.');
console.log('Reason API_KEY_SERVICE_BLOCKED / *_REFERRER_BLOCKED / *_IP_ADDRESS_BLOCKED = the key\'s restrictions block this call.');
console.log('Reason BILLING_DISABLED = billing is off. HTTP 400 API_KEY_INVALID = wrong key. HTTP 429 = quota.');
