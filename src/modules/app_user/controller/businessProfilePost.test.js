import { describe, test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

import SeoProject from '../model/SeoProject.js';
import GoogleConnection from '../model/GoogleConnection.js';
import BusinessProfilePost from '../model/BusinessProfilePost.js';
import sharp from 'sharp';
import {
  getBusinessProfilePostsController,
  createBusinessProfilePostController,
  updateBusinessProfilePostController,
  deleteBusinessProfilePostController,
  uploadBusinessProfilePostMediaController
} from './businessProfilePostController.js';

const USER = 'u12345';
const PROJECT = '6ac4bf78867ae9b647ec8478';
const POST_ID = 'local_post_999';

const mockRes = () => ({
  statusCode: 200,
  body: null,
  status(c) { this.statusCode = c; return this; },
  json(p) { this.body = p; return this; }
});

let project;
let connection;

beforeEach(() => {
  project = {
    _id: PROJECT,
    user_id: USER,
    project_name: 'Odito Test'
  };

  connection = {
    _id: 'c1',
    status: 'active',
    business_account_id: 'acc_123',
    business_location_id: 'loc_456',
    refresh_token: 'valid_refresh',
    access_token: 'valid_access_token',
    token_expires_at: new Date(Date.now() + 3600 * 1000)
  };

  mock.method(SeoProject, 'findById', async () => project);
  mock.method(GoogleConnection, 'findActiveConnection', async () => connection);
});

describe('GBP Local Posts - Validation', () => {
  test('rejects empty or whitespace summary on creation', async () => {
    const req = {
      params: { projectId: PROJECT },
      user: { _id: USER },
      body: { summary: '   ' }
    };
    const res = mockRes();

    await createBusinessProfilePostController(req, res);

    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /summary is required/i);
  });

  test('rejects summary longer than 1500 characters', async () => {
    const req = {
      params: { projectId: PROJECT },
      user: { _id: USER },
      body: { summary: 'a'.repeat(1501) }
    };
    const res = mockRes();

    await createBusinessProfilePostController(req, res);

    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /exceeds maximum limit/i);
  });

  test('rejects invalid topicType', async () => {
    const req = {
      params: { projectId: PROJECT },
      user: { _id: USER },
      body: { summary: 'Valid post summary', topicType: 'INVALID_TYPE' }
    };
    const res = mockRes();

    await createBusinessProfilePostController(req, res);

    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /invalid topic type/i);
  });

  test('rejects invalid CTA actionType or invalid URL', async () => {
    const req = {
      params: { projectId: PROJECT },
      user: { _id: USER },
      body: {
        summary: 'Valid summary',
        callToAction: { actionType: 'LEARN_MORE', url: 'not-a-url' }
      }
    };
    const res = mockRes();

    await createBusinessProfilePostController(req, res);

    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /valid url is required/i);
  });
});

describe('GBP Local Posts - Authorization chain', () => {
  test('returns 403 when user does not own project', async () => {
    const req = {
      params: { projectId: PROJECT },
      user: { _id: 'other_user' },
      body: { summary: 'Hello' }
    };
    const res = mockRes();

    await createBusinessProfilePostController(req, res);

    assert.equal(res.statusCode, 403);
  });

  test('returns 400 when no active Google connection exists', async () => {
    mock.method(GoogleConnection, 'findActiveConnection', async () => null);

    const req = {
      params: { projectId: PROJECT },
      user: { _id: USER },
      body: { summary: 'Hello' }
    };
    const res = mockRes();

    await createBusinessProfilePostController(req, res);

    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /not connected/i);
  });
});

describe('GBP Local Posts - CRUD operations', () => {
  test('createBusinessProfilePostController publishes post and returns 201', async () => {
    const fakeClient = {
      post: async (_url, payload) => ({
        data: {
          name: `accounts/acc_123/locations/loc_456/localPosts/${POST_ID}`,
          summary: payload.summary,
          topicType: payload.topicType,
          state: 'LIVE',
          createTime: new Date().toISOString()
        }
      })
    };
    mock.method(axios, 'create', () => fakeClient);
    mock.method(BusinessProfilePost, 'bulkUpsertPosts', async () => ({ upserted: 1, modified: 0 }));
    mock.method(BusinessProfilePost, 'findOne', () => ({
      lean: async () => ({
        google_post_id: POST_ID,
        summary: 'Special summer discount!',
        state: 'LIVE',
        topic_type: 'STANDARD'
      })
    }));

    const req = {
      params: { projectId: PROJECT },
      user: { _id: USER },
      body: {
        summary: 'Special summer discount!',
        topicType: 'STANDARD',
        callToAction: { actionType: 'LEARN_MORE', url: 'https://example.com/promo' }
      }
    };
    const res = mockRes();

    await createBusinessProfilePostController(req, res);

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.google_post_id, POST_ID);
  });

  test('updateBusinessProfilePostController updates post on Google and DB', async () => {
    const existingPost = {
      project_id: PROJECT,
      google_post_id: POST_ID,
      summary: 'Old text',
      is_deleted: false,
      save: async () => {},
      toObject: () => ({ google_post_id: POST_ID, summary: 'Updated text' })
    };
    mock.method(BusinessProfilePost, 'findOne', async () => existingPost);

    const fakeClient = {
      patch: async () => ({
        data: {
          name: `accounts/acc_123/locations/loc_456/localPosts/${POST_ID}`,
          summary: 'Updated text',
          updateTime: new Date().toISOString()
        }
      })
    };
    mock.method(axios, 'create', () => fakeClient);

    const req = {
      params: { projectId: PROJECT, postId: POST_ID },
      user: { _id: USER },
      body: { summary: 'Updated text' }
    };
    const res = mockRes();

    await updateBusinessProfilePostController(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.summary, 'Updated text');
  });

  test('deleteBusinessProfilePostController marks deleted in DB', async () => {
    const existingPost = {
      project_id: PROJECT,
      google_post_id: POST_ID,
      is_deleted: false,
      save: async () => {}
    };
    mock.method(BusinessProfilePost, 'findOne', async () => existingPost);

    const fakeClient = {
      delete: async () => ({ data: {} })
    };
    mock.method(axios, 'create', () => fakeClient);

    const req = {
      params: { projectId: PROJECT, postId: POST_ID },
      user: { _id: USER }
    };
    const res = mockRes();

    await deleteBusinessProfilePostController(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(existingPost.is_deleted, true);
  });
});

describe('GBP Local Posts - Media Upload', () => {
  test('rejects request when no file is provided', async () => {
    const req = {
      params: { projectId: PROJECT },
      user: { _id: USER },
      file: null
    };
    const res = mockRes();

    await uploadBusinessProfilePostMediaController(req, res);

    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /select an image/i);
  });

  test('rejects invalid or corrupted image bytes', async () => {
    const req = {
      params: { projectId: PROJECT },
      user: { _id: USER },
      file: {
        buffer: Buffer.from('not an image'),
        originalname: 'fake.jpg'
      }
    };
    const res = mockRes();

    await uploadBusinessProfilePostMediaController(req, res);

    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /valid image/i);
  });

  test('successfully validates, stores and returns media URL for valid JPEG image', async () => {
    const validJpgBuffer = await sharp({
      create: {
        width: 50,
        height: 50,
        channels: 3,
        background: { r: 200, g: 100, b: 50 }
      }
    }).jpeg().toBuffer();

    const req = {
      params: { projectId: PROJECT },
      user: { _id: USER },
      file: {
        buffer: validJpgBuffer,
        originalname: 'summer_promo.jpg'
      }
    };
    const res = mockRes();

    await uploadBusinessProfilePostMediaController(req, res);

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.success, true);
    assert.ok(res.body.data.url);
    assert.ok(res.body.data.url.includes('/storage/business_profile_posts/'));
    assert.equal(res.body.data.mimeType, 'image/jpeg');
    assert.equal(res.body.data.width, 50);
    assert.equal(res.body.data.height, 50);
  });

  test('denies upload if user does not own project', async () => {
    const req = {
      params: { projectId: PROJECT },
      user: { _id: 'other_user' },
      file: {
        buffer: Buffer.from('data'),
        originalname: 'test.jpg'
      }
    };
    const res = mockRes();

    await uploadBusinessProfilePostMediaController(req, res);

    assert.equal(res.statusCode, 403);
  });
});

