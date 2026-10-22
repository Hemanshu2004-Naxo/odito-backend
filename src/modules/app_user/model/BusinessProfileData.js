import mongoose from 'mongoose';

/**
 * Business Profile Data Model
 * 
 * Stores location-level performance data from Google My Business APIs
 * 
 * Design Principles:
 * - Raw data storage (no aggregation, no rounding)
 * - Efficient querying with proper indexing
 * - Duplicate prevention through unique constraints
 * - Future-proof for additional metrics
 * - Time-series ready for historical analysis
 */

const businessProfileDataSchema = new mongoose.Schema({
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

  // 📊 Business Profile insights metrics (raw values from Google API)
  views_search: {
    type: Number,
    required: [true, 'Search views count is required'],
    min: [0, 'Search views cannot be negative'],
    index: true
  },

  views_maps: {
    type: Number,
    required: [true, 'Maps views count is required'],
    min: [0, 'Maps views cannot be negative'],
    index: true
  },

  actions_website: {
    type: Number,
    required: [true, 'Website actions count is required'],
    min: [0, 'Website actions cannot be negative'],
    index: true
  },

  actions_calls: {
    type: Number,
    required: [true, 'Call actions count is required'],
    min: [0, 'Call actions cannot be negative'],
    index: true
  },

  actions_directions: {
    type: Number,
    required: [true, 'Directions actions count is required'],
    min: [0, 'Directions actions cannot be negative'],
    index: true
  },

  // 📈 Reviews metrics
  reviews_count: {
    type: Number,
    required: [true, 'Reviews count is required'],
    min: [0, 'Reviews count cannot be negative'],
    index: true
  },

  average_rating: {
    type: Number,
    required: [true, 'Average rating is required'],
    min: [0, 'Average rating cannot be negative'],
    max: [5, 'Average rating cannot exceed 5.0']
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

  // 🔧 Future metrics (prepared for expansion)
  // These fields will be added in future iterations:
  // photos_count: Number,           // Photos metrics
  // questions_count: Number,        // Q&A metrics
  // local_posts_count: Number,      // Posts metrics
  // booking_clicks: Number,         // Booking metrics
  // food_menus_clicks: Number       // Food ordering metrics

}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  // Optimize for time-series queries
  collection: 'business_profile_data'
});

// 🔍 CRITICAL INDEX: Prevent duplicate data points
// Ensures no duplicate performance data for the same project and date range
businessProfileDataSchema.index(
  { 
    project_id: 1, 
    'date_range.start_date': 1, 
    'date_range.end_date': 1 
  }, 
  { 
    unique: true,
    name: 'unique_project_date_range'
  }
);

// 🚀 Performance indexes for common queries

// Fast project-level queries with date filtering
businessProfileDataSchema.index(
  { 
    project_id: 1, 
    'date_range.start_date': -1, 
    'date_range.end_date': -1 
  },
  { 
    name: 'project_date_range'
  }
);

// Performance metrics queries
businessProfileDataSchema.index(
  { 
    project_id: 1, 
    views_search: -1, 
    'date_range.start_date': -1 
  },
  { 
    name: 'project_top_by_search_views'
  }
);

businessProfileDataSchema.index(
  { 
    project_id: 1, 
    views_maps: -1, 
    'date_range.start_date': -1 
  },
  { 
    name: 'project_top_by_map_views'
  }
);

businessProfileDataSchema.index(
  { 
    project_id: 1, 
    average_rating: -1, 
    'date_range.start_date': -1 
  },
  { 
    name: 'project_rating_analysis'
  }
);

// User-based queries (for multi-tenant access control)
businessProfileDataSchema.index(
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
businessProfileDataSchema.statics.upsertPerformanceData = async function(
  performanceData, 
  userId, 
  projectId, 
  startDate, 
  endDate
) {
  const fetchedAt = new Date();
  const bulkOps = performanceData.map(data => ({
    updateOne: {
      filter: {
        project_id: projectId,
        'date_range.start_date': startDate,
        'date_range.end_date': endDate
      },
      update: {
        $set: {
          user_id: userId,
          views_search: data.views_search,
          views_maps: data.views_maps,
          actions_website: data.actions_website,
          actions_calls: data.actions_calls,
          actions_directions: data.actions_directions,
          reviews_count: data.reviews_count,
          average_rating: data.average_rating,
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
businessProfileDataSchema.statics.getProjectPerformanceData = async function(
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
    sort = { views_search: -1 },
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
 * Get top performing locations for a project
 * 
 * @param {string} projectId - Project ID
 * @param {string} metric - Metric to sort by (viewsSearch, viewsMaps, actionsWebsite, etc.)
 * @param {number} limit - Number of results
 * @returns {Promise<Array>} - Top locations data
 */
businessProfileDataSchema.statics.getTopLocations = async function(
  projectId, 
  metric = 'viewsSearch', 
  limit = 50
) {
  const validMetrics = ['viewsSearch', 'viewsMaps', 'actionsWebsite', 'actionsCalls', 'actionsDirections', 'reviewsCount', 'averageRating'];
  if (!validMetrics.includes(metric)) {
    throw new Error(`Invalid metric: ${metric}. Must be one of: ${validMetrics.join(', ')}`);
  }

  const sort = {};
  sort[metric] = metric === 'averageRating' ? 1 : -1; // Rating: higher is better

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
businessProfileDataSchema.statics.getProjectAggregates = async function(
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
        totalViews: { $sum: { $add: ['$views_search', '$views_maps'] } },
        totalActions: { $sum: { $add: ['$actions_website', '$actions_calls', '$actions_directions'] } },
        avgRating: { $avg: '$average_rating' },
        page_count: { $sum: 1 },
        lastFetched: { $max: '$fetched_at' }
      }
    }
  ]);

  return result[0] || {
    totalViews: 0,
    totalActions: 0,
    avgRating: 0,
    page_count: 0,
    lastFetched: null
  };
};

// Ensure virtuals are included in JSON output
businessProfileDataSchema.set('toJSON', { 
  virtuals: true,
  transform: function(doc, ret) {
    delete ret.__v;
    return ret;
  }
});

businessProfileDataSchema.set('toObject', { virtuals: true });

const BusinessProfileData = mongoose.model('BusinessProfileData', businessProfileDataSchema);

export default BusinessProfileData;
