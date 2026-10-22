import mongoose from 'mongoose';

const domainTechnicalReportSchema = new mongoose.Schema({
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SeoProject',
    required: true,
    index: true
  },
  domain: {
    type: String,
    required: true
  },
  robotsStatus: {
    type: Number,
    default: null
  },
  robotsExists: {
    type: Boolean,
    default: false
  },
  robotsContent: {
    type: String,
    default: ''
  },
  sitemapStatus: {
    type: Number,
    default: null
  },
  sitemapExists: {
    type: Boolean,
    default: false
  },
  sitemapContent: {
    type: String,
    default: ''
  },
  parsedSitemapUrlCount: {
    type: Number,
    default: 0
  },
  llmsTxt: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  // Normalized per-bot accessibility signals derived from robots.txt (extraction only)
  aiCrawlerSignals: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  sslValid: {
    type: Boolean,
    default: false
  },
  sslExpiryDate: {
    type: Date,
    default: null
  },
  sslDaysRemaining: {
    type: Number,
    default: null
  },
  // Fine-grained result of the TLS validation (VALID, EXPIRED_CERTIFICATE,
  // HOSTNAME_MISMATCH, CERTIFICATE_CHAIN_ERROR, INVALID_CERTIFICATE,
  // NO_HTTPS, TLS_CONNECTION_ERROR, DNS_ERROR, TIMEOUT, BLOCKED, UNKNOWN).
  // See python_workers ssl_checker.py for the source of truth and
  // technicalChecks.service.js for how this maps to OK/Warning/Critical.
  sslStatus: {
    type: String,
    default: null
  },
  // Human-readable reason for the sslStatus above (e.g. "Certificate
  // expired on 2024-01-01"), surfaced verbatim in the UI when present.
  sslMessage: {
    type: String,
    default: null
  },
  // subject/issuer/san/fingerprints/tls_version/authorized/authorization_error
  sslDetails: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  httpsRedirect: {
    type: Boolean,
    default: false
  },
  redirectChain: {
    type: [String],
    default: []
  },
  finalUrl: {
    type: String,
    default: null
  },
  sitemapDeepValidation: {
    total_urls_checked: { type: Number, default: 0 },
    non_200_urls: { type: Number, default: 0 },
    redirected_urls: { type: Number, default: 0 },
    canonical_mismatches: { type: Number, default: 0 },
    non_indexable_urls: { type: Number, default: 0 },
    validation_complete: { type: Boolean, default: false }
  },
  // Framework detected from the site's homepage HTML + headers.
  // Populated by the TECHNICAL_DOMAIN worker during audit execution.
  frameworkType: {
    name:       { type: String, default: null },   // display name e.g. "Next.js"
    key:        { type: String, default: null },   // slug e.g. "nextjs"
    confidence: { type: Number, default: null },   // 0-100
    source:     { type: String, default: null },   // "html" | "generator" | "header"
  },
  // URL reachability stats from the URL_QUALIFICATION worker — powers the
  // AISO Coverage card's Site-Wide Reachability Ratio rule (AISO-CV9).
  // Patched in after the initial report is created (see jobRoutes.js), so
  // these default to 0 on older reports that predate this field.
  discoveredUrls: {
    type: Number,
    default: 0
  },
  qualifiedUrls: {
    type: Number,
    default: 0
  },
  lowPriorityUrls: {
    type: Number,
    default: 0
  },
  rejectedUrls: {
    type: Number,
    default: 0
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
}, {
  collection: 'domain_technical_reports',
  strict: false
});

// Prevent duplicate reports per project
domainTechnicalReportSchema.index({ projectId: 1 }, { unique: true });

const DomainTechnicalReport = mongoose.model('DomainTechnicalReport', domainTechnicalReportSchema);

export default DomainTechnicalReport;
