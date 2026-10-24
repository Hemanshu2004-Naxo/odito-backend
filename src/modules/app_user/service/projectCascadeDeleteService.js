import mongoose from 'mongoose';
import { unlink } from 'fs/promises';
import path from 'path';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import mediaStorageService from '../../social_meta/service/media/mediaStorageService.js';
import { purgeProjectSocialData } from '../../social_meta/service/socialProjectCleanupService.js';

const SERVICE = 'ProjectCascadeDelete';

const getDb = () => mongoose.connection.db;

/**
 * Centralized registry of every project-scoped collection to purge on
 * permanent deletion, in the exact order Phase 3 specifies. One entry per
 * collection so there is exactly one deletion code path (the loop in
 * deleteProjectCascade below) — do not add per-collection special-casing.
 *
 * field is 'projectId' or 'project_id' depending on which convention that
 * collection was written with (verified against source, not assumed —
 * see the Safe Project Deletion audit this registry is built from).
 */
const CASCADE_REGISTRY = [
  // 1. Child collections (core SEO pipeline data)
  { category: 'child', collection: 'seo_internal_links', field: 'projectId' },
  { category: 'child', collection: 'seo_social_links', field: 'projectId' },
  { category: 'child', collection: 'seo_page_data', field: 'projectId' },
  { category: 'child', collection: 'seo_crawl_graph', field: 'projectId' },
  { category: 'child', collection: 'seo_page_issues', field: 'projectId' },
  { category: 'child', collection: 'seo_page_summary', field: 'projectId' },
  { category: 'child', collection: 'seo_page_performance', field: 'projectId' },
  { category: 'child', collection: 'seo_page_scores', field: 'projectId' },
  { category: 'child', collection: 'seo_domain_performance', field: 'project_id' },
  { category: 'child', collection: 'seo_audit_url_pool', field: 'project_id' },
  { category: 'child', collection: 'seo_headless_data', field: 'projectId' },
  { category: 'child', collection: 'domain_technical_reports', field: 'projectId' },
  { category: 'child', collection: 'audit_fix_logs', field: 'projectId' },

  // 2. AI collections (ai_generated_videos is handled separately below by
  // purgeProjectVideos — it owns a video file on disk that must be unlinked
  // before its metadata document is safe to delete, same reasoning as the
  // screenshot collections in category 8).
  { category: 'ai', collection: 'ai_pages', field: 'project_id' },
  { category: 'ai', collection: 'ai_scores', field: 'project_id' },
  { category: 'ai', collection: 'ai_issues', field: 'project_id' },
  { category: 'ai', collection: 'ai_projects', field: 'project_id' },
  { category: 'ai', collection: 'aiscripts', field: 'projectId' },

  // 2b. URL Selection records (Review Discovered URLs) — previously missing
  // from this registry entirely; a permanently-deleted project left its
  // url_selections rows behind as orphans.
  { category: 'child', collection: 'url_selections', field: 'project_id' },

  // 3. Rankings
  { category: 'rankings', collection: 'keyword_ranking_history', field: 'project_id' },
  { category: 'rankings', collection: 'seo_rankings', field: 'project_id' },
  { category: 'rankings', collection: 'seo_rankings_current', field: 'project_id' },

  // 4. Recommendations
  { category: 'recommendations', collection: 'recommendations', field: 'projectId' },
  // Owner-confirmed breadcrumb hierarchies (schema-evidence/SchemaBreadcrumbEvidence.js).
  { category: 'recommendations', collection: 'schema_breadcrumb_evidence', field: 'projectId' },
  // Owner-confirmed Organization address (schema-evidence/SchemaOrganizationAddress.js).
  { category: 'recommendations', collection: 'schema_organization_address', field: 'projectId' },

  // 5. Tasks
  { category: 'tasks', collection: 'tasks', field: 'projectId' },

  // 6. Audit history
  { category: 'audit_history', collection: 'audit_runs', field: 'projectId' },

  // 7. Integrations
  { category: 'integrations', collection: 'googleconnections', field: 'project_id' },
  { category: 'integrations', collection: 'analytics_data', field: 'project_id' },
  { category: 'integrations', collection: 'search_console_data', field: 'project_id' },
  { category: 'integrations', collection: 'business_profile_data', field: 'project_id' },
  // Phase 6.3 — all three registered from day one (unlike business_profile_data,
  // which only ever registered itself and left metadata/reviews/media orphaned).
  { category: 'integrations', collection: 'google_ads_campaigns', field: 'project_id' },
  { category: 'integrations', collection: 'google_ads_campaign_metrics', field: 'project_id' },
  { category: 'integrations', collection: 'google_ads_campaign_snapshots', field: 'project_id' },
  // Phase 6.4 — same discipline, all four registered immediately.
  { category: 'integrations', collection: 'google_ads_keywords', field: 'project_id' },
  { category: 'integrations', collection: 'google_ads_search_terms', field: 'project_id' },
  { category: 'integrations', collection: 'google_ads_recommendations', field: 'project_id' },
  { category: 'integrations', collection: 'google_ads_optimization_history', field: 'project_id' },
  // Phase 6.5 — same discipline, all six registered immediately.
  { category: 'integrations', collection: 'google_ads_device_performance', field: 'project_id' },
  { category: 'integrations', collection: 'google_ads_geo_performance', field: 'project_id' },
  { category: 'integrations', collection: 'google_ads_audience_performance', field: 'project_id' },
  { category: 'integrations', collection: 'google_ads_ads', field: 'project_id' },
  { category: 'integrations', collection: 'google_ads_conversion_actions', field: 'project_id' },
  { category: 'integrations', collection: 'google_ads_budget_alerts', field: 'project_id' },

  // 8c. Social Media AI — user-entered business profile and generated AI strategies.
  // The collections of the AI features are registered here. The connection / publishing
  // collections (social accounts, publications, approval settings, import batches, pending
  // Meta connections, synced posts) are NOT in this list on purpose: they hold live
  // credentials and scheduled posts, so purgeProjectSocialData (socialProjectCleanupService.js)
  // removes them in a fixed order BEFORE this loop, and a failure there keeps the project
  // in the trash so the daily purge retries it.
  { category: 'social', collection: 'socialbusinessprofiles', field: 'project_id' },
  { category: 'social', collection: 'social_ai_strategies', field: 'project_id' },
  { category: 'social', collection: 'social_content_generations', field: 'project_id' },
  { category: 'social', collection: 'social_design_generations', field: 'project_id' },
  // Product Catalog (SocialProduct). The files its images point at are removed by purgeProjectCatalogMedia() BEFORE this
  // registry runs (it needs the documents to know which files exist); services are embedded in socialbusinessprofiles.
  { category: 'social', collection: 'social_products', field: 'project_id' },
  // Content Calendar: the run records and their planned items (planning metadata only; no files).
  { category: 'social', collection: 'social_content_calendars', field: 'project_id' },
  { category: 'social', collection: 'social_content_calendar_items', field: 'project_id' },
  // The usage ledger: the PROJECT's own monthly counters (scope_id is the project id). The account's ledger is the owner's, not the project's, and stays.
  { category: 'social', collection: 'social_ai_usage', field: 'scope_id' },

  // 8d. ChatGPT Visibility (own history, deliberately NOT cleared by the SEO recrawl reset): runs and the versioned prompt sets.
  { category: 'ai', collection: 'chatgpt_visibility_runs', field: 'projectId' },
  { category: 'ai', collection: 'ai_visibility_prompt_sets', field: 'projectId' },
  // Approved question sets (the reusable definitions) and the evidence (answers + citations) collected for them.
  { category: 'ai', collection: 'ai_visibility_question_sets', field: 'projectId' },
  { category: 'ai', collection: 'ai_visibility_evidence', field: 'projectId' },

  // 9. Jobs (8 = screenshot metadata, handled separately below — it needs
  // file cleanup before its documents can be deleted)
  { category: 'jobs', collection: 'jobs', field: 'project_id' },
];

const SCREENSHOT_COLLECTIONS = ['seo_first_snapshot', 'seo_mainurl_snapshot'];

/**
 * Delete every document in `collection` matching `{[field]: projectIdObj}`.
 * The one and only deletion code path used by both the registry loop and
 * the screenshot-metadata cleanup below.
 */
async function purgeCollection(db, collection, field, projectIdObj) {
  const result = await db.collection(collection).deleteMany({ [field]: projectIdObj });
  return result.deletedCount;
}

/**
 * Part 2 — screenshot cleanup. For each of the two snapshot-metadata
 * collections: read screenshot_path, unlink the file (ignoring ENOENT —
 * Scenario 4: an already-missing file is not a failure), then delete the
 * metadata documents via the same purgeCollection() used everywhere else.
 *
 * screenshot_path is stored relative to the odito_backend directory (e.g.
 * "storage/screenshots/internalpages/xyz.png") — see
 * python_workers/scraper/shared/screenshots.py, which computes it via
 * os.path.relpath(captured_path, PROJECT_ROOT / "odito_backend"). Resolving
 * it against process.cwd() matches how server.js itself serves the same
 * directory ( path.resolve(process.cwd(), "storage") ).
 */
async function purgeProjectScreenshots(projectId, projectIdObj) {
  const db = getDb();
  const counts = {};

  for (const collection of SCREENSHOT_COLLECTIONS) {
    let filesDeleted = 0;
    let filesMissing = 0;
    let fileErrors = 0;

    let docs = [];
    try {
      docs = await db.collection(collection)
        .find({ project_id: projectIdObj }, { projection: { screenshot_path: 1 } })
        .toArray();
    } catch (error) {
      LoggerUtil.error(`${SERVICE}: failed to read ${collection} for screenshot cleanup`, error, { projectId });
    }

    for (const doc of docs) {
      if (!doc.screenshot_path) continue;
      const absolutePath = path.resolve(process.cwd(), doc.screenshot_path);
      try {
        await unlink(absolutePath);
        filesDeleted += 1;
      } catch (error) {
        if (error.code === 'ENOENT') {
          filesMissing += 1;
        } else {
          fileErrors += 1;
          LoggerUtil.error(`${SERVICE}: failed to delete screenshot file`, error, { projectId, path: absolutePath });
        }
      }
    }

    let metadataDeleted = 0;
    try {
      metadataDeleted = await purgeCollection(db, collection, 'project_id', projectIdObj);
    } catch (error) {
      LoggerUtil.error(`${SERVICE}: failed to clear ${collection} metadata`, error, { projectId });
    }

    counts[collection] = { filesDeleted, filesMissing, fileErrors, metadataDeleted };
  }

  LoggerUtil.info(`${SERVICE}: screenshot cleanup complete`, { projectId, counts });
  return counts;
}

/**
 * Part 2b — AI-generated video cleanup. Same shape as
 * purgeProjectScreenshots above: unlink the file (ENOENT-safe) before
 * removing the metadata document, so a video is never orphaned on disk by
 * a plain deleteMany. videoFileName is a bare filename (not a path — see
 * aiGeneratedVideo.model.js), resolved against the same public/videos
 * directory server.js serves at the /videos static mount.
 */
async function purgeProjectVideos(projectId, projectIdObj) {
  const db = getDb();
  const videosDir = path.resolve(process.cwd(), 'public', 'videos');
  let filesDeleted = 0;
  let filesMissing = 0;
  let fileErrors = 0;

  let docs = [];
  try {
    docs = await db.collection('ai_generated_videos')
      .find({ projectId: projectIdObj }, { projection: { videoFileName: 1 } })
      .toArray();
  } catch (error) {
    LoggerUtil.error(`${SERVICE}: failed to read ai_generated_videos for video cleanup`, error, { projectId });
  }

  for (const doc of docs) {
    if (!doc.videoFileName) continue;
    // Defense in depth: videoFileName is always a bare filename this
    // backend itself generated, but never resolve outside videosDir even
    // if a stored value were ever malformed.
    const absolutePath = path.resolve(videosDir, doc.videoFileName);
    if (!absolutePath.startsWith(videosDir)) continue;
    try {
      await unlink(absolutePath);
      filesDeleted += 1;
    } catch (error) {
      if (error.code === 'ENOENT') {
        filesMissing += 1;
      } else {
        fileErrors += 1;
        LoggerUtil.error(`${SERVICE}: failed to delete video file`, error, { projectId, path: absolutePath });
      }
    }
  }

  let metadataDeleted = 0;
  try {
    metadataDeleted = await purgeCollection(db, 'ai_generated_videos', 'projectId', projectIdObj);
  } catch (error) {
    LoggerUtil.error(`${SERVICE}: failed to clear ai_generated_videos metadata`, error, { projectId });
  }

  const counts = { filesDeleted, filesMissing, fileErrors, metadataDeleted };
  LoggerUtil.info(`${SERVICE}: video cleanup complete`, { projectId, counts });
  return counts;
}

/**
 * Part 2c — catalog media cleanup. Product images and the user's brand logo are files in the shared social media
 * storage (storage/social_media/<projectId>/); their documents only hold a reference. This reads the storage keys
 * and unlinks the files (ENOENT-safe, and only keys that belong to THIS project are accepted by deleteByKey) so a
 * purged project leaves no catalog file behind. The documents themselves are removed by the registry loop, which
 * must run AFTER this. Post media (SocialPublication) is deliberately not touched here.
 */
async function purgeProjectCatalogMedia(projectId, projectIdObj) {
  const db = getDb();
  const keys = [];
  try {
    const products = await db.collection('social_products').find({ project_id: projectIdObj }, { projection: { 'images.storageKey': 1 } }).toArray();
    for (const doc of products) for (const img of doc.images || []) if (img?.storageKey) keys.push(img.storageKey);
    const profiles = await db.collection('socialbusinessprofiles').find({ project_id: projectIdObj }, { projection: { 'brand.logo.storageKey': 1 } }).toArray();
    for (const doc of profiles) if (doc.brand?.logo?.storageKey) keys.push(doc.brand.logo.storageKey);
  } catch (error) {
    LoggerUtil.error(`${SERVICE}: failed to read catalog media references`, error, { projectId });
  }

  let filesDeleted = 0;
  let filesMissing = 0;
  for (const key of keys) {
    // deleteByKey never throws; false = already gone, malformed, or not this project's file
    if (await mediaStorageService.deleteByKey(key, { projectId })) filesDeleted += 1;
    else filesMissing += 1;
  }
  const counts = { filesDeleted, filesMissing };
  LoggerUtil.info(`${SERVICE}: catalog media cleanup complete`, { projectId, counts });
  return counts;
}

/**
 * The single source of truth for permanently deleting a project — called by
 * both the manual permanent-delete endpoint and the daily purge scheduler.
 *
 * Idempotent: every step is a deleteMany/deleteOne scoped by projectId, so
 * re-running this against an already-partially-or-fully-purged project is
 * always safe (an empty match just deletes 0 documents, not an error).
 * Sequential, no Mongo transaction (this deployment's MongoDB is a
 * standalone instance — see the Safe Project Deletion audit's Phase 6).
 * Retryable: a caller can call this again after a failure and it will pick
 * up wherever the previous attempt left off.
 *
 * Never throws for a single collection's failure (Scenario 5) — every step
 * is individually caught and recorded in the returned `failures` array so
 * the rest of the cascade still runs. It DOES let a malformed projectId
 * (invalid ObjectId) throw synchronously before any work starts, since that
 * is a caller bug, not a partial-failure case.
 *
 * @param {string} projectId
 * @returns {Promise<{projectId:string, durationMs:number, collectionCounts:object, screenshotCounts:object, videoCounts:object, catalogMediaCounts:object, socialCounts:object, retryable:boolean, failures:object[], projectDeleted:boolean}>}
 */
export async function deleteProjectCascade(projectId) {
  const projectIdObj = new mongoose.Types.ObjectId(projectId);
  const db = getDb();
  const startedAt = Date.now();

  LoggerUtil.service(SERVICE, 'purge', 'started', { projectId });

  const collectionCounts = {};
  const failures = [];

  // 0. Catalog media files first: they are found through the product / profile documents the registry deletes below.
  const catalogMediaCounts = await purgeProjectCatalogMedia(projectId, projectIdObj);

  // 0b. Social credentials + publications, first of all the database work: from here on nothing can be dispatched for this
  // project. Never throws; critical failures are reported so the project document is kept and the purge can be retried.
  const social = await purgeProjectSocialData(projectId);
  for (const failure of social.failures) failures.push({ collection: `social:${failure.step}`, error: failure.error });

  // 1–7, 9: registry-driven collections (screenshot metadata, category 8,
  // is handled by purgeProjectScreenshots below since it needs file I/O
  // before its documents can be removed).
  for (const { collection, field } of CASCADE_REGISTRY) {
    try {
      collectionCounts[collection] = await purgeCollection(db, collection, field, projectIdObj);
    } catch (error) {
      failures.push({ collection, error: error.message });
      LoggerUtil.error(`${SERVICE}: failed to clear ${collection}`, error, { projectId });
      // Scenario 5: one collection failing must not stop the rest.
    }
  }

  // 8. Screenshot metadata + files
  const screenshotCounts = await purgeProjectScreenshots(projectId, projectIdObj);

  // 8b. AI-generated video metadata + file
  const videoCounts = await purgeProjectVideos(projectId, projectIdObj);

  // 10. SeoProject — always last. Attempted regardless of failures above EXCEPT when live credentials or scheduled posts
  // could not be removed: the project then stays in the trash (retryable) instead of orphaning them for good.
  let projectDeleted = false;
  const retryable = social.retryable;
  if (retryable) {
    LoggerUtil.error(`${SERVICE}: social credentials/publications were not fully removed; keeping the project for a retry`, null, { projectId });
  } else {
    try {
      const result = await db.collection('seoprojects').deleteOne({ _id: projectIdObj });
      projectDeleted = result.deletedCount > 0;
    } catch (error) {
      failures.push({ collection: 'seoprojects', error: error.message });
      LoggerUtil.error(`${SERVICE}: failed to delete SeoProject document`, error, { projectId });
    }
  }

  const summary = {
    projectId,
    durationMs: Date.now() - startedAt,
    collectionCounts,
    screenshotCounts,
    videoCounts,
    catalogMediaCounts,
    socialCounts: social.counts,
    retryable,
    failures,
    projectDeleted,
  };

  LoggerUtil.service(SERVICE, 'purge', failures.length ? 'completed_with_errors' : 'completed', {
    projectId,
    durationMs: summary.durationMs,
    collectionCounts,
    screenshotCounts,
    videoCounts,
    catalogMediaCounts,
    failureCount: failures.length,
    projectDeleted,
  });

  return summary;
}
