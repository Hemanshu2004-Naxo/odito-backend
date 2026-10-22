import mongoose from 'mongoose';

/**
 * Schema for storing headless accessibility scan results
 * One document per URL per project
 */
const headlessDataSchema = new mongoose.Schema({
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SeoProject',
    required: true,
    index: true
  },
  jobId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Job',
    required: true
  },
  url: {
    type: String,
    required: true,
    trim: true
  },
  render_status: {
    type: String,
    enum: ['success', 'failed'],
    required: true
  },
  statusCode: {
    type: Number,
    min: 100,
    max: 599
  },
  axeViolations: [{
    id: String,
    impact: String,
    description: String,
    helpUrl: String,
    nodes: Number,
    tags: [String],
    // The offending nodes axe-core reported (target selector path + a CLIPPED html
    // snippet, never the full node). The worker always sent these; without a schema
    // path Mongoose stripped them on save, leaving only the `nodes` count.
    nodeDetails: [{ target: [String], html: String, _id: false }]
  }],
  axeViolationCount: {
    type: Number,
    default: 0
  },
  axePassedCount: {
    type: Number,
    default: 0
  },
  domMetrics: {
    totalElements: Number,
    headings: {
      h1: Number,
      h2: Number,
      h3: Number,
      h4: Number,
      h5: Number,
      h6: Number
    },
    images: Number,
    imagesWithoutAlt: Number,
    links: Number,
    forms: Number,
    inputs: Number,
    buttons: Number,
    ariaLandmarks: Number,
    title: String,
    lang: String
  },
  error: {
    type: String,
    default: null
  },
  // Keyboard / focus audit. audit_version 2 (python_workers .../keyboard_audit.py)
  // stores the EXACT elements and the analysis behind every counter; v1 stored only
  // counters. Every field must be declared here: Mongoose strict mode silently drops
  // undeclared paths from the worker's bulkWrite $set (that is how the element lists
  // — and axe nodeDetails — were being lost before).
  keyboard_analysis: {
    keyboard_navigation_checked: { type: Boolean },
    // Legacy summary counters (same names/meaning the rules already read). In v2
    // focus_trap_detected is true only for an UNINTENDED/improper trap.
    focus_trap_detected: { type: Boolean },
    unreachable_elements: { type: Number },
    small_click_targets: { type: Number },
    small_click_targets_list: { type: [mongoose.Schema.Types.Mixed] },
    missing_focus_outline: { type: Number },
    total_tab_presses: { type: Number },
    detected_focusable_elements: { type: Number },
    focus_order: { type: [mongoose.Schema.Types.Mixed] },
    error: { type: String },
    // v2
    audit_version: { type: Number },
    audit_method: { type: String },
    tested_at: { type: Date },
    focusable_total: { type: Number },
    focusable_visible: { type: Number },
    tab_stops_visited: { type: Number },
    traversal: { type: mongoose.Schema.Types.Mixed },
    // { missing_focus_indicator[], missing_focus_indicator_total, weak_focus_indicator[],
    //   focus_not_visible[], unreachable[] } — compact structured element records, no raw HTML
    affected_elements: { type: mongoose.Schema.Types.Mixed },
    // [{ selector, tag, name, status }] for every Tab stop — lets verification re-test
    // the exact elements a fix targeted.
    element_results: { type: [mongoose.Schema.Types.Mixed] },
    focus_sequence: { type: [mongoose.Schema.Types.Mixed] },
    trap_details: { type: mongoose.Schema.Types.Mixed },
    technology: { type: mongoose.Schema.Types.Mixed },
    transitions_disabled_for_audit: { type: Boolean },
    css_rules_unavailable: { type: Boolean }
  },
  scannedAt: {
    type: Date,
    default: Date.now,
    index: true
  }
}, {
  timestamps: true,
  collection: 'seo_headless_data'
});

// Prevent duplicate entries for same project + URL
headlessDataSchema.index({ projectId: 1, url: 1 }, { unique: true });

// Index for job-based queries
headlessDataSchema.index({ jobId: 1 });

// Index for project-based queries with sorting
headlessDataSchema.index({ projectId: 1, scannedAt: -1 });

const HeadlessData = mongoose.model('HeadlessData', headlessDataSchema);

export default HeadlessData;
