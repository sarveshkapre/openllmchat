import dotenv from "dotenv";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import {
  createConversation,
  dbPath,
  getConversation,
  getMessages,
  insertMessages,
  listConversations
} from "./db.js";
import {
  bootstrapMemoryIfNeeded,
  buildContextBlock,
  getCompressedMemory,
  runMemoryAgent
} from "./memoryAgent.js";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const AGENTS = [
  {
    id: "agent-a",
    name: "Agent Atlas",
    style: "You are analytical, concrete, and strategic."
  },
  {
    id: "agent-b",
    name: "Agent Nova",
    style: "You are creative, precise, and challenge assumptions with examples."
  }
];

const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);
const client = hasOpenAI
  ? new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL || undefined
    })
  : null;

function getEngineLabel() {
  return hasOpenAI ? `OpenAI (${model})` : "Local fallback generator";
}

function localTurn(topic, transcript) {
  const recent = transcript.slice(-2).map((entry) => entry.text).join(" ");
  const seeds = [
    `Let us stay focused on ${topic}. A practical angle is to define one core objective and test it quickly.`,
    "Building on that, we should preserve context by carrying forward the prior point and tightening scope each turn.",
    "A relevant constraint is user experience: concise messages, clear sequencing, and consistent topic anchoring.",
    "A useful next move is to convert this into a lightweight loop where each reply references the previous claim.",
    "To keep relevance high, we can enforce a shared memory summary and include it in every generation step."
  ];

  const seed = seeds[transcript.length % seeds.length];
  const hook = recent
    ? `I agree with the recent point: \"${recent.slice(0, 100)}...\"`
    : "Opening thought:";

  return `${hook} ${seed}`;
}

async function generateTurn({ topic, speaker, transcript, memory }) {
  if (!client) {
    return localTurn(topic, transcript);
  }

  const prompt = buildContextBlock({
    topic,
    transcript,
    memory
  });

  const completion = await client.chat.completions.create({
    model,
    temperature: 0.7,
    messages: [
      {
        role: "system",
        content: [
          `You are ${speaker.name}.`,
          speaker.style,
          "Maintain continuity and avoid topic drift."
        ].join(" ")
      },
      {
        role: "user",
        content: prompt
      }
    ]
  });

  return completion.choices?.[0]?.message?.content?.trim() || localTurn(topic, transcript);
}

function parseTurns(rawTurns) {
  const requestedTurns = Number(rawTurns ?? 10);
  return Math.min(10, Math.max(2, Number.isFinite(requestedTurns) ? requestedTurns : 10));
}

async function resolveConversation(body) {
  const turns = parseTurns(body?.turns);
  const requestedTopic = String(body?.topic || "").trim();
  const requestedConversationId = String(body?.conversationId || "").trim();

  let conversation = null;
  if (requestedConversationId) {
    conversation = getConversation(requestedConversationId);
    if (!conversation) {
      return {
        error: "Conversation not found. Clear and start a new one.",
        status: 404
      };
    }
  }

  const topic = conversation?.topic || requestedTopic;
  if (!topic) {
    return {
      error: "Topic is required.",
      status: 400
    };
  }

  const conversationId = conversation?.id || randomUUID();
  if (!conversation) {
    createConversation(conversationId, topic);
  }

  const transcript = getMessages(conversationId);
  await bootstrapMemoryIfNeeded({
    conversationId,
    topic,
    transcript,
    client,
    model
  });

  const memory = getCompressedMemory(conversationId);

  return {
    conversationId,
    topic,
    transcript,
    turns,
    memory
  };
}

async function finalizeMemory(conversationId, topic, newEntries, totalTurns) {
  try {
    return await runMemoryAgent({
      conversationId,
      topic,
      newEntries,
      totalTurns,
      client,
      model
    });
  } catch (error) {
    console.error("Memory agent failed:", error);
    return getCompressedMemory(conversationId).stats;
  }
}

app.get("/api/conversation/:id", (req, res) => {
  const conversationId = String(req.params.id || "").trim();
  if (!conversationId) {
    return res.status(400).json({ error: "Conversation id is required." });
  }

  const conversation = getConversation(conversationId);
  if (!conversation) {
    return res.status(404).json({ error: "Conversation not found." });
  }

  const transcript = getMessages(conversationId);
  const memory = getCompressedMemory(conversationId);

  return res.json({
    conversationId,
    topic: conversation.topic,
    totalTurns: transcript.length,
    transcript,
    memory: memory.stats
  });
});

app.get("/api/conversation/:id/memory", (req, res) => {
  const conversationId = String(req.params.id || "").trim();
  if (!conversationId) {
    return res.status(400).json({ error: "Conversation id is required." });
  }

  const conversation = getConversation(conversationId);
  if (!conversation) {
    return res.status(404).json({ error: "Conversation not found." });
  }

  const memory = getCompressedMemory(conversationId);
  return res.json({
    conversationId,
    topic: conversation.topic,
    memory
  });
});

app.get("/api/conversations", (req, res) => {
  const requestedLimit = Number(req.query.limit ?? 20);
  const limit = Math.min(100, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 20));
  const conversations = listConversations(limit);
  return res.json({ conversations });
});

app.post("/api/conversation/stream", async (req, res) => {
  try {
    const setup = await resolveConversation(req.body);
    if (setup.error) {
      return res.status(setup.status).json({ error: setup.error });
    }

    const { conversationId, topic, transcript, turns, memory } = setup;
    const newEntries = [];

    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    if (typeof res.flushHeaders === "function") {
      res.flushHeaders();
    }

    const writeChunk = (payload) => {
      res.write(`${JSON.stringify(payload)}\n`);
    };

    writeChunk({
      type: "meta",
      conversationId,
      topic,
      engine: getEngineLabel(),
      memory: memory.stats
    });

    for (let i = 0; i < turns; i += 1) {
      const nextTurn = transcript.length + 1;
      const speaker = AGENTS[(nextTurn - 1) % AGENTS.length];
      const text = await generateTurn({
        topic,
        speaker,
        transcript,
        memory
      });

      const entry = {
        turn: nextTurn,
        speaker: speaker.name,
        speakerId: speaker.id,
        text
      };

      transcript.push(entry);
      newEntries.push(entry);
      writeChunk({ type: "turn", entry, totalTurns: transcript.length });
    }

    insertMessages(conversationId, newEntries);

    const memoryStats = await finalizeMemory(conversationId, topic, newEntries, transcript.length);
    writeChunk({
      type: "done",
      conversationId,
      topic,
      turns: newEntries.length,
      totalTurns: transcript.length,
      memory: memoryStats
    });
    res.end();
  } catch (error) {
    console.error(error);
    if (res.headersSent) {
      res.write(`${JSON.stringify({ type: "error", error: "Failed to generate conversation." })}\n`);
      return res.end();
    }

    return res.status(500).json({ error: "Failed to generate conversation." });
  }
});

app.post("/api/conversation", async (req, res) => {
  try {
    const setup = await resolveConversation(req.body);
    if (setup.error) {
      return res.status(setup.status).json({ error: setup.error });
    }

    const { conversationId, topic, transcript, turns, memory } = setup;
    const newEntries = [];

    for (let i = 0; i < turns; i += 1) {
      const nextTurn = transcript.length + 1;
      const speaker = AGENTS[(nextTurn - 1) % AGENTS.length];
      const text = await generateTurn({
        topic,
        speaker,
        transcript,
        memory
      });

      const entry = {
        turn: nextTurn,
        speaker: speaker.name,
        speakerId: speaker.id,
        text
      };

      transcript.push(entry);
      newEntries.push(entry);
    }

    insertMessages(conversationId, newEntries);
    const memoryStats = await finalizeMemory(conversationId, topic, newEntries, transcript.length);

    return res.json({
      conversationId,
      topic,
      turns: newEntries.length,
      totalTurns: transcript.length,
      engine: getEngineLabel(),
      transcript: newEntries,
      memory: memoryStats
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Failed to generate conversation." });
  }
});

app.listen(port, () => {
  console.log(`openllmchat running on http://localhost:${port}`);
  console.log(`SQLite database: ${dbPath}`);
});
