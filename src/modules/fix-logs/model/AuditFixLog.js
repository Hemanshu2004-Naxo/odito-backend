import mongoose from 'mongoose';

const auditFixLogSchema = new mongoose.Schema(
  {
    projectId:    { type: mongoose.Schema.Types.ObjectId, ref: 'SeoProject', required: true },
    auditId:      { type: mongoose.Schema.Types.ObjectId },
    issueKey:     { type: String, required: true },
    issueName:    { type: String, default: '' },
    issueCategory:{ type: String, default: '' },
    pageUrl:      { type: String, required: true },
    status:       { type: String, enum: ['fixed', 'reopened'], default: 'fixed' },
    fixedAt:      { type: Date },
    reopenedAt:   { type: Date },
    aiRecommendationId: { type: String },
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
    collection: 'audit_fix_logs',
  }
);

auditFixLogSchema.index({ projectId: 1 });
auditFixLogSchema.index({ auditId: 1 });
auditFixLogSchema.index({ issueKey: 1 });
auditFixLogSchema.index({ pageUrl: 1 });
auditFixLogSchema.index({ status: 1 });
// For deduplication lookups
auditFixLogSchema.index({ projectId: 1, issueKey: 1, pageUrl: 1 });

const AuditFixLog = mongoose.model('AuditFixLog', auditFixLogSchema);

export default AuditFixLog;
