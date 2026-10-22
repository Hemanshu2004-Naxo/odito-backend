import mongoose from 'mongoose';

/**
 * Analytics Data Model
 * 
 * Stores page-level performance data from Google Analytics GA4 API
 * 
 * Design Principles:
 * - Raw data storage (no aggregation, no rounding)
 * - Efficient querying with proper indexing
 * - Duplicate prevention through unique constraints
 * - Future-proof for additional dimensions
 * - Time-series ready for historical analysis
 */

const analyticsDataSchema = new mongoose.Schema({
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

  // 🔗 Page Path (the primary dimension from GA4)
  page_path: {
    type: String,
    required: [true, 'Page path is required'],
    index: true,
    trim: true
  },

  // 📊 Performance metrics (raw values from Google API)
  sessions: {
    type: Number,
    required: [true, 'Sessions count is required'],
    min: [0, 'Sessions cannot be negative'],
    index: true
  },

  active_users: {
    type: Number,
    required: [true, 'Active users count is required'],
    min: [0, 'Active users cannot be negative'],
    index: true
  },

  page_views: {
    type: Number,
    required: [true, 'Page views count is required'],
    min: [0, 'Page views cannot be negative'],
    index: true
  },

  engagement_rate: {
    type: Number,
    required: [true, 'Engagement rate is required'],
    min: [0, 'Engagement rate cannot be negative'],
    max: [1, 'Engagement rate cannot exceed 1.0']
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
  // deviceCategory: String,      // Device dimension
  // country: String,            // Country dimension  
  // cityName: String,           // City dimension
  // browser: String,            // Browser dimension
  // channelGrouping: String     // Channel dimension

}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  // Optimize for time-series queries
  collection: 'analytics_data'
});

// 🔍 CRITICAL INDEX: Prevent duplicate data points
// Ensures no duplicate page performance data for the same project, page, and date range
analyticsDataSchema.index(
  { 
    project_id: 1, 
    page_path: 1, 
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
analyticsDataSchema.index(
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
analyticsDataSchema.index(
  { 
    page_path: 1, 
    'date_range.start_date': -1 
  },
  { 
    name: 'page_path_timeline'
  }
);

// Top pages by performance metrics
analyticsDataSchema.index(
  { 
    project_id: 1, 
    sessions: -1, 
    'date_range.start_date': -1 
  },
  { 
    name: 'project_top_pages_by_sessions'
  }
);

analyticsDataSchema.index(
  { 
    project_id: 1, 
    page_views: -1, 
    'date_range.start_date': -1 
  },
  { 
    name: 'project_top_pages_by_page_views'
  }
);

// Engagement-based queries
analyticsDataSchema.index(
  { 
    project_id: 1, 
    engagement_rate: -1, 
    'date_range.start_date': -1 
  },
  { 
    name: 'project_engagement_analysis'
  }
);

// User-based queries (for multi-tenant access control)
analyticsDataSchema.index(
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
analyticsDataSchema.statics.upsertPerformanceData = async function(
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
        page_path: pageData.page_path,
        'date_range.start_date': startDate,
        'date_range.end_date': endDate
      },
      update: {
        $set: {
          user_id: userId,
          sessions: pageData.sessions,
          active_users: pageData.active_users,
          page_views: pageData.page_views,
          engagement_rate: pageData.engagement_rate,
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
 * Get performance data for a project within a date range
 * 
 * @param {string} projectId - Project ID
 * @param {Date} startDate - Start date filter
 * @param {Date} endDate - End date filter
 * @param {Object} options - Query options (sort, limit, etc.)
 * @returns {Promise<Array>} - Performance data array
 */
analyticsDataSchema.statics.getProjectPerformanceData = async function(
  projectId, 
  startDate, 
  endDate, 
  options = {}
) {
  const query = {
    project_id: projectId
  };

  // Add date range filter if provided
  if (startDate || endDate) {
    query['date_range.start_date'] = {};
    if (startDate) query['date_range.start_date'].$gte = startDate;
    if (endDate) query['date_range.start_date'].$lte = endDate;
  }

  const {
    sort = { sessions: -1 },
    limit = 100,
    skip = 0
  } = options;

  return await this.find(query)
    .sort(sort)
    .limit(limit)
    .skip(skip)
    .lean(); // Return plain objects for better performance
};

/**
 * Get top performing pages for a project
 * 
 * @param {string} projectId - Project ID
 * @param {string} metric - Metric to sort by (sessions, pageViews, engagementRate)
 * @param {number} limit - Number of results
 * @returns {Promise<Array>} - Top pages data
 */
analyticsDataSchema.statics.getTopPages = async function(
  projectId, 
  metric = 'sessions', 
  limit = 50
) {
  const validMetrics = ['sessions', 'pageViews', 'engagementRate'];
  if (!validMetrics.includes(metric)) {
    throw new Error(`Invalid metric: ${metric}. Must be one of: ${validMetrics.join(', ')}`);
  }

  const sort = {};
  sort[metric] = metric === 'engagementRate' ? 1 : -1; // Engagement rate: higher is better

  return await this.find({ project_id: projectId })
    .sort(sort)
    .limit(limit)
    .lean();
};

/**
 * Get aggregated metrics for a project
 * 
 * @param {string} projectId - Project ID
 * @param {Date} startDate - Start date
 * @param {Date} endDate - End date
 * @returns {Promise<Object>} - Aggregated metrics
 */
analyticsDataSchema.statics.getProjectAggregates = async function(
  projectId, 
  startDate, 
  endDate
) {
  const matchStage = { project_id: projectId };

  if (startDate || endDate) {
    matchStage['date_range.start_date'] = {};
    if (startDate) matchStage['date_range.start_date'].$gte = startDate;
    if (endDate) matchStage['date_range.start_date'].$lte = endDate;
  }

  const result = await this.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id: null,
        totalSessions: { $sum: '$sessions' },
        totalPageViews: { $sum: '$page_views' },
        avgEngagementRate: { $avg: '$engagement_rate' },
        page_count: { $sum: 1 },
        lastFetched: { $max: '$fetched_at' }
      }
    }
  ]);

  return result[0] || {
    totalSessions: 0,
    totalPageViews: 0,
    avgEngagementRate: 0,
    page_count: 0,
    lastFetched: null
  };
};

// Ensure virtuals are included in JSON output
analyticsDataSchema.set('toJSON', { 
  virtuals: true,
  transform: function(doc, ret) {
    delete ret.__v;
    return ret;
  }
});

analyticsDataSchema.set('toObject', { virtuals: true });

const AnalyticsData = mongoose.model('AnalyticsData', analyticsDataSchema);

export default AnalyticsData;
