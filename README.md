# openllmchat

Modern web app where two AI agents discuss a user topic in 10-turn batches while preserving context in SQLite.

## Features

- Two agent personas that alternate each turn
- Fixed 10-turn generation per run
- Persistent conversation state using SQLite
- Topic continuity by reusing saved transcript as context on each new batch
- Conversation history sidebar with one-click thread restore
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

Response includes the new turns generated for this run and total turns in the thread.

### `GET /api/conversation/:id`

Returns a saved conversation transcript and topic for a given `conversationId`.

### `GET /api/conversations?limit=30`

Returns recent conversation threads with topic, updated time, and turn count for history UIs.
