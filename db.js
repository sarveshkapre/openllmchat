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
    title TEXT NOT NULL DEFAULT '',
    starred INTEGER NOT NULL DEFAULT 0,
    mode TEXT NOT NULL DEFAULT 'exploration',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS conversation_briefs (
    conversation_id TEXT PRIMARY KEY,
    objective TEXT NOT NULL DEFAULT '',
    constraints_text TEXT NOT NULL DEFAULT '',
    done_criteria TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS conversation_agents (
    conversation_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    name TEXT NOT NULL,
    style TEXT NOT NULL,
    temperature REAL NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (conversation_id, agent_id),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
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

  CREATE TABLE IF NOT EXISTS retrieval_sources (
    conversation_id TEXT NOT NULL,
    turn INTEGER NOT NULL,
    reference_id TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'wikipedia',
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    snippet TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (conversation_id, turn, reference_id),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS claim_citations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    turn INTEGER NOT NULL,
    speaker_id TEXT NOT NULL,
    claim_text TEXT NOT NULL,
    citation_id TEXT NOT NULL,
    citation_title TEXT NOT NULL,
    citation_url TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    UNIQUE(conversation_id, turn, claim_text, citation_url)
  );

  CREATE INDEX IF NOT EXISTS idx_memory_tokens_conversation_weight
    ON memory_tokens(conversation_id, weight DESC, last_turn DESC);

  CREATE INDEX IF NOT EXISTS idx_conversation_summaries_range
    ON conversation_summaries(conversation_id, end_turn DESC);

  CREATE INDEX IF NOT EXISTS idx_semantic_memory_weight
    ON semantic_memory(conversation_id, item_type, weight DESC, last_turn DESC);

  CREATE INDEX IF NOT EXISTS idx_retrieval_sources_turn
    ON retrieval_sources(conversation_id, turn DESC, confidence DESC);

  CREATE INDEX IF NOT EXISTS idx_claim_citations_turn
    ON claim_citations(conversation_id, turn DESC, confidence DESC);
`);

function ensureColumnExists(tableName, columnName, typeSql) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const hasColumn = columns.some((column) => column.name === columnName);
  if (!hasColumn) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${typeSql}`);
  }
}

ensureColumnExists("conversations", "parent_conversation_id", "TEXT");
ensureColumnExists("conversations", "fork_from_turn", "INTEGER");
ensureColumnExists("conversations", "title", "TEXT NOT NULL DEFAULT ''");
ensureColumnExists("conversations", "starred", "INTEGER NOT NULL DEFAULT 0");
ensureColumnExists("conversations", "mode", "TEXT NOT NULL DEFAULT 'exploration'");
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_conversations_parent
    ON conversations(parent_conversation_id, fork_from_turn);
  CREATE INDEX IF NOT EXISTS idx_conversations_starred_updated
    ON conversations(starred DESC, updated_at DESC);
`);

const getConversationStmt = db.prepare(`
  SELECT
    id,
    topic,
    title,
    starred,
    mode,
    parent_conversation_id AS parentConversationId,
    fork_from_turn AS forkFromTurn,
    created_at AS createdAt,
    updated_at AS updatedAt
  FROM conversations
  WHERE id = ?
`);

const createConversationStmt = db.prepare(`
  INSERT INTO conversations (id, topic, parent_conversation_id, fork_from_turn)
  VALUES (@id, @topic, @parentConversationId, @forkFromTurn)
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

const listMessagesUpToTurnStmt = db.prepare(`
  SELECT turn, speaker, speaker_id AS speakerId, text, created_at AS createdAt
  FROM messages
  WHERE conversation_id = @conversationId
    AND turn <= @maxTurn
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
    c.title,
    c.starred,
    c.mode,
    c.parent_conversation_id AS parentConversationId,
    c.fork_from_turn AS forkFromTurn,
    c.created_at AS createdAt,
    c.updated_at AS updatedAt,
    COALESCE(MAX(m.turn), 0) AS totalTurns,
    CASE
      WHEN b.objective <> '' OR b.constraints_text <> '' OR b.done_criteria <> '' THEN 1
      ELSE 0
    END AS hasBrief,
    CASE
      WHEN COUNT(a.agent_id) > 0 THEN 1
      ELSE 0
    END AS hasCustomAgents
  FROM conversations c
  LEFT JOIN messages m ON m.conversation_id = c.id
  LEFT JOIN conversation_briefs b ON b.conversation_id = c.id
  LEFT JOIN conversation_agents a ON a.conversation_id = c.id
  GROUP BY c.id
  ORDER BY c.starred DESC, c.updated_at DESC
  LIMIT ?
`);

const updateConversationMetaStmt = db.prepare(`
  UPDATE conversations
  SET
    title = @title,
    starred = @starred,
    mode = @mode,
    updated_at = CURRENT_TIMESTAMP
  WHERE id = @conversationId
`);

const getConversationBriefStmt = db.prepare(`
  SELECT
    objective,
    constraints_text AS constraintsText,
    done_criteria AS doneCriteria,
    updated_at AS updatedAt
  FROM conversation_briefs
  WHERE conversation_id = ?
`);

const upsertConversationBriefStmt = db.prepare(`
  INSERT INTO conversation_briefs (
    conversation_id,
    objective,
    constraints_text,
    done_criteria
  )
  VALUES (
    @conversationId,
    @objective,
    @constraintsText,
    @doneCriteria
  )
  ON CONFLICT(conversation_id) DO UPDATE SET
    objective = excluded.objective,
    constraints_text = excluded.constraints_text,
    done_criteria = excluded.done_criteria,
    updated_at = CURRENT_TIMESTAMP
`);

const listConversationAgentsStmt = db.prepare(`
  SELECT
    agent_id AS agentId,
    name,
    style,
    temperature,
    updated_at AS updatedAt
  FROM conversation_agents
  WHERE conversation_id = ?
  ORDER BY agent_id ASC
`);

const upsertConversationAgentStmt = db.prepare(`
  INSERT INTO conversation_agents (
    conversation_id,
    agent_id,
    name,
    style,
    temperature
  )
  VALUES (
    @conversationId,
    @agentId,
    @name,
    @style,
    @temperature
  )
  ON CONFLICT(conversation_id, agent_id) DO UPDATE SET
    name = excluded.name,
    style = excluded.style,
    temperature = excluded.temperature,
    updated_at = CURRENT_TIMESTAMP
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

const upsertRetrievalSourceStmt = db.prepare(`
  INSERT INTO retrieval_sources (
    conversation_id,
    turn,
    reference_id,
    provider,
    title,
    url,
    snippet,
    confidence
  )
  VALUES (
    @conversationId,
    @turn,
    @referenceId,
    @provider,
    @title,
    @url,
    @snippet,
    @confidence
  )
  ON CONFLICT(conversation_id, turn, reference_id) DO UPDATE SET
    provider = excluded.provider,
    title = excluded.title,
    url = excluded.url,
    snippet = excluded.snippet,
    confidence = excluded.confidence
`);

const listRecentRetrievalSourcesStmt = db.prepare(`
  SELECT
    turn,
    reference_id AS referenceId,
    provider,
    title,
    url,
    snippet,
    confidence,
    created_at AS createdAt
  FROM retrieval_sources
  WHERE conversation_id = ?
  ORDER BY turn DESC, reference_id ASC
  LIMIT ?
`);

const insertClaimCitationStmt = db.prepare(`
  INSERT OR IGNORE INTO claim_citations (
    conversation_id,
    turn,
    speaker_id,
    claim_text,
    citation_id,
    citation_title,
    citation_url,
    confidence
  )
  VALUES (
    @conversationId,
    @turn,
    @speakerId,
    @claimText,
    @citationId,
    @citationTitle,
    @citationUrl,
    @confidence
  )
`);

const listRecentClaimCitationsStmt = db.prepare(`
  SELECT
    turn,
    speaker_id AS speakerId,
    claim_text AS claimText,
    citation_id AS citationId,
    citation_title AS citationTitle,
    citation_url AS citationUrl,
    confidence,
    created_at AS createdAt
  FROM claim_citations
  WHERE conversation_id = ?
  ORDER BY turn DESC, confidence DESC
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

const upsertConversationAgentsTx = db.transaction((conversationId, agents) => {
  for (const agent of agents) {
    upsertConversationAgentStmt.run({
      conversationId,
      agentId: agent.agentId,
      name: agent.name,
      style: agent.style,
      temperature: agent.temperature
    });
  }
});

const upsertRetrievalSourcesTx = db.transaction((conversationId, turn, sources) => {
  for (const source of sources) {
    upsertRetrievalSourceStmt.run({
      conversationId,
      turn,
      referenceId: source.referenceId,
      provider: source.provider || "wikipedia",
      title: source.title || "",
      url: source.url || "",
      snippet: source.snippet || "",
      confidence: Number(source.confidence || 0)
    });
  }
});

const insertClaimCitationsTx = db.transaction((conversationId, entries) => {
  for (const entry of entries) {
    insertClaimCitationStmt.run({
      conversationId,
      turn: entry.turn,
      speakerId: entry.speakerId,
      claimText: entry.claimText,
      citationId: entry.citationId,
      citationTitle: entry.citationTitle || "",
      citationUrl: entry.citationUrl || "",
      confidence: Number(entry.confidence || 0)
    });
  }
});

function getConversation(conversationId) {
  const row = getConversationStmt.get(conversationId);
  if (!row) {
    return null;
  }

  return {
    ...row,
    starred: Boolean(row.starred),
    mode: row.mode || "exploration"
  };
}

function createConversation(conversationId, topic, options = {}) {
  createConversationStmt.run({
    id: conversationId,
    topic,
    parentConversationId: options.parentConversationId || null,
    forkFromTurn: Number.isFinite(options.forkFromTurn) ? options.forkFromTurn : null
  });
  return getConversation(conversationId);
}

function getMessages(conversationId) {
  return listMessagesStmt.all(conversationId);
}

function getMessagesUpToTurn(conversationId, maxTurn) {
  return listMessagesUpToTurnStmt.all({ conversationId, maxTurn });
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
  return listConversationsStmt.all(safeLimit).map((row) => ({
    ...row,
    starred: Boolean(row.starred),
    mode: row.mode || "exploration",
    hasBrief: Boolean(row.hasBrief),
    hasCustomAgents: Boolean(row.hasCustomAgents)
  }));
}

function getConversationBrief(conversationId) {
  return (
    getConversationBriefStmt.get(conversationId) || {
      objective: "",
      constraintsText: "",
      doneCriteria: "",
      updatedAt: null
    }
  );
}

function upsertConversationBrief(conversationId, brief) {
  upsertConversationBriefStmt.run({
    conversationId,
    objective: brief.objective || "",
    constraintsText: brief.constraintsText || "",
    doneCriteria: brief.doneCriteria || ""
  });
}

function updateConversationMeta(conversationId, meta) {
  updateConversationMetaStmt.run({
    conversationId,
    title: meta.title || "",
    starred: meta.starred ? 1 : 0,
    mode: meta.mode || "exploration"
  });
}

function getConversationAgents(conversationId) {
  return listConversationAgentsStmt.all(conversationId);
}

function upsertConversationAgents(conversationId, agents) {
  if (!Array.isArray(agents) || agents.length === 0) {
    return;
  }

  upsertConversationAgentsTx(conversationId, agents);
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

function upsertRetrievalSources(conversationId, turn, sources) {
  if (!Array.isArray(sources) || sources.length === 0 || !Number.isFinite(Number(turn))) {
    return;
  }

  const prepared = sources
    .map((source) => ({
      referenceId: String(source.id || source.referenceId || "").trim(),
      provider: String(source.provider || "wikipedia").trim(),
      title: String(source.title || "").trim().slice(0, 180),
      url: String(source.url || "").trim().slice(0, 500),
      snippet: String(source.snippet || "").replace(/\s+/g, " ").trim().slice(0, 320),
      confidence: Number(source.confidence || 0)
    }))
    .filter((source) => source.referenceId && source.title && source.url);

  if (!prepared.length) {
    return;
  }

  upsertRetrievalSourcesTx(conversationId, Math.max(0, Math.trunc(Number(turn))), prepared);
}

function getRecentRetrievalSources(conversationId, limit = 30) {
  const safeLimit = Math.max(1, Math.min(120, Number(limit) || 30));
  return listRecentRetrievalSourcesStmt.all(conversationId, safeLimit);
}

function insertClaimCitations(conversationId, entries) {
  if (!Array.isArray(entries) || !entries.length) {
    return;
  }

  const prepared = entries
    .map((entry) => ({
      turn: Number.isFinite(Number(entry.turn)) ? Math.max(0, Math.trunc(Number(entry.turn))) : 0,
      speakerId: String(entry.speakerId || "").trim().slice(0, 40),
      claimText: String(entry.claimText || "").replace(/\s+/g, " ").trim().slice(0, 320),
      citationId: String(entry.citationId || "").trim().slice(0, 24),
      citationTitle: String(entry.citationTitle || "").replace(/\s+/g, " ").trim().slice(0, 180),
      citationUrl: String(entry.citationUrl || "").trim().slice(0, 500),
      confidence: Number(entry.confidence || 0)
    }))
    .filter((entry) => entry.turn > 0 && entry.speakerId && entry.claimText && entry.citationId && entry.citationUrl);

  if (!prepared.length) {
    return;
  }

  insertClaimCitationsTx(conversationId, prepared);
}

function getRecentClaimCitations(conversationId, limit = 60) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 60));
  return listRecentClaimCitationsStmt.all(conversationId, safeLimit);
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
  getConversationBrief,
  getConversationAgents,
  getRecentClaimCitations,
  getRecentRetrievalSources,
  getLastSummaryTurn,
  getMemoryStats,
  getMessages,
  getMessagesUpToTurn,
  getMessagesInRange,
  getRecentSummaries,
  getTopMemoryTokens,
  getTopSemanticItems,
  insertMessages,
  insertClaimCitations,
  insertSummary,
  listConversations,
  pruneMemoryTokens,
  pruneSemanticItems,
  updateConversationMeta,
  upsertConversationBrief,
  upsertConversationAgents,
  upsertMemoryTokens,
  upsertRetrievalSources,
  upsertSemanticItems
};
