const form = document.querySelector("#conversation-form");
const topicInput = document.querySelector("#topic");
const startBtn = document.querySelector("#start-btn");
const clearBtn = document.querySelector("#clear-btn");
const refreshHistoryBtn = document.querySelector("#refresh-history-btn");
const transcriptEl = document.querySelector("#transcript");
const statusEl = document.querySelector("#status");
const engineChipEl = document.querySelector("#engine-chip");
const historyListEl = document.querySelector("#history-list");
const historyStatusEl = document.querySelector("#history-status");

const CONVERSATION_ID_KEY = "openllmchat:conversationId";
const TOPIC_KEY = "openllmchat:topic";

let activeConversationId = localStorage.getItem(CONVERSATION_ID_KEY) || "";
let activeTopic = localStorage.getItem(TOPIC_KEY) || "";

function setStatus(text) {
  statusEl.textContent = text;
}

function setHistoryStatus(text) {
  historyStatusEl.textContent = text;
}

function setConversationState(conversationId, topic) {
  activeConversationId = conversationId;
  activeTopic = topic;
  localStorage.setItem(CONVERSATION_ID_KEY, conversationId);
  localStorage.setItem(TOPIC_KEY, topic);
}

function clearConversationState() {
  activeConversationId = "";
  activeTopic = "";
  localStorage.removeItem(CONVERSATION_ID_KEY);
  localStorage.removeItem(TOPIC_KEY);
}

function renderEmpty(message = "No messages yet.") {
  transcriptEl.innerHTML = "";
  const empty = document.createElement("li");
  empty.className = "empty";
  empty.textContent = message;
  transcriptEl.appendChild(empty);
}

function clearTranscript(message = "Transcript cleared.") {
  renderEmpty();
  setStatus(message);
}

function appendMessage(entry, animate = true) {
  const empty = transcriptEl.querySelector(".empty");
  if (empty) {
    empty.remove();
  }

  const item = document.createElement("li");
  item.className = "message";

  const speakerClass = entry.speakerId === "agent-a" ? "speaker-atlas" : "speaker-nova";
  const head = document.createElement("div");
  head.className = "message-head";

  const speaker = document.createElement("span");
  speaker.className = speakerClass;
  speaker.textContent = entry.speaker;

  const turn = document.createElement("span");
  turn.className = "turn";
  turn.textContent = `Turn ${entry.turn}`;

  const text = document.createElement("p");
  text.textContent = entry.text;

  head.appendChild(speaker);
  head.appendChild(turn);
  item.appendChild(head);
  item.appendChild(text);

  if (!animate) {
    item.style.animation = "none";
    item.style.opacity = "1";
    item.style.transform = "translateY(0)";
  }

  transcriptEl.appendChild(item);
  item.scrollIntoView({ behavior: animate ? "smooth" : "auto", block: "nearest" });
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

async function loadConversation(conversationId) {
  const response = await fetch(`/api/conversation/${encodeURIComponent(conversationId)}`);
  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || "Could not load conversation");
  }

  topicInput.value = result.topic;
  setConversationState(result.conversationId, result.topic);

  if (!result.transcript.length) {
    renderEmpty();
  } else {
    transcriptEl.innerHTML = "";
    for (const entry of result.transcript) {
      appendMessage(entry, false);
    }
  }

  setStatus(`Restored ${result.totalTurns} turns on topic: ${result.topic}`);
  engineChipEl.textContent = "Engine: restored thread";
}

function renderHistory(conversations) {
  historyListEl.innerHTML = "";

  if (!conversations.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No saved threads yet.";
    historyListEl.appendChild(empty);
    setHistoryStatus("0 saved threads");
    return;
  }

  for (const conversation of conversations) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "thread-item";

    if (conversation.id === activeConversationId) {
      button.classList.add("active");
    }

    const topic = document.createElement("span");
    topic.className = "thread-topic";
    topic.textContent = conversation.topic;

    const meta = document.createElement("span");
    meta.className = "thread-meta";
    meta.textContent = `${conversation.totalTurns} turns • ${formatUpdatedAt(conversation.updatedAt)}`;

    button.appendChild(topic);
    button.appendChild(meta);
    button.addEventListener("click", async () => {
      if (conversation.id === activeConversationId) {
        return;
      }

      try {
        setStatus("Loading selected thread...");
        await loadConversation(conversation.id);
        await loadHistory();
      } catch (error) {
        setStatus(error.message || "Could not switch thread.");
      }
    });

    li.appendChild(button);
    historyListEl.appendChild(li);
  }

  setHistoryStatus(`${conversations.length} saved threads`);
}

async function loadHistory() {
  try {
    const response = await fetch("/api/conversations?limit=30");
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Could not load history");
    }

    renderHistory(result.conversations || []);
  } catch (error) {
    historyListEl.innerHTML = "";
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "History unavailable.";
    historyListEl.appendChild(empty);
    setHistoryStatus("History unavailable");
  }
}

async function restoreConversation() {
  if (!activeConversationId) {
    clearTranscript("Enter a topic to begin.");
    return;
  }

  setStatus("Loading previous conversation...");

  try {
    await loadConversation(activeConversationId);
  } catch (error) {
    clearConversationState();
    clearTranscript("Saved conversation was not found. Start a new topic.");
    engineChipEl.textContent = "Engine: waiting";
  }
}

refreshHistoryBtn.addEventListener("click", async () => {
  setHistoryStatus("Refreshing...");
  await loadHistory();
});

clearBtn.addEventListener("click", async () => {
  clearConversationState();
  topicInput.value = "";
  clearTranscript("Started a fresh thread.");
  engineChipEl.textContent = "Engine: waiting";
  await loadHistory();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const topic = topicInput.value.trim();
  if (!topic) {
    setStatus("Please enter a topic.");
    return;
  }

  const switchingTopic = Boolean(activeConversationId && activeTopic && topic !== activeTopic);
  if (switchingTopic) {
    clearConversationState();
    transcriptEl.innerHTML = "";
  }

  const conversationId = activeConversationId || undefined;

  if (!conversationId) {
    transcriptEl.innerHTML = "";
  }

  startBtn.disabled = true;
  setStatus(
    conversationId
      ? "Agents are continuing this thread for 10 more turns..."
      : "Agents are reasoning through all 10 turns..."
  );

  try {
    const response = await fetch("/api/conversation", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        topic,
        turns: 10,
        conversationId
      })
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Request failed");
    }

    setConversationState(result.conversationId, result.topic);
    engineChipEl.textContent = `Engine: ${result.engine}`;

    for (const entry of result.transcript) {
      appendMessage(entry);
      await new Promise((resolve) => setTimeout(resolve, 180));
    }

    setStatus(`Added ${result.turns} turns. Total turns: ${result.totalTurns}. Topic: ${result.topic}`);
    await loadHistory();
  } catch (error) {
    if (String(error.message || "").toLowerCase().includes("not found")) {
      clearConversationState();
      await loadHistory();
    }

    if (!transcriptEl.children.length) {
      clearTranscript("Generation failed.");
    }
    setStatus(error.message || "Could not generate conversation.");
  } finally {
    startBtn.disabled = false;
  }
});

(async () => {
  await loadHistory();
  await restoreConversation();
})();
