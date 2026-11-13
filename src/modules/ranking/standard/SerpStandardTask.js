import mongoose from 'mongoose';

export const TASK_STATUSES = Object.freeze(['pending_submission', 'submitted', 'processing', 'completed', 'failed', 'retry_scheduled', 'expired']);
export const ACTIVE_TASK_STATUSES = Object.freeze(['pending_submission', 'submitted', 'processing', 'retry_scheduled']);

/**
 * One logical organic-SERP request (a keyword on one device in one market) through DataForSEO's Standard task API. It survives restarts:
 * every step of the lifecycle lives here, nothing in memory.
 *
 *   pending_submission -> submitted -> processing -> completed
 *                              \-> retry_scheduled (back to pending_submission when due) / failed / expired
 *
 * `dedupeKey` identifies the logical request. `activeKey` equals it only while the task is active and is REMOVED when it ends; the partial
 * unique index lets MongoDB allow one active task per request across every instance, so an identical request never buys a second task.
 * A retry re-uses this record (new DataForSEO id appended to `dfsTaskIds`), so retries are never new "logical" tasks.
 * `result` is the task_get task object as the provider returned it (same shape as a Live task), written together with status completed.
 */
const schema = new mongoose.Schema({
  dedupeKey: { type: String, required: true },
  activeKey: { type: String, default: undefined },
  status: { type: String, enum: TASK_STATUSES, default: 'pending_submission' },
  // Whose scan this is (for progress events); optional because some ranking flows carry no project.
  projectId: { type: mongoose.Schema.Types.ObjectId, default: null },
  keywordId: { type: mongoose.Schema.Types.ObjectId, default: null },
  keyword: { type: String, required: true, maxlength: 700 },
  device: { type: String, enum: ['desktop', 'mobile'], required: true },
  os: { type: String, required: true },
  locationCode: { type: Number, required: true },
  languageCode: { type: String, required: true },
  depth: { type: Number, required: true },
  priority: { type: Number, default: 1 },
  dfsTaskId: { type: String, default: null },
  dfsTaskIds: { type: [String], default: [] },
  attempts: { type: Number, default: 0 },          // submissions made
  submittedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  nextAttemptAt: { type: Date, default: null },    // pending_submission / retry_scheduled: not before
  nextPollAt: { type: Date, default: null },       // submitted / processing: next direct task_get
  pollCount: { type: Number, default: 0 },
  readyHint: { type: Boolean, default: false },    // tasks_ready or a pingback said the result can be fetched
  claimUntil: { type: Date, default: null },
  claimToken: { type: String, default: null },       // a worker is submitting / retrieving this task right now (until claimUntil)
  // Set when a submission was started and not known to have been refused: if the process died mid-request the provider may hold a task
  // for it. The task is not submitted again until the grace period passed, during which tasks_ready (tag = our id) can reveal and adopt it.
  submitAttemptedAt: { type: Date, default: null },
  lastError: { type: new mongoose.Schema({ code: String, message: String, at: Date, kind: String }, { _id: false }), default: null },
  providerStatusCode: { type: Number, default: null },
  outcome: { type: String, default: null },        // complete | no_results | partial (assessOrganicOutcome)
  cost: { type: Number, default: 0 },              // provider-reported cost of tasks posted for this request (all attempts)
  result: { type: mongoose.Schema.Types.Mixed, default: null },
  purgeAt: { type: Date, default: null },
}, { collection: 'serp_standard_tasks', timestamps: true, minimize: false });

schema.index({ activeKey: 1 }, { unique: true, name: 'serp_task_active_key', partialFilterExpression: { activeKey: { $type: 'string' } } });
schema.index({ status: 1, nextAttemptAt: 1 }, { name: 'serp_task_due_submission' });
schema.index({ status: 1, nextPollAt: 1 }, { name: 'serp_task_due_poll' });
schema.index({ dfsTaskId: 1 }, { name: 'serp_task_dfs_id', sparse: true });
schema.index({ dedupeKey: 1, status: 1, completedAt: -1 }, { name: 'serp_task_reuse' });
schema.index({ projectId: 1, createdAt: -1 }, { name: 'serp_task_project' });
schema.index({ purgeAt: 1 }, { name: 'serp_task_purge', expireAfterSeconds: 0 });

const SerpStandardTask = mongoose.models.SerpStandardTask || mongoose.model('SerpStandardTask', schema);
export default SerpStandardTask;

/** Singleton control documents shared by every instance: the ready-list poller schedule and the circuit breaker. */
const controlSchema = new mongoose.Schema({
  _id: { type: String },
  nextPollAt: { type: Date, default: null },
  pollIntervalMs: { type: Number, default: 0 },
  outcomes: { type: [Boolean], default: [] },      // recent terminal outcomes, true = success
  breakerOpenUntil: { type: Date, default: null },
}, { collection: 'serp_standard_control', minimize: false });
export const SerpStandardControl = mongoose.models.SerpStandardControl || mongoose.model('SerpStandardControl', controlSchema);
