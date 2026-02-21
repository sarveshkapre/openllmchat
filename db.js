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

export {
  createConversation,
  dbPath,
  getConversation,
  getMessages,
  insertMessages,
  listConversations
};
