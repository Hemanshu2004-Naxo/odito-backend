import os from 'node:os';
import SeoProject from '../../../app_user/model/SeoProject.js';
import { mongoRunStore } from '../service/scanRunStore.js';
import { executeRun } from '../service/seoScanService.js';
import { SCAN_LEASE_MS, SCAN_MAX_ATTEMPTS, WORKER } from '../config.js';
import { LoggerUtil } from '../../../../utils/LoggerUtil.js';

/**
 * The SEO scan worker: claims queued scans from MongoDB and runs them, apart from the web request that queued them.
 *
 *  - One atomic claim per scan (scanRunStore.claimNext): any number of workers, in this process or others, can poll the same queue and
 *    no scan is ever processed by two of them. A scan whose worker stopped extending its lease is claimed again and CONTINUES with the
 *    datasets not yet completed (nothing already bought is bought again).
 *  - At most `scans` scans at once per worker (each scan has its own bounded dataset concurrency, and the provider gate bounds the rest).
 *  - stop(): stops claiming, lets running scans finish their current datasets, then hands any unfinished scan back to the queue.
 *
 * Run it inside the API process (default, SEO_SCAN_WORKER_EMBEDDED) or on its own: `node src/modules/dataforseo-api/seo_data/worker/seoScanWorkerMain.js`.
 * With SEO_SCAN_WORKER_EMBEDDED=false the API process queues scans and never works on them.
 */

const loadProject = (projectId) => SeoProject.findOne({ _id: projectId, is_deleted: { $ne: true } }).select('main_url country language user_id').lean();

/**
 * @param {{ store?: object, scans?: number, pollMs?: number, leaseMs?: number, maxAttempts?: number, workerId?: string, now?: () => Date,
 *           loadProject?: Function, run?: object }} [options] `run` = extra options for executeRun (fetchSection, retry, sleep ...)
 */
export function createScanWorker({
  store = mongoRunStore, scans = WORKER.scans, pollMs = WORKER.pollMs, leaseMs = SCAN_LEASE_MS, maxAttempts = SCAN_MAX_ATTEMPTS,
  workerId = `${os.hostname()}:${process.pid}`, now = () => new Date(), loadProject: load = loadProject, run: runOptions = {},
} = {}) {
  const active = new Map(); // scan id -> promise
  let timer = null;
  let stopping = false;
  let ticking = false;

  async function handle(run) {
    try {
      if ((run.attempts ?? 1) > maxAttempts) {
        await store.finish(run._id, { status: 'failed', error: { code: 'SCAN_ATTEMPTS_EXHAUSTED' }, now: now() });
        return 'finished';
      }
      const project = await load(run.projectId);
      if (!project) {
        await store.finish(run._id, { status: 'failed', error: { code: 'PROJECT_NOT_FOUND' }, now: now() });
        return 'finished';
      }
      return await executeRun(run, {
        project, userId: run.requestedBy ? String(run.requestedBy) : null, store, workerId, now, leaseMs, maxAttempts, isStopping: () => stopping, ...runOptions,
      });
    } catch (err) {
      LoggerUtil.error('SEO scan worker: a scan could not be processed', err, { scanId: String(run._id) });
      return 'error';
    }
  }

  /** Claims as many due scans as there is room for and starts them. Resolves to the scans started (not finished). Never throws. */
  async function tick() {
    if (stopping || ticking) return [];
    ticking = true;
    const started = [];
    try {
      while (!stopping && active.size < scans) {
        // eslint-disable-next-line no-await-in-loop
        const run = await store.claimNext({ workerId, now: now(), leaseMs });
        if (!run) break;
        const id = String(run._id);
        const job = handle(run).finally(() => active.delete(id));
        active.set(id, job);
        started.push(job);
      }
    } catch (err) {
      LoggerUtil.error('SEO scan worker: claiming failed', err);
    } finally {
      ticking = false;
    }
    return started;
  }

  return {
    workerId,
    tick,
    /** Waits for every scan this worker is working on. */
    async idle() { while (active.size) await Promise.allSettled([...active.values()]); },
    /** tick() until nothing is due and nothing is running (tests, one-off drains). */
    async drain() {
      for (let i = 0; i < 200; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const started = await tick();
        // eslint-disable-next-line no-await-in-loop
        await this.idle();
        if (!started.length) return;
      }
    },
    start() {
      if (timer) return;
      stopping = false;
      timer = setInterval(() => { tick().catch(() => {}); }, pollMs);
      timer.unref?.();
      tick().catch(() => {});
      LoggerUtil.info('SEO scan worker started', { workerId, scans, pollMs });
    },
    /** Graceful: no new claims; running scans stop starting datasets and are handed back to the queue if unfinished. Resolves when they have. */
    async stop({ timeoutMs = WORKER.shutdownGraceMs } = {}) {
      stopping = true;
      if (timer) { clearInterval(timer); timer = null; }
      const all = Promise.allSettled([...active.values()]);
      await Promise.race([all, new Promise((resolve) => { const t = setTimeout(resolve, timeoutMs); t.unref?.(); })]);
      LoggerUtil.info('SEO scan worker stopped', { workerId, stillRunning: active.size });
    },
    get activeScans() { return active.size; },
  };
}

let embedded = null;
/** Starts the shared worker of this process (idempotent) and stops it cleanly on SIGTERM / SIGINT. */
export function startSeoScanWorker(options = {}) {
  if (embedded) return embedded;
  embedded = createScanWorker(options);
  embedded.start();
  const shutdown = (signal) => {
    embedded.stop().finally(() => { LoggerUtil.info('SEO scan worker: exiting', { signal }); process.exit(0); });
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  return embedded;
}
