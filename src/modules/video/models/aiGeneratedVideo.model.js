import mongoose from 'mongoose';

/**
 * AI Generated Videos Collection Schema
 * Stores metadata for all AI-generated videos
 */
const aiGeneratedVideoSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SeoProject',
    required: true,
    index: true
  },
  videoUrl: {
    type: String,
    required: false,
    validate: {
      validator: function(v) {
        // Allow null/undefined for PROCESSING/FAILED, require URL for RENDERED
        if (this.status === 'PROCESSING' || this.status === 'FAILED') {
          return v === null || v === undefined || v === '';
        }
        // For RENDERED status, require valid URL
        return v && /^https?:\/\/.+/.test(v);
      },
      message: 'Invalid videoUrl format'
    }
  },
  status: {
    type: String,
    enum: ['PROCESSING', 'RENDERED', 'FAILED'],
    required: true,
    default: 'PROCESSING',
    index: true
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  // Optional metadata for enhanced tracking
  jobId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Job',
    index: true
  },
  videoFileName: {
    type: String,
    required: false
  },
  fileSize: {
    type: Number, // in bytes
    min: 0
  },
  processingTime: {
    type: Number, // in milliseconds
    min: 0
  },
  error: {
    message: String,
    stack: String,
    timestamp: Date
  },
  // Download tracking fields
  downloadCount: {
    type: Number,
    default: 0,
    min: 0
  },
  lastDownloadedAt: {
    type: Date
  }
}, {
  collection: 'ai_generated_videos',
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' }
});

// Compound indexes for performance
aiGeneratedVideoSchema.index({ userId: 1, createdAt: -1 });
aiGeneratedVideoSchema.index({ projectId: 1, status: 1 });
aiGeneratedVideoSchema.index({ userId: 1, projectId: 1 }, { unique: true }); // Prevent duplicates per user/project

// Partial filter index for failed videos
aiGeneratedVideoSchema.index(
  { status: 1, createdAt: -1 },
  { partialFilterExpression: { status: 'FAILED' } }
);

const AIGeneratedVideo = mongoose.model('AIGeneratedVideo', aiGeneratedVideoSchema);

export default AIGeneratedVideo;
