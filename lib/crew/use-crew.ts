"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { DEFAULT_CONTEXT, minutesFile, roundBlock, type CrewContext, type CrewPhase } from "./room";
import type { CrewMember, CrewSession, CrewSolution, MemberPatch, SessionSummary, StoredMessage } from "./store";

/**
 * The room, in the browser. Everything here is read from or written through
 * /api/crew — the roster, the transcript and the solutions are the server's.
 * The Run round button wears a live quote; pressing it approves exactly that
 * figure (`maxCredits`), and the round arrives as server-sent events.
 */
export type RoomMessage = StoredMessage & { to: string | null };
export type CrewStatus = { connected: boolean; priced: boolean; model: string };
type Quote = { key: string; credits: number | null; usd: number | null; reason: string | null };

const STORE = (projectId: string) => `particl-crew-room-${projectId}`;
const remember = (projectId: string, id: string | null) => { try { if (id) sessionStorage.setItem(STORE(projectId), id); else sessionStorage.removeItem(STORE(projectId)); } catch { /* the room still works for this visit */ } };
const recall = (projectId: string) => { try { return sessionStorage.getItem(STORE(projectId)); } catch { return null; } };

export function useCrew(projectId: string | null) {
  const scoped = useScopedFetch();
  const [status, setStatus] = useState<CrewStatus | null>(null);
  const [members, setMembers] = useState<CrewMember[]>([]);
  const [session, setSession] = useState<CrewSession | null>(null);
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [solutions, setSolutions] = useState<CrewSolution[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [goal, setGoal] = useState("");
  const [context, setContext] = useState<CrewContext>(DEFAULT_CONTEXT);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<{ round: number; phase: CrewPhase } | null>(null);
  const [thinking, setThinking] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const call = useCallback(async <T,>(url: string, init?: RequestInit): Promise<T> => {
    const response = await scoped(url, { cache: "no-store", ...init, headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...(init?.headers ?? {}) } });
    const json = await response.json().catch(() => null) as (T & { error?: string }) | null;
    if (!response.ok || !json) throw new Error(json?.error ?? "Crew could not do that.");
    return json;
  }, [scoped]);

  const openRoom = useCallback(async (id: string) => {
    const room = await call<{ session: CrewSession; members: CrewMember[]; messages: RoomMessage[]; solutions: CrewSolution[] }>(`/api/crew/sessions/${encodeURIComponent(id)}`);
    setSession(room.session); setMembers(room.members); setMessages(room.messages); setSolutions(room.solutions);
    setGoal(room.session.goal); setContext(room.session.context); setNotice(null);
    remember(room.session.projectId, room.session.id);
  }, [call]);

  const refreshSessions = useCallback(async () => {
    if (!projectId) return;
    setSessions((await call<{ sessions: SessionSummary[] }>(`/api/crew/sessions?projectId=${encodeURIComponent(projectId)}`)).sessions);
  }, [call, projectId]);

  /* Load: the key's status, this project's roster, its rooms, and the room left open. */
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const s = await call<CrewStatus>("/api/crew/status");
        if (live) setStatus(s);
      } catch { if (live) setStatus({ connected: false, priced: false, model: "" }); }
      if (!projectId) { if (live) setLoaded(true); return; }
      try {
        const [roster, rooms] = await Promise.all([
          call<{ members: CrewMember[] }>(`/api/crew/members?projectId=${encodeURIComponent(projectId)}`),
          call<{ sessions: SessionSummary[] }>(`/api/crew/sessions?projectId=${encodeURIComponent(projectId)}`),
        ]);
        if (!live) return;
        setMembers(roster.members); setSessions(rooms.sessions);
        const open = recall(projectId);
        if (open && rooms.sessions.some((r) => r.id === open)) await openRoom(open);
      } catch (error) {
        if (live) setNotice(error instanceof Error ? error.message : "Crew could not be loaded.");
      } finally { if (live) setLoaded(true); }
    })();
    return () => { live = false; };
  }, [call, projectId, openRoom]);

  const active = useMemo(() => members.filter((m) => m.active), [members]);
  const blockedBy = roundBlock({ goal, seated: active.length, running, roundsRun: session?.roundsRun ?? 0, keyConnected: status?.connected ?? true, hasProject: Boolean(projectId) });

  /* The live price: what the next round can cost at most, for exactly this goal, context and roster. */
  const quoteKey = JSON.stringify([projectId, session?.id ?? null, session?.roundsRun ?? 0, messages.length, goal.trim(), context, active.map((m) => [m.id, m.stance.length, m.name, m.department])]);
  const quotable = blockedBy === null && Boolean(projectId) && loaded;
  useEffect(() => {
    if (!quotable) return;
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const q = await call<{ estimateCredits: number; estimateUsd?: number }>("/api/crew/sessions", { method: "POST", body: JSON.stringify({ projectId, goal, context, sessionId: session?.id, quoteOnly: true }) });
        if (live) setQuote({ key: quoteKey, credits: q.estimateCredits, usd: q.estimateUsd ?? null, reason: null });
      } catch (error) {
        if (live) setQuote({ key: quoteKey, credits: null, usd: null, reason: error instanceof Error ? error.message : "The round cannot be priced right now." });
      }
    }, 600);
    return () => { live = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quoteKey, quotable, call]);
  const current = quote && quote.key === quoteKey ? quote : null;
  const credits = quotable ? current?.credits ?? null : null;
  const blocked = !loaded ? "Opening the room…" : blockedBy !== null ? blockedBy : current?.reason ? current.reason : credits == null ? "Pricing…" : null;

  const live = useRef({ goal, context, session, credits, projectId });
  useEffect(() => { live.current = { goal, context, session, credits, projectId }; });

  const ensureRoom = useCallback(async (): Promise<CrewSession> => {
    const now = live.current;
    if (now.session) {
      if (now.session.goal !== now.goal.trim() || JSON.stringify(now.session.context) !== JSON.stringify(now.context)) {
        const patched = await call<{ session: CrewSession }>(`/api/crew/sessions/${now.session.id}`, { method: "PATCH", body: JSON.stringify({ goal: now.goal, context: now.context }) });
        setSession(patched.session);
        return patched.session;
      }
      return now.session;
    }
    const created = await call<{ session: CrewSession }>("/api/crew/sessions", { method: "POST", body: JSON.stringify({ projectId: now.projectId, goal: now.goal, context: now.context }) });
    setSession(created.session);
    remember(created.session.projectId, created.session.id);
    return created.session;
  }, [call]);

  const runRound = useCallback(async (): Promise<string | null> => {
    const approved = live.current.credits;
    if (approved == null) return null;
    setRunning(true); setNotice(null); setThinking([]);
    let outcome: string | null = null;
    try {
      const room = await ensureRoom();
      const response = await scoped(`/api/crew/sessions/${room.id}/rounds`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ maxCredits: approved }) });
      if (!response.ok || !response.body) throw new Error((await response.json().catch(() => null))?.error ?? "The round could not start. Nothing was charged.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const handle = (event: string, data: Record<string, unknown>) => {
        if (event === "phase") setPhase(data as { round: number; phase: CrewPhase });
        else if (event === "thinking") setThinking((t) => [...t, String(data.memberId)]);
        else if (event === "message") { const m = data as unknown as RoomMessage; setThinking((t) => t.filter((id) => id !== m.memberId)); setMessages((all) => [...all, m]); }
        else if (event === "failed") setThinking((t) => t.filter((id) => id !== data.memberId));
        else if (event === "solutions") setSolutions((all) => [...all, ...(data as unknown as CrewSolution[])]);
        else if (event === "done") outcome = data.billed ? `Round ${data.round} complete${data.spendCr == null ? "" : ` · ${Number(data.spendCr).toLocaleString("en-US")} cr settled`}` : String(data.note ?? "The round was not billed.");
        else if (event === "error") outcome = String(data.error ?? "The round stopped. Nothing was charged.");
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut: number;
        while ((cut = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, cut); buffer = buffer.slice(cut + 2);
          const event = /^event: (.+)$/m.exec(block)?.[1], data = /^data: (.+)$/m.exec(block)?.[1];
          if (event && data) { try { handle(event, JSON.parse(data)); } catch { /* a malformed frame is skipped, the room is re-read below */ } }
        }
      }
      await openRoom(room.id);
      void refreshSessions();
    } catch (error) {
      /* The stream can drop while the server finishes the round (a deploy
         cut-over did exactly that on 21 September). The room is the record,
         so re-read it before saying anything about the round. */
      const reread = live.current.session ? await openRoom(live.current.session.id).then(() => true).catch(() => false) : false;
      const message = error instanceof Error ? error.message : "";
      outcome = reread
        ? "The connection dropped while the room was talking; the room has been re-read."
        : /failed to fetch|network|load failed/i.test(message) ? "The connection dropped and the room could not be re-read. Reload to see what the round did." : message || "The round stopped. Nothing was charged.";
      void refreshSessions();
    } finally {
      setRunning(false); setPhase(null); setThinking([]);
    }
    if (outcome) setNotice(outcome);
    return outcome;
  }, [ensureRoom, scoped, openRoom, refreshSessions]);

  const guard = useCallback(async (work: () => Promise<void>) => {
    try { setNotice(null); await work(); } catch (error) { setNotice(error instanceof Error ? error.message : "Crew could not do that."); }
  }, []);

  return {
    status, loaded, members, active, session, messages, solutions, sessions, goal, context, running, phase, thinking, notice, credits, usd: current?.usd ?? null, blocked,
    setGoal, setContext: (key: keyof CrewContext) => setContext((c) => ({ ...c, [key]: !c[key] })),
    runRound,
    newRoom: () => { if (projectId) remember(projectId, null); setSession(null); setMessages([]); setSolutions([]); setGoal(""); setContext(DEFAULT_CONTEXT); setNotice(null); },
    reopen: (id: string) => guard(() => openRoom(id)),
    addMember: (presetId: string) => guard(async () => { setMembers((await call<{ members: CrewMember[] }>("/api/crew/members", { method: "POST", body: JSON.stringify({ projectId, presetId }) })).members); }),
    patchMember: (id: string, patch: MemberPatch) => guard(async () => { setMembers((await call<{ members: CrewMember[] }>("/api/crew/members", { method: "PATCH", body: JSON.stringify({ id, ...patch }) })).members); }),
    removeMember: (id: string) => guard(async () => { await call(`/api/crew/members?id=${encodeURIComponent(id)}`, { method: "DELETE" }); setMembers((all) => all.filter((m) => m.id !== id)); }),
    say: (text: string) => guard(async () => { const room = await ensureRoom(); const { message } = await call<{ message: RoomMessage }>(`/api/crew/sessions/${room.id}/notes`, { method: "POST", body: JSON.stringify({ text }) }); setMessages((all) => [...all, message]); }),
    pin: (messageId: string) => guard(async () => { const { solution } = await call<{ solution: CrewSolution }>("/api/crew/solutions", { method: "POST", body: JSON.stringify({ messageId }) }); setSolutions((all) => [...all, solution]); }),
    dropSolution: (id: string) => guard(async () => { await call(`/api/crew/solutions?id=${encodeURIComponent(id)}`, { method: "DELETE" }); setSolutions((all) => all.filter((s) => s.id !== id)); }),
    /** Where it went: the Rig route also names the draft shot it wrote (`nodeId`, `title`), so the confirmation can open it. */
    routeSolution: async (id: string, to: "brief" | "boards" | "gen"): Promise<{ status: CrewSolution["status"]; prompt?: string; nodeId?: string; title?: string } | null> => {
      try {
        const routed = await call<{ status: CrewSolution["status"]; prompt?: string; nodeId?: string; title?: string }>(`/api/crew/solutions/${encodeURIComponent(id)}/route`, { method: "POST", body: JSON.stringify({ to }) });
        setSolutions((all) => all.map((s) => (s.id === id ? { ...s, status: routed.status } : s)));
        return routed;
      } catch (error) { setNotice(error instanceof Error ? error.message : "Crew could not send that."); return null; }
    },
    minutes: () => guard(async () => {
      if (!session) return;
      const response = await scoped(`/api/crew/sessions/${session.id}/minutes`);
      if (!response.ok) throw new Error("The minutes could not be exported.");
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement("a");
      a.href = url; a.download = `crew-minutes-${session.id}.md`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }),
    /** The minutes as a file, for the Library (`uploadToProject` stores it byte-identical and files it on the project). */
    minutesAsFile: async () => {
      if (!session) throw new Error("There is no session to file.");
      const response = await scoped(`/api/crew/sessions/${session.id}/minutes`);
      if (!response.ok) throw new Error("The minutes could not be exported.");
      return minutesFile(await response.text(), session.id);
    },
    verify: async () => call<{ ok: boolean; listed: boolean; model: string; models: string[]; reason?: string }>("/api/crew/status", { method: "POST" }),
  };
}
export type CrewRoom = ReturnType<typeof useCrew>;
