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
  getConversationAgents,
  getConversationBrief,
  getMessages,
  getMessagesUpToTurn,
  insertMessages,
  listConversations,
  updateConversationMeta,
  upsertConversationAgents,
  upsertConversationBrief
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

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data:",
      "connect-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'"
    ].join("; ")
  );
  next();
});
app.use(express.static(path.join(__dirname, "public")));

const DEFAULT_AGENTS = [
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

const DISCOVERY_MODE_SET = new Set(["exploration", "debate", "synthesis"]);
const DISCOVERY_MODE_HINTS = {
  exploration: "Mode: exploration. Generate novel hypotheses and testable experiments.",
  debate: "Mode: debate. Surface strongest pro/con arguments and identify the core crux.",
  synthesis: "Mode: synthesis. Converge on decisions, tradeoffs, and an executable action plan."
};

function readIntEnv(name, fallback, min, max) {
  const raw = Number(process.env[name]);
  const value = Number.isFinite(raw) ? raw : fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function readFloatEnv(name, fallback, min, max) {
  const raw = Number(process.env[name]);
  const value = Number.isFinite(raw) ? raw : fallback;
  return Math.max(min, Math.min(max, value));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

const MODERATOR_INTERVAL = readIntEnv("MODERATOR_INTERVAL", 6, 2, 20);
const MAX_GENERATION_MS = readIntEnv("MAX_GENERATION_MS", 30000, 3000, 120000);
const MAX_REPETITION_STREAK = readIntEnv("MAX_REPETITION_STREAK", 2, 1, 5);
const QUALITY_MIN_WORDS = readIntEnv("QUALITY_MIN_WORDS", 9, 4, 40);
const QUALITY_RETRY_LIMIT = readIntEnv("QUALITY_RETRY_LIMIT", 1, 0, 3);
const QUALITY_MAX_SIMILARITY = readFloatEnv("QUALITY_MAX_SIMILARITY", 0.9, 0.6, 0.98);
const QUALITY_MIN_TOPIC_COVERAGE = readFloatEnv("QUALITY_MIN_TOPIC_COVERAGE", 0.12, 0.02, 0.8);
const RATE_LIMIT_WINDOW_MS = readIntEnv("RATE_LIMIT_WINDOW_MS", 60000, 1000, 3600000);
const RATE_LIMIT_MAX_REQUESTS = readIntEnv("RATE_LIMIT_MAX_REQUESTS", 180, 20, 5000);
const GENERATION_LIMIT_MAX_REQUESTS = readIntEnv("GENERATION_LIMIT_MAX_REQUESTS", 36, 2, 500);

const apiRateState = new Map();
const generationRateState = new Map();

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

function getClientKey(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  const ip = forwarded || req.ip || req.socket?.remoteAddress || "unknown";
  return String(ip);
}

function applyRateLimit(req, res, next, stateMap, maxRequests, windowMs) {
  const key = getClientKey(req);
  const now = Date.now();
  const existing = stateMap.get(key);

  if (!existing || existing.resetAt <= now) {
    stateMap.set(key, {
      count: 1,
      resetAt: now + windowMs
    });
    return next();
  }

  existing.count += 1;
  stateMap.set(key, existing);

  if (existing.count <= maxRequests) {
    return next();
  }

  const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
  res.setHeader("Retry-After", String(retryAfterSeconds));
  return res.status(429).json({
    error: "Rate limit exceeded. Slow down and try again shortly.",
    retryAfterSeconds
  });
}

app.use("/api", (req, res, next) =>
  applyRateLimit(req, res, next, apiRateState, RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_MS)
);

app.use("/api", (req, res, next) => {
  if (req.method !== "POST") {
    return next();
  }

  if (!["/conversation", "/conversation/stream"].includes(req.path)) {
    return next();
  }

  return applyRateLimit(
    req,
    res,
    next,
    generationRateState,
    GENERATION_LIMIT_MAX_REQUESTS,
    RATE_LIMIT_WINDOW_MS
  );
});

function sanitizeTopic(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

function sanitizeConversationId(value) {
  const id = String(value || "").trim();
  if (!id || id.length > 80) {
    return "";
  }

  if (!/^[a-zA-Z0-9-]+$/.test(id)) {
    return "";
  }

  return id;
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

function wordCount(text) {
  return normalizeText(text).split(" ").filter(Boolean).length;
}

function getQualityKeywordSet(topic, brief) {
  const source = [topic, brief?.objective, brief?.constraintsText, brief?.doneCriteria]
    .filter(Boolean)
    .join(" ");
  const keywords = [...tokenSet(source)].filter((token) => token.length >= 4);
  return new Set(keywords.slice(0, 40));
}

function topicCoverageScore(text, keywordSet) {
  if (!keywordSet || keywordSet.size === 0) {
    return 1;
  }

  const words = tokenSet(text);
  if (!words.size) {
    return 0;
  }

  let overlap = 0;
  for (const keyword of keywordSet) {
    if (words.has(keyword)) {
      overlap += 1;
    }
  }

  const denominator = Math.max(1, Math.min(10, keywordSet.size));
  return Math.min(1, overlap / denominator);
}

function evaluateTurnQuality({ text, previousText, keywordSet }) {
  const words = wordCount(text);
  const similarity = previousText ? jaccardSimilarity(previousText, text) : 0;
  const topicCoverage = topicCoverageScore(text, keywordSet);

  const tooShort = words < QUALITY_MIN_WORDS;
  const repetitive = similarity > QUALITY_MAX_SIMILARITY;
  const offTopic = topicCoverage < QUALITY_MIN_TOPIC_COVERAGE;

  const score = Math.max(
    0,
    Math.min(
      1,
      1 - (tooShort ? 0.24 : 0) - (repetitive ? 0.36 : 0) - (offTopic ? 0.3 : 0) + topicCoverage * 0.2
    )
  );

  return {
    score: Number(score.toFixed(4)),
    wordCount: words,
    similarityToPrevious: Number(similarity.toFixed(4)),
    topicCoverage: Number(topicCoverage.toFixed(4)),
    tooShort,
    repetitive,
    offTopic,
    accepted: !tooShort && !repetitive && !offTopic
  };
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

function localTurn(topic, transcript, moderatorDirective, brief, mode = "exploration") {
  const recent = transcript.slice(-2).map((entry) => entry.text).join(" ");
  const guidance = moderatorDirective
    ? `Moderator guidance: ${moderatorDirective}.`
    : "Moderator guidance: stay on-topic and add one concrete move.";
  const objectiveHint = brief?.objective ? `Primary objective: ${brief.objective}.` : "";
  const modeHint = DISCOVERY_MODE_HINTS[mode] || DISCOVERY_MODE_HINTS.exploration;

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

  return `${hook} ${objectiveHint} ${modeHint} ${guidance} ${seed}`;
}

async function generateTurn({ topic, speaker, transcript, memory, moderatorDirective, brief, mode }) {
  if (!client) {
    return localTurn(topic, transcript, moderatorDirective, brief, mode);
  }

  const prompt = buildContextBlock({
    topic,
    transcript,
    memory,
    moderatorDirective,
    charter: DISCUSSION_CHARTER,
    brief
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
          DISCOVERY_MODE_HINTS[mode] || DISCOVERY_MODE_HINTS.exploration,
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

  return (
    completion.choices?.[0]?.message?.content?.trim() ||
    localTurn(topic, transcript, moderatorDirective, brief, mode)
  );
}

function parseTurns(rawTurns) {
  const requestedTurns = Number(rawTurns ?? 10);
  return Math.min(10, Math.max(2, Number.isFinite(requestedTurns) ? requestedTurns : 10));
}

function sanitizeBriefField(value, maxLen = 800) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

function parseBriefFromBody(body) {
  return {
    objective: sanitizeBriefField(body?.objective, 280),
    constraintsText: sanitizeBriefField(body?.constraintsText ?? body?.constraints, 500),
    doneCriteria: sanitizeBriefField(body?.doneCriteria, 320)
  };
}

function hasBriefPayload(body) {
  if (!body || typeof body !== "object") {
    return false;
  }

  return ["objective", "constraintsText", "constraints", "doneCriteria"].some((key) =>
    Object.prototype.hasOwnProperty.call(body, key)
  );
}

function mergeBriefPatch(currentBrief, body, parsedBrief) {
  return {
    objective: Object.prototype.hasOwnProperty.call(body, "objective")
      ? parsedBrief.objective
      : currentBrief.objective,
    constraintsText:
      Object.prototype.hasOwnProperty.call(body, "constraintsText") ||
      Object.prototype.hasOwnProperty.call(body, "constraints")
        ? parsedBrief.constraintsText
        : currentBrief.constraintsText,
    doneCriteria: Object.prototype.hasOwnProperty.call(body, "doneCriteria")
      ? parsedBrief.doneCriteria
      : currentBrief.doneCriteria
  };
}

function sanitizeConversationTitle(value, fallback = "") {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 96);
  return text || fallback;
}

function sanitizeConversationStarred(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }

  return fallback;
}

function sanitizeConversationMode(value, fallback = "exploration") {
  const mode = String(value || "")
    .trim()
    .toLowerCase();
  if (!mode) {
    return fallback;
  }

  return DISCOVERY_MODE_SET.has(mode) ? mode : fallback;
}

function hasConversationMetaPayload(body) {
  if (!body || typeof body !== "object") {
    return false;
  }

  return ["title", "starred", "mode"].some((key) => Object.prototype.hasOwnProperty.call(body, key));
}

function parseConversationMetaFromBody(body) {
  return {
    title: Object.prototype.hasOwnProperty.call(body || {}, "title")
      ? sanitizeConversationTitle(body.title, "")
      : undefined,
    starred: Object.prototype.hasOwnProperty.call(body || {}, "starred")
      ? sanitizeConversationStarred(body.starred, false)
      : undefined,
    mode: Object.prototype.hasOwnProperty.call(body || {}, "mode")
      ? sanitizeConversationMode(body.mode, "exploration")
      : undefined
  };
}

function mergeConversationMeta(currentConversation, body, parsedMeta) {
  return {
    title: Object.prototype.hasOwnProperty.call(body || {}, "title")
      ? parsedMeta.title
      : sanitizeConversationTitle(currentConversation?.title || "", ""),
    starred: Object.prototype.hasOwnProperty.call(body || {}, "starred")
      ? parsedMeta.starred
      : sanitizeConversationStarred(currentConversation?.starred, false),
    mode: Object.prototype.hasOwnProperty.call(body || {}, "mode")
      ? parsedMeta.mode
      : sanitizeConversationMode(currentConversation?.mode, "exploration")
  };
}

function sanitizeAgentName(value, fallback) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48);
  return text || fallback;
}

function sanitizeAgentStyle(value, fallback) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 320);
  return text || fallback;
}

function sanitizeAgentTemperature(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Number(clamp(number, 0, 1.2).toFixed(2));
}

function hasAgentPayload(body) {
  return Boolean(body && typeof body === "object" && Object.prototype.hasOwnProperty.call(body, "agents"));
}

function parseAgentConfigFromBody(body) {
  if (!Array.isArray(body?.agents)) {
    return [];
  }

  return body.agents
    .filter((agent) => agent && typeof agent === "object")
    .map((agent) => ({
      agentId: String(agent.agentId || agent.id || "").trim(),
      name: Object.prototype.hasOwnProperty.call(agent, "name")
        ? sanitizeAgentName(agent.name, "")
        : undefined,
      style: Object.prototype.hasOwnProperty.call(agent, "style")
        ? sanitizeAgentStyle(agent.style, "")
        : undefined,
      temperature: Object.prototype.hasOwnProperty.call(agent, "temperature")
        ? sanitizeAgentTemperature(agent.temperature, 0.6)
        : undefined
    }))
    .filter((agent) => agent.agentId === "agent-a" || agent.agentId === "agent-b");
}

function normalizeAgentRow(agentId, input) {
  const fallback = DEFAULT_AGENTS.find((item) => item.id === agentId);
  return {
    agentId,
    id: agentId,
    name: sanitizeAgentName(input?.name, fallback?.name || "Agent"),
    style: sanitizeAgentStyle(input?.style, fallback?.style || "Stay focused and useful."),
    temperature: sanitizeAgentTemperature(input?.temperature, fallback?.temperature || 0.6)
  };
}

function mapStoredAgents(stored) {
  const byId = new Map((stored || []).map((agent) => [agent.agentId, agent]));
  return DEFAULT_AGENTS.map((fallback) => normalizeAgentRow(fallback.id, byId.get(fallback.id)));
}

function mergeAgentConfig(existingAgents, incomingAgents) {
  if (!incomingAgents.length) {
    return existingAgents;
  }

  const incomingMap = new Map(incomingAgents.map((agent) => [agent.agentId, agent]));
  return existingAgents.map((current) => {
    const incoming = incomingMap.get(current.agentId);
    if (!incoming) {
      return normalizeAgentRow(current.agentId, current);
    }

    return normalizeAgentRow(current.agentId, {
      name: incoming.name ?? current.name,
      style: incoming.style ?? current.style,
      temperature: incoming.temperature ?? current.temperature
    });
  });
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

function localModeratorAssessment({ topic, transcript, brief, mode }) {
  const last = transcript[transcript.length - 1];
  const prev = transcript[transcript.length - 2];

  const repetitive = Boolean(prev && jaccardSimilarity(last?.text, prev?.text) > 0.88);
  const tooShort = (normalizeText(last?.text).split(" ").filter(Boolean).length || 0) < 8;
  const onTopic = normalizeText(last?.text).includes(normalizeText(topic).split(" ")[0] || "");
  const done = brief?.doneCriteria
    ? jaccardSimilarity(brief.doneCriteria, last?.text || "") >= 0.42
    : false;

  let directive =
    mode === "debate"
      ? "Strengthen the crux with one argument and one counterargument."
      : mode === "synthesis"
        ? "Converge on one decision with tradeoffs and the next step."
        : "Increase specificity with one concrete actionable point.";
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
    done,
    directive
  };
}

async function runModerator({ topic, transcript, memory, currentDirective, brief, mode }) {
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
    return localModeratorAssessment({ topic, transcript, brief, mode });
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
          `Objective: ${brief?.objective || "(none)"}`,
          `Constraints: ${brief?.constraintsText || "(none)"}`,
          `Done criteria: ${brief?.doneCriteria || "(none)"}`,
          `Conversation mode: ${mode}`,
          `Current directive: ${currentDirective || "(none)"}`,
          `Memory tokens: ${memoryTokens || "(none)"}`,
          "Recent conversation:",
          recent,
          "Rules:",
          "- onTopic=false if recent turns drift from topic.",
          "- repetitive=true if last turns repeat phrasing/claims.",
          "- tooShort=true if content lacks depth.",
          "- done=true only if objective appears complete.",
          "- directive must be one concise imperative sentence.",
          "- In debate mode emphasize strongest opposing arguments and crux.",
          "- In synthesis mode emphasize convergence and concrete next actions.",
          "- In exploration mode emphasize novel testable ideas."
        ].join("\n")
      }
    ]
  });

  const raw = response.choices?.[0]?.message?.content?.trim();
  const parsed = parseJsonObject(raw);

  if (!parsed || typeof parsed !== "object") {
    return localModeratorAssessment({ topic, transcript, brief, mode });
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
  const requestedTopic = sanitizeTopic(body?.topic);
  const requestedConversationId = sanitizeConversationId(body?.conversationId);
  const requestedBrief = parseBriefFromBody(body);
  const requestedAgents = parseAgentConfigFromBody(body);
  const requestedMeta = parseConversationMetaFromBody(body);
  const shouldUpdateBrief = hasBriefPayload(body);
  const shouldUpdateAgents = hasAgentPayload(body);
  const shouldUpdateMeta = hasConversationMetaPayload(body);

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
  const currentConversation = getConversation(conversationId);
  if (shouldUpdateMeta) {
    updateConversationMeta(
      conversationId,
      mergeConversationMeta(currentConversation, body, requestedMeta)
    );
  }
  const updatedConversation = getConversation(conversationId);

  const existingBrief = getConversationBrief(conversationId);
  if (shouldUpdateBrief) {
    upsertConversationBrief(conversationId, mergeBriefPatch(existingBrief, body, requestedBrief));
  }

  const brief = getConversationBrief(conversationId);
  const existingAgents = mapStoredAgents(getConversationAgents(conversationId));
  if (shouldUpdateAgents) {
    upsertConversationAgents(conversationId, mergeAgentConfig(existingAgents, requestedAgents));
  }
  const agents = mapStoredAgents(getConversationAgents(conversationId));

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
    title: updatedConversation?.title || "",
    starred: Boolean(updatedConversation?.starred),
    mode: sanitizeConversationMode(updatedConversation?.mode, "exploration"),
    brief,
    agents,
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
  mode,
  brief,
  agents,
  transcript,
  turns,
  memory,
  writeChunk
}) {
  const newEntries = [];
  const startedAt = Date.now();
  const qualityKeywordSet = getQualityKeywordSet(topic, brief);
  const modeDefaultDirective =
    mode === "debate"
      ? "Debate the strongest opposing positions and expose the crux."
      : mode === "synthesis"
        ? "Synthesize toward one decision with clear tradeoffs."
        : "Maintain topic depth and introduce one testable idea each turn.";
  let moderatorDirective = brief?.objective
    ? `Prioritize this objective: ${brief.objective}`
    : modeDefaultDirective;
  let stopReason = "max_turns";
  let repetitionStreak = 0;
  let retriesUsed = 0;
  let qualityScoreTotal = 0;
  let qualityTurns = 0;

  for (let i = 0; i < turns; i += 1) {
    if (Date.now() - startedAt > MAX_GENERATION_MS) {
      stopReason = "time_limit";
      break;
    }

    const nextTurn = transcript.length + 1;
    const activeAgents = agents && agents.length ? agents : DEFAULT_AGENTS;
    const speaker = activeAgents[(nextTurn - 1) % activeAgents.length];
    const previous = transcript[transcript.length - 1];

    let entry = null;
    let signaledDone = false;
    let quality = null;
    let attempts = 0;
    let accepted = false;

    while (attempts <= QUALITY_RETRY_LIMIT) {
      const attemptDirective =
        attempts === 0
          ? moderatorDirective
          : `${moderatorDirective} Quality retry: improve specificity, stay on-topic, avoid repetition, and be at least ${QUALITY_MIN_WORDS} words.`;

      const generated = await generateTurn({
        topic,
        mode,
        speaker,
        transcript,
        memory,
        moderatorDirective: attemptDirective,
        brief
      });

      signaledDone = containsDoneToken(generated);
      const text = stripDonePrefix(generated);
      entry = {
        turn: nextTurn,
        speaker: speaker.name,
        speakerId: speaker.id,
        text: text || generated
      };

      quality = evaluateTurnQuality({
        text: entry.text,
        previousText: previous?.text,
        keywordSet: qualityKeywordSet
      });
      attempts += 1;

      if (quality.accepted || attempts > QUALITY_RETRY_LIMIT) {
        accepted = quality.accepted;
        break;
      }

      if (writeChunk) {
        writeChunk({
          type: "retry",
          turn: nextTurn,
          attempt: attempts,
          reason: quality.tooShort
            ? "too_short"
            : quality.repetitive
              ? "repetitive"
              : "off_topic",
          quality
        });
      }
    }

    qualityScoreTotal += quality?.score ?? 0;
    qualityTurns += 1;
    retriesUsed += Math.max(0, attempts - 1);
    repetitionStreak = quality?.repetitive ? repetitionStreak + 1 : 0;

    transcript.push(entry);
    newEntries.push(entry);

    if (writeChunk) {
      writeChunk({
        type: "turn",
        entry,
        totalTurns: transcript.length,
        quality: {
          ...quality,
          attempts,
          accepted,
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
        mode,
        brief,
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
    memoryStats,
    qualitySummary: {
      avgScore: Number((qualityTurns ? qualityScoreTotal / qualityTurns : 0).toFixed(4)),
      retriesUsed,
      turnsEvaluated: qualityTurns
    }
  };
}

app.get("/api/conversation/:id", (req, res) => {
  const conversationId = sanitizeConversationId(req.params.id);
  if (!conversationId) {
    return res.status(400).json({ error: "Conversation id is required." });
  }

  const conversation = getConversation(conversationId);
  if (!conversation) {
    return res.status(404).json({ error: "Conversation not found." });
  }

  const transcript = getMessages(conversationId);
  const memory = getCompressedMemory(conversationId);
  const brief = getConversationBrief(conversationId);
  const agents = mapStoredAgents(getConversationAgents(conversationId));

  return res.json({
    conversationId,
    topic: conversation.topic,
    title: conversation.title || "",
    starred: Boolean(conversation.starred),
    mode: sanitizeConversationMode(conversation.mode, "exploration"),
    parentConversationId: conversation.parentConversationId || null,
    forkFromTurn: Number.isFinite(conversation.forkFromTurn) ? conversation.forkFromTurn : null,
    brief,
    agents,
    totalTurns: transcript.length,
    transcript,
    memory: memory.stats
  });
});

app.post("/api/conversation/:id/fork", async (req, res) => {
  try {
    const sourceConversationId = sanitizeConversationId(req.params.id);
    if (!sourceConversationId) {
      return res.status(400).json({ error: "Conversation id is required." });
    }

    const sourceConversation = getConversation(sourceConversationId);
    if (!sourceConversation) {
      return res.status(404).json({ error: "Conversation not found." });
    }

    const allSourceMessages = getMessages(sourceConversationId);
    const maxTurn = allSourceMessages.length;
    const requestedTurn = Number(req.body?.turn);
    const forkFromTurn = Number.isFinite(requestedTurn)
      ? Math.max(0, Math.min(maxTurn, Math.trunc(requestedTurn)))
      : maxTurn;

    const forkConversationId = randomUUID();
    createConversation(forkConversationId, sourceConversation.topic, {
      parentConversationId: sourceConversationId,
      forkFromTurn
    });
    const sourceTitle = sanitizeConversationTitle(sourceConversation.title, sourceConversation.topic);
    const forkTitle = sanitizeConversationTitle(`${sourceTitle} (Fork)`, sourceConversation.topic);
    updateConversationMeta(forkConversationId, {
      title: forkTitle,
      starred: false,
      mode: sanitizeConversationMode(sourceConversation.mode, "exploration")
    });
    const forkConversation = getConversation(forkConversationId);

    const sourceBrief = getConversationBrief(sourceConversationId);
    upsertConversationBrief(forkConversationId, sourceBrief);
    const sourceStoredAgents = getConversationAgents(sourceConversationId);
    const sourceAgents = mapStoredAgents(sourceStoredAgents);
    if (sourceStoredAgents.length > 0) {
      upsertConversationAgents(forkConversationId, sourceAgents);
    }

    const forkTranscript =
      forkFromTurn > 0
        ? getMessagesUpToTurn(sourceConversationId, forkFromTurn).map((entry) => ({
            turn: entry.turn,
            speaker: entry.speaker,
            speakerId: entry.speakerId,
            text: entry.text
          }))
        : [];

    insertMessages(forkConversationId, forkTranscript);

    await bootstrapMemoryIfNeeded({
      conversationId: forkConversationId,
      topic: sourceConversation.topic,
      transcript: forkTranscript,
      client,
      model
    });
    const memory = getCompressedMemory(forkConversationId);

    return res.json({
      conversationId: forkConversationId,
      topic: sourceConversation.topic,
      title: forkConversation?.title || forkTitle,
      starred: Boolean(forkConversation?.starred),
      mode: sanitizeConversationMode(forkConversation?.mode, "exploration"),
      brief: sourceBrief,
      agents: sourceAgents,
      parentConversationId: sourceConversationId,
      forkFromTurn,
      totalTurns: forkTranscript.length,
      transcript: forkTranscript,
      memory: memory.stats
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Failed to fork conversation." });
  }
});

app.get("/api/conversation/:id/brief", (req, res) => {
  const conversationId = sanitizeConversationId(req.params.id);
  if (!conversationId) {
    return res.status(400).json({ error: "Conversation id is required." });
  }

  const conversation = getConversation(conversationId);
  if (!conversation) {
    return res.status(404).json({ error: "Conversation not found." });
  }

  return res.json({
    conversationId,
    topic: conversation.topic,
    title: conversation.title || "",
    starred: Boolean(conversation.starred),
    mode: sanitizeConversationMode(conversation.mode, "exploration"),
    brief: getConversationBrief(conversationId)
  });
});

app.get("/api/conversation/:id/agents", (req, res) => {
  const conversationId = sanitizeConversationId(req.params.id);
  if (!conversationId) {
    return res.status(400).json({ error: "Conversation id is required." });
  }

  const conversation = getConversation(conversationId);
  if (!conversation) {
    return res.status(404).json({ error: "Conversation not found." });
  }

  return res.json({
    conversationId,
    topic: conversation.topic,
    title: conversation.title || "",
    starred: Boolean(conversation.starred),
    mode: sanitizeConversationMode(conversation.mode, "exploration"),
    agents: mapStoredAgents(getConversationAgents(conversationId))
  });
});

app.post("/api/conversation/:id/agents", (req, res) => {
  const conversationId = sanitizeConversationId(req.params.id);
  if (!conversationId) {
    return res.status(400).json({ error: "Conversation id is required." });
  }

  const conversation = getConversation(conversationId);
  if (!conversation) {
    return res.status(404).json({ error: "Conversation not found." });
  }

  const currentAgents = mapStoredAgents(getConversationAgents(conversationId));
  const incomingAgents = parseAgentConfigFromBody(req.body);
  upsertConversationAgents(conversationId, mergeAgentConfig(currentAgents, incomingAgents));

  return res.json({
    conversationId,
    topic: conversation.topic,
    title: conversation.title || "",
    starred: Boolean(conversation.starred),
    mode: sanitizeConversationMode(conversation.mode, "exploration"),
    agents: mapStoredAgents(getConversationAgents(conversationId))
  });
});

app.post("/api/conversation/:id/meta", (req, res) => {
  const conversationId = sanitizeConversationId(req.params.id);
  if (!conversationId) {
    return res.status(400).json({ error: "Conversation id is required." });
  }

  const conversation = getConversation(conversationId);
  if (!conversation) {
    return res.status(404).json({ error: "Conversation not found." });
  }

  const parsedMeta = parseConversationMetaFromBody(req.body);
  const mergedMeta = mergeConversationMeta(conversation, req.body || {}, parsedMeta);
  updateConversationMeta(conversationId, mergedMeta);
  const updatedConversation = getConversation(conversationId);

  return res.json({
    conversationId,
    topic: updatedConversation.topic,
    title: updatedConversation.title || "",
    starred: Boolean(updatedConversation.starred),
    mode: sanitizeConversationMode(updatedConversation.mode, "exploration")
  });
});

app.post("/api/conversation/:id/brief", (req, res) => {
  const conversationId = sanitizeConversationId(req.params.id);
  if (!conversationId) {
    return res.status(400).json({ error: "Conversation id is required." });
  }

  const conversation = getConversation(conversationId);
  if (!conversation) {
    return res.status(404).json({ error: "Conversation not found." });
  }

  const currentBrief = getConversationBrief(conversationId);
  const parsedBrief = parseBriefFromBody(req.body);
  const mergedBrief = mergeBriefPatch(currentBrief, req.body || {}, parsedBrief);
  upsertConversationBrief(conversationId, mergedBrief);

  return res.json({
    conversationId,
    topic: conversation.topic,
    title: conversation.title || "",
    starred: Boolean(conversation.starred),
    mode: sanitizeConversationMode(conversation.mode, "exploration"),
    brief: getConversationBrief(conversationId)
  });
});

app.get("/api/conversation/:id/memory", (req, res) => {
  const conversationId = sanitizeConversationId(req.params.id);
  if (!conversationId) {
    return res.status(400).json({ error: "Conversation id is required." });
  }

  const conversation = getConversation(conversationId);
  if (!conversation) {
    return res.status(404).json({ error: "Conversation not found." });
  }

  const memory = getCompressedMemory(conversationId);
  const brief = getConversationBrief(conversationId);
  const agents = mapStoredAgents(getConversationAgents(conversationId));
  return res.json({
    conversationId,
    topic: conversation.topic,
    title: conversation.title || "",
    starred: Boolean(conversation.starred),
    mode: sanitizeConversationMode(conversation.mode, "exploration"),
    brief,
    agents,
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

    const { conversationId, topic, title, starred, mode, brief, agents, transcript, turns, memory } = setup;

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
      title,
      starred,
      mode,
      brief,
      agents,
      engine: getEngineLabel(),
      memory: memory.stats,
      charter: DISCUSSION_CHARTER,
      guardrails: {
        moderatorInterval: MODERATOR_INTERVAL,
        maxGenerationMs: MAX_GENERATION_MS,
        maxRepetitionStreak: MAX_REPETITION_STREAK,
        quality: {
          minWords: QUALITY_MIN_WORDS,
          maxSimilarity: QUALITY_MAX_SIMILARITY,
          minTopicCoverage: QUALITY_MIN_TOPIC_COVERAGE,
          retryLimit: QUALITY_RETRY_LIMIT
        }
      }
    });

    const batch = await runConversationBatch({
      conversationId,
      topic,
      mode,
      brief,
      agents,
      transcript,
      turns,
      memory,
      writeChunk
    });

    writeChunk({
      type: "done",
      conversationId,
      topic,
      title,
      starred,
      mode,
      brief,
      agents,
      turns: batch.newEntries.length,
      totalTurns: batch.totalTurns,
      stopReason: batch.stopReason,
      memory: batch.memoryStats,
      quality: batch.qualitySummary
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

    const { conversationId, topic, title, starred, mode, brief, agents, transcript, turns, memory } = setup;
    const batch = await runConversationBatch({
      conversationId,
      topic,
      mode,
      brief,
      agents,
      transcript,
      turns,
      memory
    });

    return res.json({
      conversationId,
      topic,
      title,
      starred,
      mode,
      brief,
      agents,
      turns: batch.newEntries.length,
      totalTurns: batch.totalTurns,
      stopReason: batch.stopReason,
      engine: getEngineLabel(),
      transcript: batch.newEntries,
      memory: batch.memoryStats,
      quality: batch.qualitySummary
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
