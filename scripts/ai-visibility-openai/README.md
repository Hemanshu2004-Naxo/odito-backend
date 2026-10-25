# OpenAI AI-visibility research test: "Which software companies in Nashik offer AI automation?"

A standalone script (no Odito server, no DataForSEO) that asks the **OpenAI Responses API** the question above with the **web search tool**
enabled and a Nashik user location, asks for up to 10 evidence-backed companies as strict JSON, and saves the results.

## Setup
- Node 18+ (the backend's own `openai` SDK and `dotenv` are reused; nothing new to install).
- Add to `backend/.env` (or export in your shell):
  - `OPENAI_API_KEY` (required, never printed or saved)
  - `OPENAI_MODEL` (optional, default `gpt-4.1-mini`; must support the Responses API and web search, and is checked with `models.retrieve` first)
  - `OPENAI_TIMEOUT_MS` (optional, default 180000)

## Run (from `backend/`)
```
node scripts/ai-visibility-openai/runNashikTest.js                # one paid API request
node scripts/ai-visibility-openai/runNashikTest.js --verify-urls  # also fetch each evidence URL
node --test scripts/ai-visibility-openai/normalize.test.js        # unit tests (mocked, free)
```

## Output
`backend/test-results/ai-visibility/nashik-ai-automation-YYYYMMDD-HHmmss.{json,raw.json,txt}` (git-ignored, never overwritten):
normalized results + metrics, the full API response, and a readable summary.

## Evidence and verification
Each evidence URL is labelled by what actually supports it:
- `cited`: it appears in the answer's `url_citation` annotations
- `found`: it was a web-search source but was not cited
- `fetched`: the script loaded it itself (`--verify-urls`)
- `model_only`: only the model listed it

`nashik_presence_verified` and `ai_automation_verified` stay true only when at least one evidence URL is not `model_only`; otherwise they are
set to false and the confidence to `low`. Duplicates (e.g. "Pvt Ltd" variants or the same website) are removed and ranks re-numbered.
Fewer than 10 results is a valid outcome and is reported, never padded.

## Reading the results
- **Confidence**: the model's own rating, lowered to `low` when nothing backs the claims.
- **Not an objective ranking**: positions are research-based recommendations, not audited quality rankings.
- **Different runs differ**: web results, the model's search queries and its sampling change between runs, so repeat a run before drawing conclusions.
- **Cost**: the API does not report a price, so none is shown; tokens are reported when the API returns them.
