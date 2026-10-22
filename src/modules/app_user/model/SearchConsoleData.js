import mongoose from 'mongoose';

/**
 * Search Console Data Model
 * 
 * Stores page-level performance data from Google Search Console API
 * 
 * Design Principles:
 * - Raw data storage (no aggregation, no rounding)
 * - Efficient querying with proper indexing
 * - Duplicate prevention through unique constraints
 * - Future-proof for additional dimensions
 * - Time-series ready for historical analysis
 */

const searchConsoleDataSchema = new mongoose.Schema({
  // 🔐 Project ownership
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'User ID is required'],
    index: true
  },

  // 📌 Project association
  project_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SeoProject',
    required: [true, 'Project ID is required'],
    index: true
  },

  // 🔗 Page URL (the primary dimension)
  page_url: {
    type: String,
    required: [true, 'Page URL is required'],
    index: true,
    trim: true
  },

  // 📊 Performance metrics (raw values from Google API)
  clicks: {
    type: Number,
    required: [true, 'Clicks count is required'],
    min: [0, 'Clicks cannot be negative'],
    index: true
  },

  impressions: {
    type: Number,
    required: [true, 'Impressions count is required'],
    min: [0, 'Impressions cannot be negative'],
    index: true
  },

  ctr: {
    type: Number,
    required: [true, 'CTR is required'],
    min: [0, 'CTR cannot be negative'],
    max: [1, 'CTR cannot exceed 1.0']
  },

  position: {
    type: Number,
    required: [true, 'Position is required'],
    min: [0, 'Position cannot be negative'],
    index: true
  },

  // 📅 Date range for the data point
  date_range: {
    start_date: {
      type: Date,
      required: [true, 'Start date is required'],
      index: true
    },
    end_date: {
      type: Date,
      required: [true, 'End date is required'],
      index: true
    }
  },

  // ⏰ When this data was fetched from Google API
  fetched_at: {
    type: Date,
    required: [true, 'Fetched timestamp is required'],
    default: Date.now,
    index: true
  },

  // 🔧 Future dimensions (prepared for expansion)
  // These fields will be added in future iterations:
  // query: String,           // Search query dimension
  // country: String,         // Country dimension  
  // device: String,          // Device dimension
  // search_appearance: String // Search appearance type

}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  // Optimize for time-series queries
  collection: 'search_console_data'
});

// 🔍 CRITICAL INDEX: Prevent duplicate data points
// Ensures no duplicate page performance data for the same project, page, and date range
searchConsoleDataSchema.index(
  { 
    project_id: 1, 
    page_url: 1, 
    'date_range.start_date': 1, 
    'date_range.end_date': 1 
  }, 
  { 
    unique: true,
    name: 'unique_project_page_date_range'
  }
);

// 🚀 Performance indexes for common queries

// Fast project-level queries with date filtering
searchConsoleDataSchema.index(
  { 
    project_id: 1, 
    'date_range.start_date': -1, 
    'date_range.end_date': -1 
  },
  { 
    name: 'project_date_range'
  }
);

// Page performance across all projects (for analytics)
searchConsoleDataSchema.index(
  { 
    page_url: 1, 
    'date_range.start_date': -1 
  },
  { 
    name: 'page_url_timeline'
  }
);

// Top pages by performance metrics
searchConsoleDataSchema.index(
  { 
    project_id: 1, 
    clicks: -1, 
    'date_range.start_date': -1 
  },
  { 
    name: 'project_top_pages_by_clicks'
  }
);

searchConsoleDataSchema.index(
  { 
    project_id: 1, 
    impressions: -1, 
    'date_range.start_date': -1 
  },
  { 
    name: 'project_top_pages_by_impressions'
  }
);

// Position-based queries
searchConsoleDataSchema.index(
  { 
    project_id: 1, 
    position: 1, 
    'date_range.start_date': -1 
  },
  { 
    name: 'project_position_analysis'
  }
);

// User-based queries (for multi-tenant access control)
searchConsoleDataSchema.index(
  { 
    user_id: 1, 
    project_id: 1, 
    'date_range.start_date': -1 
  },
  { 
    name: 'user_project_timeline'
  }
);

// 📊 Static methods for data operations

/**
 * Upsert performance data for a project
 * Creates new records or updates existing ones based on unique constraint
 * 
 * @param {Array} performanceData - Array of performance data objects
 * @param {string} userId - User ID
 * @param {string} projectId - Project ID
 * @param {Date} startDate - Date range start
 * @param {Date} endDate - Date range end
 * @returns {Promise<Object>} - Operation result
 */
searchConsoleDataSchema.statics.upsertPerformanceData = async function(
  performanceData, 
  userId, 
  projectId, 
  startDate, 
  endDate
) {
  const fetchedAt = new Date();
  const bulkOps = performanceData.map(pageData => ({
    updateOne: {
      filter: {
        project_id: projectId,
        page_url: pageData.page_url,
        'date_range.start_date': startDate,
        'date_range.end_date': endDate
      },
      update: {
        $set: {
          user_id: userId,
          clicks: pageData.clicks,
          impressions: pageData.impressions,
          ctr: pageData.ctr,
          position: pageData.position,
          fetched_at: fetchedAt,
          updated_at: fetchedAt
        },
        $setOnInsert: {
          created_at: fetchedAt
        }
      },
      upsert: true
    }
  }));

  const result = await this.bulkWrite(bulkOps, { 
    ordered: false,
    writeConcern: { w: 'majority', j: true }
  });

  return {
    upserted: result.upsertedCount,
    modified: result.modifiedCount,
    total: performanceData.length,
    fetched_at: fetchedAt
  };
};

/**
 * Forensic note (2026-07-24): filtering by date_range.end_date alone
 * (a prior fix) was NOT sufficient to deduplicate page_url rows. Two sync
 * windows can share the same end_date while differing in start_date - e.g.
 * a 90-day backfill (start_date = D-90, end_date = D) followed by a same-day
 * "Refresh Data" click running the 7-day incremental sync (start_date = D-7,
 * end_date = D). Both windows have end_date = D, so an end_date-only filter
 * matches documents from both, and any page_url present in both windows'
 * top-N results comes back twice. Confirmed live against
 * search_console_data: a project had 19 rows under window
 * 2026-04-25->2026-07-24 and 15 rows under 2026-07-17->2026-07-24, both
 * ending 2026-07-24, producing exactly the duplicate-key symptom reported.
 *
 * The only field that actually identifies "this page's current
 * performance" is page_url itself, not any date_range field - a page can
 * legitimately appear in many stored windows across sync history, and the
 * one that matters is whichever was fetched most recently. So every read
 * below groups by page_url and keeps the most-recently-fetched (fetched_at)
 * row for each, via an aggregation pipeline instead of a plain find().
 *
 * (This also required switching from find() to aggregate(): Mongoose casts
 * find()'s filter against the schema automatically, but aggregate()
 * pipelines are not - project_id must be cast to ObjectId explicitly or the
 * $match silently matches nothing. getProjectAggregates below had exactly
 * this bug already, independent of the above: it always returned the
 * all-zero fallback because its $match compared a raw string project_id
 * against a stored ObjectId field.)
 */
function toProjectObjectId(projectId) {
  return typeof projectId === 'string' ? new mongoose.Types.ObjectId(projectId) : projectId;
}

/**
 * Aggregation stages that collapse the collection down to one row per
 * page_url (the most recently fetched one), before any date-range match is
 * even relevant to the "no explicit range" case. Shared by every read
 * method below so there's one definition of "current" per page.
 */
function dedupeByPageUrlStages() {
  return [
    { $sort: { fetched_at: -1 } },
    { $group: { _id: '$page_url', doc: { $first: '$$ROOT' } } },
    { $replaceRoot: { newRoot: '$doc' } }
  ];
}

/**
 * Get performance data for a project within a date range
 *
 * @param {string} projectId - Project ID
 * @param {Date} startDate - Start date filter
 * @param {Date} endDate - End date filter
 * @param {Object} options - Query options (sort, limit, etc.)
 * @returns {Promise<Array>} - Performance data array, one row per page_url
 */
searchConsoleDataSchema.statics.getProjectPerformanceData = async function(
  projectId,
  startDate,
  endDate,
  options = {}
) {
  const matchStage = { project_id: toProjectObjectId(projectId) };

  if (startDate || endDate) {
    // Caller asked for a specific historical range - honor it exactly,
    // across however many sync windows fall inside it (still deduped by
    // page_url below, keeping the freshest row within that range).
    matchStage['date_range.start_date'] = {};
    if (startDate) matchStage['date_range.start_date'].$gte = startDate;
    if (endDate) matchStage['date_range.start_date'].$lte = endDate;
  }

  const {
    sort = { clicks: -1 },
    limit = 100,
    skip = 0
  } = options;

  return this.aggregate([
    { $match: matchStage },
    ...dedupeByPageUrlStages(),
    { $sort: sort },
    { $skip: skip },
    { $limit: limit }
  ]);
};

/**
 * Get top performing pages for a project
 *
 * @param {string} projectId - Project ID
 * @param {string} metric - Metric to sort by (clicks, impressions, position)
 * @param {number} limit - Number of results
 * @returns {Promise<Array>} - Top pages data, one row per page_url
 */
searchConsoleDataSchema.statics.getTopPages = async function(
  projectId,
  metric = 'clicks',
  limit = 50
) {
  const validMetrics = ['clicks', 'impressions', 'position'];
  if (!validMetrics.includes(metric)) {
    throw new Error(`Invalid metric: ${metric}. Must be one of: ${validMetrics.join(', ')}`);
  }

  const sort = {};
  sort[metric] = metric === 'position' ? 1 : -1; // Position: ascending (lower is better)

  return this.aggregate([
    { $match: { project_id: toProjectObjectId(projectId) } },
    ...dedupeByPageUrlStages(),
    { $sort: sort },
    { $limit: limit }
  ]);
};

/**
 * Get aggregated metrics for a project
 *
 * @param {string} projectId - Project ID
 * @param {Date} startDate - Start date
 * @param {Date} endDate - End date
 * @returns {Promise<Object>} - Aggregated metrics, summed over one row per page_url
 */
searchConsoleDataSchema.statics.getProjectAggregates = async function(
  projectId,
  startDate,
  endDate
) {
  const matchStage = { project_id: toProjectObjectId(projectId) };

  if (startDate || endDate) {
    matchStage['date_range.start_date'] = {};
    if (startDate) matchStage['date_range.start_date'].$gte = startDate;
    if (endDate) matchStage['date_range.start_date'].$lte = endDate;
  }

  const result = await this.aggregate([
    { $match: matchStage },
    ...dedupeByPageUrlStages(),
    {
      $group: {
        _id: null,
        totalClicks: { $sum: '$clicks' },
        totalImpressions: { $sum: '$impressions' },
        avgCtr: { $avg: '$ctr' },
        avgPosition: { $avg: '$position' },
        page_count: { $sum: 1 },
        lastFetched: { $max: '$fetched_at' }
      }
    }
  ]);

  return result[0] || {
    totalClicks: 0,
    totalImpressions: 0,
    avgCtr: 0,
    avgPosition: 0,
    page_count: 0,
    lastFetched: null
  };
};

// Ensure virtuals are included in JSON output
searchConsoleDataSchema.set('toJSON', { 
  virtuals: true,
  transform: function(doc, ret) {
    delete ret.__v;
    return ret;
  }
});

searchConsoleDataSchema.set('toObject', { virtuals: true });

const SearchConsoleData = mongoose.model('SearchConsoleData', searchConsoleDataSchema);

export default SearchConsoleData;
