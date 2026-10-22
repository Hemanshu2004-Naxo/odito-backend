# ai-investigation — universal issue investigation engine

Diagnosis only. It never writes to a website. Fixes keep going through the existing approved path
(Task -> `wordPressSeoFixService.applyFix` -> crawler verification); this module reports what that path recorded.

```
POST /recommendations/investigations         start (or join the identical running one)
GET  /recommendations/investigations/:id     progress + result (+ lifecycle derived from Task records)
POST /recommendations/investigations/:id/cancel
POST /recommendations/investigations/:id/verify   -> existing url-verification pipeline (re-fetch + detector re-run)
```

Pipeline (`service/investigationOrchestrator.js`): validate -> plan -> gather evidence -> resolve fix capabilities ->
diagnose (master prompt) -> validate output -> persist.

| Concern | File |
|---|---|
| Only network access (SSRF guard, DNS pinning, per-hop redirect checks) | `net/ssrfGuard.js` |
| Page facts from HTML (JSON-LD, breadcrumbs, images, a11y, rendering hints) | `evidence/pageInspector.js` |
| Evidence ledger (source / method / timestamp / status, dedupe, freshness) | `evidence/evidenceLedger.js` |
| Which evidence an issue family needs (data table) | `evidence/investigationPlans.js` |
| Evidence collection | `evidence/evidenceCollector.js` |
| What Odito can really fix (from `providerCapabilityRegistry`) | `capabilities/fixCapabilities.js` |
| ONE versioned master prompt | `prompt/masterPrompt.js` |
| Response contract + grounding guards (the model can't grant itself a fix) | `contract/investigationContract.js` |
| applied / verified derived from real records | `service/lifecycleService.js` |

Bump `MASTER_PROMPT_VERSION` / `CONTRACT_VERSION` when instructions or schema change.

## Fix workflow (no second execution system)
`POST .../prepare-fix` re-derives eligibility on the server, then finds/creates the Task (unique index = idempotent) and links a
same-project Recommendation (existing `recommendationService`). Applying is the EXISTING `POST /tasks/:id/apply-wordpress`, which the
backend refuses unless `approved === true`. The investigation's own code is guidance; it is never written to a site.
`applied` / `verified` are derived from the Task's own records, only for attempts made after the investigation, and a verification only
counts if it happened after the write. `POST .../verify` is allowed only for the latest completed investigation, once at a time.

## Lifecycle and recovery
- One active run per project+issue+page is a database guarantee (partial unique index on `activeKey`), so it holds across instances.
- Every write of a running pipeline is compare-and-set on "still queued/running": an abandoned provider call cannot overwrite a
  cancelled/failed/completed row. Cancel always returns an explicit outcome (`cancelled` / `not_active`).
- A run nobody has written to for deadline+60s is failed as `INVESTIGATION_INTERRUPTED` by: the startup/periodic sweep
  (`service/recoveryScheduler.js`, started from `server.js`), lazily on GET, and lazily on a new start for the same page.
- Concurrency slots are released on every path (including cancel while waiting for a slot).

## Tests
- Unit (mocked): `*/*.test.js` except `integration/`.
- Integration (real Express routes + auth + MongoDB `odito_investigation_it`, real claudeService code path with a controlled provider reply):
  `integration/api.integration.test.js` (skips itself if MongoDB is unreachable).
- Live (real site + real Claude, run manually, never in routine runs): `node integration/liveCheck.mjs [pageUrl] [issueId]` against a server
  started with `MONGO_URI=mongodb://localhost:27017/odito_investigation_it PORT=5055`.

## Known limits
- Runs in-process (not on a job queue). State survives restarts and stale runs are failed, but a restart still ends the run; the user
  must start it again.
- No on-demand headless renderer is exposed to investigations (`deps.renderPage`); the stored headless crawl is used and labelled.
- Cancelling abandons an in-flight provider call (it is not aborted at the provider); its result is discarded.
- Only the Claude provider is wired; `deps.llm` accepts any object with `complete()`.
- Real WordPress writes and real `startUrlVerification` runs are covered only against mocks / the guard path; they need a staging site.
