import mongoose from 'mongoose';
import Lead, { LEAD_STATUSES, LEAD_PRIORITIES } from '../model/Lead.js';
import { NotFoundError, ValidationError } from '../../../utils/ErrorUtil.js';

/**
 * Lead Service — business logic + MongoDB access for the Lead domain.
 *
 * Two creation entry points, one shared field-mapping implementation
 * (buildCreateData): createLead() for authenticated-dashboard-user leads
 * (plain insert), createLeadIdempotent() for machine-generated leads —
 * currently WordPress plugin submissions, see
 * modules/external_integration/service/wordPressSubmissionService.js —
 * where a network retry or a concurrent duplicate request must never
 * produce two Leads for the same source event.
 */

const CREATABLE_FIELDS = [
  'name', 'email', 'phone', 'company', 'message',
  'formName', 'pageUrl', 'source', 'referrer',
  'utmSource', 'utmMedium', 'utmCampaign', 'utmTerm', 'utmContent',
  'status', 'priority', 'lastContactAt', 'nextFollowUpAt',
];

// Deliberately narrower than CREATABLE_FIELDS — formName/pageUrl/source/
// referrer/utm* describe how the lead originated and are treated as
// immutable capture context once set, not editable sales-workflow fields.
const UPDATABLE_FIELDS = [
  'name', 'email', 'phone', 'company', 'message',
  'status', 'priority', 'lastContactAt', 'nextFollowUpAt',
];

const SORTABLE_FIELDS = ['createdAt', 'updatedAt', 'name', 'status', 'priority', 'lastContactAt', 'nextFollowUpAt'];

function toObjectId(id) {
  if (!id || !mongoose.isValidObjectId(id)) return null;
  return new mongoose.Types.ObjectId(id);
}

function pick(source, keys) {
  const out = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assertValidStatus(status) {
  if (status !== undefined && !LEAD_STATUSES.includes(status)) {
    throw new ValidationError(`Invalid status. Must be one of: ${LEAD_STATUSES.join(', ')}`);
  }
}

function assertValidPriority(priority) {
  if (priority !== undefined && !LEAD_PRIORITIES.includes(priority)) {
    throw new ValidationError(`Invalid priority. Must be one of: ${LEAD_PRIORITIES.join(', ')}`);
  }
}

/**
 * Resolve assignedTo from a raw payload value.
 * Returns undefined when the field wasn't supplied at all (caller should
 * not touch the existing value), null to explicitly unassign, or a valid
 * ObjectId.
 */
function resolveAssignedTo(rawValue) {
  if (rawValue === undefined) return undefined;
  if (rawValue === null || rawValue === '') return null;
  const oid = toObjectId(rawValue);
  if (!oid) throw new ValidationError('assignedTo must be a valid user id or null');
  return oid;
}

/**
 * Shared by createLead() (authenticated dashboard user) and
 * createLeadIdempotent() (Phase 3B — WordPress plugin submissions) — the
 * ONE place that decides which payload fields become a Lead document.
 * createdBy intentionally stays null for a machine-generated lead (see
 * createLeadIdempotent) rather than inventing a fake user id — the schema
 * already allows this (createdBy: { default: null }), no schema change was
 * needed to support it.
 */
function buildCreateData(payload, { userId } = {}) {
  assertValidStatus(payload.status);
  assertValidPriority(payload.priority);

  const data = pick(payload, CREATABLE_FIELDS);
  data.createdBy = userId || null;
  data.updatedBy = userId || null;

  const assignedTo = resolveAssignedTo(payload.assignedTo);
  if (assignedTo !== undefined) data.assignedTo = assignedTo;

  if (payload.note) {
    data.notes = [{ text: String(payload.note).trim(), authorId: userId || null, createdAt: new Date() }];
  }

  return data;
}

async function createLead({ projectId, userId, payload = {} }) {
  const pid = toObjectId(projectId);
  if (!pid) throw new ValidationError('Invalid projectId');

  const data = buildCreateData(payload, { userId });
  data.projectId = pid;

  return Lead.create(data);
}

/**
 * Idempotent creation for machine-generated leads (Phase 3B). Reuses
 * exactly the same field allow-list/validation as createLead() via
 * buildCreateData() — the only difference is concurrency-safety, which a
 * plain insert doesn't provide: relies on the partial unique index on
 * {projectId, externalEventId} (see Lead.js) to guarantee atomically, at
 * the database level, that two requests presenting the same eventId (a
 * retry, or two concurrent requests racing) can never produce two Leads —
 * not an application-level findOne-then-create check, which would have a
 * race window.
 *
 * Returns { lead, duplicate }: duplicate is true when this eventId had
 * already produced a Lead (the caller should tell WordPress to stop
 * retrying, not treat this as an error).
 */
async function createLeadIdempotent({ projectId, externalEventId, payload = {} }) {
  const pid = toObjectId(projectId);
  if (!pid) throw new ValidationError('Invalid projectId');
  if (!externalEventId || typeof externalEventId !== 'string') {
    throw new ValidationError('externalEventId is required for idempotent lead creation');
  }

  const data = buildCreateData(payload, { userId: null });
  data.projectId = pid;
  data.externalEventId = externalEventId;

  try {
    const lead = await Lead.create(data);
    return { lead, duplicate: false };
  } catch (error) {
    if (error.code === 11000) {
      const existing = await Lead.findOne({ projectId: pid, externalEventId });
      if (existing) {
        return { lead: existing, duplicate: true };
      }
      // Extremely unlikely (existing row deleted between the E11000 and
      // this re-read) — surface the original conflict rather than silently
      // creating a second lead for the same event.
    }
    throw error;
  }
}

async function getLeads(projectId, {
  status, priority, search,
  page = 1, limit = 20, sort = 'createdAt', sortOrder = 'desc',
} = {}) {
  const pid = toObjectId(projectId);
  if (!pid) throw new ValidationError('Invalid projectId');

  assertValidStatus(status);
  assertValidPriority(priority);

  const query = { projectId: pid, isDeleted: { $ne: true } };
  if (status) query.status = status;
  if (priority) query.priority = priority;
  if (search) {
    const re = { $regex: escapeRegex(search), $options: 'i' };
    query.$or = [{ name: re }, { email: re }, { phone: re }, { company: re }];
  }

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const skip = (pageNum - 1) * limitNum;

  const sortField = SORTABLE_FIELDS.includes(sort) ? sort : 'createdAt';
  const sortDir = sortOrder === 'asc' ? 1 : -1;

  const [leads, total] = await Promise.all([
    Lead.find(query).sort({ [sortField]: sortDir }).skip(skip).limit(limitNum).lean(),
    Lead.countDocuments(query),
  ]);

  return {
    leads,
    pagination: {
      page: pageNum,
      limit: limitNum,
      total,
      totalPages: Math.max(1, Math.ceil(total / limitNum)),
    },
  };
}

async function getLeadById(leadId) {
  const lid = toObjectId(leadId);
  if (!lid) throw new ValidationError('Invalid lead id');

  const lead = await Lead.findOne({ _id: lid, isDeleted: { $ne: true } });
  if (!lead) throw new NotFoundError('Lead not found');
  return lead;
}

async function updateLead(leadId, { updates = {}, note, userId } = {}) {
  const lid = toObjectId(leadId);
  if (!lid) throw new ValidationError('Invalid lead id');

  assertValidStatus(updates.status);
  assertValidPriority(updates.priority);

  const data = pick(updates, UPDATABLE_FIELDS);

  const assignedTo = resolveAssignedTo(updates.assignedTo);
  if (assignedTo !== undefined) data.assignedTo = assignedTo;

  data.updatedBy = userId || null;

  const mongoUpdate = { $set: data };
  if (note) {
    mongoUpdate.$push = { notes: { text: String(note).trim(), authorId: userId || null, createdAt: new Date() } };
  }

  const lead = await Lead.findOneAndUpdate(
    { _id: lid, isDeleted: { $ne: true } },
    mongoUpdate,
    { new: true, runValidators: true }
  );
  if (!lead) throw new NotFoundError('Lead not found');
  return lead;
}

async function deleteLead(leadId) {
  const lid = toObjectId(leadId);
  if (!lid) throw new ValidationError('Invalid lead id');

  const lead = await Lead.findOneAndUpdate(
    { _id: lid, isDeleted: { $ne: true } },
    { $set: { isDeleted: true, deletedAt: new Date() } },
    { new: true }
  );
  if (!lead) throw new NotFoundError('Lead not found');
  return lead;
}

async function getLeadStats(projectId) {
  const pid = toObjectId(projectId);
  if (!pid) throw new ValidationError('Invalid projectId');

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const [result] = await Lead.aggregate([
    { $match: { projectId: pid, isDeleted: { $ne: true } } },
    {
      $facet: {
        byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
        newToday: [{ $match: { createdAt: { $gte: startOfToday } } }, { $count: 'count' }],
        total: [{ $count: 'count' }],
      },
    },
  ]);

  const stats = { total: 0, newToday: 0 };
  for (const status of LEAD_STATUSES) stats[status] = 0;
  for (const row of result.byStatus) {
    if (row._id && Object.prototype.hasOwnProperty.call(stats, row._id)) {
      stats[row._id] = row.count;
    }
  }
  stats.total = result.total[0]?.count || 0;
  stats.newToday = result.newToday[0]?.count || 0;

  return stats;
}

export default {
  createLead,
  createLeadIdempotent,
  getLeads,
  getLeadById,
  updateLead,
  deleteLead,
  getLeadStats,
};
