import {
  getConflictLedger,
  getLastSummaryTurn,
  getMemoryStats,
  getMessagesInRange,
  getRecentSummaries,
  getRecentTierSummaries,
  getTopMemoryTokens,
  getTopSemanticItems,
  insertTierSummary,
  insertSummary,
  pruneConflictLedger,
  pruneMemoryTokens,
  pruneSemanticItems,
  upsertConflictLedger,
  upsertMemoryTokens,
  upsertSemanticItems
} from "./db.js";
import {
  createChatCompletionWithFallback,
  extractAssistantText,
  normalizeReasoningEffort
} from "./openaiCompat.js";

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "has",
  "have",
  "had",
  "he",
  "her",
  "hers",
  "him",
  "his",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "itself",
  "just",
  "me",
  "might",
  "my",
  "of",
  "on",
  "or",
  "our",
  "ours",
  "she",
  "so",
  "that",
  "the",
  "their",
  "them",
  "there",
  "they",
  "this",
  "to",
  "too",
  "uh",
  "um",
  "very",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "will",
  "with",
  "would",
  "you",
  "your",
  "yours",
  "like",
  "really",
  "basically",
  "actually",
  "literally",
  "maybe",
  "also",
  "then",
  "than",
  "can",
  "could",
  "should",
  "about",
  "over",
  "under",
  "again",
  "still",
  "each",
  "other",
  "more",
  "most",
  "some",
  "such",
  "any",
  "all",
  "few",
  "much",
  "many",
  "done",
  "doing",
  "did",
  "dont",
  "cant",
  "wont",
  "lets"
]);

function readIntEnv(name, fallback, min, max) {
  const raw = Number(process.env[name]);
  const value = Number.isFinite(raw) ? raw : fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

const MEMORY_TOKEN_KEEP_LIMIT = readIntEnv("MEMORY_TOKEN_KEEP_LIMIT", 180, 50, 500);
const MEMORY_PROMPT_TOKEN_LIMIT = readIntEnv("MEMORY_PROMPT_TOKEN_LIMIT", 50, 10, 200);
const MEMORY_SUMMARY_LIMIT = readIntEnv("MEMORY_SUMMARY_LIMIT", 6, 1, 30);
const MEMORY_SUMMARY_WINDOW_TURNS = readIntEnv("MEMORY_SUMMARY_WINDOW_TURNS", 40, 10, 200);
const MEMORY_MIN_TURNS_FOR_SUMMARY = readIntEnv("MEMORY_MIN_TURNS_FOR_SUMMARY", 40, 10, 400);
const MEMORY_SEMANTIC_KEEP_LIMIT = readIntEnv("MEMORY_SEMANTIC_KEEP_LIMIT", 240, 50, 800);
const MEMORY_PROMPT_SEMANTIC_LIMIT = readIntEnv("MEMORY_PROMPT_SEMANTIC_LIMIT", 24, 8, 120);
const MEMORY_MESO_GROUP_SIZE = readIntEnv("MEMORY_MESO_GROUP_SIZE", 4, 2, 12);
const MEMORY_MACRO_GROUP_SIZE = readIntEnv("MEMORY_MACRO_GROUP_SIZE", 3, 2, 10);
const MEMORY_PROMPT_MESO_LIMIT = readIntEnv("MEMORY_PROMPT_MESO_LIMIT", 4, 1, 12);
const MEMORY_PROMPT_MACRO_LIMIT = readIntEnv("MEMORY_PROMPT_MACRO_LIMIT", 3, 1, 8);
const MEMORY_CONFLICT_KEEP_LIMIT = readIntEnv("MEMORY_CONFLICT_KEEP_LIMIT", 160, 30, 600);
const MEMORY_PROMPT_CONFLICT_LIMIT = readIntEnv("MEMORY_PROMPT_CONFLICT_LIMIT", 14, 3, 80);
const OPENAI_REASONING_EFFORT = normalizeReasoningEffort(process.env.OPENAI_REASONING_EFFORT || "medium", "medium");
const OPENAI_FALLBACK_MODEL = process.env.OPENAI_FALLBACK_MODEL || "gpt-4o-mini";

const TOKEN_PATTERN = /[a-z0-9][a-z0-9'-]*/gi;

function normalizeToken(rawToken) {
  return rawToken.toLowerCase().replace(/(^'+|'+$)/g, "");
}

function normalizeCanonicalText(rawText, maxLen = 180) {
  return rawText
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

function isHighValueToken(token) {
  if (!token || token.length < 3) {
    return false;
  }

  if (STOP_WORDS.has(token)) {
    return false;
  }

  if (/^\d+$/.test(token)) {
    return false;
  }

  return true;
}

function scoreToken(token, occurrences) {
  const lengthBoost = Math.min(token.length, 12) / 12;
  return Number((occurrences * (1 + lengthBoost)).toFixed(4));
}

function extractTokenEntries(text, turn) {
  const matches = text.match(TOKEN_PATTERN) || [];
  const counts = new Map();

  for (const match of matches) {
    const token = normalizeToken(match);
    if (!isHighValueToken(token)) {
      continue;
    }

    counts.set(token, (counts.get(token) || 0) + 1);
  }

  return [...counts.entries()]
    .map(([token, occurrences]) => ({
      token,
      occurrences,
      weight: scoreToken(token, occurrences),
      lastTurn: turn
    }))
    .sort((a, b) => b.weight - a.weight || b.occurrences - a.occurrences || a.token.localeCompare(b.token))
    .slice(0, 24);
}

function collapseTokenEntries(entries) {
  const grouped = new Map();

  for (const entry of entries) {
    const existing = grouped.get(entry.token);
    if (!existing) {
      grouped.set(entry.token, { ...entry });
      continue;
    }

    existing.occurrences += entry.occurrences;
    existing.weight += entry.weight;
    existing.lastTurn = Math.max(existing.lastTurn, entry.lastTurn);
  }

  return [...grouped.values()];
}

function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function classifySemanticSentence(sentence) {
  const lower = sentence.toLowerCase();

  if (/\?/.test(sentence) || /\b(how|what|why|which|who|where|when)\b/.test(lower)) {
    return { itemType: "open_question", confidence: 0.62, status: "open" };
  }

  if (/\b(hypothesis|hypothesize|hypothesized|theory|we suspect|we predict|i predict|suggests that)\b/.test(lower)) {
    return { itemType: "hypothesis", confidence: 0.67, status: "active" };
  }

  if (/\b(we should|we need to|we will|let's|i propose|we agree|decision|decide|agreed)\b/.test(lower)) {
    return { itemType: "decision", confidence: 0.68, status: "active" };
  }

  if (/\b(constraint|must|cannot|can't|should not|limit|budget|deadline|latency|security|privacy|compliance)\b/.test(lower)) {
    return { itemType: "constraint", confidence: 0.66, status: "active" };
  }

  if (/\b(define|defined as|means|definition|term)\b/.test(lower)) {
    return { itemType: "definition", confidence: 0.64, status: "active" };
  }

  return null;
}

function scoreSemantic(sentence, baseConfidence) {
  const tokenCount = sentence.split(/\s+/).filter(Boolean).length;
  const densityBoost = Math.min(tokenCount, 24) / 16;
  return {
    weight: Number((1.0 + densityBoost).toFixed(4)),
    confidence: Number(Math.min(0.95, baseConfidence + densityBoost * 0.05).toFixed(4))
  };
}

function extractSemanticEntries(messages) {
  const items = [];

  for (const message of messages) {
    const sentences = splitSentences(message.text).slice(0, 4);

    for (const sentence of sentences) {
      if (sentence.length < 16) {
        continue;
      }

      const classification = classifySemanticSentence(sentence);
      if (!classification) {
        continue;
      }

      const canonicalText = normalizeCanonicalText(sentence);
      if (!canonicalText || canonicalText.length < 12) {
        continue;
      }

      const { weight, confidence } = scoreSemantic(sentence, classification.confidence);

      items.push({
        itemType: classification.itemType,
        canonicalText,
        evidenceText: sentence.slice(0, 240),
        weight,
        confidence,
        occurrences: 1,
        firstTurn: message.turn,
        lastTurn: message.turn,
        status: classification.status
      });
    }
  }

  const grouped = new Map();

  for (const item of items) {
    const key = `${item.itemType}:${item.canonicalText}`;
    const existing = grouped.get(key);

    if (!existing) {
      grouped.set(key, { ...item });
      continue;
    }

    existing.weight += item.weight;
    existing.occurrences += item.occurrences;
    existing.lastTurn = Math.max(existing.lastTurn, item.lastTurn);
    existing.confidence = Math.max(existing.confidence, item.confidence);
    existing.evidenceText = item.evidenceText;
  }

  return [...grouped.values()]
    .sort((a, b) => b.weight - a.weight || b.confidence - a.confidence)
    .slice(0, 30);
}

function localSummary(topic, messages) {
  const entries = collapseTokenEntries(
    messages.flatMap((message) => extractTokenEntries(message.text, message.turn))
  );
  const topTokens = entries
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 12)
    .map((entry) => entry.token)
    .join(", ");

  const checkpoints = [];
  if (messages.length > 0) {
    checkpoints.push(messages[0]);
  }
  if (messages.length > 2) {
    checkpoints.push(messages[Math.floor(messages.length / 2)]);
  }
  if (messages.length > 1) {
    checkpoints.push(messages[messages.length - 1]);
  }

  const narrative = checkpoints
    .map((message) => `${message.speaker} highlighted ${message.text.slice(0, 90).trim()}`)
    .join("; ");

  return [
    `Topic focus: ${topic}.`,
    topTokens ? `High-value tokens: ${topTokens}.` : "High-value tokens: none yet.",
    narrative ? `Progress narrative: ${narrative}.` : "Progress narrative: no major updates."
  ].join(" ");
}

function formatSummaryInput(messages) {
  return messages
    .map((message) => `Turn ${message.turn} | ${message.speaker}: ${message.text}`)
    .join("\n");
}

async function summarizeChunk({ topic, messages, client, model }) {
  if (!messages.length) {
    return "";
  }

  if (!client) {
    return localSummary(topic, messages);
  }

  try {
    const result = await createChatCompletionWithFallback({
      client,
      model,
      fallbackModel: OPENAI_FALLBACK_MODEL,
      reasoningEffort: OPENAI_REASONING_EFFORT,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "You are Agent Archivist. Compress conversation memory. Keep only durable context. Ignore filler words, punctuation-only cues, and stylistic fluff. Return <= 110 words in plain text."
        },
        {
          role: "user",
          content: [
            `Topic: ${topic}`,
            "Conversation segment:",
            formatSummaryInput(messages),
            "Output requirements:",
            "1) Mention decisions, constraints, open questions.",
            "2) Mention key entities/terms only.",
            "3) No bullets; one compact paragraph."
          ].join("\n")
        }
      ]
    });

    return extractAssistantText(result.completion) || localSummary(topic, messages);
  } catch {
    return localSummary(topic, messages);
  }
}

function compactLine(text, maxLen = 240) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

function localTierSummary(topic, tier, summaries) {
  const labels = summaries.map((item) => `turns ${item.startTurn}-${item.endTurn}`).join(", ");
  const condensed = summaries
    .map((item) => compactLine(item.summary, 120))
    .filter(Boolean)
    .slice(0, 4)
    .join(" | ");

  return compactLine(
    `${tier.toUpperCase()} memory for ${topic}. Covers ${labels}. Key durable context: ${condensed}`,
    800
  );
}

function summarizeTierInput(summaries) {
  return summaries
    .map((item, index) => `S${index + 1} (${item.startTurn}-${item.endTurn}): ${item.summary}`)
    .join("\n");
}

async function summarizeTierChunk({ topic, tier, summaries, client, model }) {
  if (!summaries.length) {
    return "";
  }

  if (!client) {
    return localTierSummary(topic, tier, summaries);
  }

  try {
    const result = await createChatCompletionWithFallback({
      client,
      model,
      fallbackModel: OPENAI_FALLBACK_MODEL,
      reasoningEffort: OPENAI_REASONING_EFFORT,
      temperature: 0.12,
      messages: [
        {
          role: "system",
          content:
            "You are Memory Compactor. Merge summaries into a durable, high-signal context block. Keep decisions, constraints, conflicts, unresolved questions, and critical definitions."
        },
        {
          role: "user",
          content: [
            `Topic: ${topic}`,
            `Target tier: ${tier}`,
            "Summaries to merge:",
            summarizeTierInput(summaries),
            "Output requirements:",
            "- <= 130 words",
            "- dense, compact plain text",
            "- keep only durable context"
          ].join("\n")
        }
      ]
    });

    return extractAssistantText(result.completion) || localTierSummary(topic, tier, summaries);
  } catch {
    return localTierSummary(topic, tier, summaries);
  }
}

function newestEndTurn(items) {
  if (!items.length) {
    return 0;
  }
  return Number(items[items.length - 1]?.endTurn || 0);
}

async function maybeCreateTierCompactions({ conversationId, topic, client, model }) {
  const microSummaries = getRecentSummaries(conversationId, 30);
  if (microSummaries.length < MEMORY_MESO_GROUP_SIZE) {
    return;
  }

  let mesoSummaries = getRecentTierSummaries(conversationId, "meso", 80);
  let mesoLastEnd = newestEndTurn(mesoSummaries);
  let pendingMicro = microSummaries.filter((item) => Number(item.endTurn || 0) > mesoLastEnd);

  while (pendingMicro.length >= MEMORY_MESO_GROUP_SIZE) {
    const group = pendingMicro.slice(0, MEMORY_MESO_GROUP_SIZE);
    const summary = await summarizeTierChunk({
      topic,
      tier: "meso",
      summaries: group,
      client,
      model
    });
    insertTierSummary(
      conversationId,
      "meso",
      Number(group[0]?.startTurn || 0),
      Number(group[group.length - 1]?.endTurn || 0),
      summary
    );
    mesoLastEnd = Number(group[group.length - 1]?.endTurn || mesoLastEnd);
    pendingMicro = pendingMicro.filter((item) => Number(item.endTurn || 0) > mesoLastEnd);
  }

  mesoSummaries = getRecentTierSummaries(conversationId, "meso", 80);
  if (mesoSummaries.length < MEMORY_MACRO_GROUP_SIZE) {
    return;
  }

  const macroSummaries = getRecentTierSummaries(conversationId, "macro", 80);
  let macroLastEnd = newestEndTurn(macroSummaries);
  let pendingMeso = mesoSummaries.filter((item) => Number(item.endTurn || 0) > macroLastEnd);

  while (pendingMeso.length >= MEMORY_MACRO_GROUP_SIZE) {
    const group = pendingMeso.slice(0, MEMORY_MACRO_GROUP_SIZE);
    const summary = await summarizeTierChunk({
      topic,
      tier: "macro",
      summaries: group,
      client,
      model
    });
    insertTierSummary(
      conversationId,
      "macro",
      Number(group[0]?.startTurn || 0),
      Number(group[group.length - 1]?.endTurn || 0),
      summary
    );
    macroLastEnd = Number(group[group.length - 1]?.endTurn || macroLastEnd);
    pendingMeso = pendingMeso.filter((item) => Number(item.endTurn || 0) > macroLastEnd);
  }
}

function tokenizeForConflict(text) {
  return normalizeCanonicalText(text, 220)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 && !STOP_WORDS.has(token));
}

function containsNegation(text) {
  return /\b(not|never|cannot|can't|without|avoid|against|reject)\b/.test(
    String(text || "").toLowerCase()
  );
}

function detectConflictEntries(semanticItems) {
  const candidates = (semanticItems || [])
    .filter((item) => ["decision", "constraint", "definition"].includes(item.itemType))
    .slice(0, 70);
  const conflicts = [];

  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const a = candidates[i];
      const b = candidates[j];
      const tokensA = tokenizeForConflict(a.canonicalText || a.evidenceText);
      const tokensB = tokenizeForConflict(b.canonicalText || b.evidenceText);
      if (tokensA.length === 0 || tokensB.length === 0) {
        continue;
      }

      const setB = new Set(tokensB);
      const shared = tokensA.filter((token) => setB.has(token));
      if (shared.length < 3) {
        continue;
      }

      const negationMismatch =
        containsNegation(a.evidenceText || a.canonicalText) !== containsNegation(b.evidenceText || b.canonicalText);
      if (!negationMismatch) {
        continue;
      }

      const issueKey = `${a.itemType}|${b.itemType}|${shared.slice(0, 6).join("-")}`.slice(0, 220);
      const confidence = Math.min(
        0.96,
        0.46 + shared.length * 0.07 + Math.max(Number(a.confidence || 0), Number(b.confidence || 0)) * 0.2
      );
      conflicts.push({
        issueKey,
        itemA: compactLine(a.evidenceText || a.canonicalText, 220),
        itemB: compactLine(b.evidenceText || b.canonicalText, 220),
        confidence: Number(confidence.toFixed(4)),
        status: "open",
        firstTurn: Math.min(Number(a.firstTurn || 0), Number(b.firstTurn || 0)),
        lastTurn: Math.max(Number(a.lastTurn || 0), Number(b.lastTurn || 0)),
        occurrences: 1
      });
    }
  }

  const dedup = new Map();
  for (const conflict of conflicts) {
    if (!dedup.has(conflict.issueKey)) {
      dedup.set(conflict.issueKey, conflict);
      continue;
    }

    const existing = dedup.get(conflict.issueKey);
    existing.confidence = Math.max(existing.confidence, conflict.confidence);
    existing.lastTurn = Math.max(existing.lastTurn, conflict.lastTurn);
    existing.occurrences += 1;
  }

  return [...dedup.values()]
    .sort((a, b) => b.confidence - a.confidence || b.lastTurn - a.lastTurn)
    .slice(0, 80);
}

function updateConflictLedger(conversationId) {
  const semantic = getTopSemanticItems(conversationId, Math.min(MEMORY_SEMANTIC_KEEP_LIMIT, 80));
  const conflicts = detectConflictEntries(semantic);
  if (conflicts.length > 0) {
    upsertConflictLedger(conversationId, conflicts);
  }
  pruneConflictLedger(conversationId, MEMORY_CONFLICT_KEEP_LIMIT);
}

function updateHighValueTokens(conversationId, entries) {
  const tokenEntries = collapseTokenEntries(
    entries.flatMap((entry) => extractTokenEntries(entry.text, entry.turn))
  );

  if (!tokenEntries.length) {
    return;
  }

  upsertMemoryTokens(conversationId, tokenEntries);
  pruneMemoryTokens(conversationId, MEMORY_TOKEN_KEEP_LIMIT);
}

function updateSemanticMemory(conversationId, entries) {
  const semanticEntries = extractSemanticEntries(entries);
  if (semanticEntries.length) {
    upsertSemanticItems(conversationId, semanticEntries);
    pruneSemanticItems(conversationId, MEMORY_SEMANTIC_KEEP_LIMIT);
  }

  updateConflictLedger(conversationId);
}

async function maybeCreateSummaries({ conversationId, topic, totalTurns, client, model }) {
  if (totalTurns < MEMORY_MIN_TURNS_FOR_SUMMARY) {
    return;
  }

  let lastSummaryTurn = getLastSummaryTurn(conversationId);

  while (totalTurns - lastSummaryTurn >= MEMORY_SUMMARY_WINDOW_TURNS) {
    const startTurn = lastSummaryTurn + 1;
    const endTurn = startTurn + MEMORY_SUMMARY_WINDOW_TURNS - 1;
    const segmentMessages = getMessagesInRange(conversationId, startTurn, endTurn);

    if (!segmentMessages.length) {
      break;
    }

    const summary = await summarizeChunk({
      topic,
      messages: segmentMessages,
      client,
      model
    });

    insertSummary(conversationId, startTurn, endTurn, summary);
    lastSummaryTurn = endTurn;
  }
}

async function bootstrapMemoryIfNeeded({ conversationId, topic, transcript, client, model }) {
  const stats = getMemoryStats(conversationId);
  if (stats.tokenCount === 0 && transcript.length > 0) {
    updateHighValueTokens(conversationId, transcript);
  }

  if (stats.semanticCount === 0 && transcript.length > 0) {
    updateSemanticMemory(conversationId, transcript);
  }

  if (stats.conflictCount === 0 && transcript.length > 0) {
    updateConflictLedger(conversationId);
  }

  await maybeCreateSummaries({
    conversationId,
    topic,
    totalTurns: transcript.length,
    client,
    model
  });
  await maybeCreateTierCompactions({
    conversationId,
    topic,
    client,
    model
  });

  return getMemoryStats(conversationId);
}

async function runMemoryAgent({ conversationId, topic, newEntries, totalTurns, client, model }) {
  if (newEntries.length > 0) {
    updateHighValueTokens(conversationId, newEntries);
    updateSemanticMemory(conversationId, newEntries);
  }

  await maybeCreateSummaries({
    conversationId,
    topic,
    totalTurns,
    client,
    model
  });
  await maybeCreateTierCompactions({
    conversationId,
    topic,
    client,
    model
  });

  return getMemoryStats(conversationId);
}

function groupSemanticItems(semantic) {
  return {
    hypotheses: semantic.filter((item) => item.itemType === "hypothesis").slice(0, 6),
    decisions: semantic.filter((item) => item.itemType === "decision").slice(0, 6),
    constraints: semantic.filter((item) => item.itemType === "constraint").slice(0, 6),
    definitions: semantic.filter((item) => item.itemType === "definition").slice(0, 6),
    openQuestions: semantic.filter((item) => item.itemType === "open_question").slice(0, 6)
  };
}

function getCompressedMemory(conversationId) {
  const tokens = getTopMemoryTokens(conversationId, MEMORY_PROMPT_TOKEN_LIMIT);
  const summaries = getRecentSummaries(conversationId, MEMORY_SUMMARY_LIMIT);
  const mesoSummaries = getRecentTierSummaries(conversationId, "meso", MEMORY_PROMPT_MESO_LIMIT);
  const macroSummaries = getRecentTierSummaries(conversationId, "macro", MEMORY_PROMPT_MACRO_LIMIT);
  const semantic = getTopSemanticItems(conversationId, MEMORY_PROMPT_SEMANTIC_LIMIT);
  const conflicts = getConflictLedger(conversationId, MEMORY_PROMPT_CONFLICT_LIMIT);
  const stats = getMemoryStats(conversationId);

  return {
    tokens,
    summaries,
    tierSummaries: {
      micro: summaries,
      meso: mesoSummaries,
      macro: macroSummaries
    },
    semantic,
    conflicts,
    groupedSemantic: groupSemanticItems(semantic),
    stats
  };
}

function formatSemanticLines(items) {
  if (!items.length) {
    return "(none)";
  }

  return items
    .map((item, idx) => `${idx + 1}. ${item.canonicalText}`)
    .join("\n");
}

function buildContextBlock({ topic, transcript, memory, moderatorDirective, charter, brief }) {
  const recentTurns = transcript.slice(-10);
  const tokenLine = (memory.tokens || []).map((item) => item.token).join(", ");
  const summaries = memory.summaries || [];
  const tiers = memory.tierSummaries || {
    micro: summaries,
    meso: [],
    macro: []
  };
  const grouped = memory.groupedSemantic || {
    hypotheses: [],
    decisions: [],
    constraints: [],
    definitions: [],
    openQuestions: []
  };
  const conflicts = memory.conflicts || [];

  const summaryLines = summaries.map(
    (summary, idx) => `S${idx + 1} (turns ${summary.startTurn}-${summary.endTurn}): ${summary.summary}`
  );
  const mesoLines = (tiers.meso || []).map(
    (summary, idx) => `M${idx + 1} (turns ${summary.startTurn}-${summary.endTurn}): ${summary.summary}`
  );
  const macroLines = (tiers.macro || []).map(
    (summary, idx) => `X${idx + 1} (turns ${summary.startTurn}-${summary.endTurn}): ${summary.summary}`
  );
  const conflictLines = conflicts.map(
    (item, idx) =>
      `${idx + 1}. (${item.status || "open"}, conf ${Number(item.confidence || 0).toFixed(2)}) ${item.itemA} <> ${item.itemB}`
  );
  const recentTranscript = recentTurns
    .map((entry) => `${entry.speaker}: ${entry.text}`)
    .join("\n");

  const charterBlock = charter
    .map((line, idx) => `${idx + 1}) ${line}`)
    .join("\n");

  const objective = brief?.objective || "(no explicit objective)";
  const constraints = brief?.constraintsText || "(no explicit constraints)";
  const doneCriteria = brief?.doneCriteria || "(no explicit done criteria)";

  return [
    `Topic: ${topic}`,
    "Conversation brief:",
    `Objective: ${objective}`,
    `Constraints: ${constraints}`,
    `Done criteria: ${doneCriteria}`,
    "Discussion charter:",
    charterBlock,
    tokenLine ? `High-value memory tokens: ${tokenLine}` : "High-value memory tokens: (none yet)",
    summaryLines.length > 0
      ? ["Summary memory:", ...summaryLines].join("\n")
      : "Summary memory: (no summary snapshots yet)",
    mesoLines.length > 0
      ? ["Meso memory:", ...mesoLines].join("\n")
      : "Meso memory: (no meso compaction yet)",
    macroLines.length > 0
      ? ["Macro memory:", ...macroLines].join("\n")
      : "Macro memory: (no macro compaction yet)",
    "Semantic memory: decisions",
    formatSemanticLines(grouped.decisions),
    "Semantic memory: hypotheses",
    formatSemanticLines(grouped.hypotheses),
    "Semantic memory: constraints",
    formatSemanticLines(grouped.constraints),
    "Semantic memory: definitions",
    formatSemanticLines(grouped.definitions),
    "Semantic memory: open questions",
    formatSemanticLines(grouped.openQuestions),
    conflictLines.length > 0 ? ["Conflict ledger:", ...conflictLines].join("\n") : "Conflict ledger: (none detected)",
    moderatorDirective
      ? `Moderator directive: ${moderatorDirective}`
      : "Moderator directive: continue depth-first reasoning and avoid repetition.",
    "Recent turns:",
    recentTranscript || "(No recent turns)",
    "Instructions:",
    "1) Continue only this topic.",
    "2) Reuse relevant high-value memory when answering.",
    "3) Keep reply to 2-4 conversational sentences.",
    "4) Respond to the previous point directly, then add one fresh relevant idea.",
    "5) Avoid repetitive template openers and formal proposal wording every turn.",
    "6) Suggest a concrete next step only when it naturally moves the thread forward.",
    "7) If the objective is completed, start the reply with DONE: and a concise closing statement."
  ].join("\n");
}

export {
  bootstrapMemoryIfNeeded,
  buildContextBlock,
  getCompressedMemory,
  runMemoryAgent
};
