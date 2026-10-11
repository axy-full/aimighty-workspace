"use client";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useRig } from "@/components/workspace/rig/RigProvider";
import { ACTIVE_STATES } from "@/lib/workbench/rig-agent-plan";
import { approvalsChanged } from "@/lib/control-room/approve";
import { BUSY_MS, IDLE_MS, READ_FAILED, callAgent, goalOf, readAgent, readProblem, type AgentAnswer, type AskTerms } from "./agent-api";

/**
 * The board agent's run, read for the docked panel and for the empty board's Start: one read per production,
 * shared by whoever is showing it, often while Atomik works and now and then otherwise (a teammate may start a run).
 * `GET /api/workbench/team-canvas?agent=1`; as its cards land the board folds them in.
 */
type Entry = { answer: AgentAnswer | null; error: string | null; terms: AskTerms | null; subscribers: number; timer: ReturnType<typeof setTimeout> | null; reading: boolean };
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const tell = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const keyOf = (scope: string, production: string) => `${scope}|${production}`;
const entryOf = (key: string): Entry => {
  let entry = entries.get(key);
  if (!entry) { entry = { answer: null, error: null, terms: null, subscribers: 0, timer: null, reading: false }; entries.set(key, entry); }
  return entry;
};

/** Replaces an entry's value (a new object, so a store snapshot changes) and tells every reader. */
function put(key: string, patch: Partial<Pick<Entry, "answer" | "error" | "terms">>) {
  const entry = entryOf(key);
  entries.set(key, { ...entry, ...patch });
  tell();
}

async function read(key: string, scope: string, production: string, draft: string | null) {
  const entry = entryOf(key);
  if (entry.reading) return;
  entry.reading = true;
  try {
    const answer = await readAgent(scope, production, draft);
    const now = entryOf(key);
    put(key, { answer, error: null, terms: answer.ask ?? now.terms });
  } catch {
    put(key, { error: READ_FAILED });
  } finally {
    entryOf(key).reading = false;
  }
}

function schedule(key: string, scope: string, production: string, draft: string | null) {
  const entry = entryOf(key);
  if (entry.timer || !entry.subscribers) return;
  const active = !!entry.answer?.run && ACTIVE_STATES.includes(entry.answer.run.state);
  const watching = !entry.answer || entry.answer.enabled || !!entry.answer.run;
  if (!watching) return;
  entry.timer = setTimeout(async () => {
    entryOf(key).timer = null;
    if (document.visibilityState !== "hidden") await read(key, scope, production, draft);
    schedule(key, scope, production, draft);
  }, active ? BUSY_MS : IDLE_MS);
}

export type BoardAgent = {
  /** The run and whether Atomik may build on this workspace; null until the first read. */
  answer: AgentAnswer | null;
  /** The planning figure for this board now (the code's, `ask.planning`), or null. */
  terms: AskTerms | null;
  readError: string | null;
  refresh: () => Promise<void>;
  /** A person's call on the run or a new ask, through the team-canvas route. Answers why not, or null. */
  call: (body: Record<string, unknown>) => Promise<string | null>;
  /** Ask Atomik to plan this board, at the limit the person pressed (the planning figure on the button), with the files attached (`upload:<id>`). */
  plan: (words: string, limit: number, extra?: { aspect?: string | null; seconds?: number | null }, attachments?: readonly string[]) => Promise<string | null>;
  /** Planning's figure for this board with these files attached, read now from the server (nothing is reserved); or why not. */
  quote: (attachments: readonly string[]) => Promise<{ planning: number | null } | { error: string }>;
  ready: boolean;
  /** The planning figure as the last read holds it, for a press that must not outrun a price that moved. */
  latestPlanning: () => number | null;
};

export function useAgentRun(): BoardAgent {
  const rig = useRig();
  const production = rig.project?.productionProjectId ?? null;
  const draft = rig.project?.id ?? null;
  const scope = rig.scope;
  const joined = rig.team.mode !== "off";
  const key = production ? keyOf(scope, production) : "";
  const snapshot = useSyncExternalStore(subscribe, () => (key ? entries.get(key) ?? null : null), () => null);
  const { refresh: refreshTeam } = rig.team;

  useEffect(() => {
    if (!key || !production || !joined) return;
    const entry = entryOf(key);
    entry.subscribers += 1;
    void read(key, scope, production, draft).then(() => schedule(key, scope, production, draft));
    return () => {
      const now = entryOf(key);
      now.subscribers -= 1;
      if (now.subscribers <= 0 && now.timer) { clearTimeout(now.timer); now.timer = null; }
    };
  }, [key, production, joined, scope, draft]);
  /* A run that changes state shortens the wait for the next read. */
  const run = snapshot?.answer?.run ?? null;
  const landed = run ? `${run.id}:${run.state}:${run.built.cards}:${run.built.wires}:${run.undo ? "u" : ""}:${run.paid.filter((p) => p.state === "done").length}` : "";
  useEffect(() => {
    if (!key || !production) return;
    const entry = entryOf(key);
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    schedule(key, scope, production, draft);
  }, [landed, key, production, scope, draft]);
  useEffect(() => { if (landed) void refreshTeam(); }, [landed, refreshTeam]);

  const refresh = useCallback(async () => { if (key && production) await read(key, scope, production, draft); }, [key, production, scope, draft]);
  const call = useCallback(async (body: Record<string, unknown>) => {
    if (!production || !key) return "This project has no board yet.";
    const result = await callAgent(scope, production, body);
    if (!result.ok) return result.error;
    put(key, { answer: result.agent, error: null });
    window.dispatchEvent(new Event("particl:board-agent-changed"));
    approvalsChanged();
    return null;
  }, [production, key, scope]);
  const plan = useCallback((words: string, limit: number, extra?: { aspect?: string | null; seconds?: number | null }, attachments: readonly string[] = []) => {
    if (!draft) return Promise.resolve("This project isn't ready for Atomik yet. Try again.");
    return call({ action: "agent.plan", projectId: draft, requestId: crypto.randomUUID(), goal: goalOf(words, extra), limit, mode: "ask", ...(attachments.length ? { attachments: [...attachments] } : {}) });
  }, [call, draft]);
  const quote = useCallback(async (attachments: readonly string[]) => {
    if (!production) return { error: "This project has no board yet." };
    try { return { planning: (await readAgent(scope, production, draft, attachments)).ask?.planning ?? null }; }
    catch (error) { return { error: readProblem(error) }; }
  }, [scope, production, draft]);

  return useMemo(() => ({
    answer: snapshot?.answer ?? null,
    terms: snapshot?.terms ?? null,
    readError: snapshot?.error ?? null,
    refresh, call, plan, quote,
    ready: !!snapshot?.answer,
    latestPlanning: () => (key ? entries.get(key)?.terms?.planning ?? null : null),
  }), [snapshot, refresh, call, plan, quote, key]);
}
