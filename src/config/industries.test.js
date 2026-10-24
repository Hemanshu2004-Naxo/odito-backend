import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { INDUSTRIES, isIndustryValue } from './industries.js';

// The frontend offers these values in onboarding and the profile screen; the backend validates against its own copy. They must match.
test('the frontend industry list mirrors the backend taxonomy exactly', async (t) => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const frontendFile = path.resolve(here, '../../../frontend/lib/industries.js');
  let frontend;
  try {
    frontend = await import(pathToFileURL(frontendFile).href);
  } catch {
    return t.skip('frontend checkout not present next to the backend');
  }
  assert.deepEqual(frontend.INDUSTRIES.map((i) => [i.value, i.label]), INDUSTRIES.map((i) => [i.value, i.label]));
});

test('business types are not industries', () => {
  for (const v of ['Service-based', 'Product-based', 'E-commerce', 'Agency', 'Healthcare']) assert.equal(isIndustryValue(v), false, v);
  assert.equal(isIndustryValue('healthcare'), true);
});
