import dotenv from "dotenv";
import express from "express";
import next from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, timingSafeEqual } from "node:crypto";
import OpenAI from "openai";
import {
  clearConversations,
  createConversation,
  dbPath,
  deleteConversation,
  getConversation,
  getConversationAgents,
  getConversationBrief,
  getRecentClaimCitations,
  getRecentRetrievalSources,
  getMessages,
  getMessagesUpToTurn,
  insertClaimCitations,
  insertMessages,
  listConversations,
  updateConversationMeta,
  upsertRetrievalSources,
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
const isDev = process.env.NODE_ENV !== "production";
const nextApp = next({ dev: isDev, dir: __dirname });
const nextHandler = nextApp.getRequestHandler();

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
      isDev ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'" : "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data:",
      "connect-src 'self' ws: wss:",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'"
    ].join("; ")
  );
  next();
});

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
const DISCOVERY_LAB_MODES = ["exploration", "debate", "synthesis"];
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

function readBoolEnv(name, fallback = false) {
  const raw = String(process.env[name] || "").trim().toLowerCase();
  if (!raw) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(raw);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeOrigin(origin) {
  try {
    const url = new URL(String(origin || "").trim());
    return `${url.protocol}//${url.host}`;
  } catch {
    return "";
  }
}

const MODERATOR_INTERVAL = readIntEnv("MODERATOR_INTERVAL", 6, 2, 20);
const MAX_GENERATION_MS = readIntEnv("MAX_GENERATION_MS", 30000, 3000, 120000);
const MAX_REPETITION_STREAK = readIntEnv("MAX_REPETITION_STREAK", 2, 1, 5);
const QUALITY_MIN_WORDS = readIntEnv("QUALITY_MIN_WORDS", 9, 4, 40);
const QUALITY_RETRY_LIMIT = readIntEnv("QUALITY_RETRY_LIMIT", 1, 0, 3);
const QUALITY_MAX_SIMILARITY = readFloatEnv("QUALITY_MAX_SIMILARITY", 0.9, 0.6, 0.98);
const QUALITY_MIN_TOPIC_COVERAGE = readFloatEnv("QUALITY_MIN_TOPIC_COVERAGE", 0.12, 0.02, 0.8);
const EVALUATOR_LOOP_ENABLED = readBoolEnv("EVALUATOR_LOOP_ENABLED", true);
const EVALUATOR_RETRY_LIMIT = readIntEnv("EVALUATOR_RETRY_LIMIT", 1, 0, 3);
const EVALUATOR_MIN_OVERALL = readFloatEnv("EVALUATOR_MIN_OVERALL", 0.56, 0.2, 0.9);
const EVALUATOR_MIN_NOVELTY = readFloatEnv("EVALUATOR_MIN_NOVELTY", 0.22, 0.05, 0.9);
const EVALUATOR_MIN_COHERENCE = readFloatEnv("EVALUATOR_MIN_COHERENCE", 0.26, 0.05, 0.95);
const EVALUATOR_MIN_EVIDENCE = readFloatEnv("EVALUATOR_MIN_EVIDENCE", 0.24, 0.05, 0.95);
const CITATION_RETRIEVAL_ENABLED = readBoolEnv("CITATION_RETRIEVAL_ENABLED", true);
const CITATION_MAX_REFERENCES = readIntEnv("CITATION_MAX_REFERENCES", 4, 1, 8);
const CITATION_REFRESH_INTERVAL = readIntEnv("CITATION_REFRESH_INTERVAL", 3, 1, 10);
const CITATION_TIMEOUT_MS = readIntEnv("CITATION_TIMEOUT_MS", 4500, 1000, 20000);
const CITATION_MIN_REFERENCE_CONFIDENCE = readFloatEnv("CITATION_MIN_REFERENCE_CONFIDENCE", 0.18, 0, 0.95);
const MAX_TURN_CHARS = readIntEnv("MAX_TURN_CHARS", 1400, 300, 8000);
const RATE_LIMIT_WINDOW_MS = readIntEnv("RATE_LIMIT_WINDOW_MS", 60000, 1000, 3600000);
const RATE_LIMIT_MAX_REQUESTS = readIntEnv("RATE_LIMIT_MAX_REQUESTS", 180, 20, 5000);
const GENERATION_LIMIT_MAX_REQUESTS = readIntEnv("GENERATION_LIMIT_MAX_REQUESTS", 36, 2, 500);
const RATE_LIMIT_MAX_KEYS = readIntEnv("RATE_LIMIT_MAX_KEYS", 12000, 2000, 200000);
const LAB_DEFAULT_TURNS = readIntEnv("LAB_DEFAULT_TURNS", 6, 2, 10);
const TRUST_PROXY = readBoolEnv("TRUST_PROXY", false);
const CSRF_PROTECTION = readBoolEnv("CSRF_PROTECTION", true);
const APP_ORIGIN = normalizeOrigin(process.env.APP_ORIGIN || "");
const CSRF_ALLOWED_ORIGINS = new Set(
  String(process.env.CSRF_ALLOWED_ORIGINS || "")
    .split(",")
    .map((item) => normalizeOrigin(item))
    .filter(Boolean)
);
const API_WRITE_TOKEN = String(process.env.API_WRITE_TOKEN || "").trim();

const apiRateState = new Map();
const generationRateState = new Map();
let rateSweepTick = 0;
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

app.set("trust proxy", TRUST_PROXY);

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
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  return String(ip);
}

function isWriteMethod(method) {
  return WRITE_METHODS.has(String(method || "").toUpperCase());
}

function extractBearerToken(authHeader) {
  const raw = String(authHeader || "").trim();
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? String(match[1] || "").trim() : "";
}

function constantTimeMatch(input, expected) {
  if (!input || !expected) {
    return false;
  }

  const left = Buffer.from(String(input));
  const right = Buffer.from(String(expected));
  if (left.length !== right.length) {
    return false;
  }

  return timingSafeEqual(left, right);
}

function sweepRateLimitState(stateMap, now, maxKeys) {
  if (stateMap.size === 0) {
    return;
  }

  for (const [key, value] of stateMap.entries()) {
    if (!value || value.resetAt <= now) {
      stateMap.delete(key);
    }
  }

  if (stateMap.size <= maxKeys) {
    return;
  }

  const overflow = stateMap.size - maxKeys;
  const victims = [...stateMap.entries()]
    .sort((a, b) => Number(a?.[1]?.resetAt || 0) - Number(b?.[1]?.resetAt || 0))
    .slice(0, overflow);

  for (const [key] of victims) {
    stateMap.delete(key);
  }
}

function applyRateLimit(req, res, next, stateMap, maxRequests, windowMs) {
  const key = getClientKey(req);
  const now = Date.now();
  rateSweepTick = (rateSweepTick + 1) % 1024;
  if (rateSweepTick % 64 === 0 || stateMap.size > RATE_LIMIT_MAX_KEYS) {
    sweepRateLimitState(stateMap, now, RATE_LIMIT_MAX_KEYS);
  }
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
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  next();
});

app.use("/api", (req, res, next) => {
  if (!CSRF_PROTECTION || !isWriteMethod(req.method)) {
    return next();
  }

  const origin = String(req.headers.origin || "").trim();
  if (!origin) {
    return next();
  }

  const normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedOrigin) {
    return res.status(403).json({ error: "Blocked request origin." });
  }

  const requestOrigin = APP_ORIGIN || normalizeOrigin(`${req.protocol}://${req.get("host") || ""}`);
  if (requestOrigin && (normalizedOrigin === requestOrigin || CSRF_ALLOWED_ORIGINS.has(normalizedOrigin))) {
    return next();
  }

  return res.status(403).json({ error: "Cross-origin write request denied." });
});

app.use("/api", (req, res, next) => {
  if (!API_WRITE_TOKEN || !isWriteMethod(req.method)) {
    return next();
  }

  const bearerToken = extractBearerToken(req.headers.authorization);
  const headerToken = String(req.headers["x-api-key"] || "").trim();
  const providedToken = bearerToken || headerToken;
  if (constantTimeMatch(providedToken, API_WRITE_TOKEN)) {
    return next();
  }

  res.setHeader("WWW-Authenticate", 'Bearer realm="openllmchat-write-api"');
  return res.status(401).json({ error: "Unauthorized write request." });
});

app.use("/api", (req, res, next) => {
  if (req.method !== "POST") {
    return next();
  }

  if (!["/conversation", "/conversation/stream", "/conversation/lab"].includes(req.path)) {
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

function normalizeTurnText(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_TURN_CHARS) {
    return normalized;
  }

  const keep = Math.max(1, MAX_TURN_CHARS - 3);
  return `${normalized.slice(0, keep).trimEnd()}...`;
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

function sentenceCount(text) {
  return String(text || "")
    .split(/(?<=[.!?])\s+/)
    .map((line) => line.trim())
    .filter(Boolean).length;
}

function claimLikeSentenceCount(text) {
  const sentences = String(text || "")
    .split(/(?<=[.!?])\s+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!sentences.length) {
    return 0;
  }

  return sentences.filter((sentence) => {
    if (sentence.length < 24) {
      return false;
    }
    const lower = sentence.toLowerCase();
    return /\b(is|are|was|were|has|have|shows|indicates|proves|demonstrates|according)\b/.test(lower);
  }).length;
}

function extractCitationIds(text) {
  const matches = [...String(text || "").matchAll(/\[(R\d+)\]/gi)];
  return [...new Set(matches.map((item) => String(item?.[1] || "").toUpperCase()).filter(Boolean))];
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

function evaluateEvidenceQuality({ text, mode, referenceMap }) {
  if (mode !== "debate") {
    return {
      score: 1,
      citationCount: 0,
      claimSentences: claimLikeSentenceCount(text),
      citedReferenceCount: 0
    };
  }

  if (!referenceMap || referenceMap.size === 0) {
    return {
      score: 0.55,
      citationCount: 0,
      claimSentences: claimLikeSentenceCount(text),
      citedReferenceCount: 0
    };
  }

  const citations = extractCitationIds(text);
  const claimSentences = claimLikeSentenceCount(text);
  let confidenceSum = 0;
  let confidenceCount = 0;

  for (const citationId of citations) {
    const reference = referenceMap?.get(citationId);
    if (!reference) {
      continue;
    }
    confidenceSum += Number(reference.confidence || 0);
    confidenceCount += 1;
  }

  const citationCoverage =
    claimSentences > 0 ? Math.min(1, citations.length / claimSentences) : citations.length > 0 ? 0.65 : 0;
  const sourceConfidence = confidenceCount > 0 ? confidenceSum / confidenceCount : 0;
  const score = clamp(citationCoverage * 0.62 + sourceConfidence * 0.38, 0, 1);

  return {
    score: Number(score.toFixed(4)),
    citationCount: citations.length,
    claimSentences,
    citedReferenceCount: confidenceCount
  };
}

function chooseCorrectionDirective({ novelty, coherence, nonRepetition, evidenceQuality, mode }) {
  const metrics = [
    { key: "novelty", value: novelty },
    { key: "coherence", value: coherence },
    { key: "non_repetition", value: nonRepetition },
    { key: "evidence_quality", value: evidenceQuality }
  ].sort((a, b) => a.value - b.value);
  const weakest = metrics[0]?.key || "coherence";

  if (weakest === "novelty") {
    return "Add one genuinely new angle, test, or counterfactual not present in recent turns.";
  }

  if (weakest === "non_repetition") {
    return "Avoid repeating prior wording; introduce one distinct claim and one concrete implication.";
  }

  if (weakest === "evidence_quality") {
    return mode === "debate"
      ? "Back factual claims with [R#] citations and state uncertainty when evidence is weak."
      : "Support assertions with concrete rationale rather than generic statements.";
  }

  return "Maintain coherence by directly building on the previous claim while advancing the topic.";
}

function evaluateTurnSignals({ text, previousText, recentTranscript, keywordSet, mode, referenceMap }) {
  const topicCoverage = topicCoverageScore(text, keywordSet);
  const recent = (recentTranscript || []).slice(-3);
  const maxRecentSimilarity = recent.length
    ? Math.max(...recent.map((entry) => jaccardSimilarity(entry?.text, text)))
    : 0;
  const novelty = Number(clamp(1 - maxRecentSimilarity, 0, 1).toFixed(4));
  const previousSimilarity = previousText ? jaccardSimilarity(previousText, text) : 0;
  const coherence = Number(
    clamp(topicCoverage * 0.62 + Math.min(1, previousSimilarity / 0.36) * 0.38, 0, 1).toFixed(4)
  );
  const nonRepetition = Number(clamp(1 - previousSimilarity, 0, 1).toFixed(4));
  const evidence = evaluateEvidenceQuality({ text, mode, referenceMap });
  const evidenceQuality = Number(clamp(evidence.score, 0, 1).toFixed(4));

  const overall = Number(
    clamp(novelty * 0.28 + coherence * 0.32 + nonRepetition * 0.2 + evidenceQuality * 0.2, 0, 1).toFixed(4)
  );

  const accepted =
    overall >= EVALUATOR_MIN_OVERALL &&
    novelty >= EVALUATOR_MIN_NOVELTY &&
    coherence >= EVALUATOR_MIN_COHERENCE &&
    (mode !== "debate" || evidenceQuality >= EVALUATOR_MIN_EVIDENCE);

  return {
    novelty,
    coherence,
    nonRepetition,
    evidenceQuality,
    overall,
    claimSentences: evidence.claimSentences,
    citationCount: evidence.citationCount,
    citedReferenceCount: evidence.citedReferenceCount,
    accepted,
    correctionDirective: chooseCorrectionDirective({
      novelty,
      coherence,
      nonRepetition,
      evidenceQuality,
      mode
    })
  };
}

function stripHtml(input) {
  return String(input || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function buildCitationQuery({ topic, brief, transcript }) {
  const recent = (transcript || [])
    .slice(-4)
    .map((entry) => entry.text)
    .join(" ");
  const source = [topic, brief?.objective, brief?.constraintsText, recent].filter(Boolean).join(" ");
  const words = normalizeText(source)
    .split(" ")
    .filter((token) => token.length >= 4)
    .slice(0, 18);

  return uniqueLines(words, 12).join(" ");
}

async function fetchJsonWithTimeout(url, timeoutMs = 4500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function retrieveWikipediaReferences({ query, maxReferences }) {
  const trimmedQuery = String(query || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  if (!trimmedQuery) {
    return [];
  }

  const searchUrl = new URL("https://en.wikipedia.org/w/api.php");
  searchUrl.searchParams.set("action", "query");
  searchUrl.searchParams.set("format", "json");
  searchUrl.searchParams.set("list", "search");
  searchUrl.searchParams.set("utf8", "1");
  searchUrl.searchParams.set("origin", "*");
  searchUrl.searchParams.set("srlimit", String(maxReferences));
  searchUrl.searchParams.set("srsearch", trimmedQuery);

  const searchPayload = await fetchJsonWithTimeout(searchUrl.toString(), CITATION_TIMEOUT_MS);
  const hits = Array.isArray(searchPayload?.query?.search) ? searchPayload.query.search : [];
  if (!hits.length) {
    return [];
  }

  const topHits = hits.slice(0, maxReferences);
  const details = await Promise.all(
    topHits.map(async (hit) => {
      const title = String(hit?.title || "").trim();
      if (!title) {
        return null;
      }

      const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
      const summaryPayload = await fetchJsonWithTimeout(summaryUrl, CITATION_TIMEOUT_MS);
      const snippet = stripHtml(summaryPayload?.extract || hit?.snippet || "");
      const canonicalUrl = String(summaryPayload?.content_urls?.desktop?.page || "").trim();
      const url = canonicalUrl || `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/\s+/g, "_"))}`;
      const score = Number(hit?.score || 0);
      const rank = topHits.findIndex((entry) => entry?.title === title);
      const rankConfidence = clamp(0.85 - rank * 0.12, 0.2, 0.9);
      const textConfidence = clamp(Math.min(1, snippet.length / 240) * 0.4 + rankConfidence * 0.6, 0.12, 0.95);

      return {
        title,
        url,
        snippet: snippet.slice(0, 260),
        confidence: Number(clamp((score > 0 ? textConfidence : textConfidence * 0.92), 0, 1).toFixed(4))
      };
    })
  );

  return details
    .filter((item) => item && item.url && item.confidence >= CITATION_MIN_REFERENCE_CONFIDENCE)
    .slice(0, maxReferences)
    .map((item, index) => ({
      id: `R${index + 1}`,
      provider: "wikipedia",
      title: item.title,
      url: item.url,
      snippet: item.snippet,
      confidence: item.confidence
    }));
}

async function retrieveDebateReferences({ topic, brief, transcript }) {
  if (!CITATION_RETRIEVAL_ENABLED) {
    return [];
  }

  const query = buildCitationQuery({ topic, brief, transcript });
  if (!query) {
    return [];
  }

  return retrieveWikipediaReferences({
    query,
    maxReferences: CITATION_MAX_REFERENCES
  });
}

function buildReferenceBlock(references) {
  if (!Array.isArray(references) || references.length === 0) {
    return "Reference notes: (none available)";
  }

  return [
    "Reference notes (cite as [R#] for factual claims):",
    ...references.map((reference) =>
      `${reference.id} | ${reference.title} | conf ${Number(reference.confidence || 0).toFixed(2)} | ${reference.url} | ${reference.snippet}`
    )
  ].join("\n");
}

function extractCitedClaims({ text, turn, speakerId, references }) {
  const referenceMap = new Map(
    (references || [])
      .filter((reference) => reference?.id)
      .map((reference) => [String(reference.id || "").toUpperCase(), reference])
  );
  if (!referenceMap.size) {
    return [];
  }

  const sentences = String(text || "")
    .split(/(?<=[.!?])\s+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 6);
  const claims = [];

  for (const sentence of sentences) {
    const citations = extractCitationIds(sentence);
    if (!citations.length) {
      continue;
    }

    const claimText = sentence.replace(/\[(R\d+)\]/gi, "").replace(/\s+/g, " ").trim().slice(0, 300);
    if (!claimText) {
      continue;
    }

    for (const citationId of citations) {
      const reference = referenceMap.get(citationId);
      if (!reference) {
        continue;
      }

      claims.push({
        turn,
        speakerId,
        claimText,
        citationId,
        citationTitle: reference.title || "",
        citationUrl: reference.url || "",
        confidence: Number(clamp(reference.confidence || 0, 0, 1).toFixed(4))
      });
    }
  }

  return claims;
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

function turnTakingContextBlock(topic, transcript) {
  const previous = transcript[transcript.length - 1];
  if (!previous) {
    return [
      "Turn-taking context:",
      `Original topic/question: ${topic}`,
      "No prior agent reply exists yet.",
      "You are the opening speaker: give your first opinion on the topic."
    ].join("\n");
  }

  return [
    "Turn-taking context:",
    `Original topic/question: ${topic}`,
    `Previous speaker: ${previous.speaker}`,
    `Previous reply: ${previous.text}`,
    "Respond directly to the previous reply first, then add one new relevant point."
  ].join("\n");
}

function localTurn(topic, transcript, moderatorDirective, brief, mode = "exploration", references = []) {
  const previous = transcript[transcript.length - 1];
  const recent = transcript.slice(-2).map((entry) => entry.text).join(" ");
  const guidance = moderatorDirective
    ? `Moderator guidance: ${moderatorDirective}.`
    : "Moderator guidance: stay on-topic and add one concrete move.";
  const objectiveHint = brief?.objective ? `Primary objective: ${brief.objective}.` : "";
  const modeHint = DISCOVERY_MODE_HINTS[mode] || DISCOVERY_MODE_HINTS.exploration;
  const citationHint =
    mode === "debate" && Array.isArray(references) && references.length > 0
      ? `Evidence note [R1]: ${references[0].title || references[0].url}.`
      : "";

  const seeds = [
    `Let us stay focused on ${topic}. A practical angle is to define one core objective and test it quickly.`,
    "Building on that, we should preserve context by carrying forward the prior point and tightening scope each turn.",
    "A relevant constraint is user experience: concise messages, clear sequencing, and consistent topic anchoring.",
    "A useful next move is to convert this into a lightweight loop where each reply references the previous claim.",
    "To keep relevance high, we can enforce a shared memory summary and include it in every generation step."
  ];

  const seed = seeds[transcript.length % seeds.length];
  const hook = previous
    ? `Responding to ${previous.speaker}'s point,`
    : "Opening thought:";

  return `${hook} ${objectiveHint} ${modeHint} ${guidance} ${citationHint} ${seed} ${
    previous ? `This directly builds on: "${recent.slice(0, 100)}..."` : ""
  }`
    .replace(/\s+/g, " ")
    .trim();
}

async function generateTurn({ topic, speaker, transcript, memory, moderatorDirective, brief, mode, references }) {
  if (!client) {
    return localTurn(topic, transcript, moderatorDirective, brief, mode, references);
  }

  const basePrompt = buildContextBlock({
    topic,
    transcript,
    memory,
    moderatorDirective,
    charter: DISCUSSION_CHARTER,
    brief
  });
  const turnTakingPrompt = turnTakingContextBlock(topic, transcript);
  const userPrompt = [basePrompt, turnTakingPrompt, buildReferenceBlock(references)].join("\n");

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
          "Turn-taking rule: respond to the previous agent reply before introducing your new point.",
          "When a previous reply exists, directly address it in your first sentence.",
          "Write only substantive content, no meta-commentary.",
          mode === "debate"
            ? "For factual claims, cite supporting references using [R#] from the provided reference notes."
            : "Use reference notes when useful, but keep the response concise."
        ].join(" ")
      },
      {
        role: "user",
        content: userPrompt
      }
    ]
  });

  return (
    completion.choices?.[0]?.message?.content?.trim() ||
    localTurn(topic, transcript, moderatorDirective, brief, mode, references)
  );
}

function parseTurns(rawTurns) {
  const requestedTurns = Number(rawTurns ?? 10);
  return Math.min(10, Math.max(2, Number.isFinite(requestedTurns) ? requestedTurns : 10));
}

function parseLabTurns(rawTurns) {
  const requestedTurns = Number(rawTurns ?? LAB_DEFAULT_TURNS);
  return Math.min(10, Math.max(2, Number.isFinite(requestedTurns) ? requestedTurns : LAB_DEFAULT_TURNS));
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

function semanticLines(items, limit = 4) {
  return (items || [])
    .map((item) => String(item?.evidenceText || item?.canonicalText || "").trim())
    .filter(Boolean)
    .slice(0, limit);
}

function uniqueLines(lines, limit = 3) {
  const seen = new Set();
  const result = [];
  for (const line of lines) {
    const key = line.toLowerCase();
    if (!line || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(line);
    if (result.length >= limit) {
      break;
    }
  }
  return result;
}

function compactLine(text, maxLen = 220) {
  const normalized = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= maxLen) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxLen - 3)).trimEnd()}...`;
}

function buildInsightSnapshot({ topic, brief, mode, memory }) {
  const grouped = memory?.groupedSemantic || {
    decisions: [],
    constraints: [],
    definitions: [],
    openQuestions: []
  };

  const decisions = semanticLines(grouped.decisions, 4);
  const constraints = semanticLines(grouped.constraints, 4);
  const definitions = semanticLines(grouped.definitions, 3);
  const openQuestions = semanticLines(grouped.openQuestions, 4);

  const modeStep =
    mode === "debate"
      ? "Surface the strongest counterargument and resolve the crux explicitly."
      : mode === "synthesis"
        ? "Lock one decision with tradeoffs and define the immediate execution step."
        : "Run one small experiment and capture what evidence would change direction.";

  const nextSteps = uniqueLines([
    openQuestions[0] ? `Resolve open question: ${openQuestions[0]}` : "",
    constraints[0] ? `Validate against constraint: ${constraints[0]}` : "",
    brief?.doneCriteria ? `Drive toward done criteria: ${brief.doneCriteria}` : "",
    decisions[0] ? `Pressure-test decision: ${decisions[0]}` : "",
    modeStep
  ]);

  return {
    topic,
    mode,
    objective: brief?.objective || "",
    decisions,
    constraints,
    definitions,
    openQuestions,
    nextSteps,
    stats: {
      decisionCount: Number(memory?.stats?.decisionCount || 0),
      openQuestionCount: Number(memory?.stats?.openQuestionCount || 0),
      constraintCount: Number(memory?.stats?.constraintCount || 0),
      definitionCount: Number(memory?.stats?.definitionCount || 0),
      summaryCount: Number(memory?.stats?.summaryCount || 0),
      tokenCount: Number(memory?.stats?.tokenCount || 0)
    }
  };
}

function buildDiscoveryRadar({ topic, brief, mode, memory, transcript }) {
  const grouped = memory?.groupedSemantic || {
    decisions: [],
    constraints: [],
    definitions: [],
    openQuestions: []
  };
  const openQuestions = semanticLines(grouped.openQuestions, 6);
  const decisions = semanticLines(grouped.decisions, 6);
  const constraints = semanticLines(grouped.constraints, 4);
  const definitions = semanticLines(grouped.definitions, 4);
  const summaryHighlights = (memory?.summaries || [])
    .slice(0, 3)
    .map((entry) => compactLine(entry.summary, 200))
    .filter(Boolean);

  const sourceSets = {
    openQuestion: new Set(openQuestions.map((line) => line.toLowerCase())),
    decision: new Set(decisions.map((line) => line.toLowerCase())),
    constraint: new Set(constraints.map((line) => line.toLowerCase())),
    definition: new Set(definitions.map((line) => line.toLowerCase())),
    summary: new Set(summaryHighlights.map((line) => line.toLowerCase()))
  };

  const hypothesisSeeds = uniqueLines(
    [
      ...openQuestions,
      ...constraints,
      ...definitions,
      ...summaryHighlights,
      brief?.objective ? `Objective focus: ${brief.objective}` : ""
    ],
    5
  );

  const hypotheses = hypothesisSeeds.map((seed, index) => {
    const seedKey = seed.toLowerCase();
    const sourceType = sourceSets.openQuestion.has(seedKey)
      ? "open_question"
      : sourceSets.constraint.has(seedKey)
        ? "constraint"
        : sourceSets.definition.has(seedKey)
          ? "definition"
          : sourceSets.summary.has(seedKey)
            ? "summary"
            : sourceSets.decision.has(seedKey)
              ? "decision"
              : "objective";
    const statement =
      sourceType === "open_question"
        ? `If we resolve "${compactLine(seed, 110)}", the thread can unlock a higher-confidence decision.`
        : sourceType === "constraint"
          ? `A solution that satisfies "${compactLine(seed, 110)}" will outperform broader alternatives.`
          : sourceType === "definition"
            ? `Clarifying "${compactLine(seed, 110)}" should reduce ambiguity and improve downstream choices.`
            : sourceType === "summary"
              ? `Expanding on "${compactLine(seed, 110)}" may surface a novel path not yet pressure-tested.`
              : `Aligning execution with "${compactLine(seed, 110)}" should increase delivery certainty.`;

    const confidenceBase =
      sourceType === "decision" ? 0.74 : sourceType === "constraint" ? 0.7 : sourceType === "open_question" ? 0.62 : 0.66;

    return {
      id: `H${index + 1}`,
      sourceType,
      statement,
      evidence: compactLine(seed, 180),
      confidence: Number(clamp(confidenceBase - index * 0.04, 0.42, 0.92).toFixed(2))
    };
  });

  const experiments = hypotheses.slice(0, 4).map((item, index) => ({
    id: `E${index + 1}`,
    hypothesisId: item.id,
    protocol: compactLine(
      `Run one focused ${mode} pass where each turn references this hypothesis and adds exactly one falsifiable claim: ${item.evidence}`,
      220
    ),
    successSignal: compactLine(
      openQuestions[index]
        ? `Open question reduced or resolved: ${openQuestions[index]}`
        : "Two independent turns converge on the same decision with rationale.",
      180
    ),
    failureSignal: compactLine(
      `Conversation repeats prior claims without new evidence in relation to ${item.id}.`,
      180
    )
  }));

  const riskLines = uniqueLines(
    [
      openQuestions.length > decisions.length
        ? "Open questions are accumulating faster than decisions; risk of exploration without convergence."
        : "",
      constraints.length === 0
        ? "Constraint memory is sparse; solutions may be impractical or under-specified."
        : "",
      Number(memory?.stats?.summaryCount || 0) === 0
        ? "No summary snapshots yet; long-range context may drift over extended runs."
        : "",
      Number(memory?.stats?.tokenCount || 0) >= 140
        ? "High token pressure in memory; low-value tokens may crowd out newer signals."
        : "",
      transcript?.length >= 30 && openQuestions.length >= 3
        ? "Thread depth is high with unresolved questions; schedule a synthesis pass to avoid looping."
        : ""
    ],
    4
  );

  const tokenDiversity = Math.min(1, Number(memory?.stats?.tokenCount || 0) / 160);
  const questionPressure = Math.min(1, Number(memory?.stats?.openQuestionCount || 0) / 8);
  const decisionMomentum = Math.min(1, Number(memory?.stats?.decisionCount || 0) / 6);
  const summaryDepth = Math.min(1, Number(memory?.stats?.summaryCount || 0) / 5);
  const noveltyScore = Number(
    clamp(
      tokenDiversity * 0.32 + questionPressure * 0.3 + (1 - Math.abs(questionPressure - decisionMomentum)) * 0.2 + summaryDepth * 0.18,
      0,
      1
    ).toFixed(4)
  );

  return {
    topic,
    mode,
    objective: brief?.objective || "",
    noveltyScore,
    discoveryStage:
      noveltyScore >= 0.78
        ? "frontier"
        : noveltyScore >= 0.58
          ? "promising"
          : noveltyScore >= 0.38
            ? "forming"
            : "early",
    hypotheses,
    experiments,
    risks: riskLines,
    nextAction: experiments[0]?.protocol || "Run another focused pass with one falsifiable hypothesis.",
    stats: {
      tokenCount: Number(memory?.stats?.tokenCount || 0),
      summaryCount: Number(memory?.stats?.summaryCount || 0),
      decisionCount: Number(memory?.stats?.decisionCount || 0),
      openQuestionCount: Number(memory?.stats?.openQuestionCount || 0),
      hypothesisCount: hypotheses.length,
      experimentCount: experiments.length
    }
  };
}

function buildObjectiveScore({ topic, brief, memory, transcript, insights }) {
  const recentText = (transcript || [])
    .slice(-10)
    .map((entry) => entry.text)
    .join(" ");
  const recentTokens = tokenSet(recentText);
  const objectiveSource = [topic, brief?.objective, brief?.doneCriteria].filter(Boolean).join(" ");
  const objectiveKeywords = [...tokenSet(objectiveSource)].slice(0, 30);

  let objectiveCoverage = 0;
  if (objectiveKeywords.length === 0) {
    objectiveCoverage = 1;
  } else {
    let matched = 0;
    for (const keyword of objectiveKeywords) {
      if (recentTokens.has(keyword)) {
        matched += 1;
      }
    }
    objectiveCoverage = matched / Math.max(1, objectiveKeywords.length);
  }

  const decisionMomentum = Math.min(1, Number(memory?.stats?.decisionCount || 0) / 4);
  const openQuestionPressure = Math.min(1, Number(memory?.stats?.openQuestionCount || 0) / 6);
  const lastTurn = transcript?.[transcript.length - 1]?.text || "";
  const doneSignal = brief?.doneCriteria ? jaccardSimilarity(brief.doneCriteria, lastTurn) : objectiveCoverage;
  const resolution = 1 - openQuestionPressure;

  const raw =
    objectiveCoverage * 0.34 + decisionMomentum * 0.28 + doneSignal * 0.23 + resolution * 0.15;
  const overall = Number(clamp(raw, 0, 1).toFixed(4));

  const stage =
    overall >= 0.8
      ? "near_done"
      : overall >= 0.6
        ? "converging"
        : overall >= 0.35
          ? "developing"
          : "early";

  const nextAction =
    insights?.nextSteps?.[0] ||
    (brief?.doneCriteria
      ? `Drive directly toward done criteria: ${brief.doneCriteria}`
      : "Increase specificity with one concrete next step.");

  return {
    overall,
    stage,
    components: {
      objectiveCoverage: Number(objectiveCoverage.toFixed(4)),
      decisionMomentum: Number(decisionMomentum.toFixed(4)),
      doneSignal: Number(doneSignal.toFixed(4)),
      resolution: Number(resolution.toFixed(4))
    },
    openQuestions: Number(memory?.stats?.openQuestionCount || 0),
    decisions: Number(memory?.stats?.decisionCount || 0),
    nextAction
  };
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

function resolveConversationFromParams(req, res) {
  const conversationId = sanitizeConversationId(req.params.id);
  if (!conversationId) {
    res.status(400).json({ error: "Conversation id is required." });
    return null;
  }

  const conversation = getConversation(conversationId);
  if (!conversation) {
    res.status(404).json({ error: "Conversation not found." });
    return null;
  }

  return { conversationId, conversation };
}

function conversationMetaPayload(conversation) {
  return {
    topic: conversation.topic,
    title: conversation.title || "",
    starred: Boolean(conversation.starred),
    mode: sanitizeConversationMode(conversation.mode, "exploration")
  };
}

function withConversationMeta(conversationId, conversation, extra = {}) {
  return {
    conversationId,
    ...conversationMetaPayload(conversation),
    ...extra
  };
}

function cloneTranscriptEntries(entries) {
  return (entries || []).map((entry) => ({
    turn: entry.turn,
    speaker: entry.speaker,
    speakerId: entry.speakerId,
    text: entry.text
  }));
}

function modeTitle(baseTitle, mode) {
  const prefix = sanitizeConversationTitle(baseTitle, "Conversation");
  const label = mode.charAt(0).toUpperCase() + mode.slice(1);
  return sanitizeConversationTitle(`${prefix} (${label})`, prefix);
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
  references = [],
  writeChunk
}) {
  const newEntries = [];
  const startedAt = Date.now();
  const qualityKeywordSet = getQualityKeywordSet(topic, brief);
  const citationMode = mode === "debate" && CITATION_RETRIEVAL_ENABLED;
  let activeReferences = Array.isArray(references) ? references.filter((item) => item?.id) : [];
  const citedClaims = [];
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
  let evaluatorScoreTotal = 0;
  let evaluatorTurns = 0;
  let evaluatorRetries = 0;
  let citationTurnCount = 0;
  let citationClaimCount = 0;
  let citationConfidenceTotal = 0;

  for (let i = 0; i < turns; i += 1) {
    if (Date.now() - startedAt > MAX_GENERATION_MS) {
      stopReason = "time_limit";
      break;
    }

    const nextTurn = transcript.length + 1;
    const activeAgents = agents && agents.length ? agents : DEFAULT_AGENTS;
    const speaker = activeAgents[(nextTurn - 1) % activeAgents.length];
    const previous = transcript[transcript.length - 1];
    let referenceMap = new Map(
      activeReferences
        .filter((item) => item?.id)
        .map((item) => [String(item.id).toUpperCase(), item])
    );

    if (
      citationMode &&
      (i === 0 || i % CITATION_REFRESH_INTERVAL === 0 || activeReferences.length === 0)
    ) {
      try {
        const retrieved = await retrieveDebateReferences({
          topic,
          brief,
          transcript
        });
        if (retrieved.length > 0) {
          activeReferences = retrieved;
          referenceMap = new Map(retrieved.map((item) => [String(item.id).toUpperCase(), item]));
          upsertRetrievalSources(conversationId, nextTurn, activeReferences);
          if (writeChunk) {
            writeChunk({
              type: "references",
              turn: nextTurn,
              references: activeReferences
            });
          }
        }
      } catch {
        // Ignore retrieval failures and continue with existing references.
      }
    }

    let entry = null;
    let signaledDone = false;
    let quality = null;
    let evaluator = null;
    let attempts = 0;
    let accepted = false;
    const maxAttempts = QUALITY_RETRY_LIMIT + (EVALUATOR_LOOP_ENABLED ? EVALUATOR_RETRY_LIMIT : 0);
    let correctionHint = "";

    while (attempts <= maxAttempts) {
      const attemptDirective =
        attempts === 0
          ? moderatorDirective
          : [
              `${moderatorDirective} Quality retry: improve specificity, stay on-topic, avoid repetition, and be at least ${QUALITY_MIN_WORDS} words.`,
              correctionHint ? `Evaluator correction: ${correctionHint}` : ""
            ]
              .filter(Boolean)
              .join(" ");

      const generated = await generateTurn({
        topic,
        mode,
        speaker,
        transcript,
        memory,
        moderatorDirective: attemptDirective,
        brief,
        references: activeReferences
      });

      signaledDone = containsDoneToken(generated);
      const text = stripDonePrefix(generated);
      entry = {
        turn: nextTurn,
        speaker: speaker.name,
        speakerId: speaker.id,
        text: normalizeTurnText(text || generated)
      };

      quality = evaluateTurnQuality({
        text: entry.text,
        previousText: previous?.text,
        keywordSet: qualityKeywordSet
      });
      evaluator = evaluateTurnSignals({
        text: entry.text,
        previousText: previous?.text,
        recentTranscript: transcript,
        keywordSet: qualityKeywordSet,
        mode,
        referenceMap
      });
      attempts += 1;

      const evaluatorAccepted = !EVALUATOR_LOOP_ENABLED || evaluator.accepted;
      if ((quality.accepted && evaluatorAccepted) || attempts > maxAttempts) {
        accepted = quality.accepted && evaluatorAccepted;
        break;
      }

      correctionHint = evaluator?.correctionDirective || correctionHint;

      if (writeChunk) {
        writeChunk({
          type: "retry",
          turn: nextTurn,
          attempt: attempts,
          reason: quality.tooShort
            ? "too_short"
            : quality.repetitive
              ? "repetitive"
              : quality.offTopic
                ? "off_topic"
                : "evaluator_correction",
          quality,
          evaluator
        });
      }
    }

    qualityScoreTotal += quality?.score ?? 0;
    qualityTurns += 1;
    retriesUsed += Math.max(0, attempts - 1);
    evaluatorScoreTotal += evaluator?.overall ?? 0;
    evaluatorTurns += 1;
    if (attempts > QUALITY_RETRY_LIMIT + 1) {
      evaluatorRetries += attempts - (QUALITY_RETRY_LIMIT + 1);
    }
    repetitionStreak =
      quality?.repetitive || (EVALUATOR_LOOP_ENABLED && Number(evaluator?.nonRepetition || 1) < 0.24)
        ? repetitionStreak + 1
        : 0;

    if (citationMode && evaluator?.citationCount > 0) {
      citationTurnCount += 1;
    }

    const turnCitations = extractCitedClaims({
      text: entry?.text,
      turn: nextTurn,
      speakerId: speaker.id,
      references: activeReferences
    });
    if (turnCitations.length > 0) {
      citationClaimCount += turnCitations.length;
      citationConfidenceTotal += turnCitations.reduce((sum, item) => sum + Number(item.confidence || 0), 0);
      citedClaims.push(...turnCitations);
    }

    transcript.push(entry);
    newEntries.push(entry);

    if (writeChunk) {
      writeChunk({
        type: "turn",
        entry,
        totalTurns: transcript.length,
        quality: {
          ...quality,
          evaluator: EVALUATOR_LOOP_ENABLED ? evaluator : null,
          attempts,
          accepted,
          repetitionStreak
        },
        references: citationMode ? activeReferences : []
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
  if (citedClaims.length > 0) {
    insertClaimCitations(conversationId, citedClaims);
  }
  const memoryStats = await finalizeMemory(conversationId, topic, newEntries, transcript.length);

  return {
    newEntries,
    totalTurns: transcript.length,
    stopReason,
    moderatorDirective,
    memoryStats,
    qualitySummary: {
      avgScore: Number((qualityTurns ? qualityScoreTotal / qualityTurns : 0).toFixed(4)),
      evaluatorAvgScore: Number((evaluatorTurns ? evaluatorScoreTotal / evaluatorTurns : 0).toFixed(4)),
      retriesUsed,
      evaluatorRetries,
      turnsEvaluated: qualityTurns,
      citationMode,
      citedTurns: citationTurnCount,
      citedClaims: citationClaimCount,
      citationConfidenceAvg: Number(
        (citationClaimCount > 0 ? citationConfidenceTotal / citationClaimCount : 0).toFixed(4)
      )
    },
    references: citationMode ? activeReferences : []
  };
}

app.get("/api/conversation/:id", (req, res) => {
  const resolved = resolveConversationFromParams(req, res);
  if (!resolved) {
    return;
  }
  const { conversationId, conversation } = resolved;

  const transcript = getMessages(conversationId);
  const memory = getCompressedMemory(conversationId);
  const brief = getConversationBrief(conversationId);
  const agents = mapStoredAgents(getConversationAgents(conversationId));

  return res.json(
    withConversationMeta(conversationId, conversation, {
      parentConversationId: conversation.parentConversationId || null,
      forkFromTurn: Number.isFinite(conversation.forkFromTurn) ? conversation.forkFromTurn : null,
      brief,
      agents,
      totalTurns: transcript.length,
      transcript,
      memory: memory.stats
    })
  );
});

app.post("/api/conversation/:id/fork", async (req, res) => {
  try {
    const resolved = resolveConversationFromParams(req, res);
    if (!resolved) {
      return;
    }
    const { conversationId: sourceConversationId, conversation: sourceConversation } = resolved;

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

    const resolvedForkConversation = forkConversation || {
      topic: sourceConversation.topic,
      title: forkTitle,
      starred: false,
      mode: sourceConversation.mode || "exploration"
    };
    return res.json(
      withConversationMeta(forkConversationId, resolvedForkConversation, {
        brief: sourceBrief,
        agents: sourceAgents,
        parentConversationId: sourceConversationId,
        forkFromTurn,
        totalTurns: forkTranscript.length,
        transcript: forkTranscript,
        memory: memory.stats
      })
    );
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Failed to fork conversation." });
  }
});

app.get("/api/conversation/:id/brief", (req, res) => {
  const resolved = resolveConversationFromParams(req, res);
  if (!resolved) {
    return;
  }
  const { conversationId, conversation } = resolved;

  return res.json(withConversationMeta(conversationId, conversation, { brief: getConversationBrief(conversationId) }));
});

app.get("/api/conversation/:id/agents", (req, res) => {
  const resolved = resolveConversationFromParams(req, res);
  if (!resolved) {
    return;
  }
  const { conversationId, conversation } = resolved;

  return res.json(
    withConversationMeta(conversationId, conversation, {
      agents: mapStoredAgents(getConversationAgents(conversationId))
    })
  );
});

app.post("/api/conversation/:id/agents", (req, res) => {
  const resolved = resolveConversationFromParams(req, res);
  if (!resolved) {
    return;
  }
  const { conversationId, conversation } = resolved;

  const currentAgents = mapStoredAgents(getConversationAgents(conversationId));
  const incomingAgents = parseAgentConfigFromBody(req.body);
  upsertConversationAgents(conversationId, mergeAgentConfig(currentAgents, incomingAgents));

  return res.json(
    withConversationMeta(conversationId, conversation, {
      agents: mapStoredAgents(getConversationAgents(conversationId))
    })
  );
});

app.post("/api/conversation/:id/meta", (req, res) => {
  const resolved = resolveConversationFromParams(req, res);
  if (!resolved) {
    return;
  }
  const { conversationId, conversation } = resolved;

  const parsedMeta = parseConversationMetaFromBody(req.body);
  const mergedMeta = mergeConversationMeta(conversation, req.body || {}, parsedMeta);
  updateConversationMeta(conversationId, mergedMeta);
  const updatedConversation = getConversation(conversationId);

  return res.json(withConversationMeta(conversationId, updatedConversation));
});

app.post("/api/conversation/:id/brief", (req, res) => {
  const resolved = resolveConversationFromParams(req, res);
  if (!resolved) {
    return;
  }
  const { conversationId, conversation } = resolved;

  const currentBrief = getConversationBrief(conversationId);
  const parsedBrief = parseBriefFromBody(req.body);
  const mergedBrief = mergeBriefPatch(currentBrief, req.body || {}, parsedBrief);
  upsertConversationBrief(conversationId, mergedBrief);

  return res.json(withConversationMeta(conversationId, conversation, { brief: getConversationBrief(conversationId) }));
});

app.get("/api/conversation/:id/memory", (req, res) => {
  const resolved = resolveConversationFromParams(req, res);
  if (!resolved) {
    return;
  }
  const { conversationId, conversation } = resolved;

  const memory = getCompressedMemory(conversationId);
  const brief = getConversationBrief(conversationId);
  const agents = mapStoredAgents(getConversationAgents(conversationId));
  return res.json(withConversationMeta(conversationId, conversation, { brief, agents, memory }));
});

app.get("/api/conversation/:id/insights", (req, res) => {
  const resolved = resolveConversationFromParams(req, res);
  if (!resolved) {
    return;
  }
  const { conversationId, conversation } = resolved;

  const brief = getConversationBrief(conversationId);
  const mode = sanitizeConversationMode(conversation.mode, "exploration");
  const memory = getCompressedMemory(conversationId);
  const insights = buildInsightSnapshot({
    topic: conversation.topic,
    brief,
    mode,
    memory
  });

  return res.json(withConversationMeta(conversationId, conversation, { mode, insights }));
});

app.get("/api/conversation/:id/discoveries", (req, res) => {
  const resolved = resolveConversationFromParams(req, res);
  if (!resolved) {
    return;
  }
  const { conversationId, conversation } = resolved;

  const transcript = getMessages(conversationId);
  const brief = getConversationBrief(conversationId);
  const mode = sanitizeConversationMode(conversation.mode, "exploration");
  const memory = getCompressedMemory(conversationId);
  const discoveries = buildDiscoveryRadar({
    topic: conversation.topic,
    brief,
    mode,
    memory,
    transcript
  });

  return res.json(withConversationMeta(conversationId, conversation, { brief, discoveries }));
});

app.get("/api/conversation/:id/citations", (req, res) => {
  const resolved = resolveConversationFromParams(req, res);
  if (!resolved) {
    return;
  }
  const { conversationId, conversation } = resolved;

  const sources = getRecentRetrievalSources(conversationId, 60);
  const claims = getRecentClaimCitations(conversationId, 120);
  const sourceMap = new Map();
  for (const source of sources) {
    const key = `${source.referenceId}:${source.url}`;
    if (!sourceMap.has(key)) {
      sourceMap.set(key, source);
    }
  }
  const uniqueSources = [...sourceMap.values()].slice(0, 24);
  const confidenceAvg =
    claims.length > 0
      ? claims.reduce((sum, claim) => sum + Number(claim.confidence || 0), 0) / claims.length
      : 0;

  return res.json(
    withConversationMeta(conversationId, conversation, {
      citations: {
        sources: uniqueSources,
        claims: claims.slice(0, 80),
        stats: {
          sourceCount: uniqueSources.length,
          claimCount: claims.length,
          confidenceAvg: Number(clamp(confidenceAvg, 0, 1).toFixed(4))
        }
      }
    })
  );
});

app.get("/api/conversation/:id/score", (req, res) => {
  const resolved = resolveConversationFromParams(req, res);
  if (!resolved) {
    return;
  }
  const { conversationId, conversation } = resolved;

  const transcript = getMessages(conversationId);
  const brief = getConversationBrief(conversationId);
  const mode = sanitizeConversationMode(conversation.mode, "exploration");
  const memory = getCompressedMemory(conversationId);
  const insights = buildInsightSnapshot({
    topic: conversation.topic,
    brief,
    mode,
    memory
  });
  const score = buildObjectiveScore({
    topic: conversation.topic,
    brief,
    memory,
    transcript,
    insights
  });

  return res.json(withConversationMeta(conversationId, conversation, { brief, score }));
});

app.get("/api/conversations", (req, res) => {
  const requestedLimit = Number(req.query.limit ?? 20);
  const limit = Math.min(100, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 20));
  const conversations = listConversations(limit);
  return res.json({ conversations });
});

app.delete("/api/conversations", (req, res) => {
  const deletedCount = clearConversations();
  return res.json({ ok: true, deletedCount });
});

app.delete("/api/conversation/:id", (req, res) => {
  const conversationId = sanitizeConversationId(req.params.id);
  if (!conversationId) {
    return res.status(400).json({ error: "Conversation id is required." });
  }

  const removed = deleteConversation(conversationId);
  if (!removed) {
    return res.status(404).json({ error: "Conversation not found." });
  }

  return res.json({ ok: true, conversationId });
});

app.post("/api/conversation/lab", async (req, res) => {
  try {
    const baseConversationId = sanitizeConversationId(req.body?.conversationId);
    const requestedTopic = sanitizeTopic(req.body?.topic);
    const requestedBrief = parseBriefFromBody(req.body);
    const requestedAgents = parseAgentConfigFromBody(req.body);
    const requestedMeta = parseConversationMetaFromBody(req.body);
    const turns = parseLabTurns(req.body?.turns);
    const shouldUpdateBrief = hasBriefPayload(req.body);
    const shouldUpdateAgents = hasAgentPayload(req.body);

    let sourceConversation = null;
    let sourceTranscript = [];
    let topic = requestedTopic;
    let brief = shouldUpdateBrief
      ? requestedBrief
      : {
          objective: "",
          constraintsText: "",
          doneCriteria: ""
        };
    let agents = shouldUpdateAgents
      ? mergeAgentConfig(mapStoredAgents([]), requestedAgents)
      : mapStoredAgents([]);
    let baseTitle = sanitizeConversationTitle(requestedMeta.title, topic);
    let parentConversationId = null;
    let forkFromTurn = null;

    if (baseConversationId) {
      sourceConversation = getConversation(baseConversationId);
      if (!sourceConversation) {
        return res.status(404).json({ error: "Conversation not found." });
      }

      topic = sourceConversation.topic;
      sourceTranscript = getMessages(baseConversationId);
      brief = getConversationBrief(baseConversationId);
      const storedAgents = getConversationAgents(baseConversationId);
      agents = storedAgents.length ? mapStoredAgents(storedAgents) : mapStoredAgents([]);
      if (shouldUpdateBrief) {
        brief = mergeBriefPatch(brief, req.body || {}, requestedBrief);
      }
      if (shouldUpdateAgents) {
        agents = mergeAgentConfig(agents, requestedAgents);
      }

      baseTitle = requestedMeta.title
        ? sanitizeConversationTitle(requestedMeta.title, sourceConversation.topic)
        : sanitizeConversationTitle(sourceConversation.title, sourceConversation.topic);
      parentConversationId = sourceConversation.id;
      forkFromTurn = sourceTranscript.length;
    }

    if (!topic) {
      return res.status(400).json({ error: "Topic is required." });
    }

    const runs = [];
    for (const mode of DISCOVERY_LAB_MODES) {
      const conversationId = randomUUID();
      createConversation(conversationId, topic, {
        parentConversationId,
        forkFromTurn: Number.isFinite(forkFromTurn) ? forkFromTurn : null
      });
      updateConversationMeta(conversationId, {
        title: modeTitle(baseTitle || topic, mode),
        starred: false,
        mode
      });
      upsertConversationBrief(conversationId, brief);
      upsertConversationAgents(conversationId, agents);

      const seedTranscript = cloneTranscriptEntries(sourceTranscript);
      if (seedTranscript.length) {
        insertMessages(conversationId, seedTranscript);
      }

      await bootstrapMemoryIfNeeded({
        conversationId,
        topic,
        transcript: seedTranscript,
        client,
        model
      });

      const memoryBefore = getCompressedMemory(conversationId);
      const transcript = getMessages(conversationId);
      const batch = await runConversationBatch({
        conversationId,
        topic,
        mode,
        brief,
        agents,
        transcript,
        turns,
        memory: memoryBefore
      });

      const conversation = getConversation(conversationId);
      const memory = getCompressedMemory(conversationId);
      const insights = buildInsightSnapshot({
        topic,
        brief,
        mode,
        memory
      });

      runs.push({
        conversationId,
        topic,
        title: conversation?.title || modeTitle(baseTitle || topic, mode),
        starred: Boolean(conversation?.starred),
        mode,
        parentConversationId: conversation?.parentConversationId || null,
        forkFromTurn: Number.isFinite(conversation?.forkFromTurn) ? conversation.forkFromTurn : null,
        addedTurns: batch.newEntries.length,
        totalTurns: batch.totalTurns,
        stopReason: batch.stopReason,
        quality: batch.qualitySummary,
        references: batch.references,
        memory: batch.memoryStats,
        insights
      });
    }

    return res.json({
      topic,
      turnsPerMode: turns,
      baseConversationId: sourceConversation?.id || null,
      runs
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Failed to run discovery lab." });
  }
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
        },
        evaluator: {
          enabled: EVALUATOR_LOOP_ENABLED,
          retryLimit: EVALUATOR_RETRY_LIMIT,
          minOverall: EVALUATOR_MIN_OVERALL,
          minNovelty: EVALUATOR_MIN_NOVELTY,
          minCoherence: EVALUATOR_MIN_COHERENCE,
          minEvidence: EVALUATOR_MIN_EVIDENCE
        },
        citations: {
          enabled: mode === "debate" && CITATION_RETRIEVAL_ENABLED,
          provider: "wikipedia",
          maxReferences: CITATION_MAX_REFERENCES,
          refreshInterval: CITATION_REFRESH_INTERVAL
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
      quality: batch.qualitySummary,
      references: batch.references
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
      quality: batch.qualitySummary,
      references: batch.references
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Failed to generate conversation." });
  }
});

app.use((error, req, res, next) => {
  if (!error) {
    return next();
  }

  if (error.type === "entity.too.large") {
    return res.status(413).json({ error: "Request payload too large." });
  }

  if (error.type === "entity.parse.failed" || (error instanceof SyntaxError && "body" in error)) {
    return res.status(400).json({ error: "Invalid JSON payload." });
  }

  console.error("Unhandled middleware error:", error);
  return res.status(500).json({ error: "Internal server error." });
});

app.all("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) {
    return next();
  }
  return nextHandler(req, res);
});

async function startServer() {
  await nextApp.prepare();
  app.listen(port, () => {
    console.log(`openllmchat running on http://localhost:${port}`);
    console.log(`SQLite database: ${dbPath}`);
    console.log(`UI: Next.js (${isDev ? "dev" : "prod"})`);
  });
}

startServer().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
