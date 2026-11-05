/**
 * A stand-alone SEO scan worker:  node src/modules/dataforseo-api/seo_data/worker/seoScanWorkerMain.js
 * Connects to MongoDB (MONGO_URI, MONGO_DB_NAME like the API), claims queued scans and works on them until SIGTERM / SIGINT, then hands any
 * unfinished scan back to the queue. Run as many as needed; run the API with SEO_SCAN_WORKER_EMBEDDED=false so it only queues scans.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { createScanWorker } from './seoScanWorker.js';
import { LoggerUtil } from '../../../../utils/LoggerUtil.js';

async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set');
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000, ...(process.env.MONGO_DB_NAME ? { dbName: process.env.MONGO_DB_NAME } : {}) });
  const worker = createScanWorker();
  worker.start();
  const shutdown = async (signal) => {
    LoggerUtil.info('SEO scan worker: shutting down', { signal });
    await worker.stop();
    await mongoose.disconnect();
    process.exit(0);
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => { console.error('SEO scan worker failed to start:', err.message); process.exit(1); });
