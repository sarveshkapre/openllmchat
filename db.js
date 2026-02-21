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

  CREATE INDEX IF NOT EXISTS idx_memory_tokens_conversation_weight
    ON memory_tokens(conversation_id, weight DESC, last_turn DESC);

  CREATE INDEX IF NOT EXISTS idx_conversation_summaries_range
    ON conversation_summaries(conversation_id, end_turn DESC);
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

const getMemoryStatsStmt = db.prepare(`
  SELECT
    COALESCE((SELECT COUNT(*) FROM memory_tokens WHERE conversation_id = @conversationId), 0) AS tokenCount,
    COALESCE((SELECT COUNT(*) FROM conversation_summaries WHERE conversation_id = @conversationId), 0) AS summaryCount,
    COALESCE((SELECT MAX(end_turn) FROM conversation_summaries WHERE conversation_id = @conversationId), 0) AS lastSummaryTurn
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
  insertMessages,
  insertSummary,
  listConversations,
  pruneMemoryTokens,
  upsertMemoryTokens
};
