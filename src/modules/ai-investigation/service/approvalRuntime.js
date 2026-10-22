import { createApprovalService, ApprovalError } from './approvalService.js';
import { createMongoStore } from './investigationStore.js';
import { resolveFixCapabilities } from '../capabilities/fixCapabilities.js';
import { getConfirmedAddress } from '../../schema-evidence/organizationAddressStore.js';

/** Process-wide approval service on the real store and the real capability rules. */
let service = null;
export function getApprovalService() {
  if (!service) {
    service = createApprovalService({
      store: createMongoStore(), resolveCapabilities: resolveFixCapabilities, loadConfirmedAddress: (projectId) => getConfirmedAddress(projectId),
      log: (level, event, fields) => console[level === 'warn' ? 'warn' : 'log'](`[AI_INVESTIGATION] ${event}`, JSON.stringify(fields)),
    });
  }
  return service;
}
export function __setApprovalServiceForTests(s) { service = s; }

/** For the apply route: resolves to { legacy } or { release }; throws ApprovalError (with statusCode/code) when the apply must not proceed. */
export async function claimInvestigationApproval(task) {
  return getApprovalService().claimForApply(task);
}
export { ApprovalError };
