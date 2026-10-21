"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { studioRequest, StudioRequestError } from "@/components/workbench/GenerationDialog";
import { cancelWords } from "@/lib/shell/use-key-take";
import { priceWords, type PriceValue } from "@/lib/shell/price-words";
import { generationRequestBody, type GenerationBodyInput } from "@/lib/workbench/generation-request";
import { announceJob } from "@/lib/shell/jobs-bus";
import { failureUncharged } from "@/lib/errors";
import type { TakeFailure } from "@/lib/providerOutcome";
import { dispatchGate, neutralCopy } from "@/lib/workspace/rig";
import {
  cancellable, claimLive, claimSlot, failureCharged, failureNote, failureWords, letGo, pressPrice, readClaim, readClaims, retryPrice, validQuote, validToStart, writeClaim,
  type BarState, type BatchQuote, type PressClaim, type ToStart,
} from "./director-model";
import { PLAN_APPROVAL_MS } from "@/lib/workbench/rig-agent-plan";

/**
 * "Render 8 shots · 344 cr" (v25 PR 7): the bar's one spend button. A multi-shot press is ONE job with one approval for the total (owner, 16 Oct 2026, A.2;
 * #815), so it goes through the batch press route, POST /api/generate/batch (lib/batchPress.ts), never shot by shot:
 *
 *  - the price is the server's: the whole press quoted at once (`quoteOnly`), every shot priced by the server itself, read free. A press the server refuses at
 *    the quote (the workspace's monthly cap, more shots than a press takes) shows the server's own words and Render stays off (owner, 19 Oct 2026);
 *  - a press quotes again before it sends; if the total moved, nothing is sent, the new figure is shown, and the person presses again;
 *  - then the press is sent once, with the total as its ceiling (`maxCredits`) and the quote's fingerprint, under one Idempotency-Key. The key and that approval
 *    are kept in this browser until the server has settled the press (the claim below);
 *  - the takes are then read until they settle: "Making…", then "Next: …". Cancel, offered while a take is still queued, cancels the press (the batch route's
 *    cancel under the same key): nothing more starts, and its takes still waiting are cancelled at no charge.
 *
 * THE SAME APPROVAL, ASKED AGAIN (rule 14: a failed step that cost nothing says "Nothing billed" and Retry re-runs it under the same approval). A press whose
 * reply was lost, one the server answered with shots that did not start (`partial`, or refused whole with every shot `charged: 0`), and a settled take that
 * failed at no charge are all asked again under the press's own key with the approval it was pressed with: no new quote stands in the way (a quote counts the
 * shots that already started a second time, so near the cap it would refuse a press that the server would let finish). The server reads the press's claims
 * afresh (lib/batchPress.ts admitBatch): a shot that started is reported as that take and never started again, a failed take is started again only when it is
 * known to have cost nothing, and the cap and the balance are judged on what is still to start. If the prices moved meanwhile, the server refuses the old
 * approval (409) and the person approves the new total, still under the same key.
 *
 * No new money behaviour: nothing here prices, reserves or settles by itself; there is no per-job line and no spending without a press; only a person presses it.
 */
export type DirectorShot = { id: string; input: GenerationBodyInput; /** The shot's name ("Shot 4"), for the words after a take fails. */ name?: string };
type Job = { shotId: string; jobId: string };
type Take = { id: string; status: string; failure?: TakeFailure | null };
const ACTIVE = new Set(["queued", "running", "held"]);
const BATCH = "/api/generate/batch";

type QuoteState = { key: string; quote?: BatchQuote; refusal?: string; error?: string };
type MemberOut = { index: number; id?: string; status?: string; error?: string; charged?: number };
type PressReply = { status?: string; members?: MemberOut[]; toStart?: unknown; approval?: { maxCredits?: number; expiresAt?: number } | null };
/** What one press is of: its shots (their requests, in order) and the keys they are known by. */
type Target = { members: Record<string, unknown>[]; shotIds: string[]; shotsKey: string; membersKey: string };

const UNREAD = "The price could not be read. Try again.";
const LOST_REPLY = "The connection dropped before the server answered. Press again to check what became of it; nothing is sent twice.";
const NOT_SENT = "The shots could not be sent. Nothing more was sent.";
const STILL_STARTING = "A shot is still being accepted. Press Retry in a moment; nothing is sent twice.";

/** The most the press can settle at: what the person approves and what is sent as its ceiling. */
const ceilingOf = (q: BatchQuote) => q.ceilingCredits ?? q.estimatedCredits;
const priceOfQuote = pressPrice;

/**
 * A quote of a press, free. Under the press's own key (`pressKey`) once it has been pressed: the server then reads the press first, so its started shots are not
 * priced a second time, the total is the press's next approval, and `toStart` is what is left (the batch route, quoted under the key).
 */
async function readBatchQuote(scope: string, members: Record<string, unknown>[], signal?: AbortSignal, pressKey?: string | null): Promise<BatchQuote> {
  const reply = await studioRequest<unknown>(BATCH, {
    method: "POST", signal, headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope, ...(pressKey ? { "Idempotency-Key": pressKey } : {}) }, body: JSON.stringify({ members, quoteOnly: true }),
  });
  if (!validQuote(reply, members.length)) throw new Error(UNREAD);
  return reply;
}
/** A 4xx is the server refusing the press (its own words); anything else is a read that did not happen. */
const refusedBy = (error: unknown) => error instanceof StudioRequestError && error.status >= 400 && error.status < 500;

function targetOf(scope: string, members: Record<string, unknown>[], shotIds: string[]): Target {
  return { members, shotIds, shotsKey: JSON.stringify(members), membersKey: JSON.stringify([scope, members]) };
}
/** The press's shots narrowed to these (in the press's own order). */
function narrowed(scope: string, whole: Target, ids: readonly string[]): Target | null {
  const at = whole.shotIds.flatMap((id, i) => (ids.includes(id) ? [i] : []));
  return at.length ? targetOf(scope, at.map((i) => whole.members[i]), at.map((i) => whole.shotIds[i])) : null;
}

/** A take of this press that ended without a picture: its words (the product's failure line: what happened and what it cost), whether it cost nothing, and whether it was charged. */
export type DirectorFailure = { shotId: string; name: string; words: string; free: boolean; charged: boolean };

/**
 * Render again (owner, 21 Oct 2026): a NEW press of only the shots whose take failed and was charged, under a new key, priced afresh and approved by the
 * person's press, as any Render is. A charged failure is never asked again under the old approval: what was charged stays charged.
 */
export type RenderAgain = { price: PriceValue | null; refusal: string | null; run: () => void };

export type DirectorRender = {
  state: BarState;
  price: PriceValue | null;
  pricing: "none" | "loading" | "ready" | "refused" | "error";
  /** The server's words when it refused the press at the quote (the workspace's monthly cap, more shots than a press takes): Render stays off. */
  refusal: string | null;
  tryAgain: () => void;
  /** Takes this press started. */
  sent: number;
  /** Takes this press made that have finished (done, failed or cancelled). */
  finished: number;
  total: number;
  problem: string | null;
  /** The balance is short of the press (402): Top up is offered. */
  short: boolean;
  /** Settled takes that failed or were cancelled, once every take has settled. */
  failures: DirectorFailure[];
  /** Ask the press again under its own key and approval (shots that did not start, takes that failed at no charge); null when there is nothing to ask. */
  retry: (() => void) | null;
  /** Retry's price: only the shots still to start where the server gives each shot's figure, else the whole approval; null with no Retry. */
  retryPrice: PriceValue | null;
  /** Render again for the shots whose take failed and was charged; null when there are none. */
  renderAgain: RenderAgain | null;
  /** What the failed takes a Render again is for cost: kept in the bar's line through that new press, until Next. */
  carried: string | null;
  canCancel: boolean;
  press: () => Promise<void>;
  cancel: () => Promise<void>;
  /** Back to idle, for the next press (after Next, or a failed run). */
  reset: () => void;
};

/** A press quoted as a whole, after a pause in the edits, free: the server's figure or its words. */
function useQuoted(scope: string, target: Target | null, put: (read: QuoteState) => void, again: number | string, pressKey?: string | null) {
  const key = target?.membersKey ?? "";
  useEffect(() => {
    if (!target?.members.length) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      readBatchQuote(scope, target.members, controller.signal, pressKey).then(
        (quote) => { if (!controller.signal.aborted) put({ key, quote }); },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          const words = error instanceof Error ? neutralCopy(error.message, UNREAD) : UNREAD;
          put(refusedBy(error) ? { key, refusal: words } : { key, error: words });
        },
      );
    }, 400);
    return () => { controller.abort(); clearTimeout(timer); };
    // key stands for scope and the target's members.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, again, pressKey]);
}

export function useDirectorRender({ scope, projectKey, shots, readOnly }: { scope: string; projectKey: string; shots: readonly DirectorShot[]; readOnly?: string | null }): DirectorRender {
  const members = useMemo(() => shots.map((s) => generationRequestBody(s.input)), [shots]);
  const shotIds = useMemo(() => shots.map((s) => s.id), [shots]);
  const names = useMemo(() => Object.fromEntries(shots.map((s) => [s.id, s.name ?? s.id])), [shots]);
  /* The press of every shot in the scope. */
  const whole = useMemo(() => targetOf(scope, members, shotIds), [scope, members, shotIds]);
  const slot = claimSlot(scope, projectKey);

  /* ── The price: the whole press quoted at once, after a pause in the edits, free ── */
  const [read, setRead] = useState<QuoteState | null>(null);
  /* Render again's own quote: the failed shots alone. */
  const [againRead, setAgainRead] = useState<QuoteState | null>(null);
  const [retryRead, setRetryRead] = useState(0);

  /* ── The presses this browser holds (claimSlot): the one in hand, else one a lost reply left behind; none past its time (claimLive) ── */
  const pressRef = useRef<PressClaim | null>(null);
  const [claims, setClaims] = useState<PressClaim[]>([]);
  const syncHeld = useCallback(() => {
    if (typeof window === "undefined") return;
    const now = Date.now();
    const stored = readClaims(window.localStorage, slot, now);
    const inHand = pressRef.current && claimLive(pressRef.current, now) ? pressRef.current : null;
    setClaims(inHand ? [...stored.filter((c) => c.shots !== inHand.shots), inHand] : stored);
  }, [slot]);
  useEffect(() => { syncHeld(); }, [syncHeld]);
  const heldOf = (target: Target | null) => (target ? claims.find((c) => c.shots === target.shotsKey && c.quote) ?? null : null);
  const heldWhole = heldOf(whole);
  /* A press of these shots whose approval went out of date is quoted under its own key from then on (its next approval; started shots not priced again). */
  const staleKey = claims.find((c) => c.shots === whole.shotsKey && !c.quote)?.key ?? null;
  useQuoted(scope, whole, setRead, retryRead, staleKey);
  const current = read?.key === whole.membersKey ? read : null;

  /* A press the person already approved is shown at that approval: it is what a press asks again. */
  const price = heldWhole ? priceOfQuote(heldWhole.quote!) : current?.quote ? priceOfQuote(current.quote) : null;
  /* The last price read stays on the button, disabled, while the next is read: never nothing. */
  const [last, setLast] = useState<PriceValue | null>(null);
  if (price && priceWords(price) !== priceWords(last)) setLast(price);
  const reading = Boolean(members.length) && !current && !heldWhole;

  const [state, setState] = useState<BarState>("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const [short, setShort] = useState(false);
  const [again, setAgain] = useState(false);
  /* The last Retry started nothing new: Retry is not offered again for this press. */
  const [noNew, setNoNew] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [takes, setTakes] = useState<Record<string, Take>>({});
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [pressKey, setPressKey] = useState<string | null>(null);
  /* The press in hand is a Render again of these shots (null: of every shot in the scope). */
  const [againOf, setAgainOf] = useState<Target | null>(null);
  const active = againOf ?? whole;
  /* What the press's own reply said is left to start (the batch route's `toStart`), and Retry's own quote under the press's key. */
  const [replyToStart, setReplyToStart] = useState<ToStart | null>(null);
  const [retryQuote, setRetryQuote] = useState<(QuoteState & { occasion: string }) | null>(null);
  const [carried, setCarried] = useState<string | null>(null);
  const sending = useRef(false);

  /* The takes this press made, read until each settles. */
  const watching = state === "making" ? jobs.map((j) => j.jobId).join(",") : "";
  useEffect(() => {
    if (!watching) return;
    const controller = new AbortController();
    let alive = true;
    const tick = async () => {
      for (const id of watching.split(",")) {
        if (!alive) return;
        try {
          const { generation } = await studioRequest<{ generation: Take }>(`/api/jobs/${encodeURIComponent(id)}`, { signal: controller.signal, headers: { "X-Workbench-Scope": scope }, cache: "no-store" });
          if (!alive) return;
          setStatuses((now) => (now[id] === generation.status ? now : { ...now, [id]: generation.status }));
          if (!ACTIVE.has(generation.status)) setTakes((now) => (now[id] ? now : { ...now, [id]: generation }));
        } catch { /* the next pass reads it again */ }
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 2500);
    return () => { alive = false; clearInterval(timer); controller.abort(); };
  }, [watching, scope]);
  const finished = jobs.filter((j) => takes[j.jobId]).length;
  /* Done is derived, not stored: every take this press made has settled. */
  const done = state === "making" && jobs.length > 0 && finished === jobs.length;
  const failures: DirectorFailure[] = done
    ? jobs.flatMap((j) => {
      const take = takes[j.jobId];
      if (!take || (take.status !== "failed" && take.status !== "cancelled")) return [];
      const cancelled = take.status === "cancelled";
      const words = failureWords(take.failure, cancelled);
      /* Only a failure KNOWN to have cost nothing is asked again under the same approval; a charged one is Render again, a new press that asks again. */
      return [{ shotId: j.shotId, name: names[j.shotId] ?? j.shotId, words, free: !cancelled && failureUncharged(take.failure), charged: !cancelled && failureCharged(take.failure) }];
    })
    : [];

  /** One ask of a press: under the approval it already has, else (a new press, or one whose approval went out of date or past its time) a fresh quote the person is approving now. */
  /** `renew`: Retry under the same key when the press's approval no longer covers the shots left (past its time, or the total moved above it): the person's press
      approves this quote, the press's next approval, as the server asks (its 409 says the same). */
  const ask = useCallback(async (target: Target, mode: "press" | "retry" | "again", renew?: BatchQuote) => {
    if (sending.current || readOnly || !target.members.length) return;
    const storage = window.localStorage;
    const now = Date.now();
    const inHand = pressRef.current?.shots === target.shotsKey && claimLive(pressRef.current, now) ? pressRef.current : readClaim(storage, slot, target.shotsKey, now);
    const ofWhole = target.membersKey === whole.membersKey;
    const show = ofWhole ? setRead : setAgainRead;
    const shownRead = ofWhole ? read : againRead;
    const shown = shownRead?.key === target.membersKey ? shownRead.quote : undefined;
    if (!renew && !inHand?.quote && !shown) return;
    sending.current = true;
    setState("sending");
    setProblem(null);
    setShort(false);
    setAgain(false);
    const retrying = mode === "retry";
    if (!retrying) {
      /* From here the press in hand is this one. Render again leaves the settled press behind: its charged takes' cost is carried in the line. */
      setAgainOf(mode === "again" ? target : null);
      if (mode === "again") { setJobs([]); setTakes({}); setStatuses({}); setReplyToStart(null); setNoNew(false); }
    }
    const before = jobs.map((j) => j.jobId).sort().join(",");
    const begin = (made: Job[], words: string | null, retryable = false, pending = false, toStart: unknown = null) => {
      for (const j of made) announceJob(j.jobId);
      /* A Retry that brought back exactly the takes it had (the server started nothing new): no Retry again, so a disagreement on "free" cannot loop.
         A shot the server says is still being accepted is not that: it is asked again once it has landed. */
      const same = retrying && !pending && made.map((j) => j.jobId).sort().join(",") === before;
      setNoNew(same);
      setProblem(words);
      setAgain(retryable && !same);
      setReplyToStart(validToStart(toStart) ? toStart : null);
      setJobs(made);
      setTakes({});
      setStatuses({});
      setState(made.length ? "making" : "idle");
    };
    const madeOf = (out: MemberOut[]) => out.flatMap((m) => (m.id && target.shotIds[m.index] ? [{ shotId: target.shotIds[m.index], jobId: m.id }] : []));
    const forget = (key: string) => { letGo(storage, slot, key, Date.now()); if (pressRef.current?.key === key) pressRef.current = null; setPressKey(null); syncHeld(); };
    /* The server reported this press's shots: kept for Retry, it is let go at Next. */
    const answered = (claim: PressClaim, expiresAt?: unknown) => {
      /* The server counts an approval's 7 days from the press that first started something under it: where it says when that ends, the claim keeps its time. */
      const at = typeof expiresAt === "number" && Number.isFinite(expiresAt) ? Math.min(claim.at, expiresAt - PLAN_APPROVAL_MS) : claim.at;
      const told = { ...claim, answered: true, at };
      try { writeClaim(storage, slot, told, Date.now()); } catch { /* still in hand */ }
      pressRef.current = told;
      syncHeld();
    };
    try {
      let approval: BatchQuote;
      if (renew) approval = renew;
      else if (inHand?.quote) approval = inHand.quote;
      else {
        /* The whole press priced again as it will be sent: a total that moved sends nothing, and the new figure is shown. A press already pressed is quoted
           under its own key (its started shots are not priced again, and the figure is its next approval); a new one, with none. */
        let fresh: BatchQuote;
        try { fresh = await readBatchQuote(scope, target.members, undefined, inHand?.key); } catch (error) {
          /* Refused at this quote (the cap, a limit, more shots than a press takes): its words, and Render is off, as at the debounced quote. */
          if (refusedBy(error)) { show({ key: target.membersKey, refusal: neutralCopy((error as Error).message, UNREAD) }); setState("idle"); return; }
          throw error;
        }
        if (ceilingOf(fresh) !== ceilingOf(shown!)) {
          show({ key: target.membersKey, quote: fresh });
          const gate = dispatchGate(ceilingOf(shown!), ceilingOf(fresh));
          setProblem(gate.ok ? null : gate.reason);
          setState("idle");
          return;
        }
        approval = fresh;
      }
      const reused = Boolean(inHand);
      /* Each ask is unanswered until its own reply: a Retry the server answers "still being accepted" must not inherit an earlier "answered" and be let go at Next.
         An approval keeps the time it was given: asked again under it, it still lasts only as long as a plan's (claimLive). */
      const claim: PressClaim = { key: inHand?.key ?? crypto.randomUUID(), shots: target.shotsKey, quote: approval, answered: false, at: !renew && inHand?.quote ? inHand.at : Date.now() };
      writeClaim(storage, slot, claim, Date.now());
      pressRef.current = claim;
      setPressKey(claim.key);
      syncHeld();
      let reply: PressReply;
      try {
        reply = await studioRequest<PressReply>(BATCH, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope, "Idempotency-Key": claim.key },
          body: JSON.stringify({ members: target.members, maxCredits: ceilingOf(approval), fingerprint: approval.fingerprint }),
        });
      } catch (error) {
        /* No answer: the claim stays, and the next press asks under it. */
        if (!(error instanceof StudioRequestError)) { setProblem(LOST_REPLY); setState("idle"); return; }
        const out = Array.isArray(error.data.members) ? (error.data.members as MemberOut[]) : [];
        const said = out.find((m) => m.error)?.error ?? error.message;
        if (error.status >= 500) {
          /* Refused whole with every shot listed as not started, at no charge (rule 14): "Nothing billed", and Retry under the same approval. */
          if (out.length && out.every((m) => !m.id && m.charged === 0)) { answered(claim, error.data.approval && (error.data.approval as { expiresAt?: unknown }).expiresAt); begin([], `Nothing billed. ${neutralCopy(said, NOT_SENT)}`, true, false, error.data.toStart); return; }
          setProblem(LOST_REPLY);
          setState("idle");
          return;
        }
        /* The press was cancelled: nothing more starts under its key, so it is let go and the next press is a new one. */
        if (error.data.cancelled === true) { forget(claim.key); begin(madeOf(out), neutralCopy(said, NOT_SENT)); return; }
        /* The shots or their prices changed since this approval: the new total is read and shown; the person approves it, still under this press's key. */
        if (error.data.quoteChanged === true) {
          const stale: PressClaim = { ...claim, quote: null };
          writeClaim(storage, slot, stale, Date.now());
          pressRef.current = stale;
          syncHeld();
          /* The server sends the press's next approval with its refusal (quoted under the key; past its 7 days, at today's price): shown as it is. Without it,
             the press is quoted again, under its key. */
          if (validQuote(error.data.quote, target.members.length)) show({ key: target.membersKey, quote: error.data.quote });
          else setRetryRead((n) => n + 1);
          begin([], neutralCopy(said, NOT_SENT));
          return;
        }
        if (error.status === 402 || error.data.short === true) setShort(true);
        /* Refused whole, nothing started (the cap, the balance, a person's approval). A press asked before keeps its key: some of its shots may have started under it. */
        if (!reused) forget(claim.key);
        begin(madeOf(out), neutralCopy(said, NOT_SENT));
        return;
      }
      const out = reply.members ?? [];
      const refused = out.filter((m) => m.error);
      const starting = out.some((m) => m.status === "starting");
      /* Every shot started: the browser lets the key go (the press stays in hand for a free retry of a take that fails). Otherwise it stays, for Retry;
         answered unless a shot is still being accepted. */
      if (!refused.length && !starting) letGo(storage, slot, claim.key, Date.now());
      else if (!starting) answered(claim, reply.approval?.expiresAt);
      const words = refused.length
        ? `Nothing billed for ${refused.length} ${refused.length === 1 ? "shot" : "shots"} that did not start. ${neutralCopy(refused[0].error!, NOT_SENT)}`
        : starting ? STILL_STARTING : null;
      begin(madeOf(out), words, refused.length > 0 || starting, starting, reply.toStart);
    } catch (error) {
      setProblem(neutralCopy(error instanceof Error ? error.message : "", NOT_SENT));
      setState("idle");
    } finally { sending.current = false; }
  }, [readOnly, read, againRead, whole, scope, slot, syncHeld, jobs]);

  const press = useCallback(async () => { if (state === "idle") { setCarried(null); await ask(whole, "press"); } }, [state, ask, whole]);

  /* The press is cancelled as one, under its key: nothing more starts, and its takes still waiting are cancelled at no charge (lib/batchPress.ts cancelBatch). */
  const cancel = useCallback(async () => {
    if (!pressKey) return;
    try {
      const result = await studioRequest<PressReply>(BATCH, { method: "POST", headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope, "Idempotency-Key": pressKey }, body: JSON.stringify({ cancel: true }) });
      const out = result.members ?? [];
      setProblem(cancelWords(out.some((m) => m.status === "cancelled") ? "cancelled" : out.find((m) => m.id)?.status));
      /* Confirmed: the press is set aside for good, so its claim is let go; a press after it is a new one. */
      if (result.status === "cancelled") {
        letGo(window.localStorage, slot, pressKey, Date.now());
        if (pressRef.current?.key === pressKey) pressRef.current = null;
        setAgain(false);
        syncHeld();
      }
    } catch (error) { setProblem(neutralCopy(error instanceof Error ? error.message : "", "The cancel could not be confirmed. Try again.")); }
  }, [pressKey, scope, slot, syncHeld]);

  const total = jobs.length;
  const heldActive = heldOf(active);
  /* Shots that did not start keep their Retry after the started ones settle; a take that failed at no charge adds it once all have settled. */
  const retryable = !readOnly && Boolean(heldActive) && state !== "sending" && !noNew && (again || (done && failures.some((f) => f.free)));
  /* Retry's price: the shots still to start, as the server quotes them under the press's key (`toStart`), read afresh whenever the press moves on; until that
     reply, what the press's own reply said was left. Under the same approval while it covers them; when it no longer does (past its 7 days, or a total above it),
     the person's press of Retry approves the press's next total under the same key. A route that sends neither: the whole approval, as before. */
  const occasion = retryable && heldActive ? `${heldActive.key}|${state}|${jobs.map((j) => `${j.jobId}:${takes[j.jobId]?.status ?? ""}`).join(",")}` : "";
  useQuoted(scope, occasion ? active : null, (read) => setRetryQuote({ ...read, occasion }), occasion, heldActive?.key ?? null);
  const keyedRetry = occasion && retryQuote?.key === active.membersKey && retryQuote.occasion === occasion ? retryQuote.quote ?? null : null;
  const left = validToStart(keyedRetry?.toStart) ? keyedRetry.toStart : done ? null : replyToStart;
  /* The server says nothing is left to start after the takes settled (it does not hold the failure free): no Retry, rather than a press that starts nothing. */
  const nothingLeft = Boolean(left && left.members === 0 && !again);
  const renew = keyedRetry?.approval && keyedRetry.approval.covers === false ? keyedRetry : undefined;
  const retryCost = retryable && heldActive && !nothingLeft ? retryPrice(priceOfQuote(heldActive.quote!), left) : null;

  /* Render again: the shots whose take failed and was charged, as they are set now; or, while a Render again started nothing (refused, a lost reply), its shots still. */
  const chargedIds = failures.filter((f) => f.charged).map((f) => f.shotId).join(",");
  const offer = useMemo(() => (chargedIds ? narrowed(scope, whole, chargedIds.split(",")) : null), [chargedIds, scope, whole]);
  const offered = offer ?? (state === "idle" && againOf && !jobs.length && !retryable ? againOf : null);
  useQuoted(scope, offered && !readOnly ? offered : null, setAgainRead, retryRead);
  const heldAgain = heldOf(offered);
  const againQuote = againRead?.key === offered?.membersKey ? againRead : null;
  const againPrice = heldAgain ? priceOfQuote(heldAgain.quote!) : againQuote?.quote ? priceOfQuote(againQuote.quote) : null;
  const renderAgain: RenderAgain | null = offered && !readOnly && state !== "sending"
    ? {
      price: againPrice, refusal: heldAgain ? null : againQuote?.refusal ?? null,
      run: () => {
        if (!againPrice) return;
        /* The line keeps what the failed takes cost through the new press. */
        const charged = failures.filter((f) => f.charged);
        if (charged.length) setCarried(failureNote(charged));
        void ask(offered, "again");
      },
    }
    : null;

  return {
    state: done ? "done" : state, price: price ?? (reading ? last : null),
    pricing: !members.length ? "none" : price ? "ready" : current?.refusal ? "refused" : current?.error ? "error" : "loading",
    refusal: current?.refusal ?? null,
    tryAgain: () => setRetryRead((n) => n + 1),
    sent: total, finished, total, problem, short, failures,
    retry: retryable && !nothingLeft ? () => void ask(active, "retry", renew) : null,
    retryPrice: retryCost,
    renderAgain, carried,
    canCancel: state === "making" && !done && Boolean(pressKey) && cancellable(Object.entries(statuses).filter(([id]) => !takes[id]).map(([, s]) => s)),
    press, cancel,
    reset: () => {
      /* After Next the press is over: what it holds in hand goes, and so does its claim once the server has answered it (partial, a refusal). One never
         answered (a lost reply, a shot still being accepted, an ask refused whole under a key asked before) stays: only the server knows what it started, and
         the next press of these shots asks under it. */
      const storage = window.localStorage;
      const now = Date.now();
      const claim = pressRef.current ?? readClaim(storage, slot, active.shotsKey, now);
      if (claim?.answered) letGo(storage, slot, claim.key, now);
      pressRef.current = null;
      setState("idle"); setJobs([]); setTakes({}); setStatuses({}); setProblem(null); setShort(false); setAgain(false); setNoNew(false); setPressKey(null);
      setAgainOf(null); setReplyToStart(null); setCarried(null);
      syncHeld();
    },
  };
}
