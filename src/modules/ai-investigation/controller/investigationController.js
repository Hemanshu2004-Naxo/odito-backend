import { InvestigationRunner, InvestigationError } from '../service/investigationOrchestrator.js';
import { createDefaultDeps } from '../service/defaultDeps.js';
import { defaultLifecycleService, deriveLifecycle } from '../service/lifecycleService.js';
import { prepareFix, FixPreparationError } from '../service/fixPreparationService.js';
import { ApprovalError } from '../service/approvalService.js';
import { getApprovalService } from '../service/approvalRuntime.js';
import Task from '../../tasks/model/Task.js';

/**
 * Investigation HTTP handlers. Authentication and project ownership are enforced by the router
 * (auth + validateProjectAccess) BEFORE these run; `req.project` is the authorised project. Every store call
 * is additionally scoped by that project's id, so an investigation id from another tenant is simply "not found".
 */

const toProject = (req) => ({
  id: String(req.project?._id || req.projectId),
  siteUrl: req.project?.main_url || req.project?.canonical_url || '',
  cms: req.project?.cms || null,
  framework: req.project?.framework || null,
});

/** The client-facing shape: no prompt text, no raw page data. */
export function toView(record, lifecycle = null) {
  if (!record) return null;
  return {
    id: String(record._id),
    issueId: record.issueId,
    pageUrl: record.pageUrl,
    status: record.status,
    stage: record.stage,
    progress: record.progress || [],
    planFamily: record.planFamily || null,
    promptVersion: record.promptVersion || null,
    contractVersion: record.contractVersion || null,
    evidence: record.evidenceTrace || [],
    result: record.result ? { ...record.result, lifecycle: lifecycle || record.result.lifecycle } : null,
    warnings: record.warnings || [],
    error: record.error?.code ? record.error : null,
    startedAt: record.startedAt || null,
    finishedAt: record.finishedAt || null,
    createdAt: record.createdAt || null,
  };
}

export function createInvestigationController({ runner, lifecycle, store, prepare = prepareFix, resolveCapabilities = null, approvals = null, loadTask = (projectId, issueKey, pageUrl) => Task.findOne({ projectId, issueKey, pageUrl, isDeleted: { $ne: true } }).lean() }) {
  const fail = (res, error, fallback) => {
    if (error instanceof ApprovalError) return res.status(error.statusCode).json({ success: false, code: error.code, message: error.message });
    if (error instanceof FixPreparationError) return res.status(error.statusCode).json({ success: false, code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) });
    if (error instanceof InvestigationError) return res.status(error.statusCode || 400).json({ success: false, code: error.code, message: error.message });
    console.error(`[AI_INVESTIGATION_CTRL] ${fallback}:`, error?.message);
    return res.status(500).json({ success: false, code: 'INVESTIGATION_FAILED', message: fallback });
  };

  return {
    /** POST /recommendations/investigations — body { projectId, issueId, pageUrl, ruleMetadata? } */
    async start(req, res) {
      try {
        const { issueId, pageUrl, ruleMetadata, issueSource } = req.body || {};
        const issue = { issueId, pageUrl, issueSource, ...(ruleMetadata && typeof ruleMetadata === 'object' ? {
          title: ruleMetadata.title, description: ruleMetadata.description, category: ruleMetadata.category, severity: ruleMetadata.severity, difficulty: ruleMetadata.difficulty,
        } : {}) };
        const { record, joined } = await runner.start({ project: toProject(req), userId: req.userId || req.user?.id, issue });
        return res.status(202).json({ success: true, data: toView(record), meta: { joinedExisting: joined } });
      } catch (error) { return fail(res, error, 'Failed to start the investigation'); }
    },

    /** GET /recommendations/investigations/:investigationId?projectId= */
    async get(req, res) {
      try {
        let record = await store.findById(req.params.investigationId, toProject(req).id);
        // A run nobody is working on (crashed/restarted server) must not look "running" forever: close it now.
        if (record && await runner.reapIfStale(record)) record = await store.findById(req.params.investigationId, toProject(req).id);
        if (!record) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Investigation not found.' });
        const state = await lifecycle.get({ investigationId: req.params.investigationId, projectId: toProject(req).id });
        return res.status(200).json({ success: true, data: toView(record, state?.lifecycle) });
      } catch (error) { return fail(res, error, 'Failed to load the investigation'); }
    },

    /** POST /recommendations/investigations/:investigationId/cancel */
    async cancel(req, res) {
      try {
        const out = await runner.cancel(req.params.investigationId, toProject(req).id);
        if (!out) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Investigation not found.' });
        return res.status(200).json({ success: true, data: { cancelled: out.cancelled, outcome: out.outcome, status: out.record.status } });
      } catch (error) { return fail(res, error, 'Failed to cancel the investigation'); }
    },

    /**
     * POST /recommendations/investigations/:investigationId/prepare-fix
     * Finds/creates the Task and links a recommendation so the EXISTING approval + apply controls can run. Writes nothing to the website.
     */
    async prepareFix(req, res) {
      try {
        const project = toProject(req);
        const investigation = await store.findById(req.params.investigationId, project.id);
        if (!investigation) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Investigation not found.' });
        const resolver = resolveCapabilities || (await import('../capabilities/fixCapabilities.js')).resolveFixCapabilities;
        const { getConfirmedAddress } = await import('../../schema-evidence/organizationAddressStore.js');
        const data = await prepare({ investigation, project, userId: req.userId || req.user?.id }, { resolveCapabilities: resolver, loadConfirmedAddress: (pid) => getConfirmedAddress(pid) });
        return res.status(200).json({ success: true, data });
      } catch (error) { return fail(res, error, 'Failed to prepare the fix'); }
    },

    /**
     * POST /recommendations/investigations/:investigationId/confirm-address   body { projectId, address, basisCandidateId? }
     * The user asserts the business address is correct. It is validated (street + city required, nothing guessed, placeholders refused), stored with who/when/source
     * and bound to this project's website, this issue and this Organization entity, and that is ALL: it creates no approval, generates no legacy
     * recommendation and changes nothing on the website. The client then re-runs the investigation so the proposal is rebuilt from the confirmed address.
     */
    async confirmAddress(req, res) {
      try {
        const declared = Number(req.get?.('content-length') || 0);
        if (declared > 8 * 1024) return res.status(413).json({ success: false, code: 'PAYLOAD_TOO_LARGE', message: 'The submitted address is too large.' });
        const project = toProject(req);
        const inv = await store.findById(req.params.investigationId, project.id);
        if (!inv) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Investigation not found.' });
        const analysis = (inv.result?.analyses || []).find((a) => a.data?.operation === 'address');
        if (!analysis) return res.status(422).json({ success: false, code: 'NOT_AN_ADDRESS_FINDING', message: 'This investigation is not about a missing Organization address.' });
        const { validateConfirmedAddressInput, formatAddress } = await import('../../schema-evidence/organizationAddress.js');
        const { saveConfirmedAddress, addressHashOf } = await import('../../schema-evidence/organizationAddressStore.js');
        let validated;
        try { validated = validateConfirmedAddressInput(req.body?.address); }
        catch (e) { return res.status(422).json({ success: false, code: 'ADDRESS_INPUT_INVALID', field: e.field || null, message: e.message }); }
        const cand = (analysis.data.candidates || []).find((c) => c.id === req.body?.basisCandidateId);
        const sameAsCandidate = !!cand && Object.entries(cand.fields || {}).every(([k, v]) => validated.fields[k] === v);
        const website = (() => { try { return new URL(req.project?.main_url || inv.pageUrl).origin; } catch { return null; } })();
        const saved = await saveConfirmedAddress({
          projectId: project.id, fields: validated.fields, basis: sameAsCandidate ? 'selected_candidate' : 'typed', basisSource: sameAsCandidate ? String(cand.source).slice(0, 60) : null,
          userId: req.userId || req.user?.id, website, issueId: inv.issueId, entityId: analysis.data.entity?.id || null,
        });
        return res.status(200).json({ success: true, data: {
          confirmed: true, changed: saved.changed, state: 'confirmed_by_user', source: 'user_provided', verifiedExternally: false,
          formatted: formatAddress(validated.fields), fields: validated.fields, addressHash: saved.addressHash || addressHashOf(validated.fields), website,
          note: 'You asserted this address is correct; Odito has not verified it independently. Nothing was approved or changed on your website.', nextStep: 'rerun_investigation',
        } });
      } catch (error) { return fail(res, error, 'Failed to confirm the address'); }
    },

    /**
     * POST /recommendations/investigations/:investigationId/approve   body { projectId, fingerprint }
     * Approves exactly the proposal the person reviewed. The apply route re-checks and consumes this approval; it is void if anything changes.
     */
    async approve(req, res) {
      try {
        const project = toProject(req);
        const svc = approvals || getApprovalService();
        const out = await svc.approve({ investigationId: req.params.investigationId, projectId: project.id, userId: req.userId || req.user?.id, fingerprint: req.body?.fingerprint, loadTask });
        if (!out) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Investigation not found.' });
        return res.status(200).json({ success: true, data: { approved: true, fingerprint: out.fingerprint, approvedAt: out.approvedAt } });
      } catch (error) { return fail(res, error, 'Failed to record the approval'); }
    },

    /** POST /recommendations/investigations/:investigationId/verify — re-fetch and re-run the detectors via the existing pipeline. */
    async verify(req, res) {
      try {
        const out = await lifecycle.requestVerification({ investigationId: req.params.investigationId, projectId: toProject(req).id, userId: req.userId || req.user?.id });
        if (!out) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Investigation not found.' });
        if (!out.started) return res.status(out.code === 'ALREADY_RUNNING' ? 409 : 422).json({ success: false, code: out.code, message: out.message || 'Verification could not be started.' });
        return res.status(202).json({ success: true, data: { verificationRunId: out.verificationRunId, verificationStatus: 'pending' } });
      } catch (error) { return fail(res, error, 'Failed to start verification'); }
    },
  };
}

let singleton = null;
let sharedRunner = null;
/** The one runner of this process (the controller and the recovery scheduler must share it so `controllers` reflects what is really running). */
export function getDefaultRunner() {
  if (!sharedRunner) sharedRunner = new InvestigationRunner(createDefaultDeps());
  return sharedRunner;
}
/** Test seam: swap the process-wide runner/controller (integration tests inject deterministic deps). */
export function __setDefaultRunnerForTests(runner, controllerOverrides = {}) {
  sharedRunner = runner;
  singleton = runner ? createInvestigationController({ runner, lifecycle: defaultLifecycleService(runner.deps.store), store: runner.deps.store, ...controllerOverrides }) : null;
}
export function getDefaultController() {
  if (!singleton) {
    const runner = getDefaultRunner();
    singleton = createInvestigationController({ runner, lifecycle: defaultLifecycleService(runner.deps.store), store: runner.deps.store });
  }
  return singleton;
}

export { deriveLifecycle };
export default { createInvestigationController, getDefaultController, toView };
