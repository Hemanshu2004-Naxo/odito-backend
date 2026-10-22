import mongoose from 'mongoose';



const aiScriptSchema = new mongoose.Schema({

  // Project Reference

  projectId: {

    type: mongoose.Schema.Types.ObjectId,

    ref: 'SeoProject',

    required: true,

    index: true

  },



  userId: {

    type: mongoose.Schema.Types.ObjectId,

    ref: 'User',

    required: true,

    index: true

  },



  // Audit Data Snapshot

  auditSnapshot: {

    type: Object,

    default: null,

    required: false

  },



  // Generated Script

  script: {

    type: String,

    default: null,

    required: false

  },



  // Status

  status: {

    type: String,

    enum: ['pending', 'generating', 'completed', 'failed'],

    default: 'pending',

    index: true

  },



  // Error tracking

  error: {

    type: String,

    default: null

  },



  // AI Provider that generated the script

  // Options: 'groq' (primary), 'gemini' (fallback), 'fallback' (last resort)

  aiProvider: {

    type: String,

    enum: ['groq', 'gemini', 'fallback', 'unknown'],

    default: 'unknown',

    index: true

  },



  // Metadata

  createdAt: {

    type: Date,

    default: Date.now,

    index: true

  },



  updatedAt: {

    type: Date,

    default: Date.now

  },



  // Processing times

  processingTime: {

    type: Number,

    default: null

  }

});



// Auto-update updatedAt on save

aiScriptSchema.pre('save', function(next) {

  this.updatedAt = new Date();

  next();

});



// Indexes

aiScriptSchema.index({ projectId: 1, createdAt: -1 });

aiScriptSchema.index({ userId: 1, createdAt: -1 });

aiScriptSchema.index({ status: 1 });



const AIScript = mongoose.model('AIScript', aiScriptSchema);



export default AIScript;

