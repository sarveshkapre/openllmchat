const form = document.querySelector("#conversation-form");
const topicInput = document.querySelector("#topic");
const startBtn = document.querySelector("#start-btn");
const clearBtn = document.querySelector("#clear-btn");
const transcriptEl = document.querySelector("#transcript");
const statusEl = document.querySelector("#status");
const engineChipEl = document.querySelector("#engine-chip");

function setStatus(text) {
  statusEl.textContent = text;
}

function clearTranscript(message = "Transcript cleared.") {
  transcriptEl.innerHTML = "";
  const empty = document.createElement("li");
  empty.className = "empty";
  empty.textContent = "No messages yet.";
  transcriptEl.appendChild(empty);
  setStatus(message);
}

function appendMessage(entry) {
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

  transcriptEl.appendChild(item);
  item.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

clearTranscript("Enter a topic to begin.");

clearBtn.addEventListener("click", () => {
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

  startBtn.disabled = true;
  setStatus("Agents are reasoning through all 10 turns...");
  transcriptEl.innerHTML = "";

  try {
    const response = await fetch("/api/conversation", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        topic,
        turns: 10
      })
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Request failed");
    }

    engineChipEl.textContent = `Engine: ${result.engine}`;

    for (const entry of result.transcript) {
      appendMessage(entry);
      await new Promise((resolve) => setTimeout(resolve, 180));
    }

    setStatus(`Completed ${result.turns} turns on topic: ${result.topic}`);
  } catch (error) {
    clearTranscript("Generation failed.");
    setStatus(error.message || "Could not generate conversation.");
  } finally {
    startBtn.disabled = false;
  }
});
