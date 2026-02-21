# openllmchat

Minimal modern web app where two AI agents discuss a user topic for 10 turns while preserving conversation context.

## Features

- Two agent personas that alternate each turn
- Fixed 10-turn dialog
- Context retention using running transcript in each generation request
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
- `PORT`: server port (default `3000`)

## API

`POST /api/conversation`

Request body:

```json
{
  "topic": "Designing a context-aware AI onboarding flow",
  "turns": 10
}
```

Response includes the generated transcript and engine used.
