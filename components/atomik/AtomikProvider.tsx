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
import { ACCOUNT_MODEL_PREFIX, ACCOUNT_STEP_NOTE, isAccountStep } from "@/lib/atomikAccountStep";
import { approvedBody, fetchStepQuote, planTotal, quoteMoved, stepPrice, stepRender, type StepQuote, type StepRender, type StepRenderContext } from "@/lib/atomikStepRender";
import { isKeyStep, keyStepFamily, keyStepLabel } from "@/lib/atomikKeySteps";
import { useSkillRunOpens } from "./skills/useSkillRunOpens";

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
  clear: () => void;
};

const Ctx = createContext<AtomikLive | null>(null);


export function AtomikProvider({ children }: { children: ReactNode }) {
  const { signedIn, workspace, email, requestScope } = useSession();
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
  const modelNote = !recovered?.model && !selected && savedChat?.modelNote ? savedChat.modelNote : null;
  const setDraftText = useCallback((text: string) => { if (!paid.pending && !busy) setDraft({ scope: composerScope, text }); }, [composerScope, paid.pending, busy]);
  const setThinkingModel = useCallback((value: string) => { if (!paid.pending && !busy) setSelection({ scope: composerScope, model: value, effort: "auto" }); }, [composerScope, paid.pending, busy]);
  const setReasoningEffort = useCallback((value: string) => { if (!paid.pending && !busy) setSelection({ scope: composerScope, model, effort: value }); }, [composerScope, model, paid.pending, busy]);
  const { quote, error: quoteError, loading: quoting } = useAtomikQuote(activeId ? `/api/atomik/${encodeURIComponent(activeId)}` : "/api/atomik",
    !paid.pending && draftText.trim() ? { text: draftText.trim(), model, effort, projectId: production?.id ?? null } : null);

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
  const approvable = useCallback((s: Step) => !isAccountStep(s) && liveQuoted?.stepId === s.id, [liveQuoted]);
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
    /* A step planned on the connected account is never approved: nothing here runs there any more. */
    if (isAccountStep(proposed)) { setError(ACCOUNT_STEP_NOTE); return; }
    /* Continue runs at the price it showed, or not at all. */
    const quote = liveQuoted?.stepId === proposed.id ? liveQuoted.quote : null;
    if (!quote) { setError(stepQuoteError ?? "This step is still being priced."); return; }
    /* Held only once the step is really claimed: a refusal, a failed claim or
       a dropped connection leaves Continue ready to be pressed again. */
    dispatched.current.add(proposed.id);
    let claimed = false;
    setBusy(true); setError(null);
    try {
      /* The price may have moved since the button was drawn (a rate change,
         a margin guard). Asked again before the claim, a changed price is
         shown instead of spent, and the step stays ready at the new one. */
      const again = await fetchStepQuote(stepRender(proposed, loaded?.chat.projectId ?? null, renderContext), requestScope ?? "");
      if ("error" in again) { setError(again.error); return; }
      if (quoteMoved(quote, again.quote)) {
        setStepQuote({ key: quoteRequest, quote: again.quote });
        setError(`The estimate is now about ${money.price(again.quote.price)}. Press Continue again to approve it.`);
        return;
      }
      const claim = await fetch(`/api/atomik/steps/${proposed.id}/claim`, { method: "POST" });
      const cj = await claim.json().catch(() => ({}));
      if (!claim.ok) { if (claim.status !== 409) setError(cj.error ?? "That step couldn't be started."); return; }
      claimed = true;
      const step: Step = cj.step;
      /* The quoted request, capped at the quoted credits; a step that changed
         since it was priced is refused by the route rather than charged more. */
      const render = stepRender(step, loaded?.chat.projectId ?? null, renderContext);
      /* This approval's own key: a step proposed again after a render that never arrived renders under a new one. */
      const res = await fetch(render.url, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": step.requestKey ?? `atomik-step:${step.id}` },
        body: JSON.stringify(approvedBody(render, again.quote)) });
      const j = await res.json().catch(() => ({}));
      /* Still being accepted under this step's key: not a failure. The step
         stays running and is settled from the request's record when the plan
         is next read (lib/atomik.ts › reconcileRunningSteps). */
      if (res.status === 409 && j.pending) { setError("That render is still being accepted. It will show here once it has started."); return; }
      /* It arrived after the plan had given up on it: its key was set aside and nothing was made or
         charged. The step is proposed again, and is not this reply's to mark failed. */
      if (res.status === 409 && j.code === "set_aside") { setError(j.error ?? "That render arrived too late to run. Nothing was charged."); return; }
      await fetch(`/api/atomik/steps/${step.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(res.ok ? { status: "done", genId: j.id ?? null } : { status: "failed", error: j.error ?? `Failed (${res.status})` }) });
      if (!res.ok) setError(j.error ?? "That render didn't start.");
    } catch (e) {
      /* A dropped connection leaves the claimed step running; reading the
         plan settles it from what the server recorded. */
      setError((e as Error).message);
    } finally {
      if (!claimed) dispatched.current.delete(proposed.id);
      await refreshRef.current();
      setBusy(false);
    }
  }, [busy, loaded, liveQuoted, stepQuoteError, requestScope, quoteRequest, money, renderContext]);

  const stop = useCallback(async (step: Step) => {
    if (busy || isAccountStep(step)) return;
    setBusy(true);
    try {
      await fetch(`/api/atomik/steps/${step.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "rejected" }) });
    } finally { await refreshRef.current(); setBusy(false); }
  }, [busy]);

  /* Re-priced by the server before the button can be pressed again. */
  const changeEngine = useCallback(async (step: Step, model: string) => {
    if (busy || isAccountStep(step)) return;
    setBusy(true); setError(null);
    try {
      /* The engine alone: the server moves the step's length, size and shape
         to what that engine offers and re-prices it. */
      const r = await fetch(`/api/atomik/steps/${step.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }) });
      if (!r.ok) { const j = await r.json().catch(() => ({})); setError(j.error ?? "That engine didn't stick."); }
    } finally { await refreshRef.current(); setBusy(false); }
  }, [busy]);

  const clear = useCallback(() => { setDismissed(activeId); setChatFor(null); }, [activeId]);

  const fmt = useCallback((n: number) => money.price(n), [money]);
  const value: AtomikLive = {
    chat: loaded?.chat ?? null, messages, plan, current, engines, ring, word, totals, credits, priceLabel, approvable, approximate, stepQuoteError, hosted: true, isReadOnly, fmt, engineLabel,
    busy, error:paid.error??error, recoveryText, models, model, effort, modelNote, draftText, setDraftText, setThinkingModel, setReasoningEffort, quote, quoteError, quoting, send, approve, stop, changeEngine, clear,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

const EMPTY: AtomikLive = {
  chat: null, messages: [], plan: [], current: { kind: "idle" }, engines: [], ring: { mode: "idle" }, word: null,
  totals: { total: 0, unpriced: 0, underCap: null, planning: 0 }, credits: () => null, priceLabel: () => "", approvable: () => false, approximate: () => false, stepQuoteError: null, hosted: false, isReadOnly: () => false, fmt: (n) => String(n), engineLabel: (id) => id,
  busy: false, error: null, recoveryText:null, models:[], model:"auto", effort:"auto", modelNote:null, draftText:"", setDraftText:()=>{}, setThinkingModel:()=>{}, setReasoningEffort:()=>{}, quote:null, quoteError:null, quoting:false, send: async () => {}, approve: async () => {}, stop: async () => {}, changeEngine: async () => {}, clear: () => {},
};

export function useAtomik(): AtomikLive {
  return useContext(Ctx) ?? EMPTY;
}
