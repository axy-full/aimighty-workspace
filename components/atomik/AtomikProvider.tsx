"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Chat, Message, Step, Engine } from "@/lib/atomik";
import type { StepState, RingMode } from "@/lib/ring";
import { useProject } from "@/lib/projectContext";
import { useSession } from "@/lib/session";
import { useApi } from "@/lib/useApi";
import {usePaidAction} from "@/lib/usePaidAction";
import { useMoney } from "@/lib/price";
import { useAtomikQuote } from "@/lib/useAtomikQuote";
import type { PaidTextQuote } from "@/lib/paidText";
import type { ThinkingModel } from "./ModelPicker";
import { connectedMeta } from "@/lib/higgsfield-consumer/planner-proposals";

/**
 * Atomik, at app level (design/particl-v2/README.md §5).
 *
 * One conversation per production, and the rail shows the current thing in
 * it: a checkpoint (a priced step waiting for you), a question (Atomik
 * needs a decision before it spends), a plan (steps priced, nothing run
 * yet), a receipt (everything ran), or the planning ring while it thinks.
 * The header button shows the same state at 14px whether the rail is open
 * or not, which is why this lives in the shell and not in the rail.
 *
 * It is the existing agent — chats, messages, steps, the claim-then-render
 * gate — through the existing routes. Atomik never decides anything that
 * spends: every render here is a step you pressed Continue on, claimed
 * first so two tabs cannot pay twice, then sent through the ordinary
 * generate routes so the take is indistinguishable from a hand-made one.
 */

type Loaded = { chat: Chat; messages: Message[]; steps: Step[] };
type Index = { chats: (Chat & { needsApproval: boolean })[]; engines: Engine[]; models?: { featured: ThinkingModel[]; rest: ThinkingModel[] } };

export type Current =
  | { kind: "idle" }
  | { kind: "planning" }
  | { kind: "question"; message: Message; ask: NonNullable<Message["ask"]> }
  | { kind: "checkpoint"; step: Step; done: Step[]; spentCredits: number }
  | { kind: "plan"; steps: Step[] }
  | { kind: "done"; steps: Step[]; failed: Step[]; spentCredits: number };

export type AtomikLive = {
  chat: Chat | null;
  messages: Message[];
  /** The plan: the steps of the latest turn, in order. */
  plan: Step[];
  current: Current;
  engines: Engine[];
  /** The ring, as the run stands: steps when there is a plan, a mode otherwise. */
  ring: { steps: StepState[] } | { mode: RingMode };
  /** The word beside the shortcut on the header button (`CHECKPOINT`), or none. */
  word: string | null;
  /** Credits: the plan's total, what is left under the production's cap, and what planning has cost.
   *  `connected` is the plan's connected-credit total, billed to the connected account, never mixed in. */
  totals: { total: number; underCap: number | null; planning: number; connected: number };
  /** A step's price, as a number in the workspace's unit (0 for a connected step). */
  credits: (step: Step) => number;
  /** A step's price as shown: `24 cr`, or `42 connected cr` for a connected-account step. */
  priceLabel: (step: Step) => string;
  /** True for a step that runs on the connected account at its quoted price. */
  isConnected: (step: Step) => boolean;
  /** What Continue approves for this step: its own price, or its whole batch's exact total. */
  approveLabel: (step: Step) => string;
  /** That number as the workspace prints it: `24 cr`, or `$2.90`. */
  fmt: (n: number) => string;
  engineLabel: (id: string) => string;
  busy: boolean;
  error: string | null;
  recoveryText:string|null;
  models: ThinkingModel[];
  model: string;
  effort: string;
  draftText: string;
  setDraftText: (text: string) => void;
  setThinkingModel: (model: string) => void;
  setReasoningEffort: (effort: string) => void;
  quote: PaidTextQuote | null;
  quoteError: string | null;
  quoting: boolean;
  send: (text: string) => Promise<void>;
  approve: (step: Step) => Promise<void>;
  stop: (step: Step) => Promise<void>;
  changeEngine: (step: Step, model: string) => Promise<void>;
  clear: () => void;
};

const Ctx = createContext<AtomikLive | null>(null);

const usdOf = (s: Step) => s.estCostUsd ?? 0;
const whole = (n: number) => (n > 0 ? Math.max(1, Math.ceil(n - 1e-9)) : 0);

export function AtomikProvider({ children }: { children: ReactNode }) {
  const { signedIn, workspace, email } = useSession();
  const { current: production } = useProject();
  const money = useMoney();
  const paid=usePaidAction(`/api/atomik/chat:${production?.id??"unfiled"}`);
  const recovered = paid.pending ? JSON.parse(paid.pending.body) as {text?:string;model?:string;effort?:string} : null;
  const recoveryText = recovered ? String(recovered.text ?? "") : null;
  const { data: index, refresh: refreshIndex } = useApi<Index>(signedIn ? "/api/atomik" : null, 60_000);
  /* A conversation this browser started, and the production it started it
     for — it stands in for the index's pick only while that production is
     the one on screen, so no effect has to reset anything. */
  const [chatFor, setChatFor] = useState<{ id: string; projectId: string | null } | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dispatched = useRef(new Set<string>());

  /* The conversation is the production's: its most recent chat, unless the
     person dismissed it from the rail's context chip. */
  const pick = useMemo(() => {
    if (!index?.chats?.length) return null;
    const mine = production ? index.chats.filter((c) => c.projectId === production.id) : index.chats;
    const first = (mine.length ? mine : [])[0] ?? null;
    return first && first.id !== dismissed ? first.id : null;
  }, [index, production, dismissed]);
  const activeId = chatFor && chatFor.projectId === (production?.id ?? null) ? chatFor.id : pick;

  const { data: loaded, refresh: refreshChat } = useApi<Loaded>(
    signedIn && activeId ? `/api/atomik/${encodeURIComponent(activeId)}` : null,
    thinking ? 3_000 : 15_000,
  );
  const composerScope = JSON.stringify([workspace?.id, email, production?.id, activeId]);
  const [selection, setSelection] = useState<{ scope: string; model: string; effort: string } | null>(null);
  const [draft, setDraft] = useState<{ scope: string; text: string } | null>(null);
  const selected = selection?.scope === composerScope ? selection : null;
  const savedChat = loaded?.chat.id === activeId ? loaded.chat : null;
  const model = recovered?.model ?? selected?.model ?? savedChat?.model ?? "auto";
  const effort = recovered?.effort ?? selected?.effort ?? savedChat?.effort ?? "auto";
  const draftText = recoveryText ?? (draft?.scope === composerScope ? draft.text : "");
  const models = useMemo(() => [...(index?.models?.featured ?? []), ...(index?.models?.rest ?? [])], [index]);
  const setDraftText = useCallback((text: string) => { if (!paid.pending && !busy) setDraft({ scope: composerScope, text }); }, [composerScope, paid.pending, busy]);
  const setThinkingModel = useCallback((value: string) => { if (!paid.pending && !busy) setSelection({ scope: composerScope, model: value, effort: "auto" }); }, [composerScope, paid.pending, busy]);
  const setReasoningEffort = useCallback((value: string) => { if (!paid.pending && !busy) setSelection({ scope: composerScope, model, effort: value }); }, [composerScope, model, paid.pending, busy]);
  const { quote, error: quoteError, loading: quoting } = useAtomikQuote(activeId ? `/api/atomik/${encodeURIComponent(activeId)}` : "/api/atomik",
    !paid.pending && draftText.trim() ? { text: draftText.trim(), model, effort, projectId: production?.id ?? null } : null);

  /* The latest refresh, for the flows that await it after their writes —
     bound in an effect, since a ref may not change during render. */
  const refreshRef = useRef(refreshChat);
  useEffect(() => { refreshRef.current = refreshChat; }, [refreshChat]);

  const engines = useMemo(() => index?.engines ?? [], [index]);
  const engineLabel = useCallback((id: string) => engines.find((e) => e.id === id)?.label ?? id, [engines]);
  /* The server's estimate is already in the workspace's unit (lib/price.ts):
     in credits it is rounded up to a whole credit, at least one, exactly as
     the price on a button is. */
  const credits = useCallback((s: Step) => connectedMeta(s.params) ? 0 : money.inCredits ? whole(usdOf(s)) : usdOf(s), [money]);
  const isConnected = useCallback((s: Step) => connectedMeta(s.params) !== null, []);
  const batchOf = useCallback((s: Step, steps: Step[]) => {
    const id = connectedMeta(s.params)?.batch?.id;
    return id ? steps.filter((o) => o.status === "proposed" && connectedMeta(o.params)?.batch?.id === id) : [s];
  }, []);
  const priceLabel = useCallback((s: Step) => {
    const meta = connectedMeta(s.params);
    return meta ? `${meta.credits.toLocaleString("en-US")} connected cr` : money.price(credits(s));
  }, [money, credits]);

  const messages = useMemo(() => loaded?.messages ?? [], [loaded]);
  const lastAssistant = useMemo(() => [...messages].reverse().find((m) => m.role === "assistant") ?? null, [messages]);
  const plan = useMemo(() => {
    const steps = loaded?.steps ?? [];
    const ofTurn = lastAssistant ? steps.filter((s) => s.messageId === lastAssistant.id) : [];
    return (ofTurn.length ? ofTurn : steps).filter((s) => s.status !== "rejected").sort((a, b) => a.position - b.position);
  }, [loaded, lastAssistant]);

  const spentCredits = plan.filter((s) => s.status === "done").reduce((a, s) => a + credits(s), 0);
  const current: Current = useMemo(() => {
    if (!loaded) return { kind: "idle" };
    if (thinking || loaded.chat.status === "running") return { kind: "planning" };
    const proposed = plan.find((s) => s.status === "proposed");
    if (lastAssistant?.ask && !proposed && (!plan.length || plan.every((s) => s.status === "done"))) return { kind: "question", message: lastAssistant, ask: lastAssistant.ask };
    if (proposed) return { kind: "checkpoint", step: proposed, done: plan.filter((s) => s.status === "done"), spentCredits };
    if (plan.length && plan.every((s) => s.status === "done" || s.status === "failed")) return { kind: "done", steps: plan, failed: plan.filter((s) => s.status === "failed"), spentCredits };
    if (plan.length) return { kind: "plan", steps: plan };
    if (lastAssistant?.ask) return { kind: "question", message: lastAssistant, ask: lastAssistant.ask };
    return { kind: "idle" };
  }, [loaded, thinking, plan, lastAssistant, spentCredits]);

  const ring: AtomikLive["ring"] = useMemo(() => {
    if (current.kind === "planning") return { mode: "planning" };
    if (current.kind === "done" && !current.failed.length) return { mode: "done" };
    if (!plan.length) return { mode: "idle" };
    let checkpointSeen = false;
    return { steps: plan.slice(0, 8).map((s): StepState => {
      if (s.status === "done") return "done";
      if (s.status === "running") return "running";
      if (s.status === "failed") return "needsYou";
      if (!checkpointSeen) { checkpointSeen = true; return "checkpoint"; }
      return "queued";
    }) };
  }, [current, plan]);

  const word = current.kind === "checkpoint" ? "checkpoint" : current.kind === "planning" ? "planning"
    : current.kind === "question" ? "question" : plan.some((s) => s.status === "running") ? "running"
    : current.kind === "done" ? "done" : null;

  const total = plan.reduce((a, s) => a + credits(s), 0);
  const cap = production ? (money.inCredits ? production.capCredits ?? null : production.capUsd ?? null) : null;
  const spent = production ? (money.inCredits ? production.credits ?? 0 : production.spend ?? 0) : 0;
  const planning = loaded ? (money.inCredits ? whole(loaded.chat.textCostUsd) : loaded.chat.textCostUsd) : 0;
  const approveLabel = useCallback((s: Step) => {
    const members = batchOf(s, plan);
    if (members.length < 2) return priceLabel(s);
    const sum = members.reduce((a, o) => a + (connectedMeta(o.params)?.credits ?? 0), 0);
    return `batch of ${members.length} · ${sum.toLocaleString("en-US")} connected cr`;
  }, [batchOf, plan, priceLabel]);
  const connectedTotal = plan.reduce((a, s) => a + (connectedMeta(s.params)?.credits ?? 0), 0);
  const totals = { total, underCap: cap === null ? null : cap - spent - total, planning, connected: connectedTotal };

  /* A connected step runs on the connected account: its status is read (one
     leased read per step) until the original is collected and filed. */
  const runningConnected = plan.filter((s) => s.status === "running" && connectedMeta(s.params)).map((s) => s.id).join(",");
  useEffect(() => {
    if (!runningConnected) return;
    const ids = runningConnected.split(",");
    const read = async () => {
      for (const id of ids)
        await fetch(`/api/atomik/steps/${encodeURIComponent(id)}/connected`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "status" }) }).catch(() => null);
      await refreshRef.current();
    };
    const timer = setInterval(() => void read(), 15_000);
    return () => clearInterval(timer);
  }, [runningConnected]);

  const send = useCallback(async (text: string) => {
    const t = (recoveryText??text).trim();
    if (!t || busy) return;
    if (!paid.pending && (!quote || t !== draftText.trim())) { setError("Review the current planning estimate before sending."); return; }
    const requestBody = paid.pending ? JSON.parse(paid.pending.body) : { text: t, model: quote!.model, effort: quote!.effort, maxCredits: quote!.estimateCredits };
    setBusy(true); setError(null);
    try {
      let id = paid.pending?decodeURIComponent(paid.pending.url.split("/").at(-1)!):activeId;
      if(paid.pending)setChatFor({id:id!,projectId:production?.id??null});
      if (!id) {
        const r = await fetch("/api/atomik", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: production?.id ?? null, model: requestBody.model, effort: requestBody.effort }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error ?? "Atomik couldn't start a conversation.");
        id = String(j.id); setChatFor({ id, projectId: production?.id ?? null }); setDismissed(null);
      }
      setThinking(true);
      await paid.run(`/api/atomik/${encodeURIComponent(id)}`, requestBody);
      setDraft(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setThinking(false);
      await refreshRef.current();
      refreshIndex();
      setBusy(false);
    }
  }, [activeId, busy, production, refreshIndex,paid,recoveryText,quote,draftText]);

  /* Continue: the gate. Claim, then render through the ordinary routes. */
  const approve = useCallback(async (proposed: Step) => {
    if (busy || dispatched.current.has(proposed.id)) return;
    dispatched.current.add(proposed.id);
    setBusy(true); setError(null);
    try {
      const meta = connectedMeta(proposed.params);
      if (meta) {
        /* The exact connected credits and wallet this card shows; the server
           checks them against the durable quote, claims once and submits once.
           A batch is ONE approval for its waiting steps' exact summed total. */
        const members = batchOf(proposed, loaded?.steps ?? []);
        const body = members.length > 1
          ? { action: "approve-batch", stepIds: members.map((m) => m.id), credits: members.reduce((a, m) => a + (connectedMeta(m.params)?.credits ?? 0), 0), workspaceId: meta.workspaceId }
          : { action: "approve", credits: meta.credits, workspaceId: meta.workspaceId };
        const r = await fetch(`/api/atomik/steps/${encodeURIComponent(proposed.id)}/connected`, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { dispatched.current.delete(proposed.id); setError(j.error ?? "That step couldn't be started."); }
        return;
      }
      const claim = await fetch(`/api/atomik/steps/${proposed.id}/claim`, { method: "POST" });
      const cj = await claim.json().catch(() => ({}));
      if (!claim.ok) { if (claim.status !== 409) setError(cj.error ?? "That step couldn't be started."); return; }
      const step: Step = cj.step;
      const projectId = loaded?.chat.projectId ?? null;
      const res = step.kind === "audio"
        ? await fetch("/api/audio", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": `atomik-step:${step.id}` }, body: JSON.stringify({
            task: typeof step.params.task === "string" ? step.params.task : "sound", text: step.prompt, projectId, title: step.title,
            durationSeconds: Number(step.params.seconds) || undefined }) })
        : await fetch("/api/generate", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": `atomik-step:${step.id}` }, body: JSON.stringify({
            prompt: step.prompt, model: step.model, projectId, ratio: step.params.ratio, resolution: step.params.resolution,
            duration: Number(step.params.seconds) || undefined, references: step.refs?.length ? step.refs : undefined }) });
      const j = await res.json().catch(() => ({}));
      await fetch(`/api/atomik/steps/${step.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(res.ok ? { status: "done", genId: j.id ?? null } : { status: "failed", error: j.error ?? `Failed (${res.status})` }) });
      if (!res.ok) setError(j.error ?? "That render didn't start.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      await refreshRef.current();
      setBusy(false);
    }
  }, [busy, loaded, batchOf]);

  const stop = useCallback(async (step: Step) => {
    if (busy) return;
    setBusy(true);
    try {
      await fetch(`/api/atomik/steps/${step.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "rejected" }) });
    } finally { await refreshRef.current(); setBusy(false); }
  }, [busy]);

  /* Re-priced by the server before the button can be pressed again. */
  const changeEngine = useCallback(async (step: Step, model: string) => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/atomik/steps/${step.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ params: { ...step.params, model }, model }) });
      if (!r.ok) { const j = await r.json().catch(() => ({})); setError(j.error ?? "That engine didn't stick."); }
    } finally { await refreshRef.current(); setBusy(false); }
  }, [busy]);

  const clear = useCallback(() => { setDismissed(activeId); setChatFor(null); }, [activeId]);

  const fmt = useCallback((n: number) => money.price(n), [money]);
  const value: AtomikLive = {
    chat: loaded?.chat ?? null, messages, plan, current, engines, ring, word, totals, credits, priceLabel, isConnected, approveLabel, fmt, engineLabel,
    busy, error:paid.error??error, recoveryText, models, model, effort, draftText, setDraftText, setThinkingModel, setReasoningEffort, quote, quoteError, quoting, send, approve, stop, changeEngine, clear,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

const EMPTY: AtomikLive = {
  chat: null, messages: [], plan: [], current: { kind: "idle" }, engines: [], ring: { mode: "idle" }, word: null,
  totals: { total: 0, underCap: null, planning: 0, connected: 0 }, credits: () => 0, priceLabel: () => "", isConnected: () => false, approveLabel: () => "", fmt: (n) => String(n), engineLabel: (id) => id,
  busy: false, error: null, recoveryText:null, models:[], model:"auto", effort:"auto", draftText:"", setDraftText:()=>{}, setThinkingModel:()=>{}, setReasoningEffort:()=>{}, quote:null, quoteError:null, quoting:false, send: async () => {}, approve: async () => {}, stop: async () => {}, changeEngine: async () => {}, clear: () => {},
};

export function useAtomik(): AtomikLive {
  return useContext(Ctx) ?? EMPTY;
}
