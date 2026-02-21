import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const dbPath = process.env.SQLITE_PATH || path.join(process.cwd(), "data", "openllmchat.db");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    turn INTEGER NOT NULL,
    speaker TEXT NOT NULL,
    speaker_id TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    UNIQUE(conversation_id, turn)
  );

  CREATE TABLE IF NOT EXISTS memory_tokens (
    conversation_id TEXT NOT NULL,
    token TEXT NOT NULL,
    weight REAL NOT NULL DEFAULT 0,
    occurrences INTEGER NOT NULL DEFAULT 0,
    last_turn INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (conversation_id, token),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS conversation_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    start_turn INTEGER NOT NULL,
    end_turn INTEGER NOT NULL,
    summary TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    UNIQUE (conversation_id, start_turn, end_turn)
  );

  CREATE TABLE IF NOT EXISTS semantic_memory (
    conversation_id TEXT NOT NULL,
    item_type TEXT NOT NULL,
    canonical_text TEXT NOT NULL,
    evidence_text TEXT NOT NULL,
    weight REAL NOT NULL DEFAULT 0,
    confidence REAL NOT NULL DEFAULT 0,
    occurrences INTEGER NOT NULL DEFAULT 0,
    first_turn INTEGER NOT NULL,
    last_turn INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (conversation_id, item_type, canonical_text),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_memory_tokens_conversation_weight
    ON memory_tokens(conversation_id, weight DESC, last_turn DESC);

  CREATE INDEX IF NOT EXISTS idx_conversation_summaries_range
    ON conversation_summaries(conversation_id, end_turn DESC);

  CREATE INDEX IF NOT EXISTS idx_semantic_memory_weight
    ON semantic_memory(conversation_id, item_type, weight DESC, last_turn DESC);
`);

const getConversationStmt = db.prepare(`
  SELECT id, topic, created_at AS createdAt, updated_at AS updatedAt
  FROM conversations
  WHERE id = ?
`);

const createConversationStmt = db.prepare(`
  INSERT INTO conversations (id, topic)
  VALUES (@id, @topic)
`);

const touchConversationStmt = db.prepare(`
  UPDATE conversations
  SET updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
`);

const listMessagesStmt = db.prepare(`
  SELECT turn, speaker, speaker_id AS speakerId, text, created_at AS createdAt
  FROM messages
  WHERE conversation_id = ?
  ORDER BY turn ASC
`);

const listMessagesInRangeStmt = db.prepare(`
  SELECT turn, speaker, speaker_id AS speakerId, text, created_at AS createdAt
  FROM messages
  WHERE conversation_id = @conversationId
    AND turn BETWEEN @startTurn AND @endTurn
  ORDER BY turn ASC
`);

const insertMessageStmt = db.prepare(`
  INSERT INTO messages (conversation_id, turn, speaker, speaker_id, text)
  VALUES (@conversationId, @turn, @speaker, @speakerId, @text)
`);

const listConversationsStmt = db.prepare(`
  SELECT
    c.id,
    c.topic,
    c.created_at AS createdAt,
    c.updated_at AS updatedAt,
    COALESCE(MAX(m.turn), 0) AS totalTurns
  FROM conversations c
  LEFT JOIN messages m ON m.conversation_id = c.id
  GROUP BY c.id
  ORDER BY c.updated_at DESC
  LIMIT ?
`);

const upsertMemoryTokenStmt = db.prepare(`
  INSERT INTO memory_tokens (
    conversation_id,
    token,
    weight,
    occurrences,
    last_turn
  )
  VALUES (@conversationId, @token, @weight, @occurrences, @lastTurn)
  ON CONFLICT(conversation_id, token) DO UPDATE SET
    weight = memory_tokens.weight + excluded.weight,
    occurrences = memory_tokens.occurrences + excluded.occurrences,
    last_turn = MAX(memory_tokens.last_turn, excluded.last_turn),
    updated_at = CURRENT_TIMESTAMP
`);

const pruneMemoryTokensStmt = db.prepare(`
  DELETE FROM memory_tokens
  WHERE conversation_id = @conversationId
    AND token IN (
      SELECT token
      FROM memory_tokens
      WHERE conversation_id = @conversationId
      ORDER BY weight DESC, last_turn DESC, token ASC
      LIMIT -1 OFFSET @keepLimit
    )
`);

const listMemoryTokensStmt = db.prepare(`
  SELECT token, weight, occurrences, last_turn AS lastTurn
  FROM memory_tokens
  WHERE conversation_id = ?
  ORDER BY weight DESC, last_turn DESC, token ASC
  LIMIT ?
`);

const upsertSemanticMemoryStmt = db.prepare(`
  INSERT INTO semantic_memory (
    conversation_id,
    item_type,
    canonical_text,
    evidence_text,
    weight,
    confidence,
    occurrences,
    first_turn,
    last_turn,
    status
  )
  VALUES (
    @conversationId,
    @itemType,
    @canonicalText,
    @evidenceText,
    @weight,
    @confidence,
    @occurrences,
    @firstTurn,
    @lastTurn,
    @status
  )
  ON CONFLICT(conversation_id, item_type, canonical_text) DO UPDATE SET
    evidence_text = excluded.evidence_text,
    weight = semantic_memory.weight + excluded.weight,
    confidence = MAX(semantic_memory.confidence, excluded.confidence),
    occurrences = semantic_memory.occurrences + excluded.occurrences,
    first_turn = MIN(semantic_memory.first_turn, excluded.first_turn),
    last_turn = MAX(semantic_memory.last_turn, excluded.last_turn),
    status = excluded.status,
    updated_at = CURRENT_TIMESTAMP
`);

const pruneSemanticMemoryStmt = db.prepare(`
  DELETE FROM semantic_memory
  WHERE conversation_id = @conversationId
    AND (item_type || ':' || canonical_text) IN (
      SELECT item_type || ':' || canonical_text
      FROM semantic_memory
      WHERE conversation_id = @conversationId
      ORDER BY weight DESC, last_turn DESC, canonical_text ASC
      LIMIT -1 OFFSET @keepLimit
    )
`);

const listSemanticMemoryStmt = db.prepare(`
  SELECT
    item_type AS itemType,
    canonical_text AS canonicalText,
    evidence_text AS evidenceText,
    weight,
    confidence,
    occurrences,
    first_turn AS firstTurn,
    last_turn AS lastTurn,
    status,
    updated_at AS updatedAt
  FROM semantic_memory
  WHERE conversation_id = ?
  ORDER BY weight DESC, last_turn DESC, canonical_text ASC
  LIMIT ?
`);

const getMemoryStatsStmt = db.prepare(`
  SELECT
    COALESCE((SELECT COUNT(*) FROM memory_tokens WHERE conversation_id = @conversationId), 0) AS tokenCount,
    COALESCE((SELECT COUNT(*) FROM conversation_summaries WHERE conversation_id = @conversationId), 0) AS summaryCount,
    COALESCE((SELECT MAX(end_turn) FROM conversation_summaries WHERE conversation_id = @conversationId), 0) AS lastSummaryTurn,
    COALESCE((SELECT COUNT(*) FROM semantic_memory WHERE conversation_id = @conversationId), 0) AS semanticCount,
    COALESCE((SELECT COUNT(*) FROM semantic_memory WHERE conversation_id = @conversationId AND item_type = 'decision'), 0) AS decisionCount,
    COALESCE((SELECT COUNT(*) FROM semantic_memory WHERE conversation_id = @conversationId AND item_type = 'open_question'), 0) AS openQuestionCount,
    COALESCE((SELECT COUNT(*) FROM semantic_memory WHERE conversation_id = @conversationId AND item_type = 'constraint'), 0) AS constraintCount,
    COALESCE((SELECT COUNT(*) FROM semantic_memory WHERE conversation_id = @conversationId AND item_type = 'definition'), 0) AS definitionCount
`);

const getLastSummaryTurnStmt = db.prepare(`
  SELECT COALESCE(MAX(end_turn), 0) AS lastSummaryTurn
  FROM conversation_summaries
  WHERE conversation_id = ?
`);

const insertSummaryStmt = db.prepare(`
  INSERT OR IGNORE INTO conversation_summaries (
    conversation_id,
    start_turn,
    end_turn,
    summary
  )
  VALUES (@conversationId, @startTurn, @endTurn, @summary)
`);

const listRecentSummariesStmt = db.prepare(`
  SELECT start_turn AS startTurn, end_turn AS endTurn, summary, created_at AS createdAt
  FROM conversation_summaries
  WHERE conversation_id = ?
  ORDER BY end_turn DESC
  LIMIT ?
`);

const insertMessagesTx = db.transaction((conversationId, entries) => {
  for (const entry of entries) {
    insertMessageStmt.run({
      conversationId,
      turn: entry.turn,
      speaker: entry.speaker,
      speakerId: entry.speakerId,
      text: entry.text
    });
  }

  touchConversationStmt.run(conversationId);
});

const upsertMemoryTokensTx = db.transaction((conversationId, entries) => {
  for (const entry of entries) {
    upsertMemoryTokenStmt.run({
      conversationId,
      token: entry.token,
      weight: entry.weight,
      occurrences: entry.occurrences,
      lastTurn: entry.lastTurn
    });
  }
});

const upsertSemanticMemoryTx = db.transaction((conversationId, entries) => {
  for (const entry of entries) {
    upsertSemanticMemoryStmt.run({
      conversationId,
      itemType: entry.itemType,
      canonicalText: entry.canonicalText,
      evidenceText: entry.evidenceText,
      weight: entry.weight,
      confidence: entry.confidence,
      occurrences: entry.occurrences,
      firstTurn: entry.firstTurn,
      lastTurn: entry.lastTurn,
      status: entry.status
    });
  }
});

function getConversation(conversationId) {
  return getConversationStmt.get(conversationId) || null;
}

function createConversation(conversationId, topic) {
  createConversationStmt.run({ id: conversationId, topic });
  return getConversation(conversationId);
}

function getMessages(conversationId) {
  return listMessagesStmt.all(conversationId);
}

function getMessagesInRange(conversationId, startTurn, endTurn) {
  return listMessagesInRangeStmt.all({ conversationId, startTurn, endTurn });
}

function insertMessages(conversationId, entries) {
  if (!entries.length) {
    return;
  }

  insertMessagesTx(conversationId, entries);
}

function listConversations(limit = 20) {
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
  return listConversationsStmt.all(safeLimit);
}

function upsertMemoryTokens(conversationId, entries) {
  if (!entries.length) {
    return;
  }

  upsertMemoryTokensTx(conversationId, entries);
}

function pruneMemoryTokens(conversationId, keepLimit = 180) {
  const safeKeepLimit = Math.max(20, Math.min(500, Number(keepLimit) || 180));
  pruneMemoryTokensStmt.run({ conversationId, keepLimit: safeKeepLimit });
}

function getTopMemoryTokens(conversationId, limit = 50) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  return listMemoryTokensStmt.all(conversationId, safeLimit);
}

function upsertSemanticItems(conversationId, entries) {
  if (!entries.length) {
    return;
  }

  upsertSemanticMemoryTx(conversationId, entries);
}

function pruneSemanticItems(conversationId, keepLimit = 240) {
  const safeKeepLimit = Math.max(40, Math.min(800, Number(keepLimit) || 240));
  pruneSemanticMemoryStmt.run({ conversationId, keepLimit: safeKeepLimit });
}

function getTopSemanticItems(conversationId, limit = 24) {
  const safeLimit = Math.max(1, Math.min(120, Number(limit) || 24));
  return listSemanticMemoryStmt.all(conversationId, safeLimit);
}

function getMemoryStats(conversationId) {
  return getMemoryStatsStmt.get({ conversationId });
}

function getLastSummaryTurn(conversationId) {
  const row = getLastSummaryTurnStmt.get(conversationId);
  return Number(row?.lastSummaryTurn || 0);
}

function insertSummary(conversationId, startTurn, endTurn, summary) {
  if (!summary) {
    return;
  }

  insertSummaryStmt.run({
    conversationId,
    startTurn,
    endTurn,
    summary
  });
}

function getRecentSummaries(conversationId, limit = 6) {
  const safeLimit = Math.max(1, Math.min(30, Number(limit) || 6));
  const rows = listRecentSummariesStmt.all(conversationId, safeLimit);
  return rows.reverse();
}

export {
  createConversation,
  dbPath,
  getConversation,
  getLastSummaryTurn,
  getMemoryStats,
  getMessages,
  getMessagesInRange,
  getRecentSummaries,
  getTopMemoryTokens,
  getTopSemanticItems,
  insertMessages,
  insertSummary,
  listConversations,
  pruneMemoryTokens,
  pruneSemanticItems,
  upsertMemoryTokens,
  upsertSemanticItems
};
