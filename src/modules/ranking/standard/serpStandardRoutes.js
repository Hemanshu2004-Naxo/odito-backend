import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { getStandardService } from './serpStandardService.js';
import { readStandardConfig } from './config.js';

/**
 * GET /api/serp-standard/pingback?id=<dataforseo task id>&tag=<our task id>&token=<secret>
 * DataForSEO calls this when a task is ready (task_post `pingback_url`, only sent when DATAFORSEO_SERP_PINGBACK_BASE_URL and
 * DATAFORSEO_SERP_PINGBACK_SECRET are configured). It only HINTS that the result can be fetched: the worker still verifies with task_get
 * (free), so a forged call can cost at most one free request. Polling (tasks_ready + task_get) remains the fallback if no call arrives.
 */
const router = express.Router();

const same = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

router.get('/pingback', async (req, res) => {
  const { pingbackSecret } = readStandardConfig();
  if (!pingbackSecret || typeof req.query.token !== 'string' || !same(req.query.token, pingbackSecret)) return res.status(404).end();
  const id = typeof req.query.id === 'string' ? req.query.id.slice(0, 64) : '';
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) return res.status(400).json({ success: false });
  try {
    const marked = await getStandardService().markReadyByDfsId(id);
    return res.status(200).json({ success: true, marked });
  } catch {
    return res.status(200).json({ success: true, marked: false }); // never make the provider retry because of our own hiccup
  }
});

export default router;
