# openllmchat

Modern web app where two AI agents discuss a user topic for user-selected turn counts while preserving context in SQLite.

## Features

- Next.js UI built with Tailwind CSS and shadcn-style components.
- Minimal UI with only core actions: run conversation (topic + turns), switch light/dark theme, manage saved history (refresh/clear), and use a collapsible thread history sidebar.
- Two agent personas that alternate each turn with live streaming output.
- Persistent conversation state in SQLite.
- Advanced conversation engine remains available through API:
  - high-value token memory
  - micro/meso/macro summary compaction
  - conflict ledger
  - evaluator loop with automatic self-correction
  - citation-backed debate mode with claim confidence tracking
- Security hardening includes rate limiting, strict id validation, optional write-token auth, CSRF-style origin checks, and CSP headers.
- Works with OpenAI API or local fallback mode when no API key is set.

## Quick start

```bash
npm install
cp .env.example .env
npm run dev
```

Open `http://localhost:3000`.

Production:

```bash
npm run build
npm start
```

## Environment

- `OPENAI_API_KEY`: required for live model generation
- `OPENAI_MODEL`: model name (default `gpt-5.2`)
- `OPENAI_REASONING_EFFORT`: reasoning effort (`none|minimal|low|medium|high|xhigh`, default `medium`)
- `OPENAI_FALLBACK_MODEL`: optional fallback model if primary is unavailable (default `gpt-4o-mini`)
- `OPENAI_BASE_URL`: optional for OpenAI-compatible providers
- `SQLITE_PATH`: optional SQLite file path (default `./data/openllmchat.db`)
- `MEMORY_TOKEN_KEEP_LIMIT`: max stored weighted tokens per conversation (default `180`)
- `MEMORY_PROMPT_TOKEN_LIMIT`: max memory tokens injected into prompts (default `50`)
- `MEMORY_SUMMARY_WINDOW_TURNS`: turns per summary chunk (default `40`)
- `MEMORY_MIN_TURNS_FOR_SUMMARY`: minimum total turns before summary generation starts (default `40`)
- `MEMORY_SUMMARY_LIMIT`: number of latest summaries injected into prompts (default `6`)
- `MEMORY_SEMANTIC_KEEP_LIMIT`: max semantic records stored per conversation (default `240`)
- `MEMORY_PROMPT_SEMANTIC_LIMIT`: semantic records injected into prompt context (default `24`)
- `MEMORY_MESO_GROUP_SIZE`: number of micro summaries merged into one meso summary (default `4`)
- `MEMORY_MACRO_GROUP_SIZE`: number of meso summaries merged into one macro summary (default `3`)
- `MEMORY_PROMPT_MESO_LIMIT`: meso summaries injected into context (default `4`)
- `MEMORY_PROMPT_MACRO_LIMIT`: macro summaries injected into context (default `3`)
- `MEMORY_CONFLICT_KEEP_LIMIT`: max stored conflict ledger records per conversation (default `160`)
- `MEMORY_PROMPT_CONFLICT_LIMIT`: conflict ledger records injected into context (default `14`)
- `MODERATOR_INTERVAL`: run moderator every N total turns (default `6`)
- `MAX_GENERATION_MS`: hard per-request generation time budget (default `30000`)
- `MAX_REPETITION_STREAK`: allowed near-duplicate turn streak before stop (default `2`)
- `QUALITY_MIN_WORDS`: minimum words required per turn before retry (default `9`)
- `QUALITY_RETRY_LIMIT`: retries per turn when quality checks fail (default `1`)
- `QUALITY_MAX_SIMILARITY`: max similarity to previous turn before retry (default `0.9`)
- `QUALITY_MIN_TOPIC_COVERAGE`: minimum keyword overlap score before retry (default `0.12`)
- `EVALUATOR_LOOP_ENABLED`: enable continuous evaluator loop (default `true`)
- `EVALUATOR_RETRY_LIMIT`: extra retries for evaluator-driven self-correction (default `1`)
- `EVALUATOR_MIN_OVERALL`: minimum evaluator composite score (default `0.56`)
- `EVALUATOR_MIN_NOVELTY`: minimum novelty score per turn (default `0.22`)
- `EVALUATOR_MIN_COHERENCE`: minimum coherence score per turn (default `0.26`)
- `EVALUATOR_MIN_EVIDENCE`: minimum evidence quality score in debate mode (default `0.24`)
- `CITATION_RETRIEVAL_ENABLED`: enable citation retrieval in debate mode (default `true`)
- `CITATION_MAX_REFERENCES`: max references retrieved per refresh (default `4`)
- `CITATION_REFRESH_INTERVAL`: refresh references every N generated turns (default `3`)
- `CITATION_TIMEOUT_MS`: per-request timeout for citation retrieval calls (default `4500`)
- `CITATION_MIN_REFERENCE_CONFIDENCE`: minimum confidence to keep a retrieved source (default `0.18`)
- `MAX_TURN_CHARS`: max characters stored per generated turn after normalization (default `1400`)
- `RATE_LIMIT_WINDOW_MS`: API rate limit window in milliseconds (default `60000`)
- `RATE_LIMIT_MAX_REQUESTS`: max API requests per client IP per window (default `180`)
- `GENERATION_LIMIT_MAX_REQUESTS`: max conversation generation POST requests per IP per window (default `36`)
- `RATE_LIMIT_MAX_KEYS`: max active client keys kept in rate limiter memory before sweeping/pruning (default `12000`)
- `LAB_DEFAULT_TURNS`: turns per mode in discovery lab runs (default `6`)
- `TRUST_PROXY`: set to `true` only behind a trusted reverse proxy/load balancer (default `false`)
- `APP_ORIGIN`: canonical app origin (for stricter CSRF checks behind proxies, e.g. `https://openllmchat.example`)
- `CSRF_PROTECTION`: enable/disable CSRF-style origin checks on write methods (default `true`)
- `CSRF_ALLOWED_ORIGINS`: comma-separated extra origins allowed for browser write requests (default empty)
- `API_WRITE_TOKEN`: optional shared token required on write requests (`Authorization: Bearer ...` or `x-api-key`)
- `PORT`: server port (default `3000`)

## API

### `POST /api/conversation`

Creates or continues a conversation.

Request body:

```json
{
  "topic": "Designing a context-aware AI onboarding flow",
  "turns": 10,
  "conversationId": "optional-existing-conversation-id",
  "title": "Optional thread title",
  "starred": false,
  "mode": "debate",
  "objective": "Produce a concrete architecture recommendation",
  "constraintsText": "Low latency, auditability, and minimal cost",
  "doneCriteria": "Both agents align on one plan with tradeoffs and next steps",
  "agents": [
    {
      "id": "agent-a",
      "name": "Dr. Ada",
      "style": "You are exact and systems-focused.",
      "temperature": 0.61
    },
    {
      "id": "agent-b",
      "temperature": 0.2
    }
  ]
}
```

`agents` is optional and supports partial updates (`name`, `style`, and `temperature`) for `agent-a` / `agent-b`.

Response includes generated turns, total turns, memory stats, title/starred/mode metadata, brief, agents, quality summary, and stop reason.

### `POST /api/conversation/stream`

Same behavior as `POST /api/conversation`, but returns newline-delimited JSON chunks for live UI updates:

- `meta`: conversation info, engine, memory stats, title/starred/mode, brief, agents, charter, guardrails
- `references`: retrieved citation notes for the next debate turn
- `retry`: quality optimizer retry event
- `turn`: one generated turn plus quality stats
- `moderator`: moderator assessment/directive
- `done`: final summary with stop reason, title/starred/mode, brief, agents, quality summary, and updated memory stats

### `POST /api/conversation/lab`

Runs a multi-mode experiment (`exploration`, `debate`, `synthesis`) and returns one generated thread per mode.

Request supports either:

- `conversationId` (forks current thread context into all modes), or
- `topic` for a new lab run.

Also supports optional brief/agent/thread meta fields.

Response includes:

- `turnsPerMode`
- `runs[]` where each run includes `conversationId`, `mode`, quality summary, memory stats, and insight snapshot.

### `GET /api/conversation/:id`

Returns a saved conversation transcript, topic, title/starred/mode, brief, agents, parent/fork metadata, and memory stats.

### `GET /api/conversation/:id/brief`

Returns only the persisted brief for a conversation.

### `POST /api/conversation/:id/brief`

Updates brief fields for an existing conversation.

### `POST /api/conversation/:id/meta`

Updates thread metadata for an existing conversation:

- `title` (max 96 chars)
- `starred` (`true`/`false`)
- `mode` (`exploration` | `debate` | `synthesis`)

### `GET /api/conversation/:id/agents`

Returns only the persisted agent configuration for a conversation.

### `POST /api/conversation/:id/agents`

Updates agent fields (`name`, `style`, `temperature`) for `agent-a` / `agent-b`.
Request can be partial and only changes the provided fields.

### `POST /api/conversation/:id/fork`

Creates a new conversation from an existing thread up to a selected turn.

Request body (optional):

```json
{
  "turn": 24
}
```

Returns the new `conversationId`, fork title, inherited brief, inherited agents, copied transcript, and memory stats.

### `GET /api/conversation/:id/memory`

Returns compressed memory details for a conversation:

- weighted high-value tokens
- micro summaries
- meso summaries
- macro summaries
- structured semantic memory records
- conflict ledger entries
- memory stats
- active agent configuration

### `GET /api/conversation/:id/insights`

Returns an actionable insight snapshot derived from compressed memory:

- decisions
- constraints
- definitions
- open questions
- next steps
- insight stats

### `GET /api/conversation/:id/discoveries`

Returns a discovery radar derived from transcript + compressed memory:

- hypotheses with confidence and evidence source
- experiment protocols linked to hypotheses
- discovery risk map
- novelty score and stage
- next recommended discovery action

### `GET /api/conversation/:id/citations`

Returns citation-backed debate evidence for a conversation:

- retrieved source notes (`sources[]`)
- cited claims with linked source ids/URLs (`claims[]`)
- confidence coverage stats (`sourceCount`, `claimCount`, `confidenceAvg`)

### `GET /api/conversation/:id/score`

Returns an objective progress scorecard derived from brief + transcript + memory:

- `overall` score (0-1)
- `stage` (`early`, `developing`, `converging`, `near_done`)
- component scores (`objectiveCoverage`, `decisionMomentum`, `doneSignal`, `resolution`)
- decision/open-question counts
- prioritized `nextAction`

### `GET /api/conversations?limit=30`

Returns recent conversation threads with topic, title/starred/mode, updated time, turn count, `hasBrief`, `hasCustomAgents`, and fork metadata.
