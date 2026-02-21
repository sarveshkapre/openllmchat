const form = document.querySelector("#conversation-form");
const topicInput = document.querySelector("#topic");
const startBtn = document.querySelector("#start-btn");
const labBtn = document.querySelector("#lab-btn");
const clearBtn = document.querySelector("#clear-btn");
const saveThreadBtn = document.querySelector("#save-thread-btn");
const toggleStarBtn = document.querySelector("#toggle-star-btn");
const saveBriefBtn = document.querySelector("#save-brief-btn");
const saveAgentsBtn = document.querySelector("#save-agents-btn");
const copyBtn = document.querySelector("#copy-btn");
const downloadBtn = document.querySelector("#download-btn");
const refreshHistoryBtn = document.querySelector("#refresh-history-btn");
const historySearchInput = document.querySelector("#history-search");
const refreshMemoryBtn = document.querySelector("#refresh-memory-btn");
const refreshInsightsBtn = document.querySelector("#refresh-insights-btn");
const copyInsightsBtn = document.querySelector("#copy-insights-btn");
const openBestLabBtn = document.querySelector("#open-best-lab-btn");
const copyLabReportBtn = document.querySelector("#copy-lab-report-btn");
const objectiveInput = document.querySelector("#objective");
const constraintsInput = document.querySelector("#constraints");
const doneCriteriaInput = document.querySelector("#done-criteria");
const threadTitleInput = document.querySelector("#thread-title");
const threadModeSelect = document.querySelector("#thread-mode");
const agentANameInput = document.querySelector("#agent-a-name");
const agentATempInput = document.querySelector("#agent-a-temp");
const agentAStyleInput = document.querySelector("#agent-a-style");
const agentBNameInput = document.querySelector("#agent-b-name");
const agentBTempInput = document.querySelector("#agent-b-temp");
const agentBStyleInput = document.querySelector("#agent-b-style");
const transcriptEl = document.querySelector("#transcript");
const statusEl = document.querySelector("#status");
const engineChipEl = document.querySelector("#engine-chip");
const memoryChipEl = document.querySelector("#memory-chip");
const qualityChipEl = document.querySelector("#quality-chip");
const modeChipEl = document.querySelector("#mode-chip");
const historyListEl = document.querySelector("#history-list");
const historyStatusEl = document.querySelector("#history-status");
const memoryInspectorStatusEl = document.querySelector("#memory-inspector-status");
const memoryTokenListEl = document.querySelector("#memory-token-list");
const memorySemanticListEl = document.querySelector("#memory-semantic-list");
const memorySummaryListEl = document.querySelector("#memory-summary-list");
const insightStatusEl = document.querySelector("#insight-status");
const insightDecisionsListEl = document.querySelector("#insight-decisions-list");
const insightQuestionsListEl = document.querySelector("#insight-questions-list");
const insightNextStepsListEl = document.querySelector("#insight-next-steps-list");
const labStatusEl = document.querySelector("#lab-status");
const labResultsListEl = document.querySelector("#lab-results-list");

const CONVERSATION_ID_KEY = "openllmchat:conversationId";
const TOPIC_KEY = "openllmchat:topic";
const DRAFT_KEY = "openllmchat:draft";
const DEFAULT_THREAD_MODE = "exploration";
const DEFAULT_AGENTS = [
  {
    agentId: "agent-a",
    name: "Agent Atlas",
    style: "You are analytical, concrete, and strategic.",
    temperature: 0.45
  },
  {
    agentId: "agent-b",
    name: "Agent Nova",
    style: "You are creative, precise, and challenge assumptions with examples.",
    temperature: 0.72
  }
];

let activeConversationId = localStorage.getItem(CONVERSATION_ID_KEY) || "";
let activeTopic = localStorage.getItem(TOPIC_KEY) || "";
let activeTitle = "";
let activeStarred = false;
let activeMode = DEFAULT_THREAD_MODE;
let displayedTranscript = [];
let memoryState = null;
let qualityState = null;
let memoryInspectorState = null;
let insightState = null;
let labResultsState = [];
let cachedConversations = [];
let draftSaveTimer = null;

function setStatus(text) {
  statusEl.textContent = text;
}

function setHistoryStatus(text) {
  historyStatusEl.textContent = text;
}

function normalizeThreadTitle(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 96);
}

function normalizeThreadMode(value) {
  const mode = String(value || "")
    .trim()
    .toLowerCase();
  if (["exploration", "debate", "synthesis"].includes(mode)) {
    return mode;
  }
  return DEFAULT_THREAD_MODE;
}

function setStarButtonState(starred) {
  activeStarred = Boolean(starred);
  toggleStarBtn.dataset.starred = activeStarred ? "1" : "0";
  toggleStarBtn.textContent = activeStarred ? "Starred" : "Star";
  toggleStarBtn.classList.toggle("starred-btn", activeStarred);
}

function setThreadMeta(meta) {
  activeTitle = normalizeThreadTitle(meta?.title || "");
  activeMode = normalizeThreadMode(meta?.mode || DEFAULT_THREAD_MODE);
  threadTitleInput.value = activeTitle;
  threadModeSelect.value = activeMode;
  modeChipEl.textContent = `Mode: ${activeMode}`;
  setStarButtonState(Boolean(meta?.starred));
  scheduleDraftPersist();
}

function getThreadMetaPayload() {
  return {
    title: normalizeThreadTitle(threadTitleInput.value),
    starred: activeStarred,
    mode: normalizeThreadMode(threadModeSelect.value)
  };
}

function buildDraftState() {
  return {
    topic: topicInput.value.trim(),
    threadTitle: normalizeThreadTitle(threadTitleInput.value),
    threadStarred: activeStarred,
    threadMode: normalizeThreadMode(threadModeSelect.value),
    objective: objectiveInput.value.trim(),
    constraintsText: constraintsInput.value.trim(),
    doneCriteria: doneCriteriaInput.value.trim(),
    agents: getAgentPayload()
  };
}

function persistDraftNow() {
  localStorage.setItem(DRAFT_KEY, JSON.stringify(buildDraftState()));
}

function scheduleDraftPersist() {
  if (draftSaveTimer) {
    clearTimeout(draftSaveTimer);
  }
  draftSaveTimer = setTimeout(() => {
    persistDraftNow();
    draftSaveTimer = null;
  }, 120);
}

function clearDraftState() {
  localStorage.removeItem(DRAFT_KEY);
}

function restoreDraftState() {
  const raw = localStorage.getItem(DRAFT_KEY);
  if (!raw) {
    return;
  }

  try {
    const draft = JSON.parse(raw);
    if (draft.topic) {
      topicInput.value = String(draft.topic);
    }
    if (draft.objective || draft.constraintsText || draft.doneCriteria) {
      setBriefFields({
        objective: draft.objective || "",
        constraintsText: draft.constraintsText || "",
        doneCriteria: draft.doneCriteria || ""
      });
    }
    if (Array.isArray(draft.agents) && draft.agents.length) {
      setAgentFields(draft.agents);
    }
    setThreadMeta({
      title: draft.threadTitle || "",
      starred: Boolean(draft.threadStarred),
      mode: normalizeThreadMode(draft.threadMode || DEFAULT_THREAD_MODE)
    });
  } catch {
    clearDraftState();
  }
}

async function persistThreadMeta(meta, successMessage = "Thread settings saved.") {
  if (!activeConversationId) {
    persistDraftNow();
    setStatus("Thread settings stored locally. Start a thread to persist them.");
    return false;
  }

  const response = await fetch(`/api/conversation/${encodeURIComponent(activeConversationId)}/meta`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(meta)
  });
  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || "Could not save thread settings");
  }

  setThreadMeta({
    title: result.title || "",
    starred: Boolean(result.starred),
    mode: normalizeThreadMode(result.mode || DEFAULT_THREAD_MODE)
  });
  persistDraftNow();
  setStatus(successMessage);
  await loadHistory();
  return true;
}

function setMemoryInspectorStatus(text) {
  memoryInspectorStatusEl.textContent = text;
}

function setInsightStatus(text) {
  insightStatusEl.textContent = text;
}

function setLabStatus(text) {
  labStatusEl.textContent = text;
}

function bestLabRun() {
  if (!labResultsState.length) {
    return null;
  }
  return labResultsState
    .slice()
    .sort((a, b) => Number(b?.quality?.avgScore || 0) - Number(a?.quality?.avgScore || 0))[0];
}

function createListEmpty(label) {
  const li = document.createElement("li");
  li.className = "memory-empty";
  li.textContent = label;
  return li;
}

function clearMemoryInspector(message = "Start or restore a thread to inspect memory state.") {
  memoryInspectorState = null;
  memoryTokenListEl.innerHTML = "";
  memorySemanticListEl.innerHTML = "";
  memorySummaryListEl.innerHTML = "";
  memoryTokenListEl.appendChild(createListEmpty("No tokens yet."));
  memorySemanticListEl.appendChild(createListEmpty("No semantic items yet."));
  memorySummaryListEl.appendChild(createListEmpty("No summaries yet."));
  setMemoryInspectorStatus(message);
}

function clearInsightSnapshot(message = "Start or restore a thread to compute insights.") {
  insightState = null;
  insightDecisionsListEl.innerHTML = "";
  insightQuestionsListEl.innerHTML = "";
  insightNextStepsListEl.innerHTML = "";
  insightDecisionsListEl.appendChild(createListEmpty("No decisions yet."));
  insightQuestionsListEl.appendChild(createListEmpty("No open questions yet."));
  insightNextStepsListEl.appendChild(createListEmpty("No next steps yet."));
  setInsightStatus(message);
}

function clearLabResults(message = "Run lab to compare exploration, debate, and synthesis threads.") {
  labResultsState = [];
  labResultsListEl.innerHTML = "";
  labResultsListEl.appendChild(createListEmpty("No lab runs yet."));
  setLabStatus(message);
}

function renderTokenMemory(tokens) {
  memoryTokenListEl.innerHTML = "";
  if (!tokens.length) {
    memoryTokenListEl.appendChild(createListEmpty("No tokens yet."));
    return;
  }

  for (const token of tokens) {
    const li = document.createElement("li");
    li.className = "memory-item";

    const title = document.createElement("span");
    title.className = "memory-item-title";
    title.textContent = token.token;

    const meta = document.createElement("span");
    meta.className = "memory-item-meta";
    meta.textContent = `w:${Number(token.weight || 0).toFixed(2)} • seen:${token.occurrences || 0}`;

    li.appendChild(title);
    li.appendChild(meta);
    memoryTokenListEl.appendChild(li);
  }
}

function semanticLabel(itemType) {
  if (itemType === "open_question") {
    return "open question";
  }
  return itemType.replaceAll("_", " ");
}

function renderSemanticMemory(semantic) {
  memorySemanticListEl.innerHTML = "";
  if (!semantic.length) {
    memorySemanticListEl.appendChild(createListEmpty("No semantic items yet."));
    return;
  }

  for (const item of semantic) {
    const li = document.createElement("li");
    li.className = "memory-item";

    const title = document.createElement("span");
    title.className = "memory-item-title";
    title.textContent = item.evidenceText || item.canonicalText || "(empty)";

    const meta = document.createElement("span");
    meta.className = "memory-item-meta";
    meta.textContent = `${semanticLabel(item.itemType || "item")} • conf ${Number(item.confidence || 0).toFixed(2)}`;

    li.appendChild(title);
    li.appendChild(meta);
    memorySemanticListEl.appendChild(li);
  }
}

function renderSummaryMemory(summaries) {
  memorySummaryListEl.innerHTML = "";
  if (!summaries.length) {
    memorySummaryListEl.appendChild(createListEmpty("No summaries yet."));
    return;
  }

  for (const summary of summaries) {
    const li = document.createElement("li");
    li.className = "memory-item";

    const title = document.createElement("span");
    title.className = "memory-item-title";
    title.textContent = summary.summary || "(empty summary)";

    const meta = document.createElement("span");
    meta.className = "memory-item-meta";
    meta.textContent = `turns ${summary.startTurn || 0}-${summary.endTurn || 0}`;

    li.appendChild(title);
    li.appendChild(meta);
    memorySummaryListEl.appendChild(li);
  }
}

function renderMemoryInspector(memoryEnvelope) {
  const memory = memoryEnvelope?.memory || null;
  memoryInspectorState = memory;

  if (!memory) {
    clearMemoryInspector("No memory available for this thread yet.");
    return;
  }

  renderTokenMemory(memory.tokens || []);
  renderSemanticMemory(memory.semantic || []);
  renderSummaryMemory(memory.summaries || []);

  const stats = memory.stats || {};
  setMemoryInspectorStatus(
    `${Number(stats.tokenCount || 0)} tokens • ${Number(stats.semanticCount || 0)} semantic • ${Number(
      stats.summaryCount || 0
    )} summaries`
  );
}

async function refreshMemoryInspector() {
  if (!activeConversationId) {
    clearMemoryInspector();
    return;
  }

  setMemoryInspectorStatus("Refreshing memory...");

  try {
    const response = await fetch(`/api/conversation/${encodeURIComponent(activeConversationId)}/memory`);
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Could not refresh memory");
    }

    renderMemoryInspector(result);
  } catch (error) {
    clearMemoryInspector("Memory unavailable.");
  }
}

function renderInsightList(container, lines, emptyText) {
  container.innerHTML = "";
  if (!lines.length) {
    container.appendChild(createListEmpty(emptyText));
    return;
  }

  for (const line of lines) {
    const li = document.createElement("li");
    li.className = "memory-item";

    const title = document.createElement("span");
    title.className = "memory-item-title";
    title.textContent = line;
    li.appendChild(title);

    container.appendChild(li);
  }
}

function renderInsightSnapshot(payload) {
  const insights = payload?.insights || null;
  insightState = insights;
  if (!insights) {
    clearInsightSnapshot("No insight snapshot available.");
    return;
  }

  renderInsightList(insightDecisionsListEl, insights.decisions || [], "No decisions yet.");
  renderInsightList(insightQuestionsListEl, insights.openQuestions || [], "No open questions yet.");
  renderInsightList(insightNextStepsListEl, insights.nextSteps || [], "No next steps yet.");

  const stats = insights.stats || {};
  setInsightStatus(
    `Mode ${insights.mode || DEFAULT_THREAD_MODE} • decisions ${stats.decisionCount || 0} • open questions ${
      stats.openQuestionCount || 0
    } • summaries ${stats.summaryCount || 0}`
  );
}

function toInsightMarkdown() {
  if (!insightState) {
    return "";
  }

  const title = threadTitleInput.value.trim() || activeTopic || "Untitled thread";
  const lines = [
    `# Insight Snapshot`,
    ``,
    `- Title: ${title}`,
    `- Topic: ${activeTopic || topicInput.value.trim() || "n/a"}`,
    `- Conversation ID: ${activeConversationId || "n/a"}`,
    `- Mode: ${insightState.mode || DEFAULT_THREAD_MODE}`,
    ``,
    `## Decisions`,
    ...(insightState.decisions?.length ? insightState.decisions.map((line) => `- ${line}`) : ["- None yet"]),
    ``,
    `## Open Questions`,
    ...(insightState.openQuestions?.length ? insightState.openQuestions.map((line) => `- ${line}`) : ["- None yet"]),
    ``,
    `## Next Steps`,
    ...(insightState.nextSteps?.length ? insightState.nextSteps.map((line) => `- ${line}`) : ["- None yet"])
  ];

  return lines.join("\n");
}

async function refreshInsightSnapshot() {
  if (!activeConversationId) {
    clearInsightSnapshot();
    return;
  }

  setInsightStatus("Refreshing insight snapshot...");
  try {
    const response = await fetch(`/api/conversation/${encodeURIComponent(activeConversationId)}/insights`);
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || "Could not refresh insights");
    }
    renderInsightSnapshot(result);
  } catch (error) {
    clearInsightSnapshot("Insights unavailable.");
  }
}

function renderLabResults(runs) {
  labResultsState = Array.isArray(runs) ? runs : [];
  labResultsListEl.innerHTML = "";

  if (!labResultsState.length) {
    labResultsListEl.appendChild(createListEmpty("No lab runs yet."));
    return;
  }

  for (const run of labResultsState) {
    const li = document.createElement("li");
    li.className = "lab-item";

    const top = document.createElement("div");
    top.className = "lab-item-top";

    const mode = document.createElement("span");
    mode.className = "lab-pill";
    mode.textContent = run.mode || DEFAULT_THREAD_MODE;

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "secondary lab-open-btn";
    openBtn.textContent = "Open thread";
    openBtn.addEventListener("click", async () => {
      try {
        setStatus("Loading lab thread...");
        await loadConversation(run.conversationId);
        await loadHistory();
      } catch (error) {
        setStatus(error.message || "Could not load lab thread.");
      }
    });

    top.appendChild(mode);
    top.appendChild(openBtn);

    const summary = document.createElement("span");
    summary.className = "memory-item-meta";
    const avgScore = Number(run?.quality?.avgScore || 0);
    const openQuestions = Number(run?.insights?.stats?.openQuestionCount || 0);
    const decisions = Number(run?.insights?.stats?.decisionCount || 0);
    summary.textContent = `quality ${(avgScore * 100).toFixed(0)} • decisions ${decisions} • open ${openQuestions} • turns ${
      run.totalTurns || 0
    }`;

    const nextStep = document.createElement("span");
    nextStep.className = "memory-item-title";
    nextStep.textContent = run?.insights?.nextSteps?.[0] || "No next step available.";

    li.appendChild(top);
    li.appendChild(summary);
    li.appendChild(nextStep);
    labResultsListEl.appendChild(li);
  }
}

async function runDiscoveryLab() {
  const topic = topicInput.value.trim();
  if (!topic && !activeConversationId) {
    setStatus("Enter a topic or load a thread before running Discovery Lab.");
    return;
  }

  const payload = {
    topic,
    conversationId: activeConversationId || undefined,
    turns: 6,
    ...getBriefPayload(),
    ...getThreadMetaPayload(),
    agents: getAgentPayload()
  };

  labBtn.disabled = true;
  startBtn.disabled = true;
  setLabStatus("Running discovery lab across all modes...");
  setStatus("Discovery Lab running...");

  try {
    const response = await fetch("/api/conversation/lab", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || "Could not run discovery lab");
    }

    renderLabResults(result.runs || []);
    const runs = result.runs || [];
    const best = bestLabRun();
    if (best) {
      setLabStatus(`Completed ${runs.length} runs. Best quality mode: ${best.mode}.`);
      setStatus(`Discovery Lab complete. Best mode this run: ${best.mode}.`);
    } else {
      setLabStatus("Discovery Lab completed.");
    }

    await loadHistory();
  } catch (error) {
    setLabStatus("Discovery Lab failed.");
    setStatus(error.message || "Could not run discovery lab.");
  } finally {
    labBtn.disabled = false;
    startBtn.disabled = false;
  }
}

function toLabReportMarkdown() {
  if (!labResultsState.length) {
    return "";
  }

  const topic = activeTopic || topicInput.value.trim() || "Untitled topic";
  const lines = [
    `# Discovery Lab Report`,
    ``,
    `- Topic: ${topic}`,
    `- Base conversation: ${activeConversationId || "n/a"}`,
    `- Runs: ${labResultsState.length}`,
    ``,
    `## Results`
  ];

  for (const run of labResultsState) {
    const score = Number(run?.quality?.avgScore || 0);
    const decisions = Number(run?.insights?.stats?.decisionCount || 0);
    const openQuestions = Number(run?.insights?.stats?.openQuestionCount || 0);
    const nextStep = run?.insights?.nextSteps?.[0] || "No next step.";
    lines.push(`### ${run.mode}`);
    lines.push(`- Thread: ${run.conversationId}`);
    lines.push(`- Quality: ${(score * 100).toFixed(0)}`);
    lines.push(`- Decisions: ${decisions}`);
    lines.push(`- Open questions: ${openQuestions}`);
    lines.push(`- Next step: ${nextStep}`);
    lines.push("");
  }

  const best = bestLabRun();
  if (best) {
    lines.push(`## Recommendation`);
    lines.push(`Use mode **${best.mode}** for the next deepening pass on this topic.`);
    lines.push(`Open: ${best.conversationId}`);
  }

  return lines.join("\n");
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

function setQualityChip(quality) {
  qualityState = quality || null;
  if (!qualityState) {
    qualityChipEl.textContent = "Quality: waiting";
    return;
  }

  const score = Number(qualityState.avgScore || 0);
  const retries = Number(qualityState.retriesUsed || 0);
  qualityChipEl.textContent = `Quality: ${(score * 100).toFixed(0)} • retries ${retries}`;
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
  scheduleDraftPersist();
}

function getAgentPayload() {
  return [
    {
      agentId: "agent-a",
      name: agentANameInput.value.trim(),
      style: agentAStyleInput.value.trim(),
      temperature: Number(agentATempInput.value)
    },
    {
      agentId: "agent-b",
      name: agentBNameInput.value.trim(),
      style: agentBStyleInput.value.trim(),
      temperature: Number(agentBTempInput.value)
    }
  ];
}

function setAgentFields(agents) {
  const byId = new Map((agents || []).map((agent) => [agent.agentId || agent.id, agent]));
  const fallbackA = DEFAULT_AGENTS[0];
  const fallbackB = DEFAULT_AGENTS[1];
  const agentA = byId.get("agent-a");
  const agentB = byId.get("agent-b");

  agentANameInput.value = agentA?.name || fallbackA.name;
  agentATempInput.value = Number.isFinite(Number(agentA?.temperature))
    ? String(Number(agentA.temperature))
    : String(fallbackA.temperature);
  agentAStyleInput.value = agentA?.style || fallbackA.style;

  agentBNameInput.value = agentB?.name || fallbackB.name;
  agentBTempInput.value = Number.isFinite(Number(agentB?.temperature))
    ? String(Number(agentB.temperature))
    : String(fallbackB.temperature);
  agentBStyleInput.value = agentB?.style || fallbackB.style;
  scheduleDraftPersist();
}

function hasCustomAgentOverrides(agents) {
  return agents.some((agent, index) => {
    const fallback = DEFAULT_AGENTS[index];
    const nameChanged = (agent.name || "").trim() !== fallback.name;
    const styleChanged = (agent.style || "").trim() !== fallback.style;
    const tempChanged = Math.abs(Number(agent.temperature || 0) - Number(fallback.temperature || 0)) > 0.001;
    return nameChanged || styleChanged || tempChanged;
  });
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
  const quality = entry.quality || null;

  head.appendChild(speaker);
  turnGroup.appendChild(turn);
  turnGroup.appendChild(forkBtn);
  head.appendChild(turnGroup);
  item.appendChild(head);
  item.appendChild(text);

  if (quality) {
    const qualityRow = document.createElement("div");
    qualityRow.className = "quality-row";
    const score = document.createElement("span");
    score.className = "quality-pill";
    score.textContent = `Score ${(Number(quality.score || 0) * 100).toFixed(0)}`;

    const words = document.createElement("span");
    words.className = "quality-pill";
    words.textContent = `${quality.wordCount || 0} words`;

    const sim = document.createElement("span");
    sim.className = "quality-pill";
    sim.textContent = `sim ${Number(quality.similarityToPrevious || 0).toFixed(2)}`;

    const tries = document.createElement("span");
    tries.className = "quality-pill";
    tries.textContent = `tries ${quality.attempts || 1}`;

    qualityRow.appendChild(score);
    qualityRow.appendChild(words);
    qualityRow.appendChild(sim);
    qualityRow.appendChild(tries);
    item.appendChild(qualityRow);
  }

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
    setThreadMeta({
      title: result.title || "",
      starred: Boolean(result.starred),
      mode: normalizeThreadMode(result.mode || DEFAULT_THREAD_MODE)
    });
    setBriefFields(result.brief || null);
    setAgentFields(result.agents || null);
    setMemoryChip(result.memory || null);
    setQualityChip(null);

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
    await refreshMemoryInspector();
    await refreshInsightSnapshot();
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
    `- Title: ${threadTitleInput.value.trim() || "n/a"}`,
    `- Starred: ${activeStarred ? "yes" : "no"}`,
    `- Mode: ${normalizeThreadMode(threadModeSelect.value)}`,
    `- Conversation ID: ${activeConversationId || "n/a"}`,
    `- Total turns: ${displayedTranscript.length}`,
    `- Memory tokens: ${memoryState?.tokenCount || 0}`,
    `- Memory summaries: ${memoryState?.summaryCount || 0}`,
    `- Semantic memory items: ${memoryState?.semanticCount || 0}`,
    `- Quality avg score: ${qualityState?.avgScore ?? 0}`,
    `- Quality retries: ${qualityState?.retriesUsed ?? 0}`,
    `- Objective: ${objectiveInput.value.trim() || "n/a"}`,
    `- Constraints: ${constraintsInput.value.trim() || "n/a"}`,
    `- Done criteria: ${doneCriteriaInput.value.trim() || "n/a"}`,
    `- Agent A: ${agentANameInput.value.trim() || "Agent Atlas"} (temp ${agentATempInput.value || "0.45"})`,
    `- Agent B: ${agentBNameInput.value.trim() || "Agent Nova"} (temp ${agentBTempInput.value || "0.72"})`,
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
  setThreadMeta({
    title: result.title || "",
    starred: Boolean(result.starred),
    mode: normalizeThreadMode(result.mode || DEFAULT_THREAD_MODE)
  });
  setBriefFields(result.brief || null);
  setAgentFields(result.agents || null);

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
  setQualityChip(null);
  await refreshMemoryInspector();
  await refreshInsightSnapshot();
}

function getVisibleConversations(conversations) {
  const query = historySearchInput.value.trim().toLowerCase();
  if (!query) {
    return conversations;
  }

  return conversations.filter((conversation) => {
    const haystack = `${conversation.title || ""} ${conversation.topic || ""} ${conversation.mode || ""}`.toLowerCase();
    return haystack.includes(query);
  });
}

async function setConversationStar(conversationId, starred) {
  const response = await fetch(`/api/conversation/${encodeURIComponent(conversationId)}/meta`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ starred })
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error || "Could not update thread star");
  }

  if (conversationId === activeConversationId) {
    setThreadMeta({
      title: result.title || "",
      starred: Boolean(result.starred),
      mode: normalizeThreadMode(result.mode || DEFAULT_THREAD_MODE)
    });
  }
}

function renderHistory(conversations) {
  const visibleConversations = getVisibleConversations(conversations);
  historyListEl.innerHTML = "";

  if (!visibleConversations.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = conversations.length ? "No threads match this search." : "No saved threads yet.";
    historyListEl.appendChild(empty);
    setHistoryStatus(conversations.length ? "No matches" : "0 saved threads");
    return;
  }

  for (const conversation of visibleConversations) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "thread-item";

    if (conversation.id === activeConversationId) {
      button.classList.add("active");
    }

    const head = document.createElement("div");
    head.className = "thread-head";

    const title = document.createElement("span");
    title.className = "thread-title";
    title.textContent = conversation.title || conversation.topic;

    const starBtn = document.createElement("button");
    starBtn.type = "button";
    starBtn.className = "thread-star";
    if (conversation.starred) {
      starBtn.classList.add("active");
    }
    starBtn.textContent = conversation.starred ? "★" : "☆";
    starBtn.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        await setConversationStar(conversation.id, !conversation.starred);
        await loadHistory();
      } catch (error) {
        setStatus(error.message || "Could not update thread star.");
      }
    });

    const meta = document.createElement("span");
    meta.className = "thread-meta";
    const forkMeta = conversation.parentConversationId
      ? ` • fork@${conversation.forkFromTurn ?? 0}`
      : "";
    const agentMeta = conversation.hasCustomAgents ? " • custom agents" : "";
    meta.textContent = `${conversation.totalTurns} turns • ${formatUpdatedAt(conversation.updatedAt)} • ${
      conversation.mode || DEFAULT_THREAD_MODE
    }${
      conversation.hasBrief ? " • brief" : ""
    }${agentMeta}${forkMeta}`;

    head.appendChild(title);
    head.appendChild(starBtn);
    button.appendChild(head);
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

  const suffix = visibleConversations.length === conversations.length ? "" : ` (${visibleConversations.length} shown)`;
  setHistoryStatus(`${conversations.length} saved threads${suffix}`);
}

async function loadHistory() {
  try {
    const response = await fetch("/api/conversations?limit=30");
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Could not load history");
    }

    cachedConversations = result.conversations || [];
    renderHistory(cachedConversations);
  } catch (error) {
    cachedConversations = [];
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
    setThreadMeta(null);
    setBriefFields(null);
    setAgentFields(null);
    setMemoryChip(null);
    setQualityChip(null);
    clearMemoryInspector();
    clearInsightSnapshot();
    clearLabResults();
    return;
  }

  setStatus("Loading previous conversation...");

  try {
    await loadConversation(activeConversationId);
  } catch (error) {
    clearConversationState();
    clearTranscript("Saved conversation was not found. Start a new topic.");
    engineChipEl.textContent = "Engine: waiting";
    setThreadMeta(null);
    setBriefFields(null);
    setAgentFields(null);
    setMemoryChip(null);
    setQualityChip(null);
    clearMemoryInspector();
    clearInsightSnapshot();
    clearLabResults();
  }
}

refreshHistoryBtn.addEventListener("click", async () => {
  setHistoryStatus("Refreshing...");
  await loadHistory();
});

historySearchInput.addEventListener("input", () => {
  renderHistory(cachedConversations);
});

for (const field of [
  topicInput,
  threadTitleInput,
  threadModeSelect,
  objectiveInput,
  constraintsInput,
  doneCriteriaInput,
  agentANameInput,
  agentATempInput,
  agentAStyleInput,
  agentBNameInput,
  agentBTempInput,
  agentBStyleInput
]) {
  field.addEventListener("input", scheduleDraftPersist);
  field.addEventListener("change", scheduleDraftPersist);
}

clearBtn.addEventListener("click", async () => {
  clearConversationState();
  clearDraftState();
  topicInput.value = "";
  setThreadMeta(null);
  setBriefFields(null);
  setAgentFields(null);
  clearTranscript("Started a fresh thread.");
  engineChipEl.textContent = "Engine: waiting";
  setMemoryChip(null);
  setQualityChip(null);
  clearMemoryInspector();
  clearInsightSnapshot();
  clearLabResults();
  await loadHistory();
});

refreshMemoryBtn.addEventListener("click", async () => {
  await refreshMemoryInspector();
});

refreshInsightsBtn.addEventListener("click", async () => {
  await refreshInsightSnapshot();
});

labBtn.addEventListener("click", async () => {
  await runDiscoveryLab();
});

openBestLabBtn.addEventListener("click", async () => {
  const best = bestLabRun();
  if (!best) {
    setStatus("No lab results yet.");
    return;
  }

  try {
    setStatus(`Opening best lab run: ${best.mode}...`);
    await loadConversation(best.conversationId);
    await loadHistory();
  } catch (error) {
    setStatus(error.message || "Could not open best lab run.");
  }
});

copyLabReportBtn.addEventListener("click", async () => {
  const markdown = toLabReportMarkdown();
  if (!markdown) {
    setStatus("No lab report to copy yet.");
    return;
  }

  try {
    await navigator.clipboard.writeText(markdown);
    setStatus("Lab report copied.");
  } catch (error) {
    setStatus("Clipboard blocked. Could not copy lab report.");
  }
});

copyInsightsBtn.addEventListener("click", async () => {
  const markdown = toInsightMarkdown();
  if (!markdown) {
    setStatus("No insights to copy yet.");
    return;
  }

  try {
    await navigator.clipboard.writeText(markdown);
    setStatus("Insight snapshot copied.");
  } catch (error) {
    setStatus("Clipboard blocked. Copy failed.");
  }
});

saveThreadBtn.addEventListener("click", async () => {
  try {
    await persistThreadMeta(getThreadMetaPayload());
  } catch (error) {
    setStatus(error.message || "Could not save thread settings.");
  }
});

toggleStarBtn.addEventListener("click", async () => {
  const nextStarred = !activeStarred;
  setStarButtonState(nextStarred);
  if (!activeConversationId) {
    setStatus("Star setting stored locally. Start a thread to persist it.");
    return;
  }

  try {
    await persistThreadMeta(
      {
        title: normalizeThreadTitle(threadTitleInput.value),
        starred: nextStarred,
        mode: normalizeThreadMode(threadModeSelect.value)
      },
      nextStarred ? "Thread starred." : "Thread unstarred."
    );
  } catch (error) {
    setStarButtonState(!nextStarred);
    setStatus(error.message || "Could not update star state.");
  }
});

async function persistBrief(brief, successMessage = "Conversation brief saved.") {
  if (!activeConversationId) {
    persistDraftNow();
    setStatus("Brief saved locally. Start a thread to persist it.");
    return false;
  }

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
  persistDraftNow();
  setStatus(successMessage);
  await loadHistory();
  return true;
}

async function persistAgents(agents, successMessage = "Agent studio settings saved.") {
  if (!activeConversationId) {
    persistDraftNow();
    setStatus("Agent settings saved locally. Start a thread to persist them.");
    return false;
  }

  const response = await fetch(`/api/conversation/${encodeURIComponent(activeConversationId)}/agents`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ agents })
  });
  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || "Could not save agents");
  }

  setAgentFields(result.agents || null);
  persistDraftNow();
  setStatus(successMessage);
  await loadHistory();
  return true;
}

saveBriefBtn.addEventListener("click", async () => {
  const brief = getBriefPayload();
  try {
    await persistBrief(brief);
  } catch (error) {
    setStatus(error.message || "Could not save brief.");
  }
});

saveAgentsBtn.addEventListener("click", async () => {
  const agents = getAgentPayload();
  try {
    await persistAgents(agents);
  } catch (error) {
    setStatus(error.message || "Could not save agent settings.");
  }
});

async function saveAllSettings() {
  if (!activeConversationId) {
    persistDraftNow();
    setStatus("Draft saved locally.");
    return;
  }

  try {
    await persistThreadMeta(getThreadMetaPayload(), "Thread settings saved.");
    await persistBrief(getBriefPayload(), "Brief saved.");
    await persistAgents(getAgentPayload(), "All settings saved.");
  } catch (error) {
    setStatus(error.message || "Could not save all settings.");
  }
}

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

document.addEventListener("keydown", async (event) => {
  const hasModifier = event.metaKey || event.ctrlKey;
  if (!hasModifier) {
    return;
  }

  const key = String(event.key || "").toLowerCase();
  if (key === "s") {
    event.preventDefault();
    await saveAllSettings();
    return;
  }

  if (key === "enter" && !startBtn.disabled) {
    event.preventDefault();
    form.requestSubmit();
  }
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
    setThreadMeta(null);
    setMemoryChip(null);
    clearMemoryInspector("Switched topic. Memory will rebuild for the new thread.");
    clearInsightSnapshot("Switched topic. Insights will rebuild for the new thread.");
    clearLabResults("Switched topic. Run Discovery Lab again for this topic.");
  }

  const conversationId = activeConversationId || undefined;
  const brief = getBriefPayload();
  const agents = getAgentPayload();
  const threadMeta = getThreadMetaPayload();
  const includeAgents = hasCustomAgentOverrides(agents);
  const includeThreadMeta = Boolean(
    threadMeta.title || threadMeta.starred || threadMeta.mode !== DEFAULT_THREAD_MODE
  );

  if (!conversationId) {
    transcriptEl.innerHTML = "";
    displayedTranscript = [];
  }

  startBtn.disabled = true;
  labBtn.disabled = true;
  setStatus(
    conversationId
      ? "Agents are continuing this thread for 10 more turns..."
      : "Agents are reasoning through all 10 turns..."
  );

  try {
    const payload = {
      topic,
      turns: 10,
      conversationId,
      ...brief
    };
    if (includeAgents) {
      payload.agents = agents;
    }
    if (includeThreadMeta) {
      payload.title = threadMeta.title;
      payload.starred = threadMeta.starred;
      payload.mode = threadMeta.mode;
    }

    const response = await fetch("/api/conversation/stream", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
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
    let qualitySummary = null;

    const handleChunk = (chunk) => {
      if (chunk.type === "meta") {
        setConversationState(chunk.conversationId, chunk.topic);
        setThreadMeta({
          title: chunk.title || "",
          starred: Boolean(chunk.starred),
          mode: normalizeThreadMode(chunk.mode || DEFAULT_THREAD_MODE)
        });
        engineChipEl.textContent = `Engine: ${chunk.engine}`;
        if (chunk.brief) {
          setBriefFields(chunk.brief);
        }
        if (chunk.agents) {
          setAgentFields(chunk.agents);
        }
        setMemoryChip(chunk.memory || null);
        setQualityChip(null);
        if (!memoryInspectorState) {
          setMemoryInspectorStatus("Run in progress. Memory details will refresh when done.");
        }
        finalTopic = chunk.topic || finalTopic;
        return;
      }

      if (chunk.type === "turn") {
        if (chunk.entry) {
          if (chunk.quality) {
            chunk.entry.quality = chunk.quality;
          }
          appendMessage(chunk.entry);
          generatedTurns += 1;
        }
        totalTurns = chunk.totalTurns ?? totalTurns;
        return;
      }

      if (chunk.type === "retry") {
        const reason = chunk.reason || "quality";
        setStatus(`Quality optimizer retry on turn ${chunk.turn}: ${reason}`);
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
        setThreadMeta({
          title: chunk.title || "",
          starred: Boolean(chunk.starred),
          mode: normalizeThreadMode(chunk.mode || DEFAULT_THREAD_MODE)
        });
        if (chunk.brief) {
          setBriefFields(chunk.brief);
        }
        if (chunk.agents) {
          setAgentFields(chunk.agents);
        }
        stopReason = chunk.stopReason || stopReason;
        setMemoryChip(chunk.memory || null);
        qualitySummary = chunk.quality || null;
        setQualityChip(qualitySummary);
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
    const qualitySuffix = qualitySummary
      ? ` Quality ${(Number(qualitySummary.avgScore || 0) * 100).toFixed(0)} with ${qualitySummary.retriesUsed || 0} retries.`
      : "";

    setStatus(
      `Added ${generatedTurns} turns. Total turns: ${totalTurns}. Topic: ${finalTopic}.${reasonSuffix}${moderatorSuffix}${qualitySuffix}`
    );
    await refreshMemoryInspector();
    await refreshInsightSnapshot();
    await loadHistory();
  } catch (error) {
    if (String(error.message || "").toLowerCase().includes("not found")) {
      clearConversationState();
      setMemoryChip(null);
      setQualityChip(null);
      clearMemoryInspector();
      clearInsightSnapshot();
      clearLabResults();
      await loadHistory();
    }

    if (!transcriptEl.children.length) {
      clearTranscript("Generation failed.");
    }
    setStatus(error.message || "Could not generate conversation.");
  } finally {
    startBtn.disabled = false;
    labBtn.disabled = false;
  }
});

setThreadMeta(null);
setAgentFields(null);
clearMemoryInspector();
clearInsightSnapshot();
clearLabResults();
restoreDraftState();

(async () => {
  await loadHistory();
  await restoreConversation();
})();
