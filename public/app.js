const form = document.querySelector("#conversation-form");
const topicInput = document.querySelector("#topic");
const startBtn = document.querySelector("#start-btn");
const clearBtn = document.querySelector("#clear-btn");
const transcriptEl = document.querySelector("#transcript");
const statusEl = document.querySelector("#status");
const engineChipEl = document.querySelector("#engine-chip");

const CONVERSATION_ID_KEY = "openllmchat:conversationId";
const TOPIC_KEY = "openllmchat:topic";

let activeConversationId = localStorage.getItem(CONVERSATION_ID_KEY) || "";
let activeTopic = localStorage.getItem(TOPIC_KEY) || "";

function setStatus(text) {
  statusEl.textContent = text;
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

async function restoreConversation() {
  if (!activeConversationId) {
    clearTranscript("Enter a topic to begin.");
    return;
  }

  setStatus("Loading previous conversation...");

  try {
    const response = await fetch(`/api/conversation/${encodeURIComponent(activeConversationId)}`);
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Could not restore conversation");
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
  } catch (error) {
    clearConversationState();
    clearTranscript("Saved conversation was not found. Start a new topic.");
    engineChipEl.textContent = "Engine: waiting";
  }
}

clearBtn.addEventListener("click", () => {
  clearConversationState();
  topicInput.value = "";
  clearTranscript();
  engineChipEl.textContent = "Engine: waiting";
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
  } catch (error) {
    if (String(error.message || "").toLowerCase().includes("not found")) {
      clearConversationState();
    }

    if (!transcriptEl.children.length) {
      clearTranscript("Generation failed.");
    }
    setStatus(error.message || "Could not generate conversation.");
  } finally {
    startBtn.disabled = false;
  }
});

restoreConversation();
