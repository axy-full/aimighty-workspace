"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import type { Chat, Message, Step, Engine } from "@/lib/atomik";
import type { StepState, RingMode } from "@/lib/ring";
import { useProject } from "@/lib/projectContext";
import { useSession } from "@/lib/session";
import { useApi } from "@/lib/useApi";
import {usePaidAction} from "@/lib/usePaidAction";
import { useMoney } from "@/lib/price";
import { useAtomikQuote } from "@/lib/useAtomikQuote";
import { ARCHIVED_NOTE, chatOfRequest, type Thread } from "@/lib/atomikThreadsText";
import { useRememberedThread, useThreadSends } from "./threads/useThreadSends";
import type { PaidTextQuote } from "@/lib/paidText";
import type { ThinkingModel } from "./ModelPicker";
import { ACCOUNT_MODEL_PREFIX, ACCOUNT_STEP_NOTE, isAccountStep } from "@/lib/atomikAccountStep";
import { approvedBody, fetchStepQuote, planTotal, quoteMoved, stepPrice, stepRender, type StepQuote, type StepRender, type StepRenderContext } from "@/lib/atomikStepRender";
import { isKeyStep, keyStepFamily, keyStepLabel } from "@/lib/atomikKeySteps";
import { useSkillRunOpens } from "./skills/useSkillRunOpens";

/**
 * Atomik, at app level (design/particl-v2/README.md §5).
 *
 * A production has threads — several conversations, each with its own plan
 * (lib/atomikThreads.ts) — and the rail shows the current thing in the one
 * on screen: a checkpoint (a priced step waiting for you), a question (Atomik
 * needs a decision before it spends), a plan (steps priced, nothing run
 * yet), a receipt (everything ran), or the planning ring while it thinks.
 * The header button shows the same state at 14px whether the rail is open
 * or not, which is why this lives in the shell and not in the rail.
 *
 * A turn or an approval in one thread never holds another: each thread's
 * planning turn is saved and recovered in a slot of its own
 * (threads/useThreadSends.ts), each approval renders under a key naming its
 * thread, and what is in flight, and what went wrong, is kept per thread.
 *
 * It is the existing agent — chats, messages, steps, the claim-then-render
 * gate — through the existing routes. Atomik never decides anything that
 * spends: every render here is a step you pressed Continue on, claimed
 * first so two tabs cannot pay twice, then sent through the ordinary
 * generate routes so the take is indistinguishable from a hand-made one.
 * Every step runs on Particl's own engines; a step planned on the connected
 * account before Atomik stopped using it is shown read-only and never
 * approved (lib/atomikAccountStep.ts).
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

/** The production's threads (lib/atomikThreads.ts), and which one is on screen. Nothing here spends. */
export type AtomikThreads = {
  /** The production the threads are in; null for the ones filed under none. */
  projectId: string | null;
  /** The thread on screen; null while a new one waits for its first ask. */
  activeId: string | null;
  /** The thread on screen as the list shows it, once the list is read. */
  active: Thread | null;
  /** The production's threads, newest activity first; null until read. */
  list: Thread[] | null;
  /** Why the list could not be read ("Try again" reads it again). */
  error: string | null;
  /** True while the thread to open waits for the list. */
  loading: boolean;
  /** The threads with a planning turn saved for recovery. */
  saved: string[];
  /** True when the thread on screen is archived: nothing is planned or approved in it until it is restored. */
  archived: boolean;
  /** True while a rename, an archive or a restore is saving. */
  busy: boolean;
  refresh: () => void;
  select: (id: string) => void;
  /** A new thread: the next ask starts it. */
  start: () => void;
  /** Each answers why it did not save, or null when it did. */
  archive: (id: string) => Promise<string | null>;
  restore: (id: string) => Promise<string | null>;
  rename: (id: string, title: string) => Promise<string | null>;
  /** The archived threads, read only while they are asked for. */
  archivedList: { open: boolean; list: Thread[] | null; error: string | null; show: (open: boolean) => void; refresh: () => void };
};

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
  /** The plan's priced total, the steps nothing has priced yet, what is left under the production's
   *  cap, and what planning has cost — all in the workspace's unit. Read-only steps are not in it. */
  totals: { total: number; unpriced: number; underCap: number | null; planning: number };
  /** A step's price, as a number in the workspace's unit, or null when nothing has priced it yet
   *  (or it is read-only) — never shown as free. */
  credits: (step: Step) => number | null;
  /** A step's price as shown: `24 cr`, `Read-only` for a step planned on the connected account, or why there is none. */
  priceLabel: (step: Step) => string;
  /** True once Continue can run this step at a price it shows: the checkpoint's live quote is in. */
  approvable: (step: Step) => boolean;
  /** True when that live quote is approximate (a Marketing Studio 2.5 build settles on its delivered image): shown as "about". */
  approximate: (step: Step) => boolean;
  /** Why the checkpoint could not be priced (the admission route's own refusal), if it could not. */
  stepQuoteError: string | null;
  /** True inside the app shell, which hosts the rail this conversation lives in; false where nothing does. */
  hosted: boolean;
  /** True for a step planned on the connected account: shown, never approved, edited or run. */
  isReadOnly: (step: Step) => boolean;
  /** That number as the workspace prints it: `24 cr`, or `$2.90`. */
  fmt: (n: number) => string;
  engineLabel: (id: string) => string;
  busy: boolean;
  error: string | null;
  recoveryText:string|null;
  models: ThinkingModel[];
  model: string;
  effort: string;
  /** Why the chat's saved thinking model became Auto (one Atomik no longer offers), while nothing else is picked. */
  modelNote: string | null;
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
  /** A new thread (the rail's context chip): the next ask starts one. */
  clear: () => void;
  threads: AtomikThreads;
};

const Ctx = createContext<AtomikLive | null>(null);


export function AtomikProvider({ children }: { children: ReactNode }) {
  const { signedIn, workspace, email, requestScope } = useSession();
  const { current: production } = useProject();
  const money = useMoney();
  const prodKey = production?.id ?? null;
  /* Before threads, a planning turn was saved in ONE slot per production. A request saved there is still
     recovered, in the chat its URL names; every turn since is saved in its own thread's slot. */
  const paid=usePaidAction(`/api/atomik/chat:${production?.id??"unfiled"}`);
  const legacyChat = paid.pending ? chatOfRequest(paid.pending.url) : null;
  const sends = useThreadSends(prodKey);
  const { data: index, refresh: refreshIndex } = useApi<Index>(signedIn ? "/api/atomik" : null, 60_000);
  /* The production's threads, newest activity first: a cheap read, polled slowly and read again after each change. */
  const threadsUrl = signedIn ? `/api/atomik/threads?projectId=${encodeURIComponent(prodKey ?? "")}` : null;
  const { data: listData, error: listError, refresh: refreshThreads } = useApi<{ threads?: Thread[] }>(threadsUrl, 60_000, requestScope);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const { data: archivedData, error: archivedError, refresh: refreshArchived } =
    useApi<{ threads?: Thread[] }>(threadsUrl && archivedOpen ? `${threadsUrl}&archived=1` : null, 0, requestScope);
  /* A conversation this browser started, picked or was sent to (a skill's
     run), and the production it is in — it stands in for every other choice
     only while that production is the one on screen, so no effect has to
     reset anything. `dismissed` marks a new thread asked for here. */
  const [chatFor, setChatFor] = useState<{ id: string; projectId: string | null } | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  /* What is in flight, and what went wrong, per thread (its chat id, or `new:<production>` until its first ask
     makes it): a turn or an approval in one thread never holds another. */
  const [flights, setFlights] = useState<Record<string, { busy?: boolean; thinking?: boolean }>>({});
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const fly = useCallback((keys: string[], state: { busy?: boolean; thinking?: boolean } | null) => setFlights((all) => {
    const next = { ...all };
    for (const key of keys) { if (state) next[key] = { ...next[key], ...state }; else delete next[key]; }
    return next;
  }), []);
  const failIn = useCallback((key: string, message: string | null) => setErrors((all) => ({ ...all, [key]: message })), []);
  const dispatched = useRef(new Set<string>());

  /* Which thread is on screen: one picked, started or opened here; a new one asked for; the one a link names; one
     with a turn saved for recovery; the one this tab was last on; else the one with the newest activity. A thread
     that is archived, or another production's, is never opened by itself. */
  const newThread = `new:${prodKey ?? "unfiled"}`;
  const [remembered, remember] = useRememberedThread(signedIn && workspace?.id && email ? JSON.stringify([workspace.id, email, prodKey ?? "unfiled"]) : "");
  const linked = useSearchParams()?.get("thread") || null;
  /* A thread archived here leaves the list at once: hidden until the list (or the index) it was read in is read again. */
  const [hidden, setHidden] = useState<{ id: string; list: unknown; index: unknown }[]>([]);
  const list = useMemo(() => {
    const rows = listData && Array.isArray(listData.threads) ? listData.threads : null;
    return rows ? rows.filter((t) => t.projectId === prodKey && !hidden.some((h) => h.id === t.id && h.list === listData)) : null;
  }, [listData, prodKey, hidden]);
  const indexed = useMemo(() => (index?.chats ? index.chats.filter((c) => c.projectId === prodKey && !hidden.some((h) => h.id === c.id && h.index === index)) : null), [index, prodKey, hidden]);
  /* The threads that may open, newest activity first: the list's, with the index's beside them (the two are read
     apart, so either may be a poll behind). A remembered or linked thread waits until the list is read, or failed. */
  const listFailed = !!listError || (listData !== null && !Array.isArray(listData.threads));
  const known = useMemo(() => {
    const at = new Map<string, number>();
    for (const t of list ?? []) at.set(t.id, t.lastActivityAt);
    for (const c of indexed ?? []) if (!at.has(c.id)) at.set(c.id, c.updatedAt);
    return [...at.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id);
  }, [list, indexed]);
  const openable = list !== null || listFailed ? known : null;
  const recovery = legacyChat ?? sends.saved[0]?.thread ?? null;
  const choice = ((): { id: string | null; waiting: boolean } => {
    if (chatFor && chatFor.projectId === prodKey) return { id: chatFor.id, waiting: false };
    if (dismissed === newThread) return { id: null, waiting: false };
    for (const [id, saved] of [[linked, false], [recovery, true], [remembered, false]] as const) {
      if (!id) continue;
      /* A turn saved for recovery names a thread this person started: it opens as it is. */
      if (saved) return { id, waiting: false };
      if (!openable) return { id: null, waiting: true };
      if (openable.includes(id)) return { id, waiting: false };
    }
    return { id: known[0] ?? null, waiting: false };
  })();
  const activeId = choice.id;
  const activeKey = activeId ?? newThread;
  const busy = !!flights[activeKey]?.busy;
  const thinking = !!flights[activeKey]?.thinking;

  const { data: fetched, refresh: refreshChat } = useApi<Loaded>(
    signedIn && activeId ? `/api/atomik/${encodeURIComponent(activeId)}` : null,
    thinking ? 3_000 : 15_000,
  );
  /* useApi keeps the last thread's answer until this one's lands: only the thread on screen is ever shown, so a
     switch never shows — or lets anyone approve — the checkpoint of the thread left behind. */
  const loaded = fetched && fetched.chat?.id === activeId ? fetched : null;
  const archived = loaded?.chat.archivedAt != null;
  /* The turn the thread on screen saved for recovery: one saved before threads (its chat), or its own. */
  const legacyHere = !!paid.pending && !!activeId && legacyChat === activeId;
  const ownSave = sends.pendingOf(activeId);
  const pending = legacyHere ? paid.pending : ownSave?.pending ?? null;
  const recovered = pending ? JSON.parse(pending.body) as {text?:string;model?:string;effort?:string} : null;
  const recoveryText = recovered ? String(recovered.text ?? "") : null;
  const composerScope = JSON.stringify([workspace?.id, email, production?.id, activeId]);
  /* Drafts and picks are each thread's own: switching threads keeps what was typed in the other. */
  const [selections, setSelections] = useState<Record<string, { model: string; effort: string }>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const selected = selections[composerScope] ?? null;
  const savedChat = loaded?.chat ?? null;
  const model = recovered?.model ?? selected?.model ?? savedChat?.model ?? "auto";
  const effort = recovered?.effort ?? selected?.effort ?? savedChat?.effort ?? "auto";
  const draftText = recoveryText ?? drafts[composerScope] ?? "";
  const models = useMemo(() => [...(index?.models?.featured ?? []), ...(index?.models?.rest ?? [])], [index]);
  const modelNote = !recovered?.model && !selected && savedChat?.modelNote ? savedChat.modelNote : null;
  const locked = !!pending || busy;
  const setDraftText = useCallback((text: string) => { if (!locked) setDrafts((all) => ({ ...all, [composerScope]: text })); }, [composerScope, locked]);
  const setThinkingModel = useCallback((value: string) => { if (!locked) setSelections((all) => ({ ...all, [composerScope]: { model: value, effort: "auto" } })); }, [composerScope, locked]);
  const setReasoningEffort = useCallback((value: string) => { if (!locked) setSelections((all) => ({ ...all, [composerScope]: { model, effort: value } })); }, [composerScope, model, locked]);
  /* An archived thread is not quoted: nothing is planned in it until it is restored. */
  const { quote, error: quoteError, loading: quoting } = useAtomikQuote(activeId ? `/api/atomik/${encodeURIComponent(activeId)}` : "/api/atomik",
    !pending && !archived && draftText.trim() ? { text: draftText.trim(), model, effort, projectId: production?.id ?? null } : null);

  /* A claimed step is held against a second Continue only while the plan
     still shows it past proposed. One the server settled back to proposed
     (its render never arrived: lib/atomik.ts › reconcileRunningSteps) can be
     approved again from this tab without a reload. */
  useEffect(() => {
    if (busy || !loaded) return;
    for (const s of loaded.steps) if (s.status === "proposed") dispatched.current.delete(s.id);
  }, [busy, loaded]);

  /* The latest refresh, for the flows that await it after their writes —
     bound in an effect, since a ref may not change during render. */
  const refreshRef = useRef(refreshChat);
  useEffect(() => { refreshRef.current = refreshChat; }, [refreshChat]);
  /* A skill run filed its plan in a chat (components/atomik/skills): show that chat, read afresh. */
  useSkillRunOpens(({ chatId, projectId }) => { setChatFor({ id: chatId, projectId }); setDismissed(null); void refreshRef.current(); refreshIndex(); });

  const engines = useMemo(() => index?.engines ?? [], [index]);
  /* A library step's engine (a transform, Marketing Studio) is never an engine to switch a shot to, so it is not in `engines`. */
  const engineLabel = useCallback((id: string) => engines.find((e) => e.id === id)?.label ?? keyStepLabel(id) ?? (id.startsWith(ACCOUNT_MODEL_PREFIX) ? "Connected account" : id), [engines]);

  const messages = useMemo(() => loaded?.messages ?? [], [loaded]);
  const lastAssistant = useMemo(() => [...messages].reverse().find((m) => m.role === "assistant") ?? null, [messages]);
  const plan = useMemo(() => {
    const steps = loaded?.steps ?? [];
    const ofTurn = lastAssistant ? steps.filter((s) => s.messageId === lastAssistant.id) : [];
    return (ofTurn.length ? ofTurn : steps).filter((s) => s.status !== "rejected").sort((a, b) => a.position - b.position);
  }, [loaded, lastAssistant]);
  /* The steps that can still move: a step planned on the connected account is shown in the plan, read-only,
     and never becomes the checkpoint, the running count or part of a total. */
  const live = useMemo(() => plan.filter((s) => !isAccountStep(s)), [plan]);

  /* The checkpoint's live price: the exact request Continue will send, quoted
     by the route that will run it (free; /api/generate/quote or /api/audio in
     quote mode). Continue waits for it and then sends that price as the
     ceiling, so the charge cannot pass what the button showed. Keyed by the
     request itself, so a changed engine or a new poll of the same step asks
     again only when something that prices it changed. */
  const checkpointStep = loaded && !thinking && loaded.chat.status !== "running"
    ? live.find((s) => s.status === "proposed") ?? null : null;
  /* A transform files under the approver's own Studio project for this production (the one
     GET /api/workbench/projects?production= answers for them): its checkpoint is quoted with
     that project and waits for the answer. Admission checks it belongs to the production. */
  const chatProject = loaded?.chat.projectId ?? null;
  const needsStudio = !!checkpointStep && !!chatProject && keyStepFamily(checkpointStep.model) === "transform";
  const studio = useApi<{ id: string | null }>(signedIn && needsStudio ? `/api/workbench/projects?production=${encodeURIComponent(chatProject!)}` : null, 0, requestScope);
  const studioId = studio.data?.id ?? null;
  const renderContext = useMemo<StepRenderContext>(() => ({ workbenchProjectId: studioId }), [studioId]);
  const studioKnown = !needsStudio || studio.data !== null || studio.error !== null;
  const quoteRequest = checkpointStep && signedIn && studioKnown
    ? JSON.stringify({ scope: requestScope ?? "", stepId: checkpointStep.id, render: stepRender(checkpointStep, chatProject, renderContext) })
    : "";
  const [stepQuote, setStepQuote] = useState<{ key: string; quote?: StepQuote; error?: string; retry?: boolean } | null>(null);
  const [quoteAttempt, setQuoteAttempt] = useState(0);
  useEffect(() => {
    if (!quoteRequest) return;
    const { scope, render } = JSON.parse(quoteRequest) as { scope: string; render: StepRender };
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      const result = await fetchStepQuote(render, scope, controller.signal).catch(() => null);
      if (result && !controller.signal.aborted) setStepQuote({ key: quoteRequest, ...result });
    }, 150);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [quoteRequest, quoteAttempt]);
  const checkpointId = checkpointStep?.id ?? null;
  const liveQuote = quoteRequest && stepQuote?.key === quoteRequest ? stepQuote : null;
  /* A dropped connection or a failing route is asked again on its own, so
     Continue does not stay unpriced until a reload; a refusal of the
     request itself stands until the step changes. */
  useEffect(() => {
    if (!liveQuote?.retry) return;
    const timer = setTimeout(() => setQuoteAttempt((n) => n + 1), 15_000);
    return () => clearTimeout(timer);
  }, [liveQuote]);
  const liveQuoted = useMemo(() => (checkpointId && liveQuote?.quote ? { stepId: checkpointId, quote: liveQuote.quote } : null), [checkpointId, liveQuote]);
  const stepQuoteError = liveQuote?.error ?? null;

  /* In the workspace's unit, from the server (lib/price.ts): the browser
     holds no margin to convert the engines' dollars with. */
  const credits = useCallback((s: Step) => isAccountStep(s) ? null : stepPrice(s, money.inCredits, liveQuoted?.stepId === s.id ? liveQuoted.quote : null), [money, liveQuoted]);
  const isReadOnly = useCallback((s: Step) => isAccountStep(s), []);
  /* An archived thread's step is shown at its price and waits, unpaid, until the thread is restored. */
  const approvable = useCallback((s: Step) => !archived && !isAccountStep(s) && liveQuoted?.stepId === s.id, [liveQuoted, archived]);
  const approximate = useCallback((s: Step) => liveQuoted?.stepId === s.id && liveQuoted.quote.approximate === true, [liveQuoted]);
  const priceLabel = useCallback((s: Step) => {
    if (isAccountStep(s)) return "Read-only";
    const n = credits(s);
    /* A library step's plan-time figure is the provider's estimate when it was planned: about that,
       until its checkpoint quote (the ceiling Continue sends) or its bill replaces it. */
    if (n !== null) return (isKeyStep(s) && s.status === "proposed" && liveQuoted?.stepId !== s.id) || approximate(s) ? `about ${money.price(n)}` : money.price(n);
    if (s.id === checkpointId) return stepQuoteError ? "no price" : "pricing…";
    return "priced at checkpoint";
  }, [money, credits, checkpointId, stepQuoteError, liveQuoted, approximate]);

  const spentCredits = live.filter((s) => s.status === "done").reduce((a, s) => a + (credits(s) ?? 0), 0);
  const current: Current = useMemo(() => {
    if (!loaded) return { kind: "idle" };
    if (thinking || loaded.chat.status === "running") return { kind: "planning" };
    const proposed = live.find((s) => s.status === "proposed");
    if (lastAssistant?.ask && !proposed && (!live.length || live.every((s) => s.status === "done"))) return { kind: "question", message: lastAssistant, ask: lastAssistant.ask };
    if (proposed) return { kind: "checkpoint", step: proposed, done: live.filter((s) => s.status === "done"), spentCredits };
    if (live.length && live.every((s) => s.status === "done" || s.status === "failed")) return { kind: "done", steps: live, failed: live.filter((s) => s.status === "failed"), spentCredits };
    if (plan.length) return { kind: "plan", steps: plan };
    if (lastAssistant?.ask) return { kind: "question", message: lastAssistant, ask: lastAssistant.ask };
    return { kind: "idle" };
  }, [loaded, thinking, plan, live, lastAssistant, spentCredits]);

  const ring: AtomikLive["ring"] = useMemo(() => {
    if (current.kind === "planning") return { mode: "planning" };
    if (current.kind === "done" && !current.failed.length) return { mode: "done" };
    if (!live.length) return { mode: "idle" };
    let checkpointSeen = false;
    return { steps: live.slice(0, 8).map((s): StepState => {
      if (s.status === "done") return "done";
      if (s.status === "running") return "running";
      if (s.status === "failed") return "needsYou";
      if (!checkpointSeen) { checkpointSeen = true; return "checkpoint"; }
      return "queued";
    }) };
  }, [current, live]);

  const word = current.kind === "checkpoint" ? "checkpoint" : current.kind === "planning" ? "planning"
    : current.kind === "question" ? "question" : live.some((s) => s.status === "running") ? "running"
    : current.kind === "done" ? "done" : null;

  const { total, unpriced } = planTotal(live.map(credits));
  const cap = production ? (money.inCredits ? production.capCredits ?? null : production.capUsd ?? null) : null;
  const spent = production ? (money.inCredits ? production.credits ?? 0 : production.spend ?? 0) : 0;
  /* In credits, what the ledger billed the turns — never the dollars rounded up. */
  const planning = loaded ? (money.inCredits ? loaded.chat.textCredits ?? 0 : loaded.chat.textCostUsd ?? 0) : 0;
  const totals = { total, unpriced, underCap: cap === null ? null : cap - spent - total, planning };

  const send = useCallback(async (text: string) => {
    /* The thread on screen as Send was pressed (null: a new one): the turn is its own, wherever the person goes next. */
    const from = activeId;
    const key = from ?? newThread;
    if (flights[key]?.busy) return;
    /* A turn saved for recovery goes again exactly as it was saved, or not at all. */
    const recovering = pending;
    const t = (recovering ? recoveryText ?? "" : text).trim();
    if (!t) return;
    if (!recovering && archived) { failIn(key, ARCHIVED_NOTE); return; }
    if (!recovering && (!quote || t !== draftText.trim())) { failIn(key, "Review the current planning estimate before sending."); return; }
    const requestBody = recovering ? JSON.parse(recovering.body) : { text: t, model: quote!.model, effort: quote!.effort, maxCredits: quote!.estimateCredits };
    const viaLegacy = !!recovering && legacyHere;
    let keys = [key], sentScope = composerScope;
    fly(keys, { busy: true }); failIn(key, null);
    try {
      let id = from;
      if (id) {
        /* Held on screen: the thread stays the one shown once its saved turn, if any, is cleared. */
        setChatFor({ id, projectId: prodKey }); remember(id);
      } else {
        const r = await fetch("/api/atomik", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: prodKey, model: requestBody.model, effort: requestBody.effort }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error ?? "Atomik couldn't start a conversation.");
        const made = String(j.id);
        id = made;
        /* The new thread is on screen from here, with what was typed in it and what is in flight. */
        const madeScope = JSON.stringify([workspace?.id, email, production?.id, made]);
        const was = sentScope;
        setDrafts((all) => { const next = { ...all, [madeScope]: all[was] ?? "" }; delete next[was]; return next; });
        setSelections((all) => { if (!all[was]) return all; const next = { ...all, [madeScope]: all[was] }; delete next[was]; return next; });
        sentScope = madeScope;
        fly(keys, null); keys = [made]; fly(keys, { busy: true });
        setChatFor({ id: made, projectId: prodKey }); setDismissed(null); remember(made);
      }
      fly(keys, { thinking: true });
      if (viaLegacy) await paid.run(recovering!.url, requestBody);
      else await sends.run(id, `/api/atomik/${encodeURIComponent(id)}`, requestBody, recovering?.key);
      const done = sentScope;
      setDrafts((all) => { const next = { ...all }; delete next[done]; return next; });
    } catch (e) {
      failIn(keys[0], (e as Error).message);
    } finally {
      fly(keys, null);
      await refreshRef.current();
      refreshIndex();
      refreshThreads();
    }
  }, [activeId, newThread, flights, pending, recoveryText, archived, quote, draftText, legacyHere, composerScope, fly, failIn, prodKey, remember, workspace, email, production, paid, sends, refreshIndex, refreshThreads]);

  /* Continue: the gate. Claim, then render through the ordinary routes. What is in flight, and any error, are the step's thread's. */
  const approve = useCallback(async (proposed: Step) => {
    const key = proposed.chatId;
    if (flights[key]?.busy || dispatched.current.has(proposed.id)) return;
    /* A step planned on the connected account is never approved: nothing here runs there any more. */
    if (isAccountStep(proposed)) { failIn(key, ACCOUNT_STEP_NOTE); return; }
    /* Nor is a step of an archived thread, until the thread is restored (its claim is refused too). */
    if (archived && loaded?.chat.id === key) { failIn(key, ARCHIVED_NOTE); return; }
    /* Continue runs at the price it showed, or not at all. */
    const quote = liveQuoted?.stepId === proposed.id ? liveQuoted.quote : null;
    if (!quote) { failIn(key, stepQuoteError ?? "This step is still being priced."); return; }
    /* What the step renders against, taken as Continue is pressed: a switch of thread meanwhile changes none of it. */
    const project = loaded?.chat.projectId ?? null, context = renderContext, scope = requestScope ?? "", priced = quoteRequest;
    /* Held only once the step is really claimed: a refusal, a failed claim or
       a dropped connection leaves Continue ready to be pressed again. */
    dispatched.current.add(proposed.id);
    let claimed = false;
    fly([key], { busy: true }); failIn(key, null);
    try {
      /* The price may have moved since the button was drawn (a rate change,
         a margin guard). Asked again before the claim, a changed price is
         shown instead of spent, and the step stays ready at the new one. */
      const again = await fetchStepQuote(stepRender(proposed, project, context), scope);
      if ("error" in again) { failIn(key, again.error); return; }
      if (quoteMoved(quote, again.quote)) {
        setStepQuote({ key: priced, quote: again.quote });
        failIn(key, `The estimate is now about ${money.price(again.quote.price)}. Press Continue again to approve it.`);
        return;
      }
      const claim = await fetch(`/api/atomik/steps/${proposed.id}/claim`, { method: "POST" });
      const cj = await claim.json().catch(() => ({}));
      /* A step another tab took meanwhile shows as running once the plan is read. One still proposed was
         refused (its thread was archived), and the refusal says so. */
      if (!claim.ok) { if (claim.status !== 409 || cj.step?.status === "proposed") failIn(key, cj.error ?? "That step couldn't be started."); return; }
      claimed = true;
      const step: Step = cj.step;
      /* The quoted request, capped at the quoted credits; a step that changed
         since it was priced is refused by the route rather than charged more. */
      const render = stepRender(step, project, context);
      /* This approval's own key, naming its thread: a step proposed again after a render that never arrived renders under a new one. */
      const res = await fetch(render.url, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": step.requestKey ?? `atomik-step:${step.id}` },
        body: JSON.stringify(approvedBody(render, again.quote)) });
      const j = await res.json().catch(() => ({}));
      /* Still being accepted under this step's key: not a failure. The step
         stays running and is settled from the request's record when the plan
         is next read (lib/atomik.ts › reconcileRunningSteps). */
      if (res.status === 409 && j.pending) { failIn(key, "That render is still being accepted. It will show here once it has started."); return; }
      /* It arrived after the plan had given up on it: its key was set aside and nothing was made or
         charged. The step is proposed again, and is not this reply's to mark failed. */
      if (res.status === 409 && j.code === "set_aside") { failIn(key, j.error ?? "That render arrived too late to run. Nothing was charged."); return; }
      await fetch(`/api/atomik/steps/${step.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(res.ok ? { status: "done", genId: j.id ?? null } : { status: "failed", error: j.error ?? `Failed (${res.status})` }) });
      if (!res.ok) failIn(key, j.error ?? "That render didn't start.");
    } catch (e) {
      /* A dropped connection leaves the claimed step running; reading the
         plan settles it from what the server recorded. */
      failIn(key, (e as Error).message);
    } finally {
      if (!claimed) dispatched.current.delete(proposed.id);
      await refreshRef.current();
      fly([key], null);
      refreshThreads();
    }
  }, [flights, failIn, archived, loaded, liveQuoted, stepQuoteError, renderContext, requestScope, quoteRequest, fly, money, refreshThreads]);

  const stop = useCallback(async (step: Step) => {
    const key = step.chatId;
    if (flights[key]?.busy || isAccountStep(step)) return;
    fly([key], { busy: true });
    try {
      await fetch(`/api/atomik/steps/${step.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "rejected" }) });
    } finally { await refreshRef.current(); fly([key], null); refreshThreads(); }
  }, [flights, fly, refreshThreads]);

  /* Re-priced by the server before the button can be pressed again. */
  const changeEngine = useCallback(async (step: Step, model: string) => {
    const key = step.chatId;
    if (flights[key]?.busy || isAccountStep(step)) return;
    fly([key], { busy: true }); failIn(key, null);
    try {
      /* The engine alone: the server moves the step's length, size and shape
         to what that engine offers and re-prices it. */
      const r = await fetch(`/api/atomik/steps/${step.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }) });
      if (!r.ok) { const j = await r.json().catch(() => ({})); failIn(key, j.error ?? "That engine didn't stick."); }
    } finally { await refreshRef.current(); fly([key], null); }
  }, [flights, fly, failIn]);

  /* ── Threads: pick one, start one, name, archive and restore (PATCH /api/atomik/:id). None of it spends. ── */
  const select = useCallback((id: string) => { setChatFor({ id, projectId: prodKey }); setDismissed(null); remember(id); }, [prodKey, remember]);
  const start = useCallback(() => { setDismissed(newThread); setChatFor(null); remember(null); failIn(newThread, null); }, [newThread, remember, failIn]);
  const [threadBusy, setThreadBusy] = useState(false);
  const patchThread = useCallback(async (id: string, body: Record<string, unknown>): Promise<string | null> => {
    setThreadBusy(true);
    try {
      const r = await fetch(`/api/atomik/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (r.ok) return null;
      const j = await r.json().catch(() => ({}));
      return typeof j.error === "string" && j.error ? j.error : "That did not save. Try again.";
    } catch {
      return "That did not save. Try again.";
    } finally {
      setThreadBusy(false);
      refreshThreads(); refreshArchived(); refreshIndex();
      void refreshRef.current();
    }
  }, [refreshThreads, refreshArchived, refreshIndex]);
  const archive = useCallback(async (id: string) => {
    const problem = await patchThread(id, { archived: true });
    if (!problem) {
      /* Gone from the list at once, not at the next read; the thread on screen goes with it, and the production's newest activity opens instead. */
      setHidden((all) => [...all, { id, list: listData, index }]);
      if (id === activeId) { setChatFor(null); remember(null); }
    }
    return problem;
  }, [patchThread, listData, index, activeId, remember, setHidden]);
  const restore = useCallback(async (id: string) => {
    const problem = await patchThread(id, { archived: false });
    if (!problem) { setHidden((all) => all.filter((h) => h.id !== id)); setArchivedOpen(false); select(id); }
    return problem;
  }, [patchThread, select, setHidden]);
  const rename = useCallback((id: string, title: string) => patchThread(id, { title }), [patchThread]);
  const archivedRows = archivedData && Array.isArray(archivedData.threads) ? archivedData.threads.filter((t) => t.projectId === prodKey) : null;
  const threads: AtomikThreads = {
    projectId: prodKey, activeId, active: list?.find((t) => t.id === activeId) ?? null, list,
    error: listError ? "Threads could not be read." : null, loading: choice.waiting,
    saved: [...(legacyChat ? [legacyChat] : []), ...sends.saved.map((s) => s.thread)], archived, busy: threadBusy,
    refresh: refreshThreads, select, start, archive, restore, rename,
    archivedList: { open: archivedOpen, list: archivedRows, error: archivedError ? "Archived threads could not be read." : null, show: setArchivedOpen, refresh: refreshArchived },
  };

  const fmt = useCallback((n: number) => money.price(n), [money]);
  const value: AtomikLive = {
    chat: loaded?.chat ?? null, messages, plan, current, engines, ring, word, totals, credits, priceLabel, approvable, approximate, stepQuoteError, hosted: true, isReadOnly, fmt, engineLabel,
    busy, error: paid.error ?? ownSave?.error ?? errors[activeKey] ?? null, recoveryText, models, model, effort, modelNote, draftText, setDraftText, setThinkingModel, setReasoningEffort, quote, quoteError, quoting, send, approve, stop, changeEngine, clear: start, threads,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

const NOT_HERE = "Atomik is not open here.";
const EMPTY_THREADS: AtomikThreads = {
  projectId: null, activeId: null, active: null, list: null, error: null, loading: false, saved: [], archived: false, busy: false,
  refresh: () => {}, select: () => {}, start: () => {}, archive: async () => NOT_HERE, restore: async () => NOT_HERE, rename: async () => NOT_HERE,
  archivedList: { open: false, list: null, error: null, show: () => {}, refresh: () => {} },
};

const EMPTY: AtomikLive = {
  chat: null, messages: [], plan: [], current: { kind: "idle" }, engines: [], ring: { mode: "idle" }, word: null,
  totals: { total: 0, unpriced: 0, underCap: null, planning: 0 }, credits: () => null, priceLabel: () => "", approvable: () => false, approximate: () => false, stepQuoteError: null, hosted: false, isReadOnly: () => false, fmt: (n) => String(n), engineLabel: (id) => id,
  busy: false, error: null, recoveryText:null, models:[], model:"auto", effort:"auto", modelNote:null, draftText:"", setDraftText:()=>{}, setThinkingModel:()=>{}, setReasoningEffort:()=>{}, quote:null, quoteError:null, quoting:false, send: async () => {}, approve: async () => {}, stop: async () => {}, changeEngine: async () => {}, clear: () => {}, threads: EMPTY_THREADS,
};

export function useAtomik(): AtomikLive {
  return useContext(Ctx) ?? EMPTY;
}
