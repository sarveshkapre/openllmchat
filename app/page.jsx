"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Moon, PanelLeft, PanelLeftClose, Plus, RefreshCcw, Sun, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
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

  const scrollRef = useRef(null);
  const abortRef = useRef(null);
  const scrollScheduledRef = useRef(false);

  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);

  const agentAPreset = useMemo(() => getPersonaPreset(agentAPersona, "atlas"), [agentAPersona]);
  const agentBPreset = useMemo(() => getPersonaPreset(agentBPersona, "nova"), [agentBPersona]);

  const scheduleScrollToBottom = useCallback(() => {
    if (!autoScrollEnabled) {
      return;
    }
    if (scrollScheduledRef.current) {
      return;
    }
    scrollScheduledRef.current = true;
    requestAnimationFrame(() => {
      scrollScheduledRef.current = false;
      const el = scrollRef.current;
      if (!el) {
        return;
      }
      el.scrollTop = el.scrollHeight;
    });
  }, [autoScrollEnabled]);

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
    const el = scrollRef.current;
    if (!el) {
      return undefined;
    }

    const onScroll = () => {
      const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      const nearBottom = distanceToBottom <= 140;
      setAutoScrollEnabled(nearBottom);
      setShowJumpToBottom(!nearBottom && messages.length > 0);
    };

    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [messages.length]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.agentAPersona, agentAPersona);
  }, [agentAPersona]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.agentBPersona, agentBPersona);
  }, [agentBPersona]);

  const stopConversation = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
  }, []);

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
      abortRef.current = new AbortController();
      const response = await fetch("/api/conversation/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortRef.current.signal,
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
          scheduleScrollToBottom();
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
          scheduleScrollToBottom();
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
          scheduleScrollToBottom();
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
      if (error?.name === "AbortError") {
        setStatus("Stopped.");
      } else {
        setStatus(error?.message || "Could not generate conversation.");
      }
    } finally {
      setIsRunning(false);
      abortRef.current = null;
    }
  }, [
    activeConversationId,
    activeTopic,
    agentAPreset,
    agentBPreset,
    clearThreadState,
    loadHistory,
    scheduleScrollToBottom,
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

  return (
    <main className="h-screen bg-background text-foreground">
      <div className="flex h-screen">
        <aside
          className={cn(
            "hidden border-r bg-muted/20 transition-all duration-200 ease-out md:flex md:flex-col",
            historyOpen ? "md:w-[300px]" : "md:w-16"
          )}
        >
          <div className={cn("border-b p-3", historyOpen ? "space-y-3" : "space-y-2")}>
            <div className={cn("flex items-center", historyOpen ? "justify-between" : "justify-center")}>
              {historyOpen ? <p className="text-sm font-semibold text-foreground">openllmchat</p> : null}
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
                <p className="text-xs text-muted-foreground">{historyStatus}</p>
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

        <section className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center justify-between border-b px-4 py-3 md:px-6">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">
                {topic.trim() || "Two-agent conversation"}
              </p>
              <p className="text-xs text-muted-foreground">
                {agentAPreset.label} ↔ {agentBPreset.label} · {totalTurns} turns
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                className="md:hidden"
                aria-label={historyOpen ? "Collapse sidebar" : "Expand sidebar"}
                onClick={() => setHistoryOpen((open) => !open)}
              >
                {historyOpen ? <PanelLeftClose className="size-4" /> : <PanelLeft className="size-4" />}
              </Button>
              <Button variant="ghost" size="icon" aria-label="New conversation" onClick={onNewThread}>
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
              <Button
                variant="ghost"
                size="icon"
                aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
                onClick={() => applyTheme(theme === "dark" ? "light" : "dark")}
              >
                {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
              </Button>
            </div>
          </header>

          <div ref={scrollRef} className="thread-scroll relative min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-4xl px-4 py-6 md:px-8">
              {messages.length === 0 ? (
                <div className="mx-auto mt-16 max-w-2xl text-center">
                  <h1 className="text-2xl font-semibold tracking-tight">openllmchat</h1>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Start a topic and let two personas discuss it.
                  </p>
                </div>
              ) : (
                <ul className="space-y-5">
                  {messages.map((entry, index) => {
                    const isLeft = belongsToAgent(entry, "agent-a", agentAPreset.name);
                    return (
                      <li
                        key={`${entry.turn}-${index}`}
                        className={cn("flex w-full", isLeft ? "justify-start" : "justify-end")}
                      >
                        <div className={cn("max-w-[82%] space-y-1", isLeft ? "items-start" : "items-end")}>
                          <p className={cn("text-xs", isLeft ? "text-muted-foreground" : "text-primary")}>
                            {formatSpeakerLabel(entry.speaker)} · Turn {Number(entry.turn || index + 1)}
                          </p>
                          <div
                            className={cn(
                              "rounded-2xl px-4 py-3 text-[15px] leading-7 tracking-[-0.01em]",
                              isLeft
                                ? "border bg-card text-card-foreground shadow-sm"
                                : "bg-primary text-primary-foreground shadow-sm"
                            )}
                          >
                            {entry.text || ""}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {showJumpToBottom ? (
              <div className="pointer-events-none sticky bottom-4 flex justify-center px-4">
                <div className="pointer-events-auto">
                  <Button
                    variant="secondary"
                    className="rounded-full shadow-sm"
                    onClick={() => {
                      setAutoScrollEnabled(true);
                      setShowJumpToBottom(false);
                      scheduleScrollToBottom();
                    }}
                  >
                    Jump to bottom
                  </Button>
                </div>
              </div>
            ) : null}
          </div>

          <footer className="border-t bg-background/95 px-3 py-3 md:px-6">
            <form
              className="mx-auto w-full max-w-4xl rounded-2xl border bg-card p-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (!isRunning) {
                  runConversation();
                }
              }}
            >
              <textarea
                value={topic}
                onChange={(event) => setTopic(event.target.value)}
                placeholder="Topic"
                maxLength={180}
                aria-label="Conversation topic"
                rows={1}
                className="max-h-24 w-full resize-none rounded-md border-0 bg-transparent px-2 py-2 text-[15px] leading-6 shadow-none outline-none"
              />
              <div className="mt-2 flex flex-wrap items-center gap-2 border-t pt-2">
                <Input
                  type="number"
                  min={2}
                  max={10}
                  value={turnsInput}
                  onChange={(event) => setTurnsInput(event.target.value)}
                  aria-label="Turns"
                  className="h-9 w-20"
                />
                <select
                  value={agentAPersona}
                  onChange={(event) => setAgentAPersona(event.target.value)}
                  className="h-9 min-w-[140px] rounded-md border border-input bg-background px-2 text-sm"
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
                  className="h-9 min-w-[140px] rounded-md border border-input bg-background px-2 text-sm"
                  aria-label="Agent B persona"
                >
                  {PERSONA_PRESETS.map((preset) => (
                    <option key={`agent-b-${preset.id}`} value={preset.id}>
                      B: {preset.label}
                    </option>
                  ))}
                </select>
                <div className="ml-auto flex items-center gap-2">
                  <p className="hidden max-w-[420px] truncate text-xs text-muted-foreground md:block">{status}</p>
                  {isRunning ? (
                    <Button type="button" variant="secondary" onClick={stopConversation}>
                      Stop
                    </Button>
                  ) : (
                    <Button type="submit">Start</Button>
                  )}
                </div>
              </div>
              <p className="mt-2 text-xs text-muted-foreground md:hidden">{status}</p>
            </form>
          </footer>
        </section>
        </div>
    </main>
  );
}
