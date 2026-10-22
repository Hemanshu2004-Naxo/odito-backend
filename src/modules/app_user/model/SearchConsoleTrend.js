import mongoose from 'mongoose';

/**
 * Search Console Daily Trend Model
 *
 * Stores one row per project per calendar day, fetched from Google Search
 * Console's Search Analytics API using the `date` dimension (as opposed to
 * SearchConsoleData, which uses the `page` dimension and stores one row per
 * page per sync date-range). This is what powers the Search Performance
 * Trends chart's day-by-day granularity - SearchConsoleData's page-level
 * rows have no per-day resolution to chart.
 */

const searchConsoleTrendSchema = new mongoose.Schema({
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

  date: {
    type: Date,
    required: [true, 'Date is required'],
    index: true
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

  fetched_at: {
    type: Date,
    required: [true, 'Fetched timestamp is required'],
    default: Date.now
  }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'search_console_trends'
});

// One row per project per calendar day - re-syncing the same day (e.g. the
// rolling incremental window re-pulling the last 7 days for data revisions)
// updates that day's row in place rather than duplicating it.
searchConsoleTrendSchema.index(
  { project_id: 1, date: 1 },
  { unique: true, name: 'unique_project_date' }
);

/**
 * Upsert daily trend rows for a project.
 *
 * @param {Array} dailyData - [{ date: 'YYYY-MM-DD', clicks, impressions, ctr, position }]
 * @param {string} userId
 * @param {string} projectId
 */
searchConsoleTrendSchema.statics.upsertDailyData = async function (dailyData, userId, projectId) {
  const fetchedAt = new Date();
  const bulkOps = dailyData.map((row) => ({
    updateOne: {
      filter: {
        project_id: projectId,
        date: new Date(row.date)
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
    total: dailyData.length,
    fetched_at: fetchedAt
  };
};

/**
 * Get the daily series for a project within a date range, ascending by date
 * (chart-ready order).
 */
searchConsoleTrendSchema.statics.getProjectSeries = async function (projectId, startDate, endDate) {
  const query = { project_id: projectId };

  if (startDate || endDate) {
    query.date = {};
    if (startDate) query.date.$gte = startDate;
    if (endDate) query.date.$lte = endDate;
  }

  return this.find(query).sort({ date: 1 }).lean();
};

searchConsoleTrendSchema.set('toJSON', {
  virtuals: true,
  transform: function (doc, ret) {
    delete ret.__v;
    return ret;
  }
});

const SearchConsoleTrend = mongoose.model('SearchConsoleTrend', searchConsoleTrendSchema);

export default SearchConsoleTrend;
