const form = document.querySelector("#conversation-form");
const topicInput = document.querySelector("#topic");
const startBtn = document.querySelector("#start-btn");
const clearBtn = document.querySelector("#clear-btn");
const saveBriefBtn = document.querySelector("#save-brief-btn");
const copyBtn = document.querySelector("#copy-btn");
const downloadBtn = document.querySelector("#download-btn");
const refreshHistoryBtn = document.querySelector("#refresh-history-btn");
const objectiveInput = document.querySelector("#objective");
const constraintsInput = document.querySelector("#constraints");
const doneCriteriaInput = document.querySelector("#done-criteria");
const transcriptEl = document.querySelector("#transcript");
const statusEl = document.querySelector("#status");
const engineChipEl = document.querySelector("#engine-chip");
const memoryChipEl = document.querySelector("#memory-chip");
const historyListEl = document.querySelector("#history-list");
const historyStatusEl = document.querySelector("#history-status");

const CONVERSATION_ID_KEY = "openllmchat:conversationId";
const TOPIC_KEY = "openllmchat:topic";

let activeConversationId = localStorage.getItem(CONVERSATION_ID_KEY) || "";
let activeTopic = localStorage.getItem(TOPIC_KEY) || "";
let displayedTranscript = [];
let memoryState = null;

function setStatus(text) {
  statusEl.textContent = text;
}

function setHistoryStatus(text) {
  historyStatusEl.textContent = text;
}

function setMemoryChip(memory) {
  memoryState = memory || null;
  if (!memoryState) {
    memoryChipEl.textContent = "Memory: waiting";
    return;
  }

  const tokens = Number(memoryState.tokenCount || 0);
  const summaries = Number(memoryState.summaryCount || 0);
  const semantic = Number(memoryState.semanticCount || 0);
  memoryChipEl.textContent = `Memory: ${tokens} tokens • ${summaries} summaries • ${semantic} semantic`;
}

function setConversationState(conversationId, topic) {
  activeConversationId = conversationId;
  activeTopic = topic;
  localStorage.setItem(CONVERSATION_ID_KEY, conversationId);
  localStorage.setItem(TOPIC_KEY, topic);
}

function getBriefPayload() {
  return {
    objective: objectiveInput.value.trim(),
    constraintsText: constraintsInput.value.trim(),
    doneCriteria: doneCriteriaInput.value.trim()
  };
}

function setBriefFields(brief) {
  objectiveInput.value = brief?.objective || "";
  constraintsInput.value = brief?.constraintsText || "";
  doneCriteriaInput.value = brief?.doneCriteria || "";
}

function clearConversationState() {
  activeConversationId = "";
  activeTopic = "";
  localStorage.removeItem(CONVERSATION_ID_KEY);
  localStorage.removeItem(TOPIC_KEY);
}

function renderEmpty(message = "No messages yet.") {
  transcriptEl.innerHTML = "";
  displayedTranscript = [];
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

  const turnGroup = document.createElement("span");
  turnGroup.className = "turn-group";

  const turn = document.createElement("span");
  turn.className = "turn";
  turn.textContent = `Turn ${entry.turn}`;

  const forkBtn = document.createElement("button");
  forkBtn.type = "button";
  forkBtn.className = "fork-turn-btn secondary";
  forkBtn.textContent = "Fork here";
  forkBtn.addEventListener("click", async () => {
    await forkConversation(entry.turn);
  });

  const text = document.createElement("p");
  text.textContent = entry.text;

  head.appendChild(speaker);
  turnGroup.appendChild(turn);
  turnGroup.appendChild(forkBtn);
  head.appendChild(turnGroup);
  item.appendChild(head);
  item.appendChild(text);

  if (!animate) {
    item.style.animation = "none";
    item.style.opacity = "1";
    item.style.transform = "translateY(0)";
  }

  transcriptEl.appendChild(item);
  displayedTranscript.push(entry);
  item.scrollIntoView({ behavior: animate ? "smooth" : "auto", block: "nearest" });
}

async function forkConversation(turn) {
  if (!activeConversationId) {
    setStatus("Start a thread before forking.");
    return;
  }

  try {
    setStatus(`Forking thread from turn ${turn}...`);
    const response = await fetch(`/api/conversation/${encodeURIComponent(activeConversationId)}/fork`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ turn })
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Could not fork conversation");
    }

    topicInput.value = result.topic;
    setConversationState(result.conversationId, result.topic);
    setBriefFields(result.brief || null);
    setMemoryChip(result.memory || null);

    if (!result.transcript.length) {
      renderEmpty();
    } else {
      transcriptEl.innerHTML = "";
      displayedTranscript = [];
      for (const entry of result.transcript) {
        appendMessage(entry, false);
      }
    }

    setStatus(`Fork created from turn ${result.forkFromTurn}. Now on new thread.`);
    await loadHistory();
  } catch (error) {
    setStatus(error.message || "Could not fork conversation.");
  }
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\\s-]/g, "")
    .trim()
    .replace(/\\s+/g, "-")
    .slice(0, 40);
}

function toMarkdownTranscript() {
  const titleTopic = activeTopic || topicInput.value.trim() || "Untitled topic";
  const lines = [
    `# openllmchat transcript`,
    ``,
    `- Topic: ${titleTopic}`,
    `- Conversation ID: ${activeConversationId || "n/a"}`,
    `- Total turns: ${displayedTranscript.length}`,
    `- Memory tokens: ${memoryState?.tokenCount || 0}`,
    `- Memory summaries: ${memoryState?.summaryCount || 0}`,
    `- Semantic memory items: ${memoryState?.semanticCount || 0}`,
    `- Objective: ${objectiveInput.value.trim() || "n/a"}`,
    `- Constraints: ${constraintsInput.value.trim() || "n/a"}`,
    `- Done criteria: ${doneCriteriaInput.value.trim() || "n/a"}`,
    ``,
    `## Turns`,
    ``
  ];

  for (const entry of displayedTranscript) {
    lines.push(`### Turn ${entry.turn} - ${entry.speaker}`);
    lines.push(entry.text);
    lines.push("");
  }

  return lines.join("\\n");
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
  setBriefFields(result.brief || null);

  if (!result.transcript.length) {
    renderEmpty();
  } else {
    transcriptEl.innerHTML = "";
    displayedTranscript = [];
    for (const entry of result.transcript) {
      appendMessage(entry, false);
    }
  }

  setStatus(`Restored ${result.totalTurns} turns on topic: ${result.topic}`);
  engineChipEl.textContent = "Engine: restored thread";
  setMemoryChip(result.memory || null);
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
    const forkMeta = conversation.parentConversationId
      ? ` • fork@${conversation.forkFromTurn ?? 0}`
      : "";
    meta.textContent = `${conversation.totalTurns} turns • ${formatUpdatedAt(conversation.updatedAt)}${
      conversation.hasBrief ? " • brief" : ""
    }${forkMeta}`;

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
    setBriefFields(null);
    setMemoryChip(null);
    return;
  }

  setStatus("Loading previous conversation...");

  try {
    await loadConversation(activeConversationId);
  } catch (error) {
    clearConversationState();
    clearTranscript("Saved conversation was not found. Start a new topic.");
    engineChipEl.textContent = "Engine: waiting";
    setBriefFields(null);
    setMemoryChip(null);
  }
}

refreshHistoryBtn.addEventListener("click", async () => {
  setHistoryStatus("Refreshing...");
  await loadHistory();
});

clearBtn.addEventListener("click", async () => {
  clearConversationState();
  topicInput.value = "";
  setBriefFields(null);
  clearTranscript("Started a fresh thread.");
  engineChipEl.textContent = "Engine: waiting";
  setMemoryChip(null);
  await loadHistory();
});

saveBriefBtn.addEventListener("click", async () => {
  const brief = getBriefPayload();

  if (!activeConversationId) {
    setStatus("Brief saved locally. Start a thread to persist it.");
    return;
  }

  try {
    const response = await fetch(`/api/conversation/${encodeURIComponent(activeConversationId)}/brief`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(brief)
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Could not save brief");
    }

    setBriefFields(result.brief || null);
    setStatus("Conversation brief saved.");
    await loadHistory();
  } catch (error) {
    setStatus(error.message || "Could not save brief.");
  }
});

copyBtn.addEventListener("click", async () => {
  if (!displayedTranscript.length) {
    setStatus("No transcript to copy yet.");
    return;
  }

  const markdown = toMarkdownTranscript();

  try {
    await navigator.clipboard.writeText(markdown);
    setStatus("Transcript copied as markdown.");
  } catch (error) {
    setStatus("Clipboard blocked. Use Download instead.");
  }
});

downloadBtn.addEventListener("click", () => {
  if (!displayedTranscript.length) {
    setStatus("No transcript to download yet.");
    return;
  }

  const markdown = toMarkdownTranscript();
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const topicSlug = slugify(activeTopic || topicInput.value || "chat");
  const fileName = `${topicSlug || "chat"}-transcript.md`;

  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  setStatus(`Downloaded ${fileName}`);
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
    displayedTranscript = [];
    setMemoryChip(null);
  }

  const conversationId = activeConversationId || undefined;
  const brief = getBriefPayload();

  if (!conversationId) {
    transcriptEl.innerHTML = "";
    displayedTranscript = [];
  }

  startBtn.disabled = true;
  setStatus(
    conversationId
      ? "Agents are continuing this thread for 10 more turns..."
      : "Agents are reasoning through all 10 turns..."
  );

  try {
    const response = await fetch("/api/conversation/stream", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        topic,
        turns: 10,
        conversationId,
        ...brief
      })
    });

    if (!response.ok) {
      const errorResult = await response.json().catch(() => null);
      throw new Error(errorResult?.error || "Request failed");
    }

    if (!response.body) {
      throw new Error("Streaming is not supported in this browser.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let generatedTurns = 0;
    let totalTurns = 0;
    let finalTopic = topic;
    let stopReason = "max_turns";
    let moderatorHint = "";

    const handleChunk = (chunk) => {
      if (chunk.type === "meta") {
        setConversationState(chunk.conversationId, chunk.topic);
        engineChipEl.textContent = `Engine: ${chunk.engine}`;
        if (chunk.brief) {
          setBriefFields(chunk.brief);
        }
        setMemoryChip(chunk.memory || null);
        finalTopic = chunk.topic || finalTopic;
        return;
      }

      if (chunk.type === "turn") {
        if (chunk.entry) {
          appendMessage(chunk.entry);
          generatedTurns += 1;
        }
        totalTurns = chunk.totalTurns ?? totalTurns;
        return;
      }

      if (chunk.type === "moderator") {
        moderatorHint = chunk.moderation?.directive || "";
        if (moderatorHint) {
          setStatus(`Moderator: ${moderatorHint}`);
        }
        return;
      }

      if (chunk.type === "done") {
        totalTurns = chunk.totalTurns ?? totalTurns;
        finalTopic = chunk.topic || finalTopic;
        if (chunk.brief) {
          setBriefFields(chunk.brief);
        }
        stopReason = chunk.stopReason || stopReason;
        setMemoryChip(chunk.memory || null);
        return;
      }

      if (chunk.type === "error") {
        throw new Error(chunk.error || "Generation failed");
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

    const reasonSuffix =
      stopReason && stopReason !== "max_turns" ? ` Stop reason: ${stopReason}.` : "";
    const moderatorSuffix = moderatorHint ? ` Last moderator hint: ${moderatorHint}` : "";

    setStatus(
      `Added ${generatedTurns} turns. Total turns: ${totalTurns}. Topic: ${finalTopic}.${reasonSuffix}${moderatorSuffix}`
    );
    await loadHistory();
  } catch (error) {
    if (String(error.message || "").toLowerCase().includes("not found")) {
      clearConversationState();
      setMemoryChip(null);
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
