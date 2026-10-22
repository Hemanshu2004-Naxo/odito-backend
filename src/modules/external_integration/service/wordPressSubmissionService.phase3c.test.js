import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import wordPressSubmissionService from './wordPressSubmissionService.js';
import WordPressForm from '../model/WordPressForm.js';
import Lead from '../../lead/model/Lead.js';

// Phase 3C hardening regression coverage: FORM_NOT_ACTIVE (the new gap fix),
// idempotency, and concurrent-duplicate safety for real WordPress form
// submissions. Uses the real captureSubmission() entry point against a real
// (local) MongoDB — matching this repo's existing integration-test style
// (see issueCounts.service.test.js) rather than mocking Mongoose.

let mongoAvailable = false;

before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
  } catch {
    mongoAvailable = false;
  }
});

after(async () => {
  if (mongoAvailable) await mongoose.connection.close();
});

function makeInstallation(projectId) {
  return { _id: new mongoose.Types.ObjectId(), project_id: projectId, plugin_id: 'test-plugin-id' };
}

function makePayload(overrides = {}) {
  return {
    eventId: `test-event-${new mongoose.Types.ObjectId().toString()}`,
    form: { externalId: 'cf7-test-form', provider: 'contact_form_7', name: 'Test Form', pageUrl: 'https://example.com/contact' },
    submission: { fields: { 'your-name': 'Regression Test', 'your-email': 'regression@example.com' } },
    context: { pageUrl: 'https://example.com/contact', referrer: null },
    ...overrides,
  };
}

describe('wordPressSubmissionService.captureSubmission (Phase 3C)', () => {
  let projectId;
  let installation;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    projectId = new mongoose.Types.ObjectId();
    installation = makeInstallation(projectId);
    await WordPressForm.deleteMany({ project_id: projectId });
    await Lead.deleteMany({ projectId });
  });

  test('rejects a form that was never synced with FORM_NOT_REGISTERED', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    await assert.rejects(
      () => wordPressSubmissionService.captureSubmission(installation, makePayload()),
      (err) => err.details?.code === 'FORM_NOT_REGISTERED'
    );
  });

  test('rejects a synced-but-deactivated form with FORM_NOT_ACTIVE (Phase 3C gap fix)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    await WordPressForm.create({
      project_id: projectId,
      wordpress_plugin_installation_id: installation._id,
      external_id: 'cf7-test-form',
      provider: 'contact_form_7',
      name: 'Test Form',
      is_active: false,
    });

    await assert.rejects(
      () => wordPressSubmissionService.captureSubmission(installation, makePayload()),
      (err) => err.details?.code === 'FORM_NOT_ACTIVE'
    );
  });

  test('accepts a submission for an active, synced form and creates exactly one Lead', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    await WordPressForm.create({
      project_id: projectId,
      wordpress_plugin_installation_id: installation._id,
      external_id: 'cf7-test-form',
      provider: 'contact_form_7',
      name: 'Test Form',
      is_active: true,
    });

    const result = await wordPressSubmissionService.captureSubmission(installation, makePayload());
    assert.equal(result.duplicate, false);

    const leads = await Lead.find({ projectId });
    assert.equal(leads.length, 1);
    assert.equal(leads[0].source, 'wordpress');
  });

  test('a repeated eventId is idempotent — second call reports duplicate, no second Lead', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    await WordPressForm.create({
      project_id: projectId,
      wordpress_plugin_installation_id: installation._id,
      external_id: 'cf7-test-form',
      provider: 'contact_form_7',
      is_active: true,
    });

    const payload = makePayload();
    const first = await wordPressSubmissionService.captureSubmission(installation, payload);
    const second = await wordPressSubmissionService.captureSubmission(installation, payload);

    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(first.leadId, second.leadId);

    const leads = await Lead.find({ projectId });
    assert.equal(leads.length, 1);
  });

  test('5 concurrent submissions with the same eventId produce exactly one Lead', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    await WordPressForm.create({
      project_id: projectId,
      wordpress_plugin_installation_id: installation._id,
      external_id: 'cf7-test-form',
      provider: 'contact_form_7',
      is_active: true,
    });

    const payload = makePayload();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => wordPressSubmissionService.captureSubmission(installation, payload))
    );

    const nonDuplicates = results.filter((r) => r.duplicate === false);
    assert.equal(nonDuplicates.length, 1);

    const leads = await Lead.find({ projectId });
    assert.equal(leads.length, 1);
  });

  test('sensitive-named fields never reach the Lead document', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    await WordPressForm.create({
      project_id: projectId,
      wordpress_plugin_installation_id: installation._id,
      external_id: 'cf7-test-form',
      provider: 'contact_form_7',
      is_active: true,
    });

    const payload = makePayload({
      submission: {
        fields: {
          'your-name': 'Sensitive Field Test',
          'your-email': 'sensitive@example.com',
          password: 'hunter2',
          credit_card_number: '4111111111111111',
          api_secret: 'sk_live_abc123',
        },
      },
    });

    await wordPressSubmissionService.captureSubmission(installation, payload);

    const lead = await Lead.findOne({ projectId });
    const serialized = JSON.stringify(lead.toObject());
    assert.ok(!serialized.includes('hunter2'));
    assert.ok(!serialized.includes('4111111111111111'));
    assert.ok(!serialized.includes('sk_live_abc123'));
  });
});
