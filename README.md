# openllmchat

Modern web app where two AI agents discuss a user topic in 10-turn batches while preserving context in SQLite.

## Features

- Two agent personas that alternate each turn
- Fixed 10-turn generation per run (with early-stop guardrails)
- Persistent conversation state using SQLite
- Compressed context memory for long threads:
  - Stores only high-value tokens (drops filler words, articles, punctuation-only noise)
  - Maintains weighted token memory with pruning to top tokens
  - Creates rolling summary snapshots after configurable turn windows
  - Extracts structured semantic memory (decisions, constraints, definitions, open questions)
- Coordinator guardrails:
  - Charter-driven turn generation
  - Moderator pass every N turns with steering directives
  - Repetition guard and optional DONE-token stopping
- Quality optimizer:
  - Scores each turn for topic coverage, verbosity, and repetition
  - Auto-retries weak turns with stricter guidance
  - Exposes quality score and retries in stream/UI
- Conversation Brief per thread:
  - Objective
  - Constraints
  - Done criteria
  - Brief is persisted and used by both speaker prompts and moderator checks
- One-click forking from any turn to branch strategy paths without losing context
- Conversation history sidebar with one-click thread restore
- Live turn-by-turn streaming so agent replies appear in real time
- One-click transcript export (copy markdown or download file)
- Sleek responsive UI with animated transcript rendering
- Works with OpenAI API or local fallback mode when no API key is set

## Quick start

```bash
npm install
cp .env.example .env
npm start
```

Open `http://localhost:3000`.

## Environment

- `OPENAI_API_KEY`: required for live model generation
- `OPENAI_MODEL`: model name (default `gpt-4o-mini`)
- `OPENAI_BASE_URL`: optional for OpenAI-compatible providers
- `SQLITE_PATH`: optional SQLite file path (default `./data/openllmchat.db`)
- `MEMORY_TOKEN_KEEP_LIMIT`: max stored weighted tokens per conversation (default `180`)
- `MEMORY_PROMPT_TOKEN_LIMIT`: max memory tokens injected into prompts (default `50`)
- `MEMORY_SUMMARY_WINDOW_TURNS`: turns per summary chunk (default `40`)
- `MEMORY_MIN_TURNS_FOR_SUMMARY`: minimum total turns before summary generation starts (default `40`)
- `MEMORY_SUMMARY_LIMIT`: number of latest summaries injected into prompts (default `6`)
- `MEMORY_SEMANTIC_KEEP_LIMIT`: max semantic records stored per conversation (default `240`)
- `MEMORY_PROMPT_SEMANTIC_LIMIT`: semantic records injected into prompt context (default `24`)
- `MODERATOR_INTERVAL`: run moderator every N total turns (default `6`)
- `MAX_GENERATION_MS`: hard per-request generation time budget (default `30000`)
- `MAX_REPETITION_STREAK`: allowed near-duplicate turn streak before stop (default `2`)
- `QUALITY_MIN_WORDS`: minimum words required per turn before retry (default `9`)
- `QUALITY_RETRY_LIMIT`: retries per turn when quality checks fail (default `1`)
- `QUALITY_MAX_SIMILARITY`: max similarity to previous turn before retry (default `0.9`)
- `QUALITY_MIN_TOPIC_COVERAGE`: minimum keyword overlap score before retry (default `0.12`)
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
  "objective": "Produce a concrete architecture recommendation",
  "constraintsText": "Low latency, auditability, and minimal cost",
  "doneCriteria": "Both agents align on one plan with tradeoffs and next steps"
}
```

Response includes generated turns, total turns, memory stats, brief, quality summary, and stop reason.

### `POST /api/conversation/stream`

Same behavior as `POST /api/conversation`, but returns newline-delimited JSON chunks for live UI updates:

- `meta`: conversation info, engine, memory stats, brief, charter, guardrails
- `retry`: quality optimizer retry event
- `turn`: one generated turn plus quality stats
- `moderator`: moderator assessment/directive
- `done`: final summary with stop reason, brief, quality summary, and updated memory stats

### `GET /api/conversation/:id`

Returns a saved conversation transcript, topic, brief, parent/fork metadata, and memory stats.

### `GET /api/conversation/:id/brief`

Returns only the persisted brief for a conversation.

### `POST /api/conversation/:id/brief`

Updates brief fields for an existing conversation.

### `POST /api/conversation/:id/fork`

Creates a new conversation from an existing thread up to a selected turn.

Request body (optional):

```json
{
  "turn": 24
}
```

Returns the new `conversationId`, inherited brief, copied transcript, and memory stats.

### `GET /api/conversation/:id/memory`

Returns compressed memory details for a conversation:

- weighted high-value tokens
- rolling summaries
- structured semantic memory records
- memory stats

### `GET /api/conversations?limit=30`

Returns recent conversation threads with topic, updated time, turn count, `hasBrief`, and fork metadata.
