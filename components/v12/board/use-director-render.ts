"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { studioRequest, StudioRequestError } from "@/components/workbench/GenerationDialog";
import { cancelWords } from "@/lib/shell/use-key-take";
import { exact, priceWords, upTo, type PriceValue } from "@/lib/shell/price-words";
import { generationRequestBody, type GenerationBodyInput } from "@/lib/workbench/generation-request";
import { announceJob } from "@/lib/shell/jobs-bus";
import { dispatchGate, neutralCopy } from "@/lib/workspace/rig";
import { cancellable, type BarState } from "./director-model";

/**
 * "Render 8 shots · 344 cr" (v25 PR 7): the bar's one spend button. A multi-shot press is ONE job with one approval for the total (owner, 16 Oct 2026, A.2;
 * #815), so it goes through the batch press route, POST /api/generate/batch (lib/batchPress.ts), never shot by shot:
 *
 *  - the price is the server's: the whole press quoted at once (`quoteOnly`), every shot priced by the server itself, read free. A press whose total would
 *    pass the workspace's monthly cap is refused there, at the quote (owner, 19 Oct 2026): the bar says the cap's own words and Render stays off;
 *  - a press quotes again before it sends; if the total moved, nothing is sent, the new figure is shown, and the person presses again;
 *  - then the press is sent once, with the total as its ceiling (`maxCredits`) and the quote's fingerprint, under one Idempotency-Key kept in this browser
 *    until the server has answered, so a lost reply asked again starts nothing twice; the server judges the cap and the balance before the first shot starts;
 *  - the takes are then read until they settle: "Making…", then "Next: …". Cancel, offered while a take is still queued, cancels the press (the batch
 *    route's cancel under the same key): nothing more starts, and its takes still waiting are cancelled at no charge.
 *
 * No new money behaviour: nothing here prices, reserves or settles by itself; there is no per-job line and no spending without a press; only a person presses it.
 */
export type DirectorShot = { id: string; input: GenerationBodyInput };
type Job = { shotId: string; jobId: string };
type Settled = Record<string, string>;
const ACTIVE = new Set(["queued", "running", "held"]);
const BATCH = "/api/generate/batch";

/** The server's quote for the whole press (lib/batchPress.ts admitBatch with `quoteOnly`). */
type BatchQuote = { estimatedCredits: number; ceilingCredits?: number; price?: number; unit?: string; fingerprint: string; members: number };
type QuoteState = { key: string; quote?: BatchQuote; refusal?: string; error?: string };
type MemberOut = { index: number; id?: string; status?: string; error?: string };
type PressReply = { status?: string; members?: MemberOut[] };

const FINGERPRINT = /^[a-f0-9]{64}$/;
const UNREAD = "The price could not be read. Try again.";
const LOST_REPLY = "The connection dropped before the server answered. Press again to check what became of it; nothing is sent twice.";
const NOT_SENT = "The shots could not be sent. Nothing more was sent.";
const STILL_STARTING = "A shot is still being accepted. Press again in a moment; nothing is sent twice.";

/** The most the press can settle at: what the person approves and what is sent as its ceiling. */
const ceilingOf = (q: BatchQuote) => q.ceilingCredits ?? q.estimatedCredits;
/** The press's price as the button shows it: "N cr", or "up to N cr" when a shot holds a ceiling above its estimate. */
const priceOfQuote = (q: BatchQuote): PriceValue | null =>
  q.ceilingCredits != null && q.ceilingCredits > q.estimatedCredits ? upTo(q.ceilingCredits) : exact(q.estimatedCredits, q.unit === "usd" && Number.isFinite(q.price) ? q.price : undefined);

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

/* ── The press's key, kept in this browser until the server has answered under it: asked again, the press starts nothing twice ── */
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
type PressClaim = { key: string; shots: string };
const claimSlot = (scope: string, projectKey: string) => `particl:director-press:${JSON.stringify([scope, projectKey])}`;
function readClaim(storage: Storage, slot: string): PressClaim | null {
  try {
    const raw = storage.getItem(slot);
    const v = raw ? (JSON.parse(raw) as Partial<PressClaim>) : null;
    return v && typeof v.key === "string" && typeof v.shots === "string" ? { key: v.key, shots: v.shots } : null;
  } catch { return null; }
}
/** This press's key: the one a lost reply left for exactly these shots, else a new one, written before anything is sent. Throws when it cannot be kept. */
function claimPress(storage: Storage, slot: string, shots: string): string {
  const held = readClaim(storage, slot);
  if (held && held.shots === shots) return held.key;
  const claim: PressClaim = { key: crypto.randomUUID(), shots };
  storage.setItem(slot, JSON.stringify(claim));
  if (storage.getItem(slot) !== JSON.stringify(claim)) throw new Error("Enable local storage to safely recover this press.");
  return claim.key;
}
function letGo(storage: Storage, slot: string, key: string) {
  try { if (readClaim(storage, slot)?.key === key) storage.removeItem(slot); } catch { /* the next press asks under it, and starts nothing twice */ }
}

export type DirectorRender = {
  state: BarState;
  price: PriceValue | null;
  pricing: "none" | "loading" | "ready" | "refused" | "error";
  /** The server's words when it refused the press at the quote (the workspace's monthly cap): Render stays off. */
  refusal: string | null;
  tryAgain: () => void;
  /** Takes this press started. */
  sent: number;
  /** Takes this press made that have finished (done, failed or cancelled). */
  finished: number;
  total: number;
  problem: string | null;
  canCancel: boolean;
  press: () => Promise<void>;
  cancel: () => Promise<void>;
  /** Back to idle, for the next press (after Next, or a failed run). */
  reset: () => void;
};

export function useDirectorRender({ scope, projectKey, shots, readOnly }: { scope: string; projectKey: string; shots: readonly DirectorShot[]; readOnly?: string | null }): DirectorRender {
  const members = useMemo(() => shots.map((s) => generationRequestBody(s.input)), [shots]);
  const shotIds = useMemo(() => shots.map((s) => s.id), [shots]);
  const membersKey = JSON.stringify([scope, members]);

  /* ── The price: the whole press quoted at once, after a pause in the edits, free ── */
  const [read, setRead] = useState<QuoteState | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!members.length) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      readBatchQuote(scope, members, controller.signal).then(
        (quote) => { if (!controller.signal.aborted) setRead({ key: membersKey, quote }); },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          const words = error instanceof Error ? neutralCopy(error.message, UNREAD) : UNREAD;
          /* 429: refused at the quote (the workspace's monthly cap, or a limit), in the server's own words. */
          setRead(error instanceof StudioRequestError && error.status === 429 ? { key: membersKey, refusal: words } : { key: membersKey, error: words });
        },
      );
    }, 400);
    return () => { controller.abort(); clearTimeout(timer); };
    // membersKey stands for scope and members.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [membersKey, retry]);
  const current = read?.key === membersKey ? read : null;
  const price = current?.quote ? priceOfQuote(current.quote) : null;
  /* The last price read stays on the button, disabled, while the next is read: never nothing. */
  const [last, setLast] = useState<PriceValue | null>(null);
  if (price && priceWords(price) !== priceWords(last)) setLast(price);
  const reading = Boolean(members.length) && !current;

  const [state, setState] = useState<BarState>("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [settled, setSettled] = useState<Settled>({});
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [pressKey, setPressKey] = useState<string | null>(null);
  const sending = useRef(false);

  const press = useCallback(async () => {
    if (sending.current || readOnly || state !== "idle") return;
    const shown = current?.quote;
    if (!members.length || !shown) return;
    sending.current = true;
    setState("sending");
    setProblem(null);
    const begin = (made: Job[], words: string | null) => {
      for (const j of made) announceJob(j.jobId);
      setProblem(words);
      setJobs(made);
      setSettled({});
      setStatuses({});
      setState(made.length ? "making" : "idle");
    };
    const madeOf = (out: MemberOut[]) => out.flatMap((m) => (m.id && shotIds[m.index] ? [{ shotId: shotIds[m.index], jobId: m.id }] : []));
    try {
      /* The whole press priced again as it will be sent: a total that moved sends nothing, and the new figure is shown. */
      const fresh = await readBatchQuote(scope, members);
      if (ceilingOf(fresh) !== ceilingOf(shown)) {
        setRead({ key: membersKey, quote: fresh });
        const gate = dispatchGate(ceilingOf(shown), ceilingOf(fresh));
        setProblem(gate.ok ? null : gate.reason);
        setState("idle");
        return;
      }
      const storage = window.localStorage;
      const slot = claimSlot(scope, projectKey);
      const key = claimPress(storage, slot, JSON.stringify(members));
      setPressKey(key);
      let reply: PressReply;
      try {
        reply = await studioRequest<PressReply>(BATCH, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope, "Idempotency-Key": key },
          body: JSON.stringify({ members, maxCredits: ceilingOf(fresh), fingerprint: fresh.fingerprint }),
        });
      } catch (error) {
        /* No answer: the key stays, and the next press asks under it. */
        if (!(error instanceof StudioRequestError) || error.status >= 500) { setProblem(LOST_REPLY); setState("idle"); return; }
        letGo(storage, slot, key);
        /* The shots or their prices changed on the server: the new total is read and shown; nothing was sent. */
        if (error.data.quoteChanged === true) setRetry((n) => n + 1);
        const out = Array.isArray(error.data.members) ? (error.data.members as MemberOut[]) : [];
        /* Refused whole (the cap, the balance, a person's approval) or every shot refused: the server's words, nothing started. */
        begin(madeOf(out), neutralCopy(out.find((m) => m.error)?.error ?? error.message, NOT_SENT));
        return;
      }
      const out = reply.members ?? [];
      const starting = out.some((m) => m.status === "starting");
      /* A shot still being accepted keeps the key, so the next press reads it again rather than start it twice. */
      if (!starting) letGo(storage, slot, key);
      const refused = out.find((m) => m.error)?.error;
      begin(madeOf(out), refused ? neutralCopy(refused, NOT_SENT) : starting ? STILL_STARTING : null);
    } catch (error) {
      setProblem(neutralCopy(error instanceof Error ? error.message : "", NOT_SENT));
      setState("idle");
    } finally { sending.current = false; }
  }, [readOnly, state, current, members, membersKey, shotIds, scope, projectKey]);

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
          const { generation } = await studioRequest<{ generation: { id: string; status: string } }>(`/api/jobs/${encodeURIComponent(id)}`, { signal: controller.signal, headers: { "X-Workbench-Scope": scope }, cache: "no-store" });
          if (!alive) return;
          setStatuses((now) => (now[id] === generation.status ? now : { ...now, [id]: generation.status }));
          if (!ACTIVE.has(generation.status)) setSettled((now) => (now[id] ? now : { ...now, [id]: generation.status }));
        } catch { /* the next pass reads it again */ }
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 2500);
    return () => { alive = false; clearInterval(timer); controller.abort(); };
  }, [watching, scope]);
  const finished = jobs.filter((j) => settled[j.jobId]).length;
  /* Done is derived, not stored: every take this press made has settled. */
  const done = state === "making" && jobs.length > 0 && finished === jobs.length;

  /* The press is cancelled as one, under its key: nothing more starts, and its takes still waiting are cancelled at no charge (lib/batchPress.ts cancelBatch). */
  const cancel = useCallback(async () => {
    if (!pressKey) return;
    try {
      const result = await studioRequest<PressReply>(BATCH, { method: "POST", headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope, "Idempotency-Key": pressKey }, body: JSON.stringify({ cancel: true }) });
      const out = result.members ?? [];
      setProblem(cancelWords(out.some((m) => m.status === "cancelled") ? "cancelled" : out.find((m) => m.id)?.status));
    } catch (error) { setProblem(neutralCopy(error instanceof Error ? error.message : "", "The cancel could not be confirmed. Try again.")); }
  }, [pressKey, scope]);

  const total = jobs.length;
  return {
    state: done ? "done" : state, price: price ?? (reading ? last : null),
    pricing: !members.length ? "none" : price ? "ready" : current?.refusal ? "refused" : current?.error ? "error" : "loading",
    refusal: current?.refusal ?? null,
    tryAgain: () => setRetry((n) => n + 1),
    sent: total, finished, total, problem,
    canCancel: state === "making" && !done && Boolean(pressKey) && cancellable(Object.entries(statuses).filter(([id]) => !settled[id]).map(([, s]) => s)),
    press, cancel,
    reset: () => { setState("idle"); setJobs([]); setSettled({}); setStatuses({}); setProblem(null); setPressKey(null); },
  };
}
