/**
 * The render-state model under every rendering card (P3), Make tile and Rig
 * shot node in the new interface (redesign plan C1; docs/redesign/inventory.md
 * §7; docs/redesign/cancel-billing.md).
 *
 * One take's row and the time now become what a card shows: its stage in
 * plain words (In queue → Preparing → Rendering → Saving), whether it is slow
 * or failed, the one-line time ("Seedance 2.5 · usually 2–4 min · 1:12 so
 * far") with a short form for narrow cards, the bar (to about 90% over the
 * typical time, then held there; never 99%), the money line, whether it can be
 * cancelled and why not, and a batch's summary ("3 of 8 ready · about 4 min
 * left").
 *
 * Pure, and safe in the browser. What only the server can see on a row (a
 * provider's task id, a store lease) arrives as facts made by
 * lib/v12/renderFacts.ts. No engine reports a percentage, and there is no
 * "storing" status: Saving is shown only where a row's own facts say its
 * result is being stored.
 *
 * Every price is the take's own figure (what was reserved for it, what it
 * needs to start, what the ledger charged) passed in; none is written here.
 */
import { displayModelName } from "../models";
import { isHiggsfieldVideoModel } from "../cinemaStudioTypes";
import { POOL_MARK } from "../sharedKeyTerms";
import { fmtLedgerCredits, fmtLedgerUsd } from "../usageLedgerTerms";
import { fmtTypical, typicalFor, type TypicalRange, type TypicalTimesReply } from "./typicalTimes";

export type RenderPrice = { amount: number; unit: "cr" | "usd" };

/** A take as the model reads it: its stored row (generations), plus the facts only the server can tell. */
export type RenderTake = {
  id: string;
  /** generations.status: held | queued | running | succeeded | failed | cancelled. */
  status: string;
  kind: string;
  /** The engine id (generations.model). */
  model: string;
  /** The provider id that runs it (generations.provider: byteplus, fal, higgsfield, google, …). */
  provider?: string | null;
  createdAt: number;
  /** When its work began, when known (created_at + queue_ms); else createdAt. */
  startedAt?: number | null;
  /** params.held as the browser sees it (lib/jobs heldForBrowser): why it waits, and what it needs to start. */
  held?: { why?: string; pool?: string; needs?: number } | null;
  /** The provider has accepted it (a task id or request handle is on the row). */
  atProvider?: boolean;
  /** Its result is being moved into storage now (a live store lease, or a collected original). */
  saving?: boolean;
  /** Its place in the line, 1 first, when it is known (lib/v12/queuePosition.ts). */
  queuePosition?: number | null;
  /**
   * The take's own figure: in flight, what was reserved (approved) for it; held, what it needs to start. Null when the
   * row has none.
   */
  price?: RenderPrice | null;
  /** Settled: what the ledger charged — 0 is "nothing billed" — or null when it has no settled figure. */
  charged?: number | null;
  /** Retry's figure, a fresh quote of the same request; the take's own price when no fresh quote has come back. */
  retryPrice?: RenderPrice | null;
  /** Whether this viewer may cancel it at all (its author, or an admin). Defaults to true. */
  mayCancel?: boolean;
  /** Cancelled by discarding it while held (params.discardedAt): nothing was reserved, so nothing was billed. */
  discarded?: boolean;
};

export type RenderStage = "held" | "queue" | "preparing" | "rendering" | "saving" | "ready" | "failed" | "cancelled";
export type RenderTone = "grey" | "blue" | "amber" | "green" | "red";
/** How a cancel would be done: a held take is discarded (lib/held discardHeldJob); a take in the provider's queue is cancelled there (POST /api/generations/:id/cancel). */
export type CancelVia = "discard" | "provider-queue";

export type RenderLine = {
  /** "Seedance 2.5 · usually 2–4 min · 1:12 so far" — or, slow, the whole sentence. */
  full: string;
  /** For narrow cards, one line at 12 px on a 260 px card: "Seedance 2.5 · 2–4 min · 1:12". */
  short: string;
  /** The tooltip: always the full words. */
  title: string;
};

export type RenderState = {
  stage: RenderStage;
  /** The stage in the card's words: "In queue · position 3", "Preparing", "Rendering", "Saving", "Didn’t finish". */
  label: string;
  tone: RenderTone;
  /** Not settled: something still runs or waits. */
  active: boolean;
  /** Past twice the typical upper bound while it works. Never red. */
  slow: boolean;
  failed: boolean;
  /** Settled with the ledger showing nothing charged (or discarded before it was reserved). */
  nothingBilled: boolean;
  /** Time spent working (from startedAt), or waiting while it has not started; null once settled. */
  elapsedMs: number | null;
  typical: TypicalRange;
  /** About how long until it is ready; null when settled, slow, or held for a person. */
  remainingMs: number | null;
  line: RenderLine | null;
  /** 0–0.9. `hold`: it has reached the cap and holds there with a soft shimmer. Null when settled. */
  bar: { pct: number; hold: boolean } | null;
  money: { text: string; short: string } | null;
  /** A failed take's one action. */
  retry: { label: string; price: RenderPrice | null } | null;
  /** Null once settled; otherwise whether Cancel is offered, how, and its tooltip either way. Esc never cancels. */
  cancel: { cancellable: boolean; via: CancelVia | null; tooltip: string } | null;
  /** A Make tile's one line: "Rendering · 0:21 so far · 2 cr held", "Preparing · Nano Banana 2 · usually 20–40 s". */
  tile: string | null;
};

/** The bar's cap: it fills to here over the typical time, then holds. Never 99%. */
export const BAR_CAP = 0.9;
/** What a waiting take's bar shows: a sliver, so the card reads as started-to-be-handled, not empty. */
export const BAR_WAITING = 0.04;
/** Slow is past this many times the typical upper bound. */
export const SLOW_FACTOR = 2;

/* ── Words (the prototype's, verbatim) ───────────────────────────────── */

export const SLOW_TEXT = "Taking longer than usual — the provider is slow right now. Still working; you won’t be charged twice.";
export const SLOW_SHORT = "Taking longer than usual · still working";
export const CANCEL_FREE = "Cancel this take — nothing is billed for a cancelled take";
export const CANCEL_PREPARING = "It’s being sent to the engine now, so it can’t be cancelled.";
export const CANCEL_PROVIDER_QUEUE = "This engine’s queue can’t be cancelled from here yet. It’s charged only when it’s ready.";
export const CANCEL_RUNNING = "It has started rendering, so it can’t be cancelled.";
export const CANCEL_NOT_YOURS = "Only the person who made this take, or an admin, can cancel it.";
export const CANCELLED_TOAST = "Cancelled · nothing billed · the frame stays";

/** A take's price in the unit its workspace pays in: "43 cr", "$0.840". */
export const fmtRenderPrice = (p: RenderPrice): string => (p.unit === "usd" ? fmtLedgerUsd(p.amount) : fmtLedgerCredits(p.amount));
const priced = (p: RenderPrice | null | undefined): RenderPrice | null =>
  p && Number.isFinite(p.amount) && p.amount > 0 && (p.unit === "cr" || p.unit === "usd") ? p : null;

/** "0:07", "1:12", "12:40", "1:02:03". */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}

/** "about 4 min left", "about 20 s left", "almost done". */
export function fmtTimeLeft(ms: number): string {
  if (ms <= 2_500) return "almost done";
  if (ms < 60_000) return `about ${Math.max(5, Math.ceil(ms / 5_000) * 5)} s left`;
  return `about ${Math.ceil(ms / 60_000)} min left`;
}

/** The engine's name, as the cards name it ("Seedance 2.5", "Kling 3.0"). */
export const engineName = (model: string): string => displayModelName(model);
/** The same, shortened for a narrow card: "Kling 3.0 Standard" → "Kling 3.0 Std". */
export const engineShort = (name: string): string =>
  name.replace(/\bStandard\b/g, "Std").replace(/\bProfessional\b/g, "Pro").replace(/\bMultilingual\b/g, "ML").replace(/\s+/g, " ").trim();

/* ── One take ─────────────────────────────────────────────────────────── */

const waitsForSlot = (held: RenderTake["held"]) => held?.why === "slots" || held?.pool === POOL_MARK;

/** The stage a row is at. Held for a slot waits in line; held for credits (or a new price) waits on a person. */
export function stageOf(take: Pick<RenderTake, "status" | "held" | "atProvider" | "saving">): RenderStage {
  switch (take.status) {
    case "succeeded": return "ready";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    case "held": return waitsForSlot(take.held) ? "queue" : "held";
    /* Admitted and reserved: with the provider's own queue once it accepted it, else still being prepared and sent. */
    case "queued": return take.atProvider ? "queue" : "preparing";
    case "running": return take.saving ? "saving" : "rendering";
    default: return "preparing";
  }
}

/**
 * Whether Cancel is offered (plan decision 7): only while nothing can be
 * billed and our code can do it today — a held take (discarded; nothing was
 * reserved or sent), or a video waiting in the queue of the one provider whose
 * cancel we call (the API-key video engines on POST /api/generations/:id/
 * cancel, lib/genjutsuVideo.ts). Ark and fal document a queued cancel too, but
 * calling them is new money-adjacent code (NEEDS AKSHAY), so not yet. Once a
 * take is rendering, no provider promises a stopped job is not billed.
 */
export function cancelOf(take: RenderTake, stage: RenderStage = stageOf(take)): RenderState["cancel"] {
  if (stage === "ready" || stage === "failed" || stage === "cancelled") return null;
  const refuse = (tooltip: string) => ({ cancellable: false, via: null, tooltip });
  if (take.status === "held") return take.mayCancel === false ? refuse(CANCEL_NOT_YOURS) : { cancellable: true, via: "discard", tooltip: CANCEL_FREE };
  if (stage === "queue") {
    const ours = take.provider === "higgsfield" && take.kind === "video" && isHiggsfieldVideoModel(take.model);
    if (!ours) return refuse(CANCEL_PROVIDER_QUEUE);
    return take.mayCancel === false ? refuse(CANCEL_NOT_YOURS) : { cancellable: true, via: "provider-queue", tooltip: CANCEL_FREE };
  }
  if (stage === "preparing") return refuse(CANCEL_PREPARING);
  return refuse(CANCEL_RUNNING);
}

const LABEL: Record<Exclude<RenderStage, "queue" | "held">, string> = {
  preparing: "Preparing", rendering: "Rendering", saving: "Saving", ready: "Ready", failed: "Didn’t finish", cancelled: "Cancelled",
};
const TONE: Record<RenderStage, RenderTone> = {
  held: "amber", queue: "grey", preparing: "blue", rendering: "blue", saving: "blue", ready: "green", failed: "red", cancelled: "grey",
};

export function renderState(take: RenderTake, now: number, typicalTimes?: TypicalTimesReply | null): RenderState {
  const stage = stageOf(take);
  const typical = typicalFor(take.model, take.kind, typicalTimes);
  const settled = stage === "ready" || stage === "failed" || stage === "cancelled";
  const waiting = stage === "queue" || stage === "held";
  const working = stage === "preparing" || stage === "rendering" || stage === "saving";
  const since = working && take.startedAt != null && Number.isFinite(take.startedAt) ? take.startedAt : take.createdAt;
  const elapsedMs = settled ? null : Math.max(0, now - since);
  const slow = working && elapsedMs != null && elapsedMs > SLOW_FACTOR * typical.highMs;
  const price = priced(take.price);
  const charged = typeof take.charged === "number" && Number.isFinite(take.charged) ? take.charged : null;
  const nothingBilled = settled && stage !== "ready" && (charged === 0 || (stage === "cancelled" && take.discarded === true));

  const engine = engineName(take.model);
  const range = fmtTypical(typical);
  const label = stage === "queue"
    ? (take.queuePosition && take.queuePosition > 0 ? `In queue · position ${Math.floor(take.queuePosition)}` : "In queue")
    : stage === "held"
      ? (take.held?.needs && take.held.needs > 0 ? `Held · needs ${fmtRenderPrice({ amount: take.held.needs, unit: "cr" })}` : price ? `Held · needs ${fmtRenderPrice(price)}` : "Held · needs credits")
      : LABEL[stage];

  /* The time line: one line, with a short form; the slow sentence lives in the tooltip. */
  let line: RenderLine | null = null;
  if (slow) line = { full: SLOW_TEXT, short: SLOW_SHORT, title: SLOW_TEXT };
  else if (waiting || working) {
    const time = waiting ? "not started" : `${fmtElapsed(elapsedMs ?? 0)} so far`;
    const full = `${engine} · usually ${range} · ${time}`;
    const short = `${engineShort(engine)} · ${range} · ${waiting ? "not started" : fmtElapsed(elapsedMs ?? 0)}`;
    line = { full, short, title: full };
  }

  const bar = settled ? null
    : waiting ? { pct: BAR_WAITING, hold: false }
      : stage === "saving" || slow ? { pct: BAR_CAP, hold: true }
        : (() => {
          const pct = Math.min(BAR_CAP, Math.max(BAR_WAITING, (BAR_CAP * (elapsedMs ?? 0)) / Math.max(1, typical.highMs)));
          return { pct, hold: pct >= BAR_CAP };
        })();

  const remainingMs = settled || slow || stage === "held" ? null
    : stage === "queue" ? typical.highMs
      : stage === "saving" ? 0
        : Math.max(0, typical.highMs - (elapsedMs ?? 0));

  /* Money, once. Reserved takes say "held"; a take waiting for a slot has nothing reserved yet, so it does not. */
  const retryPrice = priced(take.retryPrice) ?? price;
  let money: RenderState["money"] = null;
  let retry: RenderState["retry"] = null;
  if (stage === "failed") {
    const billed = charged != null && charged > 0 ? fmtRenderPrice({ amount: charged, unit: price?.unit ?? retryPrice?.unit ?? "cr" }) : null;
    retry = { label: retryPrice ? `Retry · ${fmtRenderPrice(retryPrice)}` : "Retry", price: retryPrice };
    const what = nothingBilled ? "nothing billed" : billed ? `${billed} charged` : null;
    const head = ["Didn’t finish", what].filter(Boolean).join(" · ");
    money = { text: `${head} · ${retry.label}`, short: head };
  } else if (stage === "cancelled") {
    const text = nothingBilled ? "Cancelled · nothing billed" : "Cancelled";
    money = { text, short: text };
  } else if (stage === "held") {
    money = { text: "Nothing charged yet", short: "Nothing charged yet" };
  } else if (stage !== "ready") {
    const reserved = take.status !== "held";
    const tail = "charged only when it’s ready";
    money = price
      ? { text: `${fmtRenderPrice(price)}${reserved ? " held" : ""} · ${tail}`, short: `${fmtRenderPrice(price)}${reserved ? " held" : ""}` }
      : { text: "Charged only when it’s ready", short: "Charged when ready" };
  }

  const tile = stage === "ready" ? null
    : stage === "failed" || stage === "cancelled" ? money?.short ?? label
      : slow ? `${label} · taking longer than usual`
        : stage === "rendering" || stage === "saving"
          ? [label, `${fmtElapsed(elapsedMs ?? 0)} so far`, price && take.status !== "held" ? `${fmtRenderPrice(price)} held` : null].filter(Boolean).join(" · ")
          : `${label} · ${engine} · usually ${range}`;

  return {
    stage, label, tone: TONE[stage], active: !settled, slow, failed: stage === "failed", nothingBilled,
    elapsedMs, typical, remainingMs, line, bar, money, retry, cancel: cancelOf(take, stage), tile,
  };
}

/* ── A batch ──────────────────────────────────────────────────────────── */

export type BatchItem = { name?: string | null; state: RenderState };

/**
 * A batch's stage meta, in the prototype's words: "3 of 8 ready · about 4 min
 * left"; one take rendering, "2 of 8 ready · Shot 3 rendering · about 2 min
 * left"; slow, "2 of 8 ready · Shot 3 is taking longer than usual"; failed,
 * "2 of 8 ready · Shot 3 didn’t finish · nothing billed"; nothing running,
 * "2 of 8 ready to review". Takes run side by side, so the time left is the
 * longest of theirs. Null for an empty batch.
 */
export function batchSummary(items: readonly BatchItem[]): string | null {
  if (!items.length) return null;
  const total = items.length;
  const ready = items.filter((i) => i.state.stage === "ready").length;
  const failed = items.filter((i) => i.state.failed);
  const slow = items.filter((i) => i.state.slow);
  const timed = items.filter((i) => i.state.active && i.state.remainingMs != null);
  const head = `${ready} of ${total} ready`;
  const parts = [head];
  if (failed.length === 1) {
    const one = failed[0];
    parts.push(`${one.name ? `${one.name} didn’t finish` : "1 didn’t finish"}${one.state.nothingBilled ? " · nothing billed" : ""}`);
  } else if (failed.length > 1) {
    parts.push(`${failed.length} didn’t finish${failed.every((i) => i.state.nothingBilled) ? " · nothing billed" : ""}`);
  }
  if (slow.length === 1) parts.push(slow[0].name ? `${slow[0].name} is taking longer than usual` : "1 is taking longer than usual");
  else if (slow.length > 1) parts.push(`${slow.length} are taking longer than usual`);
  else if (timed.length) {
    const left = fmtTimeLeft(Math.max(...timed.map((i) => i.state.remainingMs ?? 0)));
    const working = items.filter((i) => i.state.stage === "rendering" || i.state.stage === "preparing" || i.state.stage === "saving");
    const waiting = items.filter((i) => i.state.stage === "queue");
    if (working.length === 1 && !waiting.length && working[0].name) parts.push(`${working[0].name} ${working[0].state.label.toLowerCase()}`);
    parts.push(left);
  }
  return parts.length === 1 && !items.some((i) => i.state.active) ? `${head} to review` : parts.join(" · ");
}
