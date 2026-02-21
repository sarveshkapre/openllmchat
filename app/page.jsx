"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Moon, PanelLeft, PanelLeftClose, Plus, RefreshCcw, Sun, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const STORAGE_KEYS = {
  conversationId: "openllmchat:min:conversationId",
  topic: "openllmchat:min:topic",
  theme: "openllmchat:min:theme",
  sidebarOpen: "openllmchat:min:sidebarOpen",
  agentAPersona: "openllmchat:min:agentAPersona",
  agentBPersona: "openllmchat:min:agentBPersona"
};

const PERSONA_PRESETS = [
  {
    id: "atlas",
    name: "Atlas",
    label: "Atlas",
    persona:
      "A systems strategist focused on first principles, measurable outcomes, and explicit tradeoffs.",
    style: "Analytical, grounded, and structured. Prefer clear reasoning over rhetoric.",
    temperature: 0.45,
    tools: { webSearch: true }
  },
  {
    id: "nova",
    name: "Nova",
    label: "Nova",
    persona:
      "A creative applied thinker who pressure-tests assumptions with examples, user impact, and edge cases.",
    style: "Conversational, vivid, and practical. Challenge weak claims with concrete alternatives.",
    temperature: 0.72,
    tools: { webSearch: true }
  },
  {
    id: "curiosity",
    name: "Curiosity",
    label: "Curiosity",
    persona:
      "A curiosity-driven thinker who asks critical, interesting questions to expose assumptions and unlock deeper insight.",
    style: "Probe with high-leverage questions and keep the discussion intellectually adventurous but precise.",
    temperature: 0.78,
    tools: { webSearch: true }
  },
  {
    id: "knowledge",
    name: "Knowledge",
    label: "Knowledge",
    persona:
      "A knowledge persona that answers questions directly, clearly, and accurately with concise supporting reasoning.",
    style: "Answer-first, concrete, and grounded; avoid unnecessary detours or open-ended questioning.",
    temperature: 0.35,
    tools: { webSearch: true }
  },
  {
    id: "interviewer",
    name: "Interviewer",
    label: "Interviewer",
    persona:
      "A rigorous interviewer persona that asks focused, sequenced questions and drives toward clarity through follow-ups.",
    style: "Ask one sharp question at a time, escalate depth, and avoid answering on behalf of the other speaker.",
    temperature: 0.5,
    tools: { webSearch: true }
  }
];

function parseTurns(value) {
  const turns = Number(value);
  if (!Number.isFinite(turns)) {
    return 10;
  }
  return Math.max(2, Math.min(10, Math.trunc(turns)));
}

function formatUpdatedAt(value) {
  const date = new Date(value);
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

function formatSpeakerLabel(value) {
  return String(value || "Agent")
    .replace(/^agent\s+/i, "")
    .trim() || "Agent";
}

function getPersonaPreset(presetId, fallbackId = "atlas") {
  const preset = PERSONA_PRESETS.find((item) => item.id === presetId);
  if (preset) {
    return preset;
  }
  return PERSONA_PRESETS.find((item) => item.id === fallbackId) || PERSONA_PRESETS[0];
}

function matchPersonaPreset(agent) {
  if (!agent || typeof agent !== "object") {
    return "";
  }

  const normalizedName = String(agent.name || "").trim().toLowerCase();
  const normalizedPersona = String(agent.persona || "").trim().toLowerCase();
  const normalizedStyle = String(agent.style || "").trim().toLowerCase();

  const match = PERSONA_PRESETS.find((preset) => {
    const presetName = String(preset.name || "").toLowerCase();
    const presetPersona = String(preset.persona || "").toLowerCase();
    const presetStyle = String(preset.style || "").toLowerCase();
    return (
      (normalizedName && normalizedName === presetName) ||
      (normalizedPersona && normalizedPersona === presetPersona) ||
      (normalizedStyle && normalizedStyle === presetStyle)
    );
  });

  return match?.id || "";
}

function belongsToAgent(entry, agentId, agentName) {
  const speakerId = String(entry?.speakerId || "").trim().toLowerCase();
  if (speakerId) {
    return speakerId === String(agentId || "").toLowerCase();
  }

  const speaker = formatSpeakerLabel(entry?.speaker).toLowerCase();
  if (speaker && agentName) {
    return speaker === String(agentName).toLowerCase();
  }

  const turn = Number(entry?.turn || 0);
  if (!Number.isFinite(turn) || turn <= 0) {
    return false;
  }
  return agentId === "agent-a" ? turn % 2 === 1 : turn % 2 === 0;
}

function upsertMessageByTurn(messages, entry) {
  if (!entry || typeof entry !== "object") {
    return messages;
  }

  const turn = Number(entry.turn);
  if (!Number.isFinite(turn)) {
    return messages;
  }

  const index = messages.findIndex((item) => Number(item?.turn) === turn);
  if (index === -1) {
    return [...messages, entry];
  }

  const next = messages.slice();
  next[index] = { ...next[index], ...entry };
  return next;
}

export default function HomePage() {
  const [theme, setTheme] = useState("light");
  const [historyOpen, setHistoryOpen] = useState(true);
  const [agentAPersona, setAgentAPersona] = useState("atlas");
  const [agentBPersona, setAgentBPersona] = useState("nova");

  const [topic, setTopic] = useState("");
  const [turnsInput, setTurnsInput] = useState("10");
  const [status, setStatus] = useState("Enter a topic and start.");
  const [engine, setEngine] = useState("waiting");
  const [totalTurns, setTotalTurns] = useState(0);

  const [isRunning, setIsRunning] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyClearing, setHistoryClearing] = useState(false);

  const [messages, setMessages] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [activeConversationId, setActiveConversationId] = useState("");
  const [activeTopic, setActiveTopic] = useState("");

  const agentAPreset = useMemo(() => getPersonaPreset(agentAPersona, "atlas"), [agentAPersona]);
  const agentBPreset = useMemo(() => getPersonaPreset(agentBPersona, "nova"), [agentBPersona]);

  const applyTheme = useCallback((nextTheme) => {
    const resolved = nextTheme === "dark" ? "dark" : "light";
    setTheme(resolved);
    if (typeof document !== "undefined") {
      document.documentElement.classList.toggle("dark", resolved === "dark");
    }
    localStorage.setItem(STORAGE_KEYS.theme, resolved);
  }, []);

  const fetchJson = useCallback(async (url, options = {}) => {
    const response = await fetch(url, options);
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    const payload = contentType.includes("application/json") ? await response.json() : null;

    if (!response.ok) {
      throw new Error(payload?.error || `Request failed (${response.status})`);
    }

    return payload;
  }, []);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const result = await fetchJson("/api/conversations?limit=30");
      setConversations(Array.isArray(result.conversations) ? result.conversations : []);
    } catch {
      setConversations([]);
    } finally {
      setHistoryLoading(false);
    }
  }, [fetchJson]);

  const loadConversation = useCallback(
    async (conversationId) => {
      const result = await fetchJson(`/api/conversation/${encodeURIComponent(conversationId)}`);
      const transcript = Array.isArray(result.transcript) ? result.transcript : [];
      const loadedAgents = Array.isArray(result.agents) ? result.agents : [];
      const agentA = loadedAgents.find((item) => item?.agentId === "agent-a" || item?.id === "agent-a");
      const agentB = loadedAgents.find((item) => item?.agentId === "agent-b" || item?.id === "agent-b");
      const matchedA = matchPersonaPreset(agentA);
      const matchedB = matchPersonaPreset(agentB);
      if (matchedA) {
        setAgentAPersona(matchedA);
      }
      if (matchedB) {
        setAgentBPersona(matchedB);
      }
      setActiveConversationId(result.conversationId || conversationId);
      setActiveTopic(result.topic || "");
      setTopic(result.topic || "");
      setMessages(transcript);
      setTotalTurns(Number(result.totalTurns || transcript.length || 0));
      setEngine("restored");
      setStatus(`Restored ${Number(result.totalTurns || transcript.length || 0)} turns.`);
    },
    [fetchJson]
  );

  const clearThreadState = useCallback(() => {
    setActiveConversationId("");
    setActiveTopic("");
    setMessages([]);
    setTotalTurns(0);
    setEngine("waiting");
    localStorage.removeItem(STORAGE_KEYS.conversationId);
  }, []);

  useEffect(() => {
    const savedTheme = localStorage.getItem(STORAGE_KEYS.theme) || "light";
    applyTheme(savedTheme);
    const savedSidebarOpen = localStorage.getItem(STORAGE_KEYS.sidebarOpen);
    if (savedSidebarOpen !== null) {
      setHistoryOpen(savedSidebarOpen === "1");
    }
    const savedAgentA = localStorage.getItem(STORAGE_KEYS.agentAPersona);
    const savedAgentB = localStorage.getItem(STORAGE_KEYS.agentBPersona);
    if (savedAgentA) {
      setAgentAPersona(savedAgentA);
    }
    if (savedAgentB) {
      setAgentBPersona(savedAgentB);
    }

    const savedTopic = localStorage.getItem(STORAGE_KEYS.topic) || "";
    const savedConversationId = localStorage.getItem(STORAGE_KEYS.conversationId) || "";

    if (savedTopic) {
      setTopic(savedTopic);
    }

    loadHistory();

    if (savedConversationId) {
      loadConversation(savedConversationId).catch(() => {
        clearThreadState();
        setStatus("Saved thread not found. Start a new one.");
      });
    }
  }, [applyTheme, clearThreadState, loadConversation, loadHistory]);

  useEffect(() => {
    if (activeConversationId) {
      localStorage.setItem(STORAGE_KEYS.conversationId, activeConversationId);
    } else {
      localStorage.removeItem(STORAGE_KEYS.conversationId);
    }
  }, [activeConversationId]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.topic, topic);
  }, [topic]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.sidebarOpen, historyOpen ? "1" : "0");
  }, [historyOpen]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.agentAPersona, agentAPersona);
  }, [agentAPersona]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.agentBPersona, agentBPersona);
  }, [agentBPersona]);

  const runConversation = useCallback(async () => {
    const cleanTopic = topic.trim();
    if (!cleanTopic) {
      setStatus("Please enter a topic.");
      return;
    }

    const turns = parseTurns(turnsInput);
    setTurnsInput(String(turns));

    let conversationId = activeConversationId;
    if (activeTopic && cleanTopic !== activeTopic) {
      clearThreadState();
      conversationId = "";
    }

    if (!conversationId) {
      setMessages([]);
      setTotalTurns(0);
    }

    setIsRunning(true);
    setStatus(conversationId ? `Continuing for ${turns} turns...` : `Running ${turns} turns...`);

    try {
      const response = await fetch("/api/conversation/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: cleanTopic,
          turns,
          conversationId: conversationId || undefined,
          agents: [
            {
              id: "agent-a",
              name: agentAPreset.name,
              persona: agentAPreset.persona,
              style: agentAPreset.style,
              temperature: agentAPreset.temperature,
              tools: agentAPreset.tools
            },
            {
              id: "agent-b",
              name: agentBPreset.name,
              persona: agentBPreset.persona,
              style: agentBPreset.style,
              temperature: agentBPreset.temperature,
              tools: agentBPreset.tools
            }
          ]
        })
      });

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
      let finalTotalTurns = totalTurns;
      let stopReason = "max_turns";
      const completedTurns = new Set();

      const handleChunk = (chunk) => {
        if (!chunk || typeof chunk !== "object") {
          return;
        }

        if (chunk.type === "meta") {
          const nextId = String(chunk.conversationId || "");
          if (nextId) {
            setActiveConversationId(nextId);
          }
          const nextTopic = String(chunk.topic || cleanTopic);
          setActiveTopic(nextTopic);
          setTopic(nextTopic);
          setEngine(String(chunk.engine || "running"));
          return;
        }

        if (chunk.type === "turn_start") {
          const provisional = {
            turn: Number(chunk.turn),
            speaker: String(chunk.speaker || "Agent"),
            speakerId: String(chunk.speakerId || ""),
            text: ""
          };
          setMessages((previous) => upsertMessageByTurn(previous, provisional));
          const nextTotal = Number(chunk.totalTurns || finalTotalTurns);
          finalTotalTurns = nextTotal;
          setTotalTurns(nextTotal);
          return;
        }

        if (chunk.type === "turn_delta") {
          const partial = {
            turn: Number(chunk.turn),
            speaker: String(chunk.speaker || "Agent"),
            speakerId: String(chunk.speakerId || ""),
            text: String(chunk.text || "")
          };
          setMessages((previous) => upsertMessageByTurn(previous, partial));
          const nextTotal = Number(chunk.totalTurns || finalTotalTurns);
          finalTotalTurns = nextTotal;
          setTotalTurns(nextTotal);
          return;
        }

        if (chunk.type === "turn" && chunk.entry) {
          const completedTurn = Number(chunk.entry.turn);
          if (!completedTurns.has(completedTurn)) {
            completedTurns.add(completedTurn);
            generatedTurns += 1;
          }
          setMessages((previous) => upsertMessageByTurn(previous, chunk.entry));
          const nextTotal = Number(chunk.totalTurns || finalTotalTurns + 1);
          finalTotalTurns = nextTotal;
          setTotalTurns(nextTotal);
          return;
        }

        if (chunk.type === "done") {
          finalTotalTurns = Number(chunk.totalTurns || finalTotalTurns);
          setTotalTurns(finalTotalTurns);
          stopReason = String(chunk.stopReason || stopReason);
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

      const stopMessage = stopReason !== "max_turns" ? ` Stop reason: ${stopReason}.` : "";
      setStatus(`Added ${generatedTurns} turns. Total: ${finalTotalTurns}.${stopMessage}`);
      await loadHistory();
    } catch (error) {
      setStatus(error?.message || "Could not generate conversation.");
    } finally {
      setIsRunning(false);
    }
  }, [
    activeConversationId,
    activeTopic,
    agentAPreset,
    agentBPreset,
    clearThreadState,
    loadHistory,
    topic,
    totalTurns,
    turnsInput
  ]);

  const onNewThread = useCallback(async () => {
    clearThreadState();
    setTopic("");
    setStatus("New thread started. Enter a topic and start.");
    await loadHistory();
  }, [clearThreadState, loadHistory]);

  const onClearHistory = useCallback(async () => {
    if (!conversations.length) {
      return;
    }

    const confirmed = window.confirm("Delete all saved conversations?");
    if (!confirmed) {
      return;
    }

    setHistoryClearing(true);
    try {
      const result = await fetchJson("/api/conversations", { method: "DELETE" });
      clearThreadState();
      setConversations([]);
      setStatus(`Deleted ${Number(result?.deletedCount || 0)} conversations.`);
    } catch (error) {
      setStatus(error?.message || "Could not clear history.");
    } finally {
      setHistoryClearing(false);
    }
  }, [clearThreadState, conversations.length, fetchJson]);

  const historyStatus = useMemo(() => {
    if (historyLoading) {
      return "Loading conversations...";
    }
    return `${conversations.length} conversations`;
  }, [conversations.length, historyLoading]);

  const agentAMessages = useMemo(
    () => messages.filter((entry) => belongsToAgent(entry, "agent-a", agentAPreset.name)),
    [agentAPreset.name, messages]
  );
  const agentBMessages = useMemo(
    () => messages.filter((entry) => belongsToAgent(entry, "agent-b", agentBPreset.name)),
    [agentBPreset.name, messages]
  );

  return (
    <main className="min-h-screen bg-background">
      <div className="flex min-h-screen">
        <aside
          className={cn(
            "hidden border-r bg-card/60 transition-all duration-200 ease-out md:flex md:flex-col",
            historyOpen ? "md:w-[300px]" : "md:w-16"
          )}
        >
          <div className={cn("border-b p-3", historyOpen ? "space-y-3" : "space-y-2")}>
            <div className={cn("flex items-center", historyOpen ? "justify-between" : "justify-center")}>
              {historyOpen ? <p className="text-sm font-medium text-foreground">Saved conversations</p> : null}
              <Button
                variant="ghost"
                size="icon"
                aria-label={historyOpen ? "Collapse sidebar" : "Expand sidebar"}
                onClick={() => setHistoryOpen((open) => !open)}
              >
                {historyOpen ? <PanelLeftClose className="size-4" /> : <PanelLeft className="size-4" />}
              </Button>
            </div>
            {historyOpen ? (
              <>
                <CardDescription>{historyStatus}</CardDescription>
                <div className="flex items-center gap-1">
                  <Button variant="secondary" className="flex-1" onClick={onNewThread}>
                    <Plus className="size-4" />
                    New conversation
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Refresh conversation history"
                    onClick={loadHistory}
                    disabled={historyLoading || historyClearing}
                  >
                    <RefreshCcw className={cn("size-4", historyLoading && "animate-spin")} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Delete all saved conversations"
                    onClick={onClearHistory}
                    disabled={historyLoading || historyClearing || conversations.length === 0}
                  >
                    <Trash2 className={cn("size-4", historyClearing && "animate-pulse")} />
                  </Button>
                </div>
              </>
            ) : (
              <div className="flex flex-col items-center gap-2">
                <Button variant="ghost" size="icon" onClick={onNewThread} aria-label="New conversation">
                  <Plus className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Refresh conversation history"
                  onClick={loadHistory}
                  disabled={historyLoading || historyClearing}
                >
                  <RefreshCcw className={cn("size-4", historyLoading && "animate-spin")} />
                </Button>
              </div>
            )}
          </div>

          {historyOpen ? (
            <div className="thread-scroll flex-1 overflow-y-auto p-2">
              {conversations.length === 0 ? (
                <p className="rounded-md px-3 py-2 text-sm text-muted-foreground">No conversations yet.</p>
              ) : (
                <ul className="space-y-1">
                  {conversations.map((conversation) => {
                    const isActive = conversation.id === activeConversationId;
                    return (
                      <li key={conversation.id}>
                        <button
                          type="button"
                          onClick={() => loadConversation(conversation.id).catch((error) => setStatus(error.message))}
                          className={cn(
                            "w-full rounded-md border px-3 py-2 text-left transition-colors",
                            isActive
                              ? "border-primary/40 bg-primary/10"
                              : "border-transparent hover:border-border hover:bg-muted/55"
                          )}
                        >
                          <p className="truncate text-sm font-medium">{conversation.title || conversation.topic}</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {conversation.totalTurns || 0} turns · {formatUpdatedAt(conversation.updatedAt)}
                          </p>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          ) : (
            <div className="flex-1" />
          )}
        </aside>

        <section className="flex-1 p-4 md:p-6">
          <div className="mx-auto max-w-5xl">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h1 className="text-2xl font-semibold tracking-tight">openllmchat</h1>
                <p className="text-sm text-muted-foreground">Two agents, one focused conversation.</p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="icon"
                  aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
                  onClick={() => applyTheme(theme === "dark" ? "light" : "dark")}
                >
                  {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
                </Button>
              </div>
            </div>

            <Card className="h-[78vh] min-h-[540px] overflow-hidden">
              <CardHeader className="border-b pb-4">
                <form
                  className="grid gap-3 md:grid-cols-[1fr,110px,180px,180px,auto]"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!isRunning) {
                      runConversation();
                    }
                  }}
                >
                  <Input
                    value={topic}
                    onChange={(event) => setTopic(event.target.value)}
                    placeholder="Topic"
                    maxLength={180}
                    aria-label="Conversation topic"
                  />
                  <Input
                    type="number"
                    min={2}
                    max={10}
                    value={turnsInput}
                    onChange={(event) => setTurnsInput(event.target.value)}
                    aria-label="Turns"
                  />
                  <select
                    value={agentAPersona}
                    onChange={(event) => setAgentAPersona(event.target.value)}
                    className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                    aria-label="Agent A persona"
                  >
                    {PERSONA_PRESETS.map((preset) => (
                      <option key={`agent-a-${preset.id}`} value={preset.id}>
                        A: {preset.label}
                      </option>
                    ))}
                  </select>
                  <select
                    value={agentBPersona}
                    onChange={(event) => setAgentBPersona(event.target.value)}
                    className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                    aria-label="Agent B persona"
                  >
                    {PERSONA_PRESETS.map((preset) => (
                      <option key={`agent-b-${preset.id}`} value={preset.id}>
                        B: {preset.label}
                      </option>
                    ))}
                  </select>
                  <Button type="submit" disabled={isRunning}>
                    {isRunning ? "Running..." : "Start conversation"}
                  </Button>
                </form>
                <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                  <span>Engine: {engine}</span>
                  <span>Turns: {totalTurns}</span>
                  <span>{status}</span>
                </div>
              </CardHeader>
              <CardContent className="h-[calc(78vh-122px)] p-4 md:p-5">
                {messages.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No messages yet. Add a topic and start.</p>
                ) : (
                  <div className="grid h-full gap-4 md:grid-cols-2">
                    <section className="flex min-h-0 flex-col rounded-md border bg-muted/20">
                      <header className="border-b px-4 py-3">
                        <p className="text-sm font-semibold">Agent A · {agentAPreset.label}</p>
                        <p className="text-xs text-muted-foreground">{agentAPreset.persona}</p>
                      </header>
                      <div className="thread-scroll min-h-0 flex-1 overflow-y-auto p-3">
                        {agentAMessages.length === 0 ? (
                          <p className="text-xs text-muted-foreground">No turns yet.</p>
                        ) : (
                          <ul className="space-y-2">
                            {agentAMessages.map((entry, index) => (
                              <li key={`a-${entry.turn}-${index}`} className="rounded-md border bg-background px-3 py-2">
                                <p className="mb-1 font-mono text-[11px] text-muted-foreground">
                                  Turn {Number(entry.turn || index + 1)}
                                </p>
                                <p className="text-sm leading-6 text-foreground/95">{entry.text || ""}</p>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </section>

                    <section className="flex min-h-0 flex-col rounded-md border bg-muted/20">
                      <header className="border-b px-4 py-3">
                        <p className="text-sm font-semibold">Agent B · {agentBPreset.label}</p>
                        <p className="text-xs text-muted-foreground">{agentBPreset.persona}</p>
                      </header>
                      <div className="thread-scroll min-h-0 flex-1 overflow-y-auto p-3">
                        {agentBMessages.length === 0 ? (
                          <p className="text-xs text-muted-foreground">No turns yet.</p>
                        ) : (
                          <ul className="space-y-2">
                            {agentBMessages.map((entry, index) => (
                              <li key={`b-${entry.turn}-${index}`} className="rounded-md border bg-background px-3 py-2">
                                <p className="mb-1 font-mono text-[11px] text-muted-foreground">
                                  Turn {Number(entry.turn || index + 1)}
                                </p>
                                <p className="text-sm leading-6 text-foreground/95">{entry.text || ""}</p>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </section>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
          </section>
        </div>
    </main>
  );
}
