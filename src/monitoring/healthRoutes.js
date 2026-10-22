import crypto from 'node:crypto';
import express from 'express';
import mongoose from 'mongoose';
import { renderMetrics } from './metrics.js';
import './socialAiMetrics.js'; // registers the Social AI metrics and their scrape-time collectors
import { LoggerUtil } from '../utils/LoggerUtil.js';

/**
 * Liveness, readiness and metrics - mounted at the root AND under /api (a reverse proxy often forwards only /api).
 *
 *   GET /healthz   LIVENESS. 200 while the process can answer. It never touches MongoDB or a provider: a database outage must not make an
 *                  orchestrator restart a healthy API (which would only add load and lose in-flight work).
 *   GET /readyz    READINESS. 200 only when startup has finished AND MongoDB answers a bounded ping; otherwise 503. Use it to decide whether
 *                  to send traffic. The body names the failing check ("database" / "startup") and nothing else - no host, no driver
 *                  message, no stack, no configuration, no customer data.
 *   GET /metrics   Prometheus text. Requires `Authorization: Bearer <METRICS_TOKEN>`. In production with no (or a too short) METRICS_TOKEN the
 *                  endpoint does not exist (404); outside production an unset token leaves it open for local use.
 *
 * Responses are never cached.
 */

const READY_PING_TIMEOUT_MS = 2000;
const MIN_METRICS_TOKEN_LENGTH = 16;
const isProd = () => process.env.NODE_ENV === 'production';

let startupComplete = false;
export const markStartupComplete = () => { startupComplete = true; };
export const resetStartupState = () => { startupComplete = false; }; // tests

async function databaseAnswers(timeoutMs = READY_PING_TIMEOUT_MS) {
  if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) return false;
  let timer;
  try {
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); });
    await Promise.race([mongoose.connection.db.admin().ping(), timeout]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

let probe = databaseAnswers;
export const setReadinessProbe = (fn) => { probe = fn || databaseAnswers; }; // tests

const sameSecret = (given, expected) => {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
};

const noStore = (res) => res.set('Cache-Control', 'no-store');

export function metricsAccess(req, env = process.env) {
  const expected = (env.METRICS_TOKEN || '').trim();
  const production = env.NODE_ENV === 'production';
  if (!expected) return production ? 'disabled' : 'open';
  if (production && expected.length < MIN_METRICS_TOKEN_LENGTH) return 'disabled'; // a guessable token is no protection
  const header = req.get('authorization') || '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match && sameSecret(match[1], expected) ? 'allowed' : 'denied';
}

const router = express.Router();

router.get('/healthz', (req, res) => {
  noStore(res);
  res.status(200).json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
});

router.get('/readyz', async (req, res) => {
  noStore(res);
  const database = await probe().catch(() => false);
  const checks = { database: database ? 'ok' : 'fail', startup: startupComplete ? 'ok' : 'pending' };
  const ready = database && startupComplete;
  res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', checks });
});

router.get('/metrics', async (req, res) => {
  noStore(res);
  const access = metricsAccess(req);
  if (access === 'disabled') return res.status(404).json({ success: false, message: 'Not found' });
  if (access === 'denied') {
    res.set('WWW-Authenticate', 'Bearer realm="metrics"');
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  try {
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    return res.status(200).send(await renderMetrics());
  } catch (error) {
    LoggerUtil.error('[METRICS] Could not render metrics', { message: error.message });
    return res.status(500).json({ success: false, message: 'Metrics unavailable' });
  }
});

export default router;
