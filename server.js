import dotenv from 'dotenv'

import path from 'path'

import { fileURLToPath } from 'url'

import { validateEnvironment, logConfiguration } from './src/config/env.js'



dotenv.config()



// Validate environment at startup

try {

  const validation = validateEnvironment();

  if (validation.isValid) {

    console.log('✅ Environment validation passed');

  } else {

    console.warn('⚠️ Environment validation warnings:', validation.missing);

  }

  

  // Log configuration (without secrets)

  logConfiguration();

} catch (error) {

  console.error('❌ Environment validation failed:', error.message);

  if (process.env.NODE_ENV === 'production') {

    process.exit(1);

  } else {

    console.warn('⚠️ Continuing in development mode...');

  }

}



const __filename = fileURLToPath(import.meta.url)

const __dirname = path.dirname(__filename)



import express from 'express';

import cors from 'cors';

import helmet from 'helmet';

import { createServer } from 'http';

import { Server } from 'socket.io';

import 'express-async-errors';

import fs from 'fs';

import connectDB from './src/config/database.js';

import routes from './src/routes/index.js';

import Job from './src/modules/jobs/model/Job.js';

import jwt from 'jsonwebtoken';

import SeoProject from './src/modules/app_user/model/SeoProject.js';
import { startWeeklyRecheckScheduler } from './src/modules/jobs/service/weeklyRecheckScheduler.js';
import { startDeletedProjectPurgeScheduler } from './src/modules/jobs/service/deletedProjectPurgeScheduler.js';
import { startStaleLockScheduler } from './src/modules/jobs/service/staleLockScheduler.js';
import { startVerificationBatchRecoveryScheduler } from './src/modules/verification/service/verificationBatchRecoveryScheduler.js';
import { startSocialScheduler } from './src/modules/social_meta/service/socialSchedulerService.js';
import { startBulkImportRecoveryScheduler } from './src/modules/social_meta/service/bulkImport/bulkImportRecoveryScheduler.js';
import { startCalendarRecoveryScheduler } from './src/modules/social_meta/service/calendar/calendarRecoveryScheduler.js';
import { startAutomationScheduler } from './src/modules/aiCampaign/service/automation/automationScheduler.js';
import { startInvestigationRecoveryScheduler } from './src/modules/ai-investigation/service/recoveryScheduler.js';
import { startReviewSnapshotScheduler } from './src/services/businessProfileReviewSnapshotScheduler.js';
import { handleStripeWebhook } from './src/modules/subscription/controller/subscriptionController.js';
import auth from './src/modules/user/middleware/auth.js';
import { requireAdmin } from './src/middleware/auth.middleware.js';
import healthRoutes, { markStartupComplete } from './src/monitoring/healthRoutes.js';



const startServer = async () => {

  const app = express();

  const server = createServer(app);

  // Behind a reverse proxy / load balancer, req.ip is the proxy's address
  // unless Express is told to trust the X-Forwarded-For chain. Auth rate
  // limiting keys on req.ip, so this must be set correctly in such a
  // deployment. Opt-in and off by default so single-host / local setups are
  // completely unchanged. TRUST_PROXY accepts the same values app.set
  // supports: "1" (first hop), "true", "loopback", a subnet, etc.
  if (process.env.TRUST_PROXY) {
    const tp = process.env.TRUST_PROXY;
    app.set('trust proxy', tp === 'true' ? true : (/^\d+$/.test(tp) ? Number(tp) : tp));
  }



  // Validate required environment variables

  const requiredEnvVars = ['PORT', 'CORS_ORIGIN', 'MONGO_URI'];

  for (const envVar of requiredEnvVars) {

    if (!process.env[envVar]) {

      throw new Error(`Required environment variable ${envVar} is not defined`);

    }

  }



  // Initialize Socket.IO for real-time progress updates

  const io = new Server(server, {

    cors: {

      origin: process.env.CORS_ORIGIN,

      credentials: true,

      methods: ['GET', 'POST']

    },

    transports: ['websocket', 'polling']

  });



  // Store socket.io instance globally for access in services

  global.io = io;



  // Socket.IO connection handling with authentication

  io.use(async (socket, next) => {
    // 🔒 SECURITY: Extract and verify JWT from socket handshake
    try {
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;
      if (token) {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.userId = decoded.id || decoded._id || decoded.userId;
        console.log(`🔌 Socket authenticated | socketId=${socket.id} | userId=${socket.userId}`);
      } else {
        console.warn(`⚠️ Socket connected without auth token | socketId=${socket.id}`);
        // Allow connection but mark as unauthenticated (backward compatibility)
        socket.userId = null;
      }
    } catch (err) {
      console.warn(`⚠️ Socket auth failed | socketId=${socket.id} | error=${err.message}`);
      socket.userId = null;
    }
    next();
  });

  io.on('connection', (socket) => {

    console.log(`🔌 Client connected: ${socket.id} | userId=${socket.userId || 'anonymous'}`);

    

    // Join job-specific rooms for progress updates

    socket.on('join-audit', async (jobId) => {
      try {
        // 🔒 SECURITY: Verify socket user owns the job's project before joining room
        if (socket.userId) {
          const job = await Job.findById(jobId).select('project_id').lean();
          if (!job) {
            console.warn(`⚠️ Socket join-audit rejected: job not found | socketId=${socket.id} | jobId=${jobId}`);
            return;
          }
          const project = await SeoProject.findById(job.project_id).select('user_id').lean();
          if (!project || project.user_id.toString() !== socket.userId.toString()) {
            console.warn(`⚠️ Socket join-audit rejected: ownership mismatch | socketId=${socket.id} | jobId=${jobId}`);
            return;
          }
        }
        socket.join(`audit-${jobId}`);
        console.log(`📊 Client ${socket.id} joined audit room for job: ${jobId}`);
      } catch (err) {
        console.error(`❌ Socket join-audit error | socketId=${socket.id} | jobId=${jobId} | error=${err.message}`);
        // Fallback: allow join if DB lookup fails (prevents breaking real-time updates)
        socket.join(`audit-${jobId}`);
      }
    });

    // 🔒 Join project-scoped room for completion/error events
    socket.on('join-project', async (projectId) => {
      try {
        if (socket.userId) {
          const project = await SeoProject.findById(projectId).select('user_id').lean();
          if (!project || project.user_id.toString() !== socket.userId.toString()) {
            console.warn(`⚠️ Socket join-project rejected: ownership mismatch | socketId=${socket.id} | projectId=${projectId}`);
            return;
          }
        }
        socket.join(`project-${projectId}`);
        console.log(`📊 Client ${socket.id} joined project room: ${projectId}`);
      } catch (err) {
        console.error(`❌ Socket join-project error | socketId=${socket.id} | projectId=${projectId} | error=${err.message}`);
      }
    });

    // Leave project room
    socket.on('leave-project', (projectId) => {
      socket.leave(`project-${projectId}`);
      console.log(`📊 Client ${socket.id} left project room: ${projectId}`);
    });

    

    socket.on('leave-audit', (jobId) => {

      socket.leave(`audit-${jobId}`);

      console.log(`📊 Client ${socket.id} left audit room for job: ${jobId}`);

    });

    

    socket.on('disconnect', () => {

      console.log(`🔌 Client disconnected: ${socket.id}`);

    });

  });



  await connectDB();

  // Weekly Recheck: daily cron tick that starts the Quick Recheck pipeline for
  // projects due for their scheduled refresh (never a full Recrawl, never
  // billed). Registered once the DB connection is ready.
  startWeeklyRecheckScheduler();

  // Project Trash & Restore, Phase 3: daily cron tick that permanently
  // purges projects whose 7-day trash retention window has elapsed.
  startDeletedProjectPurgeScheduler();

  // Stale Job Lock Recovery: periodic sweep that resets jobs stuck in
  // 'processing' (e.g. a crashed worker) back to 'failed', releasing any
  // per-jobType/target-URL uniqueness lock they were otherwise holding
  // forever.
  startStaleLockScheduler();

  // F4-018: Verification Batch recovery — reclaims due PROJECT_TASK_VERIFICATION
  // retries (Node-self-processed, so nothing else polls it) and resumes any
  // Verification Batch stuck in AGGREGATING (missing/orphaned aggregation
  // jobs, an interrupted barrier, etc).
  startVerificationBatchRecoveryScheduler();

  // Social Publishing: per-minute cron that actually publishes scheduled
  // posts to real Facebook/Instagram accounts once they're due. OFF by
  // default — set SOCIAL_SCHEDULER_ENABLED=true to turn it on (see
  // socialSchedulerService.js for why this one defaults OFF unlike every
  // other scheduler above).
  startSocialScheduler();

  // Bulk Social Upload: every 2 minutes, flip a genuinely abandoned
  // `importing` import batch back to `failed` (re-claimable) so a crashed
  // mid-import never blocks a project's next upload. Never touches
  // publications. Opt-out via BULK_IMPORT_RECOVERY_ENABLED=false.
  startBulkImportRecoveryScheduler();

  // Social Content Calendar: every minute, take over a calendar generation whose worker died or restarted (its lease expired) and
  // continue it from the posts already saved, so a restart never costs a calendar or locks the project out. Safe on many instances
  // (every take-over is one conditional update). Opt-out via SOCIAL_AI_CALENDAR_RECOVERY_ENABLED=false.
  startCalendarRecoveryScheduler();

  // AI Investigation: fail investigations interrupted by a restart/crash so none stays "running" forever (and none blocks a page's next run).
  startInvestigationRecoveryScheduler();

  // AI Campaign Builder — Phase 8 automation: every 15 minutes, scans for
  // enabled automation policies whose scheduled window has arrived and runs
  // them (observe/recommend/execute per policy). Global kill switch:
  // AI_CAMPAIGN_AUTOMATION_ENABLED=false. A policy itself defaults
  // disabled, so this being on is not sufficient for anything to happen —
  // a user must also explicitly enable each policy.
  startAutomationScheduler();

  // Google Business Profile review analytics - historical snapshots: hourly
  // tick that records ONE snapshot per connected location per local day (the
  // first tick after that owner's local midnight). Idempotent (unique index +
  // upsert), never calls Google, never touches connection status. Opt-out via
  // REVIEW_SNAPSHOT_ENABLED=false.
  startReviewSnapshotScheduler();


  /**

   * ABSOLUTE path to storage (inside backend package)

  */

  const storagePath = path.resolve(

    process.cwd(),

    "storage"

  );



  console.log("📂 Serving screenshots from:", storagePath);



  app.use(

    "/storage",

    express.static(storagePath)

  );



  /**

   * STATIC FILE SERVING FOR AUDIO AND VIDEO

   * Move both audio and video storage into the backend project

   */

  // Location-independent path resolution for public files (works across renames and moves)
  let publicPath = path.resolve(__dirname, "public");
  if (!fs.existsSync(publicPath)) {
    const parentPath1 = path.resolve(__dirname, "../odito_backend/public");
    const parentPath2 = path.resolve(__dirname, "../odito-backend/public");
    if (fs.existsSync(parentPath1)) {
      publicPath = parentPath1;
    } else if (fs.existsSync(parentPath2)) {
      publicPath = parentPath2;
    }
  }



  // Ensure public directories exist

  const audioDir = path.join(publicPath, "audio");

  const videosDir = path.join(publicPath, "videos");

  

  if (!fs.existsSync(audioDir)) {

    fs.mkdirSync(audioDir, { recursive: true });

    console.log("🎵 Created audio directory:", audioDir);

  }

  

  if (!fs.existsSync(videosDir)) {

    fs.mkdirSync(videosDir, { recursive: true });

    console.log("🎬 Created videos directory:", videosDir);

  }



  console.log("🎵 Serving audio files from:", audioDir);

  app.use("/audio", express.static(audioDir));



  console.log("🎬 Serving video files from:", videosDir);

  app.use("/videos", express.static(videosDir));



  // Create and serve reports directory for PDF files

  const reportsDir = path.join(__dirname, 'reports');

  if (!fs.existsSync(reportsDir)) {

    fs.mkdirSync(reportsDir, { recursive: true });

    console.log("📊 Created reports directory:", reportsDir);

  }

  console.log("📊 Serving PDF reports from:", reportsDir);

  app.use("/reports", express.static(reportsDir));



  // Security headers for the API surface (mounted here, so it covers /api/*,
  // /, and the debug/test routes below — deliberately NOT the static
  // /storage,/audio,/videos,/reports handlers registered above, so nothing
  // interferes with the frontend loading avatars/screenshots/PDF reports
  // cross-origin; uploaded avatars are already re-encoded to real WebP by
  // sharp on upload).
  //   - contentSecurityPolicy: off — a JSON API plus a one-line HTML health
  //     page gains nothing from CSP and it's an easy way to break a future
  //     embedded response.
  //   - crossOriginResourcePolicy: 'cross-origin' — the frontend origin is
  //     different from this API's; the default 'same-origin' would block
  //     legitimate cross-origin reads.
  //   - crossOriginEmbedderPolicy: off (also the current helmet default) —
  //     pinned so a helmet upgrade can't silently enable COEP and break
  //     third-party resource loads.
  //   - HSTS left at helmet's default: ignored by browsers over plain HTTP
  //     (local dev), correct once the backend is served over HTTPS.
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false,
  }));

  app.use(cors({

    origin: process.env.CORS_ORIGIN,

    credentials: true,

  }));



  // Liveness (/healthz), readiness (/readyz) and Prometheus metrics (/metrics, bearer-protected). Mounted at the root and under /api (a reverse
  // proxy often forwards only /api), before the body parsers and the /api routes: no session, no JSON parsing. See src/monitoring/healthRoutes.js.
  app.use('/api', healthRoutes);
  app.use('/', healthRoutes);

  // Stripe webhook — MUST be registered before express.json() below with its
  // own raw-body parser. Stripe signature verification is an HMAC over the
  // exact raw request bytes; once express.json() has parsed the body into a
  // JS object, the original bytes are gone and verification can never
  // succeed. This route is intentionally registered directly on `app`
  // (not inside src/routes/index.js, which only mounts after express.json())
  // and requires no auth middleware — Stripe calls it server-to-server.

  app.post('/api/subscription/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);



  // Increase payload limit to avoid "request entity too large"

  app.use(express.json({ limit: '50mb' }));

  app.use(express.urlencoded({ limit: '50mb', extended: true }));



  app.use('/api', routes);



  // Previously completely unauthenticated — dumped every job for every
  // user/project in the system to any caller. Gated the same way the
  // existing /api/app_user/projects-needing-scrape ops-visibility endpoint
  // already is (auth, requireAdmin()) rather than removing it outright,
  // since it's a genuinely useful ops/debug tool, just one that must not be
  // public.
  app.get('/debug/jobs', auth, requireAdmin(), async (req, res) => {

    try {

      const jobs = await Job.find({}).lean();

      res.json({ success: true, data: jobs });

    } catch (error) {

      res.status(500).json({ success: false, message: error.message });

    }

  });



  app.get('/', (req, res) => {

    res.json({ message: 'Odito Backend API is running' });

  });



  // Test endpoint for debugging

  app.get('/api/test', (req, res) => {

    console.log('🧪 Test endpoint called');

    res.json({ success: true, message: 'Test endpoint working', timestamp: new Date() });

  });



  // File validation endpoints

  app.get('/api/validate/audio/:projectId', (req, res) => {

    try {

      const { projectId } = req.params;

      const audioPath = path.join(audioDir, `${projectId}.mp3`);

      

      if (!fs.existsSync(audioPath)) {

        return res.status(404).json({

          success: false,

          message: 'Audio file not found',

          path: audioPath

        });

      }

      

      res.json({

        success: true,

        message: 'Audio file exists',

        url: `/audio/${projectId}.mp3`,

        path: audioPath

      });

    } catch (error) {

      res.status(500).json({

        success: false,

        message: error.message

      });

    }

  });



  app.get('/api/validate/video/:projectId', (req, res) => {

    try {

      const { projectId } = req.params;

      const videoPath = path.join(videosDir, `${projectId}.mp4`);

      

      if (!fs.existsSync(videoPath)) {

        return res.status(404).json({

          success: false,

          message: 'Video file not found',

          path: videoPath

        });

      }

      

      res.json({

        success: true,

        message: 'Video file exists',

        url: `/videos/${projectId}.mp4`,

        path: videoPath

      });

    } catch (error) {

      res.status(500).json({

        success: false,

        message: error.message

      });

    }

  });



  app.use((err, req, res, next) => {

    console.error('❌ Error occurred:');

    console.error('  Method:', req.method);

    console.error('  URL:', req.url);

    console.error('  Message:', err.message);

    console.error('  Stack:', err.stack);

    res.status(500).json({

      success: false,

      message: 'Something went wrong!',

      error: process.env.NODE_ENV === 'development' ? err.message : undefined,

    });

  });



  const PORT = process.env.PORT;



  server.listen(PORT, () => {

    markStartupComplete(); // readiness turns green only once the database is connected, the schedulers are registered and the port is open

    console.log(`✓ Server is listening on port ${PORT}`);

    const serviceUrls = {
      api: `${process.env.BACKEND_URL || `http://localhost:${PORT}`}/api`,
      ws: `${process.env.BACKEND_URL || `http://localhost:${PORT}`}`
    };
    console.log(`✓ API available at ${serviceUrls.api}`);
    console.log(`✓ WebSocket server running for real-time updates`);

  });



  // Add server error handling

  server.on('error', (error) => {

    console.error('❌ Server error:', error);

    if (error.code === 'EADDRINUSE') {

      console.error(`❌ Port ${PORT} is already in use`);

    }

  });



  server.on('clientError', (err, socket) => {

    console.error('❌ Client error:', err);

    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');

  });



  process.on('unhandledRejection', (reason, promise) => {

    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);

  });



  process.on('uncaughtException', (error) => {

    console.error('❌ Uncaught Exception:', error);

  });

};



startServer();

