import mongoose from 'mongoose';

/**
 * Search Console Dimension Breakdown Model
 *
 * Stores one row per project per dimension-value per sync date-range, for
 * each of the 4 Search Analytics dimensions beyond `page`/`date` (which
 * already have their own models - SearchConsoleData, SearchConsoleTrend):
 * `query`, `country`, `device`, `searchAppearance`. One generic schema
 * instead of 4 near-identical ones - `dimension` distinguishes which
 * breakdown a row belongs to, `dimension_value` holds whatever that
 * dimension's key actually is (a query string, an ISO country code, a
 * device class, a search-appearance type).
 */

const BREAKDOWN_DIMENSIONS = ['query', 'country', 'device', 'searchAppearance'];

const searchConsoleBreakdownSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'User ID is required'],
    index: true
  },

  project_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SeoProject',
    required: [true, 'Project ID is required'],
    index: true
  },

  dimension: {
    type: String,
    required: [true, 'Dimension is required'],
    enum: BREAKDOWN_DIMENSIONS,
    index: true
  },

  dimension_value: {
    type: String,
    required: [true, 'Dimension value is required'],
    trim: true
  },

  clicks: {
    type: Number,
    required: [true, 'Clicks count is required'],
    min: [0, 'Clicks cannot be negative']
  },

  impressions: {
    type: Number,
    required: [true, 'Impressions count is required'],
    min: [0, 'Impressions cannot be negative']
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
    min: [0, 'Position cannot be negative']
  },

  date_range: {
    start_date: { type: Date, required: [true, 'Start date is required'] },
    end_date: { type: Date, required: [true, 'End date is required'] }
  },

  fetched_at: {
    type: Date,
    required: [true, 'Fetched timestamp is required'],
    default: Date.now
  }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'search_console_breakdowns'
});

// One row per project+dimension+dimension_value per sync date-range -
// mirrors SearchConsoleData's unique_project_page_date_range index.
searchConsoleBreakdownSchema.index(
  {
    project_id: 1,
    dimension: 1,
    dimension_value: 1,
    'date_range.start_date': 1,
    'date_range.end_date': 1
  },
  { unique: true, name: 'unique_project_dimension_value_date_range' }
);

// Top-N-by-clicks lookup, the only read pattern this model needs to serve.
searchConsoleBreakdownSchema.index(
  { project_id: 1, dimension: 1, clicks: -1 },
  { name: 'project_dimension_top_by_clicks' }
);

/**
 * Upsert breakdown rows for a project+dimension.
 *
 * @param {string} dimension - one of BREAKDOWN_DIMENSIONS
 * @param {Array} rows - [{ dimension_value, clicks, impressions, ctr, position }]
 * @param {string} userId
 * @param {string} projectId
 * @param {Date} startDate
 * @param {Date} endDate
 */
searchConsoleBreakdownSchema.statics.upsertBreakdownData = async function (
  dimension, rows, userId, projectId, startDate, endDate
) {
  const fetchedAt = new Date();
  const bulkOps = rows.map((row) => ({
    updateOne: {
      filter: {
        project_id: projectId,
        dimension,
        dimension_value: row.dimension_value,
        'date_range.start_date': startDate,
        'date_range.end_date': endDate
      },
      update: {
        $set: {
          user_id: userId,
          clicks: row.clicks,
          impressions: row.impressions,
          ctr: row.ctr,
          position: row.position,
          fetched_at: fetchedAt,
          updated_at: fetchedAt
        },
        $setOnInsert: { created_at: fetchedAt }
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
    total: rows.length,
    fetched_at: fetchedAt
  };
};

/**
 * Top rows for a project+dimension, most recent date-range first, ranked by
 * clicks - the only query the breakdown endpoint needs.
 */
searchConsoleBreakdownSchema.statics.getTopByDimension = async function (projectId, dimension, limit = 25) {
  return this.find({ project_id: projectId, dimension })
    .sort({ 'date_range.end_date': -1, clicks: -1 })
    .limit(limit)
    .lean();
};

searchConsoleBreakdownSchema.set('toJSON', {
  virtuals: true,
  transform: function (doc, ret) {
    delete ret.__v;
    return ret;
  }
});

const SearchConsoleBreakdown = mongoose.model('SearchConsoleBreakdown', searchConsoleBreakdownSchema);

export default SearchConsoleBreakdown;
