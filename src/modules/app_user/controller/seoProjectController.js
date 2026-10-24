import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import SeoProject from '../model/SeoProject.js';
import { JobService } from '../../jobs/service/jobService.js';
import { JOB_TYPES } from '../../jobs/constants/jobTypes.js';
import Job from '../../jobs/model/Job.js';
import { ProjectPerformanceService } from '../service/projectPerformance.service.js';
import { IssueCountsService } from '../service/issueCounts.service.js';
import { TechnicalChecksService } from '../service/technicalChecks.service.js';
import mongoose from 'mongoose';
import { checkPublicWebsiteUrl } from '../../../utils/publicWebsiteUrl.js';
import { isAuditInProgress } from '../service/projectAuditService.js';
import { deleteProjectCascade } from '../service/projectCascadeDeleteService.js';
import { hasCredits, deductCredits, refundCredits } from '../../../utils/creditService.js';
import { canConsumeQuota } from '../../subscription/service/subscriptionLifecycle.js';
import { isIndustryValue, LOCATION_SOURCES } from '../../../config/industries.js';

/**
 * Validate the business-profile fields of a create/update body. Only fields PRESENT in the body are returned, so an update never
 * resets something the client did not send; an explicit null / '' clears it. Industry must be a taxonomy value: a generic
 * business type ("Service-based") or free text is refused rather than stored as an industry.
 * @returns {{ error: string|null, code?: string, values: object }}
 */
export function validateProfileFields(body = {}) {
  const values = {};
  const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : null);
  if (body.industry !== undefined) {
    const v = text(body.industry, 100);
    if (v && !isIndustryValue(v)) return { error: 'Choose an industry from the list', code: 'INVALID_INDUSTRY', values };
    values.industry = v || null;
  }
  if (body.sub_industry !== undefined) values.sub_industry = text(body.sub_industry, 100) || null;
  if (body.target_city !== undefined) values.target_city = text(body.target_city, 100) || null;
  if (body.location_source !== undefined) {
    const v = body.location_source || null;
    if (v !== null && !LOCATION_SOURCES.includes(v)) return { error: 'Invalid location source', code: 'INVALID_LOCATION_SOURCE', values };
    values.location_source = v;
  }
  return { error: null, values };
}

// A retried create (double-click, or a client retry after a timed-out response)
// for the SAME user + name + URL within this window returns the project that was
// already created instead of failing - and never charges a second credit.
const CREATE_IDEMPOTENCY_WINDOW_MS = 10 * 60 * 1000;

// Create a new SEO project
const createSeoProject = async (req, res) => {
  const { 
    project_name, 
    main_url, 
    keywords, 
    business_type,
    industry,
    location,
    country = null,
    language = 'en',
    description,
    scrape_frequency = 'manual',
    status = 'draft',
    // Website Manual Fallback fields
    onboarding_mode,
    discovery_source,
    extracted_metadata,
    verified_business,
    source,
    seo_scope,
    business_name
  } = req.body;

  LoggerUtil.info('Create project request received', { userId: req.user?._id });
  LoggerUtil.debug('Request body', req.body);

  try {

    // Validate required fields with detailed error messages
    if (!project_name?.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Project name is required'
      });
    }

    if (!main_url?.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Main URL is required'
      });
    }

    if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'At least one keyword is required'
      });
    }

    const profileCheck = validateProfileFields(req.body);
    if (profileCheck.error) {
      return res.status(400).json({ success: false, code: profileCheck.code, message: profileCheck.error });
    }

    // Server-side URL validation. Syntax only (no fetch): http(s), no credentials,
    // and nothing loopback/private/link-local/internal - main_url is fetched
    // server-side later (crawler, brand assets), so it must not name our own network.
    const urlCheck = checkPublicWebsiteUrl(main_url, { allowPublicIp: true, allowCustomPorts: true });
    if (!urlCheck.ok) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_MAIN_URL',
        message: urlCheck.reason
      });
    }

    // Idempotent retry: see CREATE_IDEMPOTENCY_WINDOW_MS. Checked before the
    // subscription/credit gates on purpose - replaying an already-created project
    // must not fail just because that creation consumed the user's last credit.
    const existingRecent = await SeoProject.findOne({
      user_id: req.user._id,
      project_name: project_name.trim(),
      main_url: main_url.trim().toLowerCase(),
      is_deleted: { $ne: true },
      created_at: { $gte: new Date(Date.now() - CREATE_IDEMPOTENCY_WINDOW_MS) }
    });
    if (existingRecent) {
      LoggerUtil.info('Duplicate project create replayed as no-op', { userId: req.user._id, projectId: existingRecent._id });
      return res.status(200).json({
        success: true,
        idempotent: true,
        message: 'SEO Project already created',
        data: { project: existingRecent, projectId: existingRecent._id }
      });
    }

    // Subscription lifecycle gate (Phase 15) — a paused/canceled/past_due
    // subscription cannot create new projects, independent of remaining
    // credit balance. Checked before the credit check so the error a
    // past_due user sees points at the actual blocker (their subscription),
    // not a misleading "insufficient credits".
    if (!canConsumeQuota(req.user.subscription.status)) {
      return res.status(403).json({
        success: false,
        code: 'SUBSCRIPTION_NOT_ACTIVE',
        message: `Your subscription is ${req.user.subscription.status}. Resolve this via Billing Portal to create new projects.`
      });
    }

    // Cheap fast-fail: req.user is already loaded by the auth middleware, so
    // this is a read-only check with no extra DB round-trip. Not the
    // authoritative gate — that's the atomic deductCredits() call below,
    // right before the project is actually created. This just avoids doing
    // the duplicate-name query for a request that's obviously going to be
    // rejected anyway.
    if (!hasCredits(req.user, 1)) {
      return res.status(403).json({
        success: false,
        code: 'INSUFFICIENT_CREDITS',
        message: 'No credits remaining. Upgrade your plan to create a new project.'
      });
    }

    // Check if project name already exists for this user
    const existingProject = await SeoProject.findOne({
      user_id: req.user._id,
      project_name: project_name.trim()
    });

    if (existingProject) {
      return res.status(400).json({
        success: false,
        message: 'A project with this name already exists'
      });
    }

    // Authoritative, atomic credit gate — 1 credit = 1 project. Guarded via
    // $expr inside deductCredits() so two concurrent creation requests can
    // never both succeed: MongoDB serializes concurrent updates to the same
    // User document, so only one request can push `used` past `limit`'s
    // ceiling. The loser gets INSUFFICIENT_CREDITS here, before any project
    // document is ever built.
    try {
      await deductCredits(req.user._id, 1);
    } catch (creditError) {
      if (creditError.code === 'INSUFFICIENT_CREDITS') {
        return res.status(403).json({
          success: false,
          code: 'INSUFFICIENT_CREDITS',
          message: 'No credits remaining. Upgrade your plan to create a new project.'
        });
      }
      throw creditError;
    }

    // CRITICAL LOG: Capture keywords before saving to DB
    const processedKeywords = keywords.map(k => k.trim()).filter(k => k.length >= 2);

    // Create the SEO project with new schema
    const seoProject = new SeoProject({
      user_id: req.user._id,
      project_name: project_name.trim(),
      main_url: main_url.trim().toLowerCase(),
      keywords: processedKeywords,
      business_type: business_type?.trim() || null,
      industry: profileCheck.values.industry ?? null,
      sub_industry: profileCheck.values.sub_industry ?? null,
      target_city: profileCheck.values.target_city ?? null,
      location_source: profileCheck.values.location_source ?? null,
      location: location?.trim() || null,
      // An explicit country wins; otherwise use the verified business's country
      // code so a Places-verified project is not left with country: null.
      country: (country || verified_business?.countryCode)?.toUpperCase() || null,
      language: language.toLowerCase(),
      description: description?.trim() || '',
      scrape_frequency: scrape_frequency || 'manual',
      status: status || 'draft',
      // Website Manual Fallback fields (optional, backward-compatible)
      ...(onboarding_mode && { onboarding_mode }),
      ...(discovery_source && { discovery_source }),
      ...(extracted_metadata && { extracted_metadata }),
      ...(verified_business && { verified_business }),
      ...(source && { source }),
      ...(seo_scope && { seo_scope }),
      // Name the customer entered/confirmed (unverified); separate from verified_business.
      ...(typeof business_name === 'string' && business_name.trim() && { business_name: business_name.trim() })
    });

    // The credit is already spent at this point. If saving the project
    // fails for any reason, the credit must never be permanently lost —
    // refund it, then re-throw so the existing catch block below still
    // formats the HTTP response exactly as it did before (ValidationError,
    // duplicate key, or generic 500), with no duplicated error-handling logic.
    let savedProject;
    try {
      savedProject = await seoProject.save();
    } catch (saveError) {
      await refundCredits(req.user._id, 1);
      throw saveError;
    }

    // Link most recent Homepage Audit for this URL (non-blocking)
    try {
      const [{ default: HomepageAudit }, { normalizeUrl }] = await Promise.all([
        import('../../external/model/HomepageAudit.js'),
        import('../../../utils/normalizeUrl.js')
      ]);
      const normalizedUrl = normalizeUrl(savedProject.main_url);

      const preAudit = await HomepageAudit.findOne({ url: normalizedUrl })
        .sort({ created_at: -1 })
        .lean();

      if (preAudit) {
        await SeoProject.findByIdAndUpdate(savedProject._id, { pre_audit_id: preAudit._id });
        savedProject.pre_audit_id = preAudit._id;
        LoggerUtil.info('Pre-audit linked to project', { projectId: savedProject._id, auditId: preAudit._id });
      }
    } catch (linkError) {
      LoggerUtil.error('Failed to link pre-audit to project', linkError, { projectId: savedProject._id });
    }

    res.status(201).json({
      success: true,
      message: 'SEO Project created successfully',
      data: {
        project: savedProject,
        projectId: savedProject._id
      }
    });

  } catch (error) {
    LoggerUtil.error('Error creating SEO project', error, { userId: req.user?._id });
    
    // Handle validation errors
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map(err => err.message);
      return res.status(400).json(ResponseUtil.validationError(errors, 'Validation failed'));
    }

    // Handle duplicate key error
    if (error.code === 11000) {
      return res.status(400).json(ResponseUtil.error('Duplicate entry detected', 400));
    }

    return res.status(500).json(ResponseUtil.error('Internal server error', 500));
  }
};

// Get all SEO projects for the logged-in user
const getAllSeoProjects = async (req, res) => {
  try {
    const { page = 1, limit = 10, status, search, industry, scrape_frequency } = req.query;
    const skip = (page - 1) * limit;

    // Build query — excludes trashed projects (Project Trash & Restore, Phase 1)
    const query = { user_id: req.user._id, is_deleted: { $ne: true } };

    // Filter by status if provided
    if (status) {
      query.status = status;
    }

    // Filter by industry if provided
    if (industry) {
      query.industry = { $regex: industry, $options: 'i' };
    }

    // Filter by scrape frequency if provided
    if (scrape_frequency) {
      query.scrape_frequency = scrape_frequency;
    }

    // Search by project name or business name if provided
    if (search) {
      query.$or = [
        { project_name: { $regex: search, $options: 'i' } },
        { business_type: { $regex: search, $options: 'i' } },
        { main_url: { $regex: search, $options: 'i' } }
      ];
    }

    // Get projects with pagination and enhanced fields
    const projects = await SeoProject.aggregate([
      { $match: query },
      { $sort: { created_at: -1 } },
      {
        $addFields: {
          keyword_count: { $size: { $ifNull: ['$keywords', []] } },
          project_age_days: {
            $floor: {
              $divide: [
                { $subtract: [new Date(), '$created_at'] },
                1000 * 60 * 60 * 24
              ]
            }
          },
          days_since_last_scrape: {
            $cond: {
              if: { $ne: ['$last_scraped_at', null] },
              then: {
                $floor: {
                  $divide: [
                    { $subtract: [new Date(), '$last_scraped_at'] },
                    1000 * 60 * 60 * 24
                  ]
                }
              },
              else: null
            }
          },
          // NEW: Add crawl duration formatting
          crawl_duration_formatted: {
            $cond: {
              if: { $gt: ['$crawl_duration', 0] },
              then: {
                $let: {
                  vars: {
                    totalSeconds: { $floor: { $divide: ['$crawl_duration', 1000] } }
                  },
                  in: {
                    $concat: [
                      { $toString: { $floor: { $divide: ['$$totalSeconds', 60] } } },
                      'm ',
                      { $toString: { $mod: ['$$totalSeconds', 60] } },
                      's'
                    ]
                  }
                }
              },
              else: 'N/A'
            }
          }
        }
      },
      {
        $project: {
          project_name: 1,
          main_url: 1,
          business_type: 1,
          industry: 1,
          location: 1,
          country: 1,
          language: 1,
          status: 1,
          scrape_frequency: 1,
          last_scraped_at: 1,
          total_pages: 1,
          total_issues: 1,
          // NEW: Include crawl summary fields
          pages_discovered: 1,
          pages_crawled: 1,
          pages_analyzed: 1,
          crawl_duration: 1,
          crawl_success_rate: 1,
          crawl_coverage_rate: 1,
          crawl_status: 1,
          last_analysis_at: 1,
          crawl_duration_formatted: 1,
          keyword_count: 1,
          project_age_days: 1,
          days_since_last_scrape: 1,
          created_at: 1,
          updated_at: 1,
          pre_audit_id: 1
        }
      },
      { $skip: skip },
      { $limit: parseInt(limit) }
    ]);

    // Get total count for pagination
    const totalProjects = await SeoProject.countDocuments(query);

    // Get statistics (also excludes trashed projects, matching the list above)
    const stats = await SeoProject.aggregate([
      { $match: { user_id: req.user._id, is_deleted: { $ne: true } } },
      {
        $group: {
          _id: null,
          totalProjects: { $sum: 1 },
          activeProjects: {
            $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] }
          },
          draftProjects: {
            $sum: { $cond: [{ $eq: ['$status', 'draft'] }, 1, 0] }
          },
          pausedProjects: {
            $sum: { $cond: [{ $eq: ['$status', 'paused'] }, 1, 0] }
          },
          errorProjects: {
            $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] }
          },
          totalScraped: {
            $sum: { $cond: [{ $ne: ['$last_scraped_at', null] }, 1, 0] }
          },
          totalPages: { $sum: '$total_pages' },
          totalIssues: { $sum: '$total_issues' },
          // NEW: Add crawl summary statistics
          completedCrawls: {
            $sum: { $cond: [{ $eq: ['$crawl_status', 'completed'] }, 1, 0] }
          },
          averageCrawlDuration: {
            $avg: { $cond: [{ $gt: ['$crawl_duration', 0] }, '$crawl_duration', null] }
          },
          totalPagesDiscovered: { $sum: '$pages_discovered' },
          totalPagesCrawled: { $sum: '$pages_crawled' },
          totalPagesAnalyzed: { $sum: '$pages_analyzed' }
        }
      }
    ]);

    res.status(200).json({
      success: true,
      data: {
        projects,
        pagination: {
          currentPage: parseInt(page),
          totalPages: Math.ceil(totalProjects / limit),
          totalProjects,
          hasNext: page * limit < totalProjects,
          hasPrev: page > 1
        },
        stats: stats[0] || {
          totalProjects: 0,
          activeProjects: 0,
          draftProjects: 0,
          pausedProjects: 0,
          errorProjects: 0,
          totalScraped: 0,
          totalPages: 0,
          totalIssues: 0,
          // NEW: Default crawl summary statistics
          completedCrawls: 0,
          averageCrawlDuration: 0,
          totalPagesDiscovered: 0,
          totalPagesCrawled: 0,
          totalPagesAnalyzed: 0
        }
      }
    });
  } catch (error) {
    LoggerUtil.error('Error getting projects', error, { userId: req.user._id });
    return res.status(500).json(ResponseUtil.error('Failed to get projects', 500));
  }
};

// Get single SEO project by ID
const getSeoProjectById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid project ID'
      });
    }

    const project = await SeoProject.findOne({
      _id: id,
      user_id: req.user._id,
      is_deleted: { $ne: true }
    });

    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    // Fetch latest screenshot for this project - DISABLED
    let screenshotUrl = null;
    try {
      // Screenshots disabled for performance
      LoggerUtil.debug('Screenshot fetching DISABLED', { projectId: id });
    } catch (screenshotError) {
      LoggerUtil.error('Error fetching screenshot', screenshotError, { projectId: id });
      // Continue without screenshot if fetch fails
    }

    const projectData = {
      ...project.toObject(),
      screenshot_url: screenshotUrl
    };

    LoggerUtil.debug('Project data response', { 
      projectId: id, 
      hasScreenshot: !!screenshotUrl
    });

    res.status(200).json({
      success: true,
      data: projectData
    });

  } catch (error) {
    LoggerUtil.error('Error fetching SEO project', error, { projectId: req.params.id });
    return res.status(500).json(ResponseUtil.error('Internal server error', 500));
  }
};

// Update SEO project details
const updateSeoProject = async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      project_name, 
      main_url, 
      keywords, 
      business_type,
      industry,
      location,
      country, 
      language, 
      description,
      scrape_frequency,
      status
    } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid project ID'
      });
    }

    // Find the project and ensure it belongs to the user
    const project = await SeoProject.findOne({
      _id: id,
      user_id: req.user._id
    });

    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    // Check if new project name conflicts with existing projects
    if (project_name && project_name !== project.project_name) {
      const existingProject = await SeoProject.findOne({
        _id: { $ne: id },
        user_id: req.user._id,
        project_name: project_name.trim()
      });

      if (existingProject) {
        return res.status(400).json({
          success: false,
          message: 'A project with this name already exists'
        });
      }
    }

    const profileCheck = validateProfileFields(req.body);
    if (profileCheck.error) {
      return res.status(400).json({ success: false, code: profileCheck.code, message: profileCheck.error });
    }

    // Update project fields with new schema
    if (project_name) project.project_name = project_name.trim();
    if (main_url) project.main_url = main_url.trim().toLowerCase();
    if (keywords) project.keywords = keywords.map(k => k.trim()).filter(k => k.length >= 2);
    if (business_type !== undefined) project.business_type = business_type?.trim() || null;
    // Only fields present in the body change (an omitted field is never reset).
    for (const [field, value] of Object.entries(profileCheck.values)) project[field] = value;
    if (location !== undefined) project.location = location?.trim() || null;
    if (country) project.country = country.toUpperCase();
    if (language) project.language = language.toLowerCase();
    if (description !== undefined) project.description = description?.trim() || '';
    if (scrape_frequency) project.scrape_frequency = scrape_frequency;
    if (status) project.status = status;

    await project.save();

    res.status(200).json({
      success: true,
      message: 'Project updated successfully',
      data: project
    });

  } catch (error) {
    LoggerUtil.error('Error updating SEO project', error, { projectId: req.params.id });
    
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map(err => err.message);
      return res.status(400).json(ResponseUtil.validationError(errors, 'Validation failed'));
    }

    return res.status(500).json(ResponseUtil.error('Internal server error', 500));
  }
};

// Update project status
const updateSeoProjectStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid project ID'
      });
    }

    if (!['draft', 'active', 'paused', 'error'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status. Must be draft, active, paused, or error'
      });
    }

    const project = await SeoProject.findOneAndUpdate(
      {
        _id: id,
        user_id: req.user._id
      },
      { status },
      { new: true }
    );

    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Project status updated successfully',
      data: project
    });

  } catch (error) {
    LoggerUtil.error('Error updating SEO project status', error, { projectId: req.params.id });
    return res.status(500).json(ResponseUtil.error('Internal server error', 500));
  }
};

// Delete SEO project
const deleteSeoProject = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid project ID'
      });
    }

    // Find the project and ensure it belongs to the user. Excludes already-
    // trashed projects so deleting twice reports 404, not a silent re-trash.
    const project = await SeoProject.findOne({
      _id: id,
      user_id: req.user._id,
      is_deleted: { $ne: true }
    });

    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    // 🔒 AUDIT SAFETY: block soft delete while an audit is running/pending/
    // processing — reuses the exact same guard startProjectAudit() uses, so
    // "in progress" means the same thing everywhere in this codebase.
    if (await isAuditInProgress(id)) {
      return res.status(409).json({
        success: false,
        code: 'AUDIT_IN_PROGRESS',
        message: 'An audit is currently running for this project. Wait for it to finish, or cancel it, before deleting.'
      });
    }

    // Soft delete — move to trash instead of removing any data (Project
    // Trash & Restore, Phase 1). No collections besides SeoProject itself
    // are touched; restore just has to flip is_deleted back to false.
    const now = new Date();
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

    await SeoProject.updateOne(
      { _id: id },
      {
        is_deleted: true,
        deleted_at: now,
        scheduled_purge_at: new Date(now.getTime() + SEVEN_DAYS_MS),
        deleted_by: req.user._id
      }
    );

    res.status(200).json({
      success: true,
      message: 'Project moved to trash'
    });

  } catch (error) {
    LoggerUtil.error('Error deleting SEO project', error, { projectId: req.params.id });
    return res.status(500).json(ResponseUtil.error('Internal server error', 500));
  }
};

// ── Project Trash (Phase 1) ──────────────────────────────────────────────

// List trashed projects for the current user
const getTrashedProjects = async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    const skip = (page - 1) * limit;

    const query = { user_id: req.user._id, is_deleted: true };

    const [projects, totalProjects] = await Promise.all([
      SeoProject.find(query)
        .select('project_name main_url business_type industry status scrape_frequency deleted_at scheduled_purge_at deleted_by user_id created_at')
        .populate('deleted_by', 'firstName lastName roleId')
        .sort({ deleted_at: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      SeoProject.countDocuments(query)
    ]);

    // Whether the OWNER themselves deleted it (deleted_by === user_id) vs a
    // System Admin did (see deleteProjectSoft in systemAdminProjectService.js,
    // which never has ownership of the project it deletes). No new field —
    // this is derived from the two fields that already exist.
    const projectsWithPermission = projects.map((project) => {
      const deletedByOwner = !project.deleted_by || project.deleted_by._id.toString() === project.user_id.toString();
      const obj = project.toObject();
      obj.deletedByOwner = deletedByOwner;
      return obj;
    });

    res.status(200).json({
      success: true,
      data: {
        projects: projectsWithPermission,
        pagination: {
          currentPage: parseInt(page),
          totalPages: Math.ceil(totalProjects / limit),
          totalProjects,
          hasNext: page * limit < totalProjects,
          hasPrev: page > 1
        }
      }
    });
  } catch (error) {
    LoggerUtil.error('Error getting trashed projects', error, { userId: req.user._id });
    return res.status(500).json(ResponseUtil.error('Failed to get trashed projects', 500));
  }
};

// Get a single trashed project by ID
const getTrashedProjectById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid project ID'
      });
    }

    // Deliberately requires is_deleted: true — this endpoint only exists to
    // view trashed projects, unlike getSeoProjectById which now excludes them.
    const project = await SeoProject.findOne({
      _id: id,
      user_id: req.user._id,
      is_deleted: true
    }).populate('deleted_by', 'firstName lastName roleId');

    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Trashed project not found'
      });
    }

    const deletedByOwner = !project.deleted_by || project.deleted_by._id.toString() === project.user_id.toString();
    const obj = project.toObject();
    obj.deletedByOwner = deletedByOwner;

    res.status(200).json({
      success: true,
      data: obj
    });
  } catch (error) {
    LoggerUtil.error('Error getting trashed project', error, { projectId: req.params.id });
    return res.status(500).json(ResponseUtil.error('Internal server error', 500));
  }
};

// Restore a trashed project (Phase 2)
const restoreProject = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid project ID'
      });
    }

    // Looked up WITHOUT scoping by user_id or is_deleted here, on purpose —
    // that lets us tell apart the three distinct outcomes the API contract
    // requires (404 vs 403 vs 400) instead of collapsing them all into 404.
    const project = await SeoProject.findById(id);

    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    if (project.user_id.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Unauthorized'
      });
    }

    if (!project.is_deleted) {
      return res.status(400).json({
        success: false,
        message: 'Project is not deleted'
      });
    }

    // 🔒 If a System Admin deleted this project (deleted_by !== the owner
    // themselves — see systemAdminProjectService.js's deleteProjectSoft,
    // which always sets deleted_by to the admin's own id, never the
    // project's owner), the owner may not restore it themselves. Enforced
    // here, not just hidden in the UI — a normal user cannot bypass this by
    // calling the API directly.
    if (project.deleted_by && project.deleted_by.toString() !== project.user_id.toString()) {
      return res.status(403).json({
        success: false,
        code: 'ADMIN_DELETED',
        message: 'This project was deleted by your System Administrator. Please contact them to restore it.'
      });
    }

    project.is_deleted = false;
    project.deleted_at = null;
    project.scheduled_purge_at = null;
    project.deleted_by = null;
    await project.save();

    res.status(200).json({
      success: true,
      message: 'Project restored successfully',
      data: project
    });
  } catch (error) {
    LoggerUtil.error('Error restoring SEO project', error, { projectId: req.params.id });
    return res.status(500).json(ResponseUtil.error('Internal server error', 500));
  }
};

// Permanently delete a trashed project (Phase 3, Part 3)
const permanentlyDeleteProject = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid project ID'
      });
    }

    // Same lookup-without-scoping approach as restoreProject, so 404/403/400
    // stay distinct instead of collapsing into one generic "not found".
    const project = await SeoProject.findById(id);

    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    if (project.user_id.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Unauthorized'
      });
    }

    if (!project.is_deleted) {
      return res.status(400).json({
        success: false,
        message: 'Project is not deleted'
      });
    }

    // 🔒 Same rule as restoreProject above — if a System Admin deleted this
    // project, the owner cannot permanently delete it either (that would
    // remove the admin's own ability to restore it later).
    if (project.deleted_by && project.deleted_by.toString() !== project.user_id.toString()) {
      return res.status(403).json({
        success: false,
        code: 'ADMIN_DELETED',
        message: 'This project was deleted by your System Administrator. Please contact them to restore it.'
      });
    }

    const result = await deleteProjectCascade(id);

    res.status(200).json({
      success: true,
      message: 'Project permanently deleted',
      data: result
    });
  } catch (error) {
    LoggerUtil.error('Error permanently deleting SEO project', error, { projectId: req.params.id });
    return res.status(500).json(ResponseUtil.error('Internal server error', 500));
  }
};

// Get project scraping summary
const getProjectScrapingSummary = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid project ID'
      });
    }

    const summary = await SeoProject.getScrapingSummary(id);

    if (!summary) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    // Verify project belongs to user
    if (summary.user_id.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    res.status(200).json({
      success: true,
      data: summary
    });

  } catch (error) {
    LoggerUtil.error('Error getting scraping summary', error, { projectId: req.params.id });
    return res.status(500).json(ResponseUtil.error('Failed to get scraping summary', 500));
  }
};

// Get projects needing scraping (for scheduled jobs)
const getProjectsNeedingScrape = async (req, res) => {
  try {
    // This endpoint is for internal/scheduled use
    const projects = await SeoProject.getProjectsNeedingScrape();

    res.status(200).json({
      success: true,
      data: projects,
      count: projects.length
    });

  } catch (error) {
    LoggerUtil.error('Error getting projects needing scrape', error);
    return res.status(500).json(ResponseUtil.error('Failed to get projects needing scrape', 500));
  }
};

// Get issue counts for a project (lightweight - single collection query)
const getIssueCounts = async (req, res) => {
  try {
    const { id: projectId } = req.params;

    // Verify project belongs to user
    const project = await SeoProject.findById(projectId);
    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    if (project.user_id.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    const result = await IssueCountsService.getIssueCounts(projectId);

    res.status(200).json(result);

  } catch (error) {
    LoggerUtil.error('Error getting issue counts', error, { projectId: req.params.id });
    // A failed aggregation must surface as an explicit error, never as a
    // fake "0 issues" success response (that used to happen inside the
    // service itself — see IssueCountsService.getIssueCounts).
    const statusCode = error.statusCode || 500;
    return res.status(statusCode).json(ResponseUtil.error(error.message || 'Failed to get issue counts', statusCode));
  }
};

// Get unified project overview (combines project, performance, and technical data)
const getProjectOverview = async (req, res) => {
  try {
    const { id: projectId } = req.params;

    // Verify project belongs to user
    const project = await SeoProject.findById(projectId);
    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    if (project.user_id.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    // Execute all queries in parallel for maximum performance
    const db = mongoose.connection.db;
    const pid = new mongoose.Types.ObjectId(projectId);

    const [performanceResult, technicalResult, aiProjectDoc] = await Promise.all([
      ProjectPerformanceService.getProjectPerformance(project),
      TechnicalChecksService.getTechnicalChecks(project),
      db.collection('ai_projects')
        .find({ project_id: pid })
        .sort({ computed_at: -1 })
        .limit(1)
        .next()
    ]);

    const overviewData = {
      project: project.toObject(),
      performance: performanceResult.success ? performanceResult.data : null,
      technical: technicalResult.success ? technicalResult.data : null,
      ai_visibility: {
        score: aiProjectDoc?.overall_score ?? null
      }
    };

    res.status(200).json({
      success: true,
      data: overviewData
    });

  } catch (error) {
    LoggerUtil.error('Error getting project overview', error, { projectId: req.params.id });
    return res.status(500).json(ResponseUtil.error('Failed to get project overview', 500));
  }
};

// Get project dashboard data
const getProjectDashboard = async (req, res) => {
  try {
    const { id: projectId } = req.params;

    // Verify project belongs to user
    const project = await SeoProject.findById(projectId);
    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    if (project.user_id.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    // Get link counts directly from MongoDB collections
    const db = mongoose.connection.db;
    const { ObjectId } = mongoose.Types;
    
    // Get the latest completed LINK_DISCOVERY job for this project
    const latestJob = await Job.findOne({
      project_id: projectId,
      jobType: JOB_TYPES.LINK_DISCOVERY,
      status: 'completed'
    }).sort({ created_at: -1 });
    
    // If no completed job, return 0 counts
    if (!latestJob) {
      return {
        internalLinks: 0,
        externalLinks: 0,
        socialLinks: 0,
        totalUrlsFound: 0
      };
    }
    
    LoggerUtil.debug('Latest completed job', { jobId: latestJob._id });
    
    // Query links using the job's _id as seo_jobId
    const internalLinksCount = await db.collection('seo_internal_links').countDocuments({
      seo_jobId: latestJob._id
    });

    const externalLinksCount = 0;  // External links disabled

    const socialLinksCount = await db.collection('seo_social_links').countDocuments({
      seo_jobId: latestJob._id
    });

    // Get crawl status
    const linkDiscoveryJob = await Job.findOne({
      project_id: projectId,
      jobType: JOB_TYPES.LINK_DISCOVERY
    }).sort({ created_at: -1 });

    LoggerUtil.debug('Dashboard data loaded', {
      projectId,
      latestJobId: latestJob._id,
      linkDiscoveryJob: linkDiscoveryJob?.status,
      internalLinksCount,
      externalLinksCount,
      socialLinksCount
    });

    const crawlStatus = {
      linkDiscovery: {
        completed: linkDiscoveryJob?.status === 'completed' || internalLinksCount > 0,
        running: linkDiscoveryJob?.status === 'processing',
        pending: !linkDiscoveryJob || (linkDiscoveryJob?.status === 'pending' && internalLinksCount === 0)
      }
    };

    // Get performance data
    let performanceData = { performanceScore: 0 };
    try {
      console.log("Fetching performance data for project:", projectId);
      const performanceResult = await ProjectPerformanceService.getProjectPerformance(project);
      console.log("Performance service result:", performanceResult);
      if (performanceResult.success) {
        performanceData = {
          mobileScore: performanceResult.data.summary.mobileScore,
          desktopScore: performanceResult.data.summary.desktopScore,
          performanceScore: performanceResult.data.summary.performanceScore
        };
        console.log("Final performance data:", performanceData);
      }
    } catch (error) {
      LoggerUtil.warn('Failed to fetch performance data for dashboard', error);
    }

    const dashboardData = {
      summary: {
        internalLinks: internalLinksCount,
        externalLinks: externalLinksCount,
        socialLinks: socialLinksCount,
        totalUrlsFound: linkDiscoveryJob?.result_data?.totalUrlsFound || (internalLinksCount + externalLinksCount + socialLinksCount)
      },
      performance: performanceData,
      crawlStatus
    };

    res.status(200).json({
      success: true,
      data: dashboardData
    });

  } catch (error) {
    LoggerUtil.error('Error getting project dashboard', error, { projectId: req.params.id });
    return res.status(500).json(ResponseUtil.error('Failed to get project dashboard', 500));
  }
};

// Get project screenshot data
const getProjectScreenshot = async (req, res) => {
  try {
    const { id: projectId } = req.params;
    
    LoggerUtil.info('Screenshot API called - DISABLED', { projectId });
    
    // Return safe empty response - screenshots disabled for performance
    return res.status(200).json({
      success: true,
      data: {
        sections: [],
        message: "Screenshot functionality disabled for performance"
      }
    });
    
    // Validate project exists
    const project = await SeoProject.findById(projectId);
    
    LoggerUtil.debug('Project lookup result', { found: !!project });
    
    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    // Get the most recent screenshot data for this project from mainurl_snapshot collection
    LoggerUtil.debug('Querying seo_mainurl_snapshot collection', { projectId });
    const screenshotData = await db.collection('seo_mainurl_snapshot')
      .find({ project_id: new ObjectId(projectId) })
      .sort({ captured_at: -1 })
      .limit(1)
      .toArray();

    LoggerUtil.debug('Screenshot data loaded', {
      projectId,
      found: screenshotData.length,
      hasPath: !!screenshotData[0]?.screenshot_path
    });

    if (screenshotData.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No screenshot data found for this project'
      });
    }

    const screenshot = screenshotData[0];
    
    // Construct full URL for screenshot path
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const fullScreenshotPath = screenshot.screenshot_path.startsWith('./') 
      ? screenshot.screenshot_path.replace('./', `${baseUrl}/`)
      : `${baseUrl}/${screenshot.screenshot_path}`;
    
    LoggerUtil.debug('Full screenshot URL constructed', { fullScreenshotPath });
    
    // Calculate screenshot sections for processing
    const scrollHeight = screenshot.scroll_height || 17248; // Default height
    const sectionHeight = 800; // A4-friendly section height
    const numSections = Math.ceil(scrollHeight / sectionHeight);
    
    // Generate section metadata
    const sections = [];
    for (let i = 0; i < numSections; i++) {
      const startY = i * sectionHeight;
      const endY = Math.min((i + 1) * sectionHeight, scrollHeight);
      const sectionHeight_actual = endY - startY;
      
      // Skip sections that are too small
      if (sectionHeight_actual < 400 && i > 0) continue;
      
      const sectionType = i === 0 ? 'hero' : (i === numSections - 1 ? 'footer' : 'content');
      const sectionLabels = {
        hero: 'Above the Fold',
        content: numSections > 2 ? `Content Section ${i}` : 'Main Content',
        footer: 'Footer'
      };
      
      sections.push({
        id: `section-${i + 1}`,
        type: sectionType,
        index: i,
        startY,
        endY,
        height: sectionHeight_actual,
        width: 1200, // Standard screenshot width
        totalHeight: scrollHeight,
        imageUrl: fullScreenshotPath,
        label: sectionLabels[sectionType] || `Section ${i + 1}`,
        cropParams: {
          x: 0,
          y: startY,
          width: 1200,
          height: sectionHeight_actual
        }
      });
    }
    
    res.status(200).json({
      success: true,
      data: {
        _id: screenshot._id,
        project_id: screenshot.project_id,
        job_id: screenshot.job_id,
        url: screenshot.url,
        final_url: screenshot.final_url,
        canonical_url: screenshot.canonical_url,
        screenshot_path: fullScreenshotPath,
        dom_hash: screenshot.dom_hash,
        scroll_height: screenshot.scroll_height,
        status: screenshot.status,
        error: screenshot.error,
        captured_at: screenshot.captured_at,
        // Add processed sections metadata
        sections: sections,
        totalSections: sections.length,
        processing: {
          sectionHeight,
          minSectionHeight: 400,
          maxSectionHeight: 800,
          aspectRatio: '16:9',
          printOptimized: true
        }
      }
    });

  } catch (error) {
    LoggerUtil.error('Error getting project screenshot', error, { projectId: req.params.id });
    return res.status(500).json(ResponseUtil.error('Failed to get project screenshot', 500));
  }
};

export {
  createSeoProject,
  getAllSeoProjects,
  getSeoProjectById,
  updateSeoProject,
  updateSeoProjectStatus,
  deleteSeoProject,
  getTrashedProjects,
  getTrashedProjectById,
  restoreProject,
  permanentlyDeleteProject,
  getProjectScrapingSummary,
  getProjectsNeedingScrape,
  getProjectDashboard,
  getProjectScreenshot,
  getIssueCounts,
  getProjectOverview
};
