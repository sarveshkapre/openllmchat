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
    style: "You are analytical, concrete, and strategic.",
    temperature: 0.45
  },
  {
    id: "agent-b",
    name: "Agent Nova",
    style: "You are creative, precise, and challenge assumptions with examples.",
    temperature: 0.72
  }
];

const DISCUSSION_CHARTER = [
  "Stay strictly on the assigned topic and objective.",
  "If drifting, explicitly steer back to the topic.",
  "Ask clarifying questions rather than changing topics.",
  "Avoid repetitive phrasing and low-information filler.",
  "Focus on claims, constraints, decisions, and unresolved questions."
];

function readIntEnv(name, fallback, min, max) {
  const raw = Number(process.env[name]);
  const value = Number.isFinite(raw) ? raw : fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

const MODERATOR_INTERVAL = readIntEnv("MODERATOR_INTERVAL", 6, 2, 20);
const MAX_GENERATION_MS = readIntEnv("MAX_GENERATION_MS", 30000, 3000, 120000);
const MAX_REPETITION_STREAK = readIntEnv("MAX_REPETITION_STREAK", 2, 1, 5);

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

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(text) {
  const tokens = normalizeText(text)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 2);
  return new Set(tokens);
}

function jaccardSimilarity(a, b) {
  if (!a || !b) {
    return 0;
  }

  const setA = tokenSet(a);
  const setB = tokenSet(b);
  if (!setA.size || !setB.size) {
    return 0;
  }

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) {
      intersection += 1;
    }
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function containsDoneToken(text) {
  return /\bDONE\b\s*:/i.test(text) || /^\s*DONE\b/i.test(text);
}

function stripDonePrefix(text) {
  return String(text || "")
    .replace(/^\s*DONE\b\s*:?-?\s*/i, "")
    .trim();
}

function localTurn(topic, transcript, moderatorDirective) {
  const recent = transcript.slice(-2).map((entry) => entry.text).join(" ");
  const guidance = moderatorDirective
    ? `Moderator guidance: ${moderatorDirective}.`
    : "Moderator guidance: stay on-topic and add one concrete move.";

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

  return `${hook} ${guidance} ${seed}`;
}

async function generateTurn({ topic, speaker, transcript, memory, moderatorDirective }) {
  if (!client) {
    return localTurn(topic, transcript, moderatorDirective);
  }

  const prompt = buildContextBlock({
    topic,
    transcript,
    memory,
    moderatorDirective,
    charter: DISCUSSION_CHARTER
  });

  const completion = await client.chat.completions.create({
    model,
    temperature: speaker.temperature,
    messages: [
      {
        role: "system",
        content: [
          `You are ${speaker.name}.`,
          speaker.style,
          "Maintain continuity and avoid topic drift.",
          "Write only substantive content, no meta-commentary."
        ].join(" ")
      },
      {
        role: "user",
        content: prompt
      }
    ]
  });

  return completion.choices?.[0]?.message?.content?.trim() || localTurn(topic, transcript, moderatorDirective);
}

function parseTurns(rawTurns) {
  const requestedTurns = Number(rawTurns ?? 10);
  return Math.min(10, Math.max(2, Number.isFinite(requestedTurns) ? requestedTurns : 10));
}

function parseJsonObject(text) {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    const match = String(text).match(/\{[\s\S]*\}/);
    if (!match) {
      return null;
    }

    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function localModeratorAssessment({ topic, transcript }) {
  const last = transcript[transcript.length - 1];
  const prev = transcript[transcript.length - 2];

  const repetitive = Boolean(prev && jaccardSimilarity(last?.text, prev?.text) > 0.88);
  const tooShort = (normalizeText(last?.text).split(" ").filter(Boolean).length || 0) < 8;
  const onTopic = normalizeText(last?.text).includes(normalizeText(topic).split(" ")[0] || "");

  let directive = "Increase specificity with one concrete actionable point.";
  if (!onTopic) {
    directive = `Steer back to topic: ${topic}.`;
  } else if (repetitive) {
    directive = "Avoid repeating prior wording; add a counterpoint or new evidence.";
  } else if (tooShort) {
    directive = "Add depth: include one rationale and one practical implication.";
  }

  return {
    onTopic,
    repetitive,
    tooShort,
    done: false,
    directive
  };
}

async function runModerator({ topic, transcript, memory, currentDirective }) {
  if (transcript.length < 2) {
    return {
      onTopic: true,
      repetitive: false,
      tooShort: false,
      done: false,
      directive: currentDirective || "Continue discussion with concrete progress."
    };
  }

  if (!client) {
    return localModeratorAssessment({ topic, transcript });
  }

  const recent = transcript
    .slice(-8)
    .map((entry) => `Turn ${entry.turn} | ${entry.speaker}: ${entry.text}`)
    .join("\n");

  const memoryTokens = (memory.tokens || [])
    .slice(0, 20)
    .map((item) => item.token)
    .join(", ");

  const response = await client.chat.completions.create({
    model,
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "You are a strict conversation moderator. Return JSON only with keys: onTopic, repetitive, tooShort, done, directive."
      },
      {
        role: "user",
        content: [
          `Topic: ${topic}`,
          `Current directive: ${currentDirective || "(none)"}`,
          `Memory tokens: ${memoryTokens || "(none)"}`,
          "Recent conversation:",
          recent,
          "Rules:",
          "- onTopic=false if recent turns drift from topic.",
          "- repetitive=true if last turns repeat phrasing/claims.",
          "- tooShort=true if content lacks depth.",
          "- done=true only if objective appears complete.",
          "- directive must be one concise imperative sentence."
        ].join("\n")
      }
    ]
  });

  const raw = response.choices?.[0]?.message?.content?.trim();
  const parsed = parseJsonObject(raw);

  if (!parsed || typeof parsed !== "object") {
    return localModeratorAssessment({ topic, transcript });
  }

  return {
    onTopic: Boolean(parsed.onTopic),
    repetitive: Boolean(parsed.repetitive),
    tooShort: Boolean(parsed.tooShort),
    done: Boolean(parsed.done),
    directive: String(parsed.directive || "Stay on-topic and add one concrete next step.").slice(0, 280)
  };
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

async function runConversationBatch({
  conversationId,
  topic,
  transcript,
  turns,
  memory,
  writeChunk
}) {
  const newEntries = [];
  const startedAt = Date.now();
  let moderatorDirective = "Maintain topic depth and avoid repetition.";
  let stopReason = "max_turns";
  let repetitionStreak = 0;

  for (let i = 0; i < turns; i += 1) {
    if (Date.now() - startedAt > MAX_GENERATION_MS) {
      stopReason = "time_limit";
      break;
    }

    const nextTurn = transcript.length + 1;
    const speaker = AGENTS[(nextTurn - 1) % AGENTS.length];
    const generated = await generateTurn({
      topic,
      speaker,
      transcript,
      memory,
      moderatorDirective
    });

    const signaledDone = containsDoneToken(generated);
    const text = stripDonePrefix(generated);

    const entry = {
      turn: nextTurn,
      speaker: speaker.name,
      speakerId: speaker.id,
      text: text || generated
    };

    const previous = transcript[transcript.length - 1];
    const similarity = previous ? jaccardSimilarity(previous.text, entry.text) : 0;
    repetitionStreak = similarity >= 0.9 ? repetitionStreak + 1 : 0;

    transcript.push(entry);
    newEntries.push(entry);

    if (writeChunk) {
      writeChunk({
        type: "turn",
        entry,
        totalTurns: transcript.length,
        quality: {
          similarityToPrevious: Number(similarity.toFixed(4)),
          repetitionStreak
        }
      });
    }

    if (repetitionStreak >= MAX_REPETITION_STREAK) {
      stopReason = "repetition_guard";
      break;
    }

    if (signaledDone) {
      stopReason = "done_token";
      break;
    }

    const shouldModerate = transcript.length % MODERATOR_INTERVAL === 0;
    if (shouldModerate) {
      const moderation = await runModerator({
        topic,
        transcript,
        memory,
        currentDirective: moderatorDirective
      });

      moderatorDirective = moderation.directive || moderatorDirective;

      if (writeChunk) {
        writeChunk({ type: "moderator", moderation, totalTurns: transcript.length });
      }

      if (moderation.done) {
        stopReason = "moderator_done";
        break;
      }
    }
  }

  insertMessages(conversationId, newEntries);
  const memoryStats = await finalizeMemory(conversationId, topic, newEntries, transcript.length);

  return {
    newEntries,
    totalTurns: transcript.length,
    stopReason,
    moderatorDirective,
    memoryStats
  };
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
      memory: memory.stats,
      charter: DISCUSSION_CHARTER,
      guardrails: {
        moderatorInterval: MODERATOR_INTERVAL,
        maxGenerationMs: MAX_GENERATION_MS,
        maxRepetitionStreak: MAX_REPETITION_STREAK
      }
    });

    const batch = await runConversationBatch({
      conversationId,
      topic,
      transcript,
      turns,
      memory,
      writeChunk
    });

    writeChunk({
      type: "done",
      conversationId,
      topic,
      turns: batch.newEntries.length,
      totalTurns: batch.totalTurns,
      stopReason: batch.stopReason,
      memory: batch.memoryStats
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
    const batch = await runConversationBatch({
      conversationId,
      topic,
      transcript,
      turns,
      memory
    });

    return res.json({
      conversationId,
      topic,
      turns: batch.newEntries.length,
      totalTurns: batch.totalTurns,
      stopReason: batch.stopReason,
      engine: getEngineLabel(),
      transcript: batch.newEntries,
      memory: batch.memoryStats
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
