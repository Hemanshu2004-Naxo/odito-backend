import CustomPlanRequest from '../../subscription/model/CustomPlanRequest.js';

// Kept in sync with CustomPlanRequest.js's status enum by hand — same
// convention systemAdminSubscriptionService.js already uses for
// SUBSCRIPTION_STATUSES.
const REQUEST_STATUSES = ['pending', 'contacted', 'closed'];

const SORT_OPTIONS = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
};

const ADMIN_PROJECTION = 'firstName lastName email';

function serializeAdminRef(user) {
  if (!user) return null;
  return { id: user._id, name: `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email, email: user.email };
}

function serializeRequestSummary(request) {
  return {
    id: request._id,
    status: request.status,
    companyName: request.companyName,
    contactName: request.contactName,
    contactEmail: request.contactEmail,
    projectCount: request.projectCount,
    requiredCredits: request.requiredCredits,
    requiredPages: request.requiredPages,
    createdAt: request.createdAt,
  };
}

/**
 * List + search + filter + sort + paginate Custom Plan requests. Same
 * query-shape as systemAdminSubscriptionService.listSubscriptions — search
 * is a $regex $or, pagination is the same skip+limit+countDocuments-in-
 * parallel pattern, so this is deliberately unsurprising to anyone already
 * familiar with the Subscriptions admin list.
 */
const listCustomPlanRequests = async ({ page, limit, search, status, sort }) => {
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const skip = (pageNum - 1) * limitNum;

  const query = {};

  if (search && String(search).trim()) {
    const term = String(search).trim();
    query.$or = [
      { companyName: { $regex: term, $options: 'i' } },
      { contactEmail: { $regex: term, $options: 'i' } },
      { contactName: { $regex: term, $options: 'i' } },
    ];
  }

  if (status && REQUEST_STATUSES.includes(status)) {
    query.status = status;
  }

  const sortSpec = SORT_OPTIONS[sort] || SORT_OPTIONS.newest;

  const [requests, total] = await Promise.all([
    CustomPlanRequest.find(query).sort(sortSpec).skip(skip).limit(limitNum).lean(),
    CustomPlanRequest.countDocuments(query),
  ]);

  return {
    requests: requests.map(serializeRequestSummary),
    pagination: {
      page: pageNum,
      limit: limitNum,
      total,
      pages: Math.max(1, Math.ceil(total / limitNum)),
    },
  };
};

/**
 * Full request detail: every submitted field + adminNotes + statusHistory,
 * both populated with the acting admin's name/email so the UI never shows
 * a raw ObjectId. Also builds the merged, newest-first Timeline (STEP 7) —
 * "Created" + every status change + every note, one array, one sort — the
 * same "merge at serialization time, don't duplicate storage" pattern
 * subscriptionController.getBillingHistory already uses for Transaction +
 * PagePurchase + CreditPurchase.
 */
const getCustomPlanRequestDetail = async (id) => {
  const request = await CustomPlanRequest.findById(id)
    .populate('adminNotes.addedBy', ADMIN_PROJECTION)
    .populate('statusHistory.changedBy', ADMIN_PROJECTION)
    .lean();
  if (!request) return null;

  // NOTE: `request.timeline` (the customer's submitted preference — e.g.
  // 'within_30_days') and this computed admin-panel event log are two
  // unrelated concepts that happen to share the word "timeline" in the
  // spec. Named distinctly here (timelineEvents) so the two are never
  // confused in code, even though the field name collision is unavoidable
  // in the response shape below.
  const timelineEvents = [
    { type: 'created', date: request.createdAt, label: 'Request submitted' },
    ...(request.statusHistory || []).map((entry) => ({
      type: 'status_change',
      date: entry.changedAt,
      label: entry.fromStatus ? `Status changed: ${entry.fromStatus} → ${entry.toStatus}` : `Status set to ${entry.toStatus}`,
      by: serializeAdminRef(entry.changedBy),
    })),
    ...(request.adminNotes || []).map((entry) => ({
      type: 'note',
      date: entry.addedAt,
      label: 'Internal note added',
      note: entry.note,
      by: serializeAdminRef(entry.addedBy),
    })),
  ].sort((a, b) => new Date(b.date) - new Date(a.date));

  return {
    id: request._id,
    status: request.status,
    companyName: request.companyName,
    companyWebsite: request.companyWebsite,
    contactName: request.contactName,
    contactEmail: request.contactEmail,
    contactPhone: request.contactPhone,
    teamSize: request.teamSize,
    projectCount: request.projectCount,
    requiredCredits: request.requiredCredits,
    requiredPages: request.requiredPages,
    featureRequirements: request.featureRequirements,
    budgetRange: request.budgetRange,
    timeline: request.timeline,
    additionalRequirements: request.additionalRequirements,
    adminNotes: (request.adminNotes || []).map((n) => ({
      note: n.note,
      addedBy: serializeAdminRef(n.addedBy),
      addedAt: n.addedAt,
    })),
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    timelineEvents,
  };
};

export { listCustomPlanRequests, getCustomPlanRequestDetail };
