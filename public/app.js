const form = document.querySelector("#conversation-form");
const topicInput = document.querySelector("#topic");
const turnsInput = document.querySelector("#turns");
const startBtn = document.querySelector("#start-btn");
const newThreadBtn = document.querySelector("#new-thread-btn");
const sidebarToggleBtn = document.querySelector("#sidebar-toggle");
const themeToggleBtn = document.querySelector("#theme-toggle");
const refreshHistoryBtn = document.querySelector("#refresh-history-btn");
const statusEl = document.querySelector("#status");
const engineChipEl = document.querySelector("#engine-chip");
const turnChipEl = document.querySelector("#turn-chip");
const transcriptEl = document.querySelector("#transcript");
const historyStatusEl = document.querySelector("#history-status");
const historyListEl = document.querySelector("#history-list");
const shellEl = document.querySelector(".shell");

const CONVERSATION_ID_KEY = "openllmchat:min:conversationId";
const TOPIC_KEY = "openllmchat:min:topic";
const THEME_KEY = "openllmchat:min:theme";
const SIDEBAR_COLLAPSED_KEY = "openllmchat:min:sidebarCollapsed";

let activeConversationId = localStorage.getItem(CONVERSATION_ID_KEY) || "";
let activeTopic = localStorage.getItem(TOPIC_KEY) || "";
let displayedTranscript = [];
let cachedConversations = [];
let sidebarCollapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";

function setStatus(text) {
  statusEl.textContent = text;
}

function setEngineChip(text) {
  engineChipEl.textContent = `Engine: ${text || "waiting"}`;
}

function setTurnChip(turns) {
  turnChipEl.textContent = `Turns: ${Number(turns || 0)}`;
}

function setHistoryStatus(text) {
  historyStatusEl.textContent = text;
}

function clearConversationState() {
  activeConversationId = "";
  activeTopic = "";
  localStorage.removeItem(CONVERSATION_ID_KEY);
  localStorage.removeItem(TOPIC_KEY);
}

function setConversationState(conversationId, topic) {
  activeConversationId = String(conversationId || "");
  activeTopic = String(topic || "");
  localStorage.setItem(CONVERSATION_ID_KEY, activeConversationId);
  localStorage.setItem(TOPIC_KEY, activeTopic);
}

function renderEmpty(message = "No messages yet.") {
  transcriptEl.innerHTML = "";
  displayedTranscript = [];
  const item = document.createElement("li");
  item.className = "empty";
  item.textContent = message;
  transcriptEl.appendChild(item);
}

function appendMessage(entry) {
  const empty = transcriptEl.querySelector(".empty");
  if (empty) {
    empty.remove();
  }

  const item = document.createElement("li");
  item.className = "message";

  const head = document.createElement("div");
  head.className = "message-head";

  const speaker = document.createElement("span");
  speaker.className = "speaker";
  speaker.textContent = entry.speaker || "Agent";

  const turn = document.createElement("span");
  turn.className = "turn";
  turn.textContent = `Turn ${Number(entry.turn || displayedTranscript.length + 1)}`;

  head.appendChild(speaker);
  head.appendChild(turn);

  const text = document.createElement("p");
  text.textContent = entry.text || "";

  item.appendChild(head);
  item.appendChild(text);
  transcriptEl.appendChild(item);

  displayedTranscript.push(entry);
  setTurnChip(displayedTranscript.length);
  item.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderTranscript(entries) {
  transcriptEl.innerHTML = "";
  displayedTranscript = [];

  if (!Array.isArray(entries) || entries.length === 0) {
    renderEmpty();
    return;
  }

  for (const entry of entries) {
    appendMessage(entry);
  }
}

function normalizeTheme(value) {
  return value === "dark" ? "dark" : "light";
}

function parseTurns(value) {
  const turns = Number(value);
  if (!Number.isFinite(turns)) {
    return 10;
  }
  return Math.max(2, Math.min(10, Math.trunc(turns)));
}

function applySidebarCollapsed(collapsed) {
  sidebarCollapsed = Boolean(collapsed);
  shellEl.classList.toggle("sidebar-collapsed", sidebarCollapsed);
  sidebarToggleBtn.textContent = sidebarCollapsed ? "Show threads" : "Hide threads";
  localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? "1" : "0");
}

function applyTheme(theme) {
  const resolved = normalizeTheme(theme);
  document.documentElement.setAttribute("data-theme", resolved);
  themeToggleBtn.textContent = resolved === "dark" ? "Light theme" : "Dark theme";
  localStorage.setItem(THEME_KEY, resolved);
}

function jsonRequestOptions(method = "GET", body) {
  const options = { method };
  if (body !== undefined) {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(body);
  }
  return options;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  const isJson = contentType.includes("application/json");
  const result = isJson ? await response.json() : null;

  if (!response.ok) {
    throw new Error(result?.error || `Request failed (${response.status})`);
  }

  return result;
}

function formatUpdatedAt(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }

  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function renderHistory(conversations) {
  historyListEl.innerHTML = "";
  if (!conversations.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No threads yet.";
    historyListEl.appendChild(empty);
    setHistoryStatus("0 threads");
    return;
  }

  for (const conversation of conversations) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "history-item";

    if (conversation.id === activeConversationId) {
      button.classList.add("active");
    }

    const title = document.createElement("span");
    title.className = "history-title";
    title.textContent = conversation.title || conversation.topic;

    const meta = document.createElement("span");
    meta.className = "history-meta";
    meta.textContent = `${conversation.totalTurns || 0} turns • ${formatUpdatedAt(conversation.updatedAt)}`;

    button.appendChild(title);
    button.appendChild(meta);

    button.addEventListener("click", async () => {
      if (conversation.id === activeConversationId) {
        return;
      }

      try {
        setStatus("Loading thread...");
        await loadConversation(conversation.id);
        await loadHistory();
      } catch (error) {
        setStatus(error.message || "Could not load thread.");
      }
    });

    item.appendChild(button);
    historyListEl.appendChild(item);
  }

  setHistoryStatus(`${conversations.length} threads`);
}

async function loadHistory() {
  try {
    const result = await fetchJson("/api/conversations?limit=30");
    cachedConversations = Array.isArray(result.conversations) ? result.conversations : [];
    renderHistory(cachedConversations);
  } catch {
    cachedConversations = [];
    historyListEl.innerHTML = "";
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "History unavailable.";
    historyListEl.appendChild(empty);
    setHistoryStatus("History unavailable");
  }
}

async function loadConversation(conversationId) {
  const result = await fetchJson(`/api/conversation/${encodeURIComponent(conversationId)}`);
  setConversationState(result.conversationId, result.topic);
  topicInput.value = result.topic || "";
  renderTranscript(result.transcript || []);
  setEngineChip("restored");
  setTurnChip(result.totalTurns || (result.transcript || []).length);
  setStatus(`Restored ${result.totalTurns || 0} turns.`);
}

async function runConversation(topic, turns) {
  const payload = {
    topic,
    turns,
    conversationId: activeConversationId || undefined
  };

  startBtn.disabled = true;
  setStatus(
    activeConversationId
      ? `Continuing thread for ${turns} turns...`
      : `Running conversation for ${turns} turns...`
  );

  try {
    const response = await fetch("/api/conversation/stream", jsonRequestOptions("POST", payload));
    if (!response.ok) {
      const errorPayload = await response.json().catch(() => null);
      throw new Error(errorPayload?.error || "Generation failed.");
    }

    if (!response.body) {
      throw new Error("Streaming is not supported in this browser.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let generatedTurns = 0;
    let totalTurns = displayedTranscript.length;
    let stopReason = "max_turns";

    if (!activeConversationId) {
      renderEmpty("Generating...");
    }

    const handleChunk = (chunk) => {
      if (chunk.type === "meta") {
        setConversationState(chunk.conversationId, chunk.topic);
        topicInput.value = chunk.topic || topic;
        setEngineChip(chunk.engine || "running");
        return;
      }

      if (chunk.type === "turn") {
        if (chunk.entry) {
          appendMessage(chunk.entry);
          generatedTurns += 1;
        }
        totalTurns = Number(chunk.totalTurns || totalTurns);
        return;
      }

      if (chunk.type === "done") {
        totalTurns = Number(chunk.totalTurns || totalTurns);
        stopReason = chunk.stopReason || stopReason;
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          handleChunk(JSON.parse(line));
        }
        newlineIndex = buffer.indexOf("\n");
      }
    }

    const tail = buffer.trim();
    if (tail) {
      handleChunk(JSON.parse(tail));
    }

    setTurnChip(totalTurns);
    setStatus(
      `Added ${generatedTurns} turns. Total: ${totalTurns}.${
        stopReason && stopReason !== "max_turns" ? ` Stop reason: ${stopReason}.` : ""
      } Saved in Threads.`
    );
    await loadHistory();
  } catch (error) {
    if (!displayedTranscript.length) {
      renderEmpty();
    }
    setStatus(error.message || "Could not generate conversation.");
  } finally {
    startBtn.disabled = false;
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const topic = String(topicInput.value || "").trim();
  const turns = parseTurns(turnsInput.value);
  turnsInput.value = String(turns);
  if (!topic) {
    setStatus("Please enter a topic.");
    return;
  }

  if (activeTopic && topic !== activeTopic) {
    clearConversationState();
    renderEmpty();
    setTurnChip(0);
  }

  await runConversation(topic, turns);
});

newThreadBtn.addEventListener("click", async () => {
  clearConversationState();
  topicInput.value = "";
  renderEmpty("New thread started.");
  setEngineChip("waiting");
  setTurnChip(0);
  setStatus("Enter a topic and run.");
  await loadHistory();
});

refreshHistoryBtn.addEventListener("click", async () => {
  setHistoryStatus("Refreshing...");
  await loadHistory();
});

themeToggleBtn.addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme") || "light";
  applyTheme(current === "dark" ? "light" : "dark");
});

sidebarToggleBtn.addEventListener("click", () => {
  applySidebarCollapsed(!sidebarCollapsed);
});

(function init() {
  const savedTheme = normalizeTheme(localStorage.getItem(THEME_KEY) || "light");
  applyTheme(savedTheme);
  applySidebarCollapsed(sidebarCollapsed);

  renderEmpty();
  setEngineChip("waiting");
  setTurnChip(0);
  setStatus("Enter a topic and run.");

  const initialTopic = localStorage.getItem(TOPIC_KEY) || "";
  if (initialTopic) {
    topicInput.value = initialTopic;
  }

  loadHistory();

  if (activeConversationId) {
    loadConversation(activeConversationId).catch(() => {
      clearConversationState();
      renderEmpty("Saved thread not found.");
      setStatus("Enter a topic and run.");
    });
  }
})();
