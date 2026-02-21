"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Moon, PanelLeft, PanelLeftClose, Plus, RefreshCcw, Sun, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const STORAGE_KEYS = {
  conversationId: "openllmchat:min:conversationId",
  topic: "openllmchat:min:topic",
  theme: "openllmchat:min:theme"
};

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

export default function HomePage() {
  const [theme, setTheme] = useState("light");
  const [historyOpen, setHistoryOpen] = useState(true);

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
          conversationId: conversationId || undefined
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

        if (chunk.type === "turn" && chunk.entry) {
          generatedTurns += 1;
          setMessages((previous) => [...previous, chunk.entry]);
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
  }, [activeConversationId, activeTopic, clearThreadState, loadHistory, topic, totalTurns, turnsInput]);

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
      return "Loading threads...";
    }
    return `${conversations.length} threads`;
  }, [conversations.length, historyLoading]);

  return (
    <main className="min-h-screen bg-background">
      <div className="container py-6 md:py-10">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">openllmchat</h1>
            <p className="text-sm text-muted-foreground">Two agents, one focused conversation.</p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="icon"
              aria-label={historyOpen ? "Collapse sidebar" : "Expand sidebar"}
              onClick={() => setHistoryOpen((open) => !open)}
            >
              {historyOpen ? <PanelLeftClose className="size-4" /> : <PanelLeft className="size-4" />}
            </Button>
            <Button
              variant="secondary"
              size="icon"
              aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
              onClick={() => applyTheme(theme === "dark" ? "light" : "dark")}
            >
              {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </Button>
            <Button variant="secondary" onClick={onNewThread}>
              <Plus className="size-4" />
              New thread
            </Button>
          </div>
        </div>

        <div className={cn("grid gap-4", historyOpen ? "lg:grid-cols-[290px,1fr]" : "lg:grid-cols-1")}>
          {historyOpen ? (
            <Card className="h-[76vh] min-h-[520px] overflow-hidden">
              <CardHeader className="border-b pb-4">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-base">Saved conversations</CardTitle>
                  <div className="flex items-center gap-1">
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
                </div>
                <CardDescription>{historyStatus}</CardDescription>
              </CardHeader>
              <CardContent className="thread-scroll h-[calc(76vh-88px)] overflow-y-auto p-2">
                {conversations.length === 0 ? (
                  <p className="rounded-md px-3 py-2 text-sm text-muted-foreground">No threads yet.</p>
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
              </CardContent>
            </Card>
          ) : null}

          <Card className="h-[76vh] min-h-[520px] overflow-hidden">
            <CardHeader className="border-b pb-4">
              <form
                className="grid gap-3 md:grid-cols-[1fr,120px,auto]"
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
            <CardContent className="thread-scroll h-[calc(76vh-122px)] overflow-y-auto p-4 md:p-5">
              {messages.length === 0 ? (
                <p className="text-sm text-muted-foreground">No messages yet. Add a topic and start.</p>
              ) : (
                <ul className="space-y-3">
                  {messages.map((entry, index) => (
                    <li key={`${entry.turn}-${index}`} className="rounded-md border bg-muted/30 px-4 py-3">
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <p className="text-sm font-semibold">{entry.speaker || "Agent"}</p>
                        <p className="font-mono text-xs text-muted-foreground">
                          Turn {Number(entry.turn || index + 1)}
                        </p>
                      </div>
                      <p className="text-sm leading-6 text-foreground/95">{entry.text || ""}</p>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  );
}
