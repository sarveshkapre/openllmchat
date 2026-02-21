# openllmchat

Modern web app where two AI agents discuss a user topic in 10-turn batches while preserving context in SQLite.

## Features

- Two agent personas that alternate each turn
- Fixed 10-turn generation per run
- Persistent conversation state using SQLite
- Compressed context memory for long threads:
  - Stores only high-value tokens (drops filler words, articles, punctuation-only noise)
  - Maintains weighted token memory with pruning to top tokens
  - Creates rolling summary snapshots after configurable turn windows
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
- `PORT`: server port (default `3000`)

## API

### `POST /api/conversation`

Creates or continues a conversation.

Request body:

```json
{
  "topic": "Designing a context-aware AI onboarding flow",
  "turns": 10,
  "conversationId": "optional-existing-conversation-id"
}
```

Response includes the new turns generated for this run, total turns, and memory stats.

### `POST /api/conversation/stream`

Same behavior as `POST /api/conversation`, but returns newline-delimited JSON chunks for live UI updates:

- `meta`: conversation info, engine, current memory stats
- `turn`: one generated turn
- `done`: final summary with updated memory stats

### `GET /api/conversation/:id`

Returns a saved conversation transcript, topic, and memory stats.

### `GET /api/conversation/:id/memory`

Returns compressed memory details for a conversation:

- weighted high-value tokens
- rolling summaries
- memory stats

### `GET /api/conversations?limit=30`

Returns recent conversation threads with topic, updated time, and turn count for history UIs.
