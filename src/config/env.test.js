import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { validateEnvironment } from './env.js';

dotenv.config();

/**
 * Root-cause regression coverage: BACKEND_URL=http://localhost:5000 in a
 * PRODUCTION deployment silently makes every Facebook/Instagram media
 * publish fail (Meta cannot fetch a localhost URL — confirmed live, see
 * mediaStorageService.js/platformAdapters' own comments) with no signal
 * at startup that anything is wrong. validateEnvironment() now warns
 * loudly at boot in that specific case, while never touching local
 * development (localhost is expected and fine there) and never hard-
 * exiting over this one feature's requirement (BACKEND_URL also serves
 * unrelated features).
 */

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_BACKEND_URL = process.env.BACKEND_URL;

afterEach(() => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  process.env.BACKEND_URL = ORIGINAL_BACKEND_URL;
});

function captureWarnings(fn) {
  const original = console.warn;
  const captured = [];
  console.warn = (...args) => { captured.push(args.join(' ')); };
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return captured.join('\n');
}

describe('validateEnvironment — production BACKEND_URL warning', () => {
  test('production + localhost BACKEND_URL triggers a clear warning naming the exact problem', () => {
    process.env.NODE_ENV = 'production';
    process.env.BACKEND_URL = 'http://localhost:5000';
    const output = captureWarnings(() => validateEnvironment());
    assert.ok(output.includes('BACKEND_URL is not a public HTTPS origin'));
    assert.ok(output.includes('http://localhost:5000'));
  });

  test('production + 127.0.0.1 BACKEND_URL also warns', () => {
    process.env.NODE_ENV = 'production';
    process.env.BACKEND_URL = 'http://127.0.0.1:5000';
    const output = captureWarnings(() => validateEnvironment());
    assert.ok(output.includes('BACKEND_URL is not a public HTTPS origin'));
  });

  test('production + a plain-http real domain (no HTTPS) also warns', () => {
    process.env.NODE_ENV = 'production';
    process.env.BACKEND_URL = 'http://odito-backend.example.com';
    const output = captureWarnings(() => validateEnvironment());
    assert.ok(output.includes('BACKEND_URL is not a public HTTPS origin'));
  });

  test('production + a real public HTTPS BACKEND_URL never warns', () => {
    process.env.NODE_ENV = 'production';
    process.env.BACKEND_URL = 'https://odito-backend.example.com';
    const output = captureWarnings(() => validateEnvironment());
    assert.ok(!output.includes('BACKEND_URL is not a public HTTPS origin'));
  });

  test('development + localhost BACKEND_URL never warns — local dev must not be broken', () => {
    process.env.NODE_ENV = 'development';
    process.env.BACKEND_URL = 'http://localhost:5000';
    const output = captureWarnings(() => validateEnvironment());
    assert.ok(!output.includes('BACKEND_URL is not a public HTTPS origin'));
  });

  test('validateEnvironment still returns isValid:true in every case above — this is a warning, never a hard failure', () => {
    process.env.NODE_ENV = 'production';
    process.env.BACKEND_URL = 'http://localhost:5000';
    let result;
    captureWarnings(() => { result = validateEnvironment(); });
    assert.equal(result.isValid, true);
  });
});
