"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { studioRequest, StudioRequestError } from "@/components/workbench/GenerationDialog";
import { cancelWords } from "@/lib/shell/use-key-take";
import { priceWords, type PriceValue } from "@/lib/shell/price-words";
import { generationRequestBody, type GenerationBodyInput } from "@/lib/workbench/generation-request";
import { announceJob } from "@/lib/shell/jobs-bus";
import { failureLine, failureUncharged } from "@/lib/errors";
import type { TakeFailure } from "@/lib/providerOutcome";
import { dispatchGate, neutralCopy } from "@/lib/workspace/rig";
import { cancellable, pressPrice, type BarState } from "./director-model";

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

/** The server's quote for the whole press (lib/batchPress.ts admitBatch with `quoteOnly`). */
type BatchQuote = { estimatedCredits: number; ceilingCredits?: number; price?: number; unit?: string; fingerprint: string; members: number };
type QuoteState = { key: string; quote?: BatchQuote; refusal?: string; error?: string };
type MemberOut = { index: number; id?: string; status?: string; error?: string; charged?: number };
type PressReply = { status?: string; members?: MemberOut[] };

const FINGERPRINT = /^[a-f0-9]{64}$/;
const UNREAD = "The price could not be read. Try again.";
const LOST_REPLY = "The connection dropped before the server answered. Press again to check what became of it; nothing is sent twice.";
const NOT_SENT = "The shots could not be sent. Nothing more was sent.";
const STILL_STARTING = "A shot is still being accepted. Press Retry in a moment; nothing is sent twice.";

/** The most the press can settle at: what the person approves and what is sent as its ceiling. */
const ceilingOf = (q: BatchQuote) => q.ceilingCredits ?? q.estimatedCredits;
const priceOfQuote = pressPrice;

function validQuote(q: unknown, members: number): q is BatchQuote {
  if (!q || typeof q !== "object") return false;
  const v = q as Partial<BatchQuote>;
  return Number.isInteger(v.estimatedCredits) && v.estimatedCredits! >= 0 && FINGERPRINT.test(String(v.fingerprint ?? "")) && v.members === members
    && (v.ceilingCredits == null || (Number.isInteger(v.ceilingCredits) && v.ceilingCredits >= v.estimatedCredits!));
}

async function readBatchQuote(scope: string, members: Record<string, unknown>[], signal?: AbortSignal): Promise<BatchQuote> {
  const reply = await studioRequest<unknown>(BATCH, { method: "POST", signal, headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope }, body: JSON.stringify({ members, quoteOnly: true }) });
  if (!validQuote(reply, members.length)) throw new Error(UNREAD);
  return reply;
}
/** A 4xx is the server refusing the press (its own words); anything else is a read that did not happen. */
const refusedBy = (error: unknown) => error instanceof StudioRequestError && error.status >= 400 && error.status < 500;

/* ── The press's claim: its key and the approval it was pressed with, kept in this browser until the server has settled the press ── */
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
/** `quote`: the approval the press carries (its fingerprint and total), or null when the server refused it as out of date and the person must approve the new total. */
type PressClaim = { key: string; shots: string; quote: BatchQuote | null };
const claimSlot = (scope: string, projectKey: string) => `particl:director-press:${JSON.stringify([scope, projectKey])}`;
function readClaim(storage: Storage, slot: string, shots: string): PressClaim | null {
  try {
    const raw = storage.getItem(slot);
    const v = raw ? (JSON.parse(raw) as Partial<PressClaim>) : null;
    if (!v || typeof v.key !== "string" || v.shots !== shots) return null;
    const quote = v.quote && validQuote(v.quote, v.quote.members) ? v.quote : null;
    return { key: v.key, shots, quote };
  } catch { return null; }
}
/** Written before anything is sent. Throws when it cannot be kept: without it a lost reply could not be told from a new press. */
function writeClaim(storage: Storage, slot: string, claim: PressClaim) {
  storage.setItem(slot, JSON.stringify(claim));
  if (storage.getItem(slot) !== JSON.stringify(claim)) throw new Error("Enable local storage to safely recover this press.");
}
function letGo(storage: Storage, slot: string, key: string) {
  try {
    const raw = storage.getItem(slot);
    if (raw && (JSON.parse(raw) as { key?: unknown }).key === key) storage.removeItem(slot);
  } catch { /* the next press asks under it, and starts nothing twice */ }
}

/** A take of this press that ended without a picture: its words (the product's failure line: what happened and what it cost) and whether it cost nothing. */
export type DirectorFailure = { shotId: string; name: string; words: string; free: boolean };

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
  canCancel: boolean;
  press: () => Promise<void>;
  cancel: () => Promise<void>;
  /** Back to idle, for the next press (after Next, or a failed run). */
  reset: () => void;
};

export function useDirectorRender({ scope, projectKey, shots, readOnly }: { scope: string; projectKey: string; shots: readonly DirectorShot[]; readOnly?: string | null }): DirectorRender {
  const members = useMemo(() => shots.map((s) => generationRequestBody(s.input)), [shots]);
  const shotIds = useMemo(() => shots.map((s) => s.id), [shots]);
  const names = useMemo(() => Object.fromEntries(shots.map((s) => [s.id, s.name ?? s.id])), [shots]);
  const membersKey = JSON.stringify([scope, members]);
  const shotsKey = JSON.stringify(members);
  const slot = claimSlot(scope, projectKey);

  /* ── The price: the whole press quoted at once, after a pause in the edits, free ── */
  const [read, setRead] = useState<QuoteState | null>(null);
  const [retryRead, setRetryRead] = useState(0);
  useEffect(() => {
    if (!members.length) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      readBatchQuote(scope, members, controller.signal).then(
        (quote) => { if (!controller.signal.aborted) setRead({ key: membersKey, quote }); },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          const words = error instanceof Error ? neutralCopy(error.message, UNREAD) : UNREAD;
          setRead(refusedBy(error) ? { key: membersKey, refusal: words } : { key: membersKey, error: words });
        },
      );
    }, 400);
    return () => { controller.abort(); clearTimeout(timer); };
    // membersKey stands for scope and members.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [membersKey, retryRead]);
  const current = read?.key === membersKey ? read : null;

  /* ── The press this browser holds for these shots: the one in hand, else one a lost reply left behind ── */
  const pressRef = useRef<PressClaim | null>(null);
  const [held, setHeld] = useState<PressClaim | null>(null);
  const syncHeld = useCallback(() => {
    const inHand = pressRef.current?.shots === shotsKey ? pressRef.current : null;
    setHeld(inHand ?? (typeof window === "undefined" ? null : readClaim(window.localStorage, slot, shotsKey)));
  }, [shotsKey, slot]);
  useEffect(() => { syncHeld(); }, [syncHeld]);
  const heldFor = held?.shots === shotsKey && held.quote ? held : null;

  /* A press the person already approved is shown at that approval: it is what a press asks again. */
  const price = heldFor ? priceOfQuote(heldFor.quote!) : current?.quote ? priceOfQuote(current.quote) : null;
  /* The last price read stays on the button, disabled, while the next is read: never nothing. */
  const [last, setLast] = useState<PriceValue | null>(null);
  if (price && priceWords(price) !== priceWords(last)) setLast(price);
  const reading = Boolean(members.length) && !current && !heldFor;

  const [state, setState] = useState<BarState>("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const [short, setShort] = useState(false);
  const [again, setAgain] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [takes, setTakes] = useState<Record<string, Take>>({});
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [pressKey, setPressKey] = useState<string | null>(null);
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
      const words = take.failure ? failureLine(take.failure, { cancelled }).text : cancelled ? "Cancelled" : "Failed";
      /* Only a failure KNOWN to have cost nothing is asked again under the same approval; a charged one, or one not settled, would be new spend, which asks again. */
      return [{ shotId: j.shotId, name: names[j.shotId] ?? j.shotId, words, free: !cancelled && failureUncharged(take.failure) }];
    })
    : [];

  /** One ask of the press: under the approval it already has, else (a new press, or one whose approval went out of date) a fresh quote the person is approving now. */
  const ask = useCallback(async () => {
    if (sending.current || readOnly || !members.length) return;
    const storage = window.localStorage;
    const inHand = pressRef.current?.shots === shotsKey ? pressRef.current : readClaim(storage, slot, shotsKey);
    const shown = current?.quote;
    if (!inHand?.quote && !shown) return;
    sending.current = true;
    setState("sending");
    setProblem(null);
    setShort(false);
    setAgain(false);
    const begin = (made: Job[], words: string | null, retryable = false) => {
      for (const j of made) announceJob(j.jobId);
      setProblem(words);
      setAgain(retryable);
      setJobs(made);
      setTakes({});
      setStatuses({});
      setState(made.length ? "making" : "idle");
    };
    const madeOf = (out: MemberOut[]) => out.flatMap((m) => (m.id && shotIds[m.index] ? [{ shotId: shotIds[m.index], jobId: m.id }] : []));
    const forget = (key: string) => { letGo(storage, slot, key); if (pressRef.current?.key === key) pressRef.current = null; setPressKey(null); syncHeld(); };
    try {
      let approval: BatchQuote;
      if (inHand?.quote) approval = inHand.quote;
      else {
        /* The whole press priced again as it will be sent: a total that moved sends nothing, and the new figure is shown. */
        let fresh: BatchQuote;
        try { fresh = await readBatchQuote(scope, members); } catch (error) {
          /* Refused at this quote (the cap, a limit, more shots than a press takes): its words, and Render is off, as at the debounced quote. */
          if (refusedBy(error)) { setRead({ key: membersKey, refusal: neutralCopy((error as Error).message, UNREAD) }); setState("idle"); return; }
          throw error;
        }
        if (ceilingOf(fresh) !== ceilingOf(shown!)) {
          setRead({ key: membersKey, quote: fresh });
          const gate = dispatchGate(ceilingOf(shown!), ceilingOf(fresh));
          setProblem(gate.ok ? null : gate.reason);
          setState("idle");
          return;
        }
        approval = fresh;
      }
      const reused = Boolean(inHand);
      const claim: PressClaim = { key: inHand?.key ?? crypto.randomUUID(), shots: shotsKey, quote: approval };
      writeClaim(storage, slot, claim);
      pressRef.current = claim;
      setPressKey(claim.key);
      syncHeld();
      let reply: PressReply;
      try {
        reply = await studioRequest<PressReply>(BATCH, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope, "Idempotency-Key": claim.key },
          body: JSON.stringify({ members, maxCredits: ceilingOf(approval), fingerprint: approval.fingerprint }),
        });
      } catch (error) {
        /* No answer: the claim stays, and the next press asks under it. */
        if (!(error instanceof StudioRequestError)) { setProblem(LOST_REPLY); setState("idle"); return; }
        const out = Array.isArray(error.data.members) ? (error.data.members as MemberOut[]) : [];
        const said = out.find((m) => m.error)?.error ?? error.message;
        if (error.status >= 500) {
          /* Refused whole with every shot listed as not started, at no charge (rule 14): "Nothing billed", and Retry under the same approval. */
          if (out.length && out.every((m) => !m.id && m.charged === 0)) { begin([], `Nothing billed. ${neutralCopy(said, NOT_SENT)}`, true); return; }
          setProblem(LOST_REPLY);
          setState("idle");
          return;
        }
        /* The press was cancelled: nothing more starts under its key, so it is let go and the next press is a new one. */
        if (error.data.cancelled === true) { forget(claim.key); begin(madeOf(out), neutralCopy(said, NOT_SENT)); return; }
        /* The shots or their prices changed since this approval: the new total is read and shown; the person approves it, still under this press's key. */
        if (error.data.quoteChanged === true) {
          const stale: PressClaim = { ...claim, quote: null };
          writeClaim(storage, slot, stale);
          pressRef.current = stale;
          syncHeld();
          setRetryRead((n) => n + 1);
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
      /* Every shot started: the browser lets the key go (the press stays in hand for a free retry of a take that fails). Otherwise it stays, for Retry. */
      if (!refused.length && !starting) letGo(storage, slot, claim.key);
      const words = refused.length
        ? `Nothing billed for ${refused.length} ${refused.length === 1 ? "shot" : "shots"} that did not start. ${neutralCopy(refused[0].error!, NOT_SENT)}`
        : starting ? STILL_STARTING : null;
      begin(madeOf(out), words, refused.length > 0 || starting);
    } catch (error) {
      setProblem(neutralCopy(error instanceof Error ? error.message : "", NOT_SENT));
      setState("idle");
    } finally { sending.current = false; }
  }, [readOnly, current, members, membersKey, shotsKey, shotIds, scope, slot, syncHeld]);

  const press = useCallback(async () => { if (state === "idle") await ask(); }, [state, ask]);

  /* The press is cancelled as one, under its key: nothing more starts, and its takes still waiting are cancelled at no charge (lib/batchPress.ts cancelBatch). */
  const cancel = useCallback(async () => {
    if (!pressKey) return;
    try {
      const result = await studioRequest<PressReply>(BATCH, { method: "POST", headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope, "Idempotency-Key": pressKey }, body: JSON.stringify({ cancel: true }) });
      const out = result.members ?? [];
      setProblem(cancelWords(out.some((m) => m.status === "cancelled") ? "cancelled" : out.find((m) => m.id)?.status));
      /* Confirmed: the press is set aside for good, so its claim is let go; a press after it is a new one. */
      if (result.status === "cancelled") {
        letGo(window.localStorage, slot, pressKey);
        if (pressRef.current?.key === pressKey) pressRef.current = null;
        setAgain(false);
        syncHeld();
      }
    } catch (error) { setProblem(neutralCopy(error instanceof Error ? error.message : "", "The cancel could not be confirmed. Try again.")); }
  }, [pressKey, scope, slot, syncHeld]);

  const total = jobs.length;
  const inHand = Boolean(heldFor);
  const retryable = !readOnly && inHand && state !== "sending" && ((again && !done) || (done && failures.some((f) => f.free)));
  return {
    state: done ? "done" : state, price: price ?? (reading ? last : null),
    pricing: !members.length ? "none" : price ? "ready" : current?.refusal ? "refused" : current?.error ? "error" : "loading",
    refusal: current?.refusal ?? null,
    tryAgain: () => setRetryRead((n) => n + 1),
    sent: total, finished, total, problem, short, failures,
    retry: retryable ? () => void ask() : null,
    canCancel: state === "making" && !done && Boolean(pressKey) && cancellable(Object.entries(statuses).filter(([id]) => !takes[id]).map(([, s]) => s)),
    press, cancel,
    reset: () => {
      /* After Next the press is over: what it holds in hand goes too. A claim a lost reply left in storage stays until the server has answered it. */
      pressRef.current = null;
      setState("idle"); setJobs([]); setTakes({}); setStatuses({}); setProblem(null); setShort(false); setAgain(false); setPressKey(null);
      syncHeld();
    },
  };
}
