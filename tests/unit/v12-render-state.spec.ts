import { test, expect } from "@playwright/test";
import {
  BAR_CAP, BAR_WAITING, CANCELLED_FREE_TOAST, CANCEL_FREE, CANCEL_MAY_CHARGE, CANCEL_NOT_YOURS, CANCEL_PREPARING, CANCEL_PROVIDER_QUEUE, CANCEL_RUNNING, SLOW_SHORT, SLOW_TEXT,
  batchSummary, cancelOf, engineShort, fmtElapsed, fmtTimeLeft, renderState, stageOf, type RenderPrice, type RenderTake,
} from "../../lib/v12/renderState";
import { renderFactsFromRow } from "../../lib/v12/renderFacts";
import type { TypicalTimesReply } from "../../lib/v12/typicalTimes";

/**
 * The render-state model (lib/v12/renderState.ts) under every rendering card,
 * Make tile and Rig node of the new interface: stages, slow, the time line and
 * its one-line short form, the 90% bar, the money line, Cancel per provider,
 * and a batch's summary. Pure: no database, no network.
 */
const T0 = 1_760_000_000_000;
const S = 1_000;
const MIN = 60 * S;
const SEEDANCE = "dreamina-seedance-2-5-260628";
const KLING = "fal-ai/kling-video/v3/standard";
const NANO = "gemini-3.1-flash-image";
const CINEMA = "higgsfield-cinema-studio-4.0";
const TRANSFORM = "higgsfield-genjutsu-motion-transfer";
/* Prices arrive as the take's own figures; these are test inputs, never UI literals. */
const HELD: RenderPrice = { amount: 43, unit: "cr" };
const SEVEN: RenderPrice = { amount: 7, unit: "cr" };

const take = (fields: Partial<RenderTake>): RenderTake => ({
  id: "g1", status: "running", kind: "video", model: SEEDANCE, provider: "byteplus", createdAt: T0, price: HELD, ...fields,
});
const at = (ms: number) => T0 + ms;

test.describe("stages", () => {
  test("each stored status maps to the stage the card shows", () => {
    expect(stageOf({ status: "held", held: { why: "slots" } })).toBe("queue");
    expect(stageOf({ status: "held", held: { why: "slots", pool: "shared" } })).toBe("queue");
    expect(stageOf({ status: "held", held: { why: "credits" } })).toBe("held");
    expect(stageOf({ status: "held", held: null })).toBe("held");
    expect(stageOf({ status: "queued" })).toBe("preparing");
    expect(stageOf({ status: "queued", atProvider: true })).toBe("queue");
    expect(stageOf({ status: "running" })).toBe("rendering");
    expect(stageOf({ status: "running", saving: true })).toBe("saving");
    expect(stageOf({ status: "succeeded" })).toBe("ready");
    expect(stageOf({ status: "failed" })).toBe("failed");
    expect(stageOf({ status: "cancelled" })).toBe("cancelled");
    expect(stageOf({ status: "something-new" })).toBe("preparing");
  });

  test("Saving shows only where the row's own facts say it is storing; there is no storing status", () => {
    expect(renderState(take({ status: "running", saving: false }), at(MIN)).stage).toBe("rendering");
    expect(renderState(take({ status: "running", saving: true }), at(MIN)).stage).toBe("saving");
    /* A saving fact on a row that is not running is ignored. */
    expect(renderState(take({ status: "queued", saving: true }), at(MIN)).stage).toBe("preparing");
  });

  test("a full lifecycle moves In queue → Preparing → Rendering → Saving → Ready", () => {
    const steps: Partial<RenderTake>[] = [
      { status: "held", held: { why: "slots" }, queuePosition: 2 },
      { status: "queued" },
      { status: "running" },
      { status: "running", saving: true },
      { status: "succeeded", charged: { amount: 43, unit: "cr" } },
    ];
    const seen = steps.map((s, i) => renderState(take(s), at(i * 20 * S)));
    expect(seen.map((s) => s.stage)).toEqual(["queue", "preparing", "rendering", "saving", "ready"]);
    expect(seen.map((s) => s.label)).toEqual(["In queue · position 2", "Preparing", "Rendering", "Saving", "Ready"]);
    expect(seen.map((s) => s.tone)).toEqual(["grey", "blue", "blue", "blue", "green"]);
    expect(seen.map((s) => s.active)).toEqual([true, true, true, true, false]);
  });

  test("queue position shows when known, and only a real one", () => {
    expect(renderState(take({ status: "held", held: { why: "slots" }, queuePosition: 5 }), T0).label).toBe("In queue · position 5");
    expect(renderState(take({ status: "held", held: { why: "slots" } }), T0).label).toBe("In queue");
    expect(renderState(take({ status: "held", held: { why: "slots" }, queuePosition: 0 }), T0).label).toBe("In queue");
    expect(renderState(take({ status: "queued", atProvider: true, queuePosition: null }), T0).label).toBe("In queue");
  });

  test("held for credits waits on a person: its label names what it needs, and nothing is charged yet", () => {
    const s = renderState(take({ status: "held", held: { why: "credits", needs: 43 }, price: null }), at(MIN));
    expect(s).toMatchObject({ stage: "held", label: "Held · needs 43 cr", tone: "amber", remainingMs: null, slow: false });
    expect(s.money?.text).toBe("Nothing charged yet");
    expect(renderState(take({ status: "held", held: { why: "credits" }, price: null }), T0).label).toBe("Held · needs credits");
    expect(renderState(take({ status: "held", held: {}, price: { amount: 0.84, unit: "usd" } }), T0).label).toBe("Held · needs $0.840");
  });
});

test.describe("the time line", () => {
  test("the prototype's words: engine · usually range · elapsed so far", () => {
    const s = renderState(take({ status: "running" }), at(72 * S));
    expect(s.line?.full).toBe("Seedance 2.5 · usually 2–4 min · 1:12 so far");
    expect(s.line?.title).toBe(s.line?.full);
    expect(s.elapsedMs).toBe(72 * S);
  });

  test("a queued take has not started", () => {
    const s = renderState(take({ status: "queued", atProvider: true, model: KLING, provider: "fal", price: SEVEN }), at(30 * S));
    expect(s.line?.full).toBe("Kling 3.0 · usually 1–2 min · not started");
    expect(s.line?.short).toBe("Kling 3.0 · 1–2 min · not started");
  });

  test("elapsed counts from when it was asked for, the basis of the typical times, so the bar never jumps back between stages", () => {
    const stages: Partial<RenderTake>[] = [{ status: "queued" }, { status: "running" }, { status: "running", saving: false }];
    let last = 0;
    stages.forEach((fields, i) => {
      const s = renderState(take(fields), at((i + 1) * 30 * S));
      expect(s.elapsedMs).toBe((i + 1) * 30 * S);
      expect(s.bar!.pct).toBeGreaterThanOrEqual(last);
      last = s.bar!.pct;
    });
  });

  test("FIX: the short form fits one line on a 260 px card (about 36 characters at 12 px)", () => {
    for (const model of [SEEDANCE, KLING, NANO, "fal-ai/kling-video/v3/pro", "dreamina-seedance-2-0-260128", "eleven_multilingual_v2", "gemini-3-pro-image"]) {
      for (const elapsed of [0, 72 * S, 9 * MIN + 59 * S, 59 * MIN + 59 * S]) {
        const s = renderState(take({ status: "running", model, kind: model.startsWith("gemini") ? "image" : model.startsWith("eleven") ? "audio" : "video" }), at(elapsed));
        if (!s.slow) {
          expect(s.line!.short.length, s.line!.short).toBeLessThanOrEqual(36);
          expect(s.line!.short).not.toContain("\n");
        }
      }
    }
    expect(renderState(take({ status: "running" }), at(72 * S)).line?.short).toBe("Seedance 2.5 · 2–4 min · 1:12");
    expect(engineShort("Kling 3.0 Standard")).toBe("Kling 3.0 Std");
  });

  test("elapsed and time-left words", () => {
    expect(fmtElapsed(0)).toBe("0:00");
    expect(fmtElapsed(7 * S)).toBe("0:07");
    expect(fmtElapsed(72 * S)).toBe("1:12");
    expect(fmtElapsed(12 * MIN + 40 * S)).toBe("12:40");
    expect(fmtElapsed(62 * MIN + 3 * S)).toBe("1:02:03");
    expect(fmtTimeLeft(0)).toBe("almost done");
    expect(fmtTimeLeft(18 * S)).toBe("about 20 s left");
    expect(fmtTimeLeft(3 * MIN + 10 * S)).toBe("about 4 min left");
  });
});

test.describe("slow", () => {
  test("slow starts strictly past twice the typical upper bound, and is never red", () => {
    /* Seedance's fallback range is 2–4 min: slow past 8 min. */
    expect(renderState(take({ status: "running" }), at(8 * MIN)).slow).toBe(false);
    const s = renderState(take({ status: "running" }), at(8 * MIN + S));
    expect(s.slow).toBe(true);
    expect(s.tone).toBe("blue");
    expect(s.label).toBe("Rendering");
    expect(s.failed).toBe(false);
  });

  test("the slow sentence goes in the tooltip; the card keeps one line", () => {
    const s = renderState(take({ status: "running" }), at(9 * MIN));
    expect(s.line).toEqual({ full: SLOW_TEXT, short: SLOW_SHORT, title: SLOW_TEXT });
    expect(SLOW_TEXT).toBe("Taking longer than usual — the provider is slow right now. Still working; you won’t be charged twice.");
    expect(s.remainingMs).toBeNull();
    expect(s.tile).toBe("Rendering · taking longer than usual");
  });

  test("the threshold follows measured history, not the fallback, when history is there", () => {
    const history: TypicalTimesReply = { models: { [SEEDANCE]: { lowMs: 60 * S, highMs: 90 * S, source: "history" } } };
    expect(renderState(take({ status: "running" }), at(3 * MIN + S), history).slow).toBe(true);
    expect(renderState(take({ status: "running" }), at(3 * MIN + S)).slow).toBe(false);
    expect(renderState(take({ status: "running" }), at(30 * S), history).line?.full).toBe("Seedance 2.5 · usually 1–2 min · 0:30 so far");
  });

  test("a take waiting in a line is never slow (the provider is not working on it yet)", () => {
    expect(renderState(take({ status: "held", held: { why: "slots" } }), at(60 * MIN)).slow).toBe(false);
    expect(renderState(take({ status: "queued", atProvider: true }), at(60 * MIN)).slow).toBe(false);
  });

  test("preparing and saving can be slow too", () => {
    expect(renderState(take({ status: "queued" }), at(9 * MIN)).slow).toBe(true);
    expect(renderState(take({ status: "running", saving: true }), at(9 * MIN)).slow).toBe(true);
  });
});

test.describe("the bar", () => {
  test("fills to 90% over the typical time, then holds there — never 99%", () => {
    const pct = (ms: number) => renderState(take({ status: "running" }), at(ms)).bar!;
    expect(pct(0).pct).toBe(BAR_WAITING);
    expect(pct(2 * MIN).pct).toBeCloseTo(0.45, 5);
    expect(pct(2 * MIN).hold).toBe(false);
    expect(pct(4 * MIN)).toEqual({ pct: BAR_CAP, hold: true });
    expect(pct(7 * MIN)).toEqual({ pct: BAR_CAP, hold: true });
    expect(pct(60 * MIN)).toEqual({ pct: BAR_CAP, hold: true });
    for (let ms = 0; ms <= 20 * MIN; ms += 7 * S) {
      const b = pct(ms);
      expect(b.pct).toBeLessThanOrEqual(0.9);
      expect(b.pct).toBeGreaterThan(0);
    }
  });

  test("monotonic while it renders", () => {
    let last = 0;
    for (let ms = 0; ms <= 6 * MIN; ms += 5 * S) {
      const p = renderState(take({ status: "running" }), at(ms)).bar!.pct;
      expect(p).toBeGreaterThanOrEqual(last);
      last = p;
    }
  });

  test("waiting shows a sliver; saving and slow hold at the cap; settled has none", () => {
    expect(renderState(take({ status: "held", held: { why: "slots" } }), at(MIN)).bar).toEqual({ pct: BAR_WAITING, hold: false });
    expect(renderState(take({ status: "queued", atProvider: true }), at(MIN)).bar).toEqual({ pct: BAR_WAITING, hold: false });
    expect(renderState(take({ status: "running", saving: true }), at(10 * S)).bar).toEqual({ pct: BAR_CAP, hold: true });
    expect(renderState(take({ status: "running" }), at(9 * MIN)).bar).toEqual({ pct: BAR_CAP, hold: true });
    for (const status of ["succeeded", "failed", "cancelled"]) expect(renderState(take({ status }), at(MIN)).bar).toBeNull();
  });
});

test.describe("money", () => {
  test("in flight: the take's own reserved figure, held, charged only when it's ready", () => {
    expect(renderState(take({ status: "running" }), at(MIN)).money).toEqual({ text: "43 cr held · charged only when it’s ready", short: "43 cr held" });
    expect(renderState(take({ status: "queued", price: SEVEN, model: KLING }), at(MIN)).money?.text).toBe("7 cr held · charged only when it’s ready");
    expect(renderState(take({ status: "running", price: { amount: 0.84, unit: "usd" } }), at(MIN)).money?.text).toBe("$0.840 held · charged only when it’s ready");
  });

  test("the figure is whatever the take carries, never a fixed one", () => {
    for (const amount of [1, 2, 13, 128, 1_250]) {
      expect(renderState(take({ status: "running", price: { amount, unit: "cr" } }), at(MIN)).money?.text).toBe(`${amount.toLocaleString("en-US")} cr held · charged only when it’s ready`);
    }
  });

  test("waiting for a slot has nothing reserved yet, so it is not called held", () => {
    expect(renderState(take({ status: "held", held: { why: "slots" } }), at(MIN)).money).toEqual({ text: "43 cr · charged only when it’s ready", short: "43 cr" });
  });

  test("no figure on the row: the promise without a number", () => {
    expect(renderState(take({ status: "running", price: null }), at(MIN)).money?.text).toBe("Charged only when it’s ready");
    expect(renderState(take({ status: "running", price: { amount: 0, unit: "cr" } }), at(MIN)).money?.text).toBe("Charged only when it’s ready");
  });

  test("failed with nothing charged: Didn't finish · nothing billed · Retry · the fresh quote", () => {
    const s = renderState(take({ status: "failed", charged: { amount: 0, unit: "cr" }, price: SEVEN, retryPrice: SEVEN, model: KLING }), at(MIN));
    expect(s).toMatchObject({ stage: "failed", label: "Didn’t finish", tone: "red", failed: true, nothingBilled: true, line: null, bar: null, cancel: null });
    expect(s.money).toEqual({ text: "Didn’t finish · nothing billed · Retry · 7 cr", short: "Didn’t finish · nothing billed" });
    expect(s.retry).toEqual({ label: "Retry · 7 cr", price: SEVEN });
  });

  test("Retry shows a figure only from a fresh quote, never the take's own price (which may be a hold)", () => {
    const s = renderState(take({ status: "failed", charged: { amount: 0, unit: "cr" }, price: SEVEN }), at(MIN));
    expect(s.retry).toEqual({ label: "Retry", price: null });
    expect(s.money?.text).toBe("Didn’t finish · nothing billed · Retry");
    const quoted = renderState(take({ status: "failed", charged: { amount: 0, unit: "cr" }, price: SEVEN, retryPrice: { amount: 8, unit: "cr" } }), at(MIN));
    expect(quoted.money?.text).toBe("Didn’t finish · nothing billed · Retry · 8 cr");
  });

  test("a failure that was charged says what it cost (rule 14); an unknown charge claims nothing", () => {
    expect(renderState(take({ status: "failed", charged: { amount: 43, unit: "cr" }, retryPrice: HELD }), at(MIN)).money?.text).toBe("Didn’t finish · 43 cr charged · Retry · 43 cr");
    expect(renderState(take({ status: "failed", charged: { amount: 0.42, unit: "usd" } }), at(MIN)).money?.text).toBe("Didn’t finish · $0.420 charged · Retry");
    const unknown = renderState(take({ status: "failed", charged: null }), at(MIN));
    expect(unknown.money?.text).toBe("Didn’t finish · Retry");
    expect(unknown.nothingBilled).toBe(false);
    expect(renderState(take({ status: "failed", charged: { amount: 0, unit: "cr" }, price: null }), at(MIN)).retry).toEqual({ label: "Retry", price: null });
  });

  test("cancelled and discarded takes say nothing was billed only when that is so", () => {
    expect(renderState(take({ status: "cancelled", charged: { amount: 0, unit: "cr" } }), at(MIN)).money?.text).toBe("Cancelled · nothing billed");
    expect(renderState(take({ status: "cancelled", discarded: true, charged: null }), at(MIN)).money?.text).toBe("Cancelled · nothing billed");
    expect(renderState(take({ status: "cancelled", charged: null }), at(MIN)).money?.text).toBe("Cancelled");
  });

  test("Cinema Studio holds a band over its quote and is charged what its engine reports, up to the hold", () => {
    const cinema = (fields: Partial<RenderTake>) => take({ provider: "higgsfield", model: CINEMA, price: { amount: 129, unit: "cr" }, ...fields });
    expect(renderState(cinema({ status: "running" }), at(MIN)).money).toEqual({ text: "up to 129 cr held · charged what the engine reports", short: "up to 129 cr held" });
    expect(renderState(cinema({ status: "queued", atProvider: true }), at(MIN)).money?.text).toBe("up to 129 cr held · charged what the engine reports");
    expect(renderState(cinema({ status: "held", held: { why: "slots" } }), at(MIN)).money?.text).toBe("up to 129 cr · charged what the engine reports");
    expect(renderState(cinema({ status: "running", price: null }), at(MIN)).money?.text).toBe("Charged what the engine reports");
    expect(renderState(cinema({ status: "running" }), at(MIN)).tile).toBe("Rendering · 1:00 so far · up to 129 cr held");
    for (const status of ["held", "queued", "running"]) expect(renderState(cinema({ status, held: status === "held" ? { why: "slots" } : null }), at(MIN)).money?.text).not.toMatch(/only when it’s ready/);
    /* A failed Cinema take says what the ledger charged; nothing billed only when it shows zero. */
    expect(renderState(cinema({ status: "failed", charged: { amount: 12, unit: "cr" } }), at(MIN)).money?.text).toBe("Didn’t finish · 12 cr charged · Retry");
    expect(renderState(cinema({ status: "failed", charged: { amount: 0, unit: "cr" } }), at(MIN)).money?.text).toBe("Didn’t finish · nothing billed · Retry");
    /* Other engines keep the plain promise. */
    expect(renderState(take({ status: "running", provider: "higgsfield", model: TRANSFORM }), at(MIN)).money?.text).toBe("43 cr held · charged only when it’s ready");
  });

  test("ready carries no money line", () => {
    expect(renderState(take({ status: "succeeded", charged: { amount: 43, unit: "cr" } }), at(MIN)).money).toBeNull();
  });
});

test.describe("Cancel (plan decision 8)", () => {
  test("a held take is discarded: nothing reserved, nothing billed", () => {
    for (const held of [{ why: "slots" }, { why: "credits", needs: 43 }, { why: "slots", pool: "shared" }]) {
      expect(cancelOf(take({ status: "held", held }))).toEqual({ cancellable: true, via: "discard", tooltip: CANCEL_FREE, toast: CANCELLED_FREE_TOAST });
    }
    /* Held, even a Cinema take is discarded free: nothing was reserved or sent. */
    expect(cancelOf(take({ status: "held", held: { why: "credits" }, provider: "higgsfield", model: CINEMA }))?.cancellable).toBe(true);
    expect(CANCELLED_FREE_TOAST).toBe("Cancelled · nothing billed · the frame stays");
    expect(CANCEL_FREE).toBe("Cancel this take — nothing is billed for a cancelled take");
  });

  test("a motion transfer or object swap in its provider's queue is cancelled there; the same take running is not", () => {
    for (const model of [TRANSFORM, "higgsfield-genjutsu-object-swap"]) {
      const queued = take({ status: "queued", atProvider: true, provider: "higgsfield", model });
      expect(cancelOf(queued)).toEqual({ cancellable: true, via: "provider-queue", tooltip: CANCEL_FREE, toast: CANCELLED_FREE_TOAST });
      expect(cancelOf({ ...queued, status: "running" })).toEqual({ cancellable: false, via: null, tooltip: CANCEL_RUNNING, toast: null });
      /* Not yet accepted (no request handle): there is nothing to cancel there yet. */
      expect(cancelOf({ ...queued, atProvider: false })).toEqual({ cancellable: false, via: null, tooltip: CANCEL_PREPARING, toast: null });
    }
  });

  test("Cinema Studio in its provider's queue: not offered, and the tooltip never promises nothing is billed", () => {
    const queued = take({ status: "queued", atProvider: true, provider: "higgsfield", model: CINEMA });
    expect(cancelOf(queued)).toEqual({ cancellable: false, via: null, tooltip: CANCEL_MAY_CHARGE, toast: null });
    expect(CANCEL_MAY_CHARGE).not.toMatch(/nothing is billed|not billed|free/i);
    expect(renderState(queued, at(MIN)).cancel?.cancellable).toBe(false);
  });

  test("Seedance (Ark) and Kling or Topaz (fal) in their provider's queue: offered, free, and only to who may cancel; a running one never", () => {
    for (const [provider, model] of [["byteplus", SEEDANCE], ["fal", KLING]] as const) {
      expect(cancelOf(take({ status: "queued", atProvider: true, provider, model }))).toEqual({ cancellable: true, via: "provider-queue", tooltip: CANCEL_FREE, toast: CANCELLED_FREE_TOAST });
      expect(cancelOf(take({ status: "queued", atProvider: true, provider, model, mayCancel: false }))).toEqual({ cancellable: false, via: null, tooltip: CANCEL_NOT_YOURS, toast: null });
      expect(cancelOf(take({ status: "running", atProvider: true, provider, model }))?.cancellable).toBe(false);
    }
    /* A take not at the provider yet is being prepared, not queued there. */
    expect(cancelOf(take({ status: "queued", atProvider: false, provider: "byteplus", model: SEEDANCE }))?.cancellable).toBe(false);
    /* A still on the same provider is not the video cancel path. */
    expect(cancelOf(take({ status: "queued", atProvider: true, provider: "higgsfield", kind: "image", model: "higgsfield/marketing-studio-image" }))?.cancellable).toBe(false);
    expect(cancelOf(take({ status: "queued", atProvider: true, provider: "google", kind: "image", model: "gemini-3.1-flash-image" }))).toEqual({ cancellable: false, via: null, tooltip: CANCEL_PROVIDER_QUEUE, toast: null });
  });

  test("never once rendering, saving or slow, on any provider", () => {
    for (const provider of ["byteplus", "fal", "higgsfield", "google", "xai", "elevenlabs"]) {
      expect(cancelOf(take({ status: "running", provider, model: provider === "higgsfield" ? CINEMA : SEEDANCE }))).toEqual({ cancellable: false, via: null, tooltip: CANCEL_RUNNING, toast: null });
      expect(renderState(take({ status: "running", saving: true, provider }), at(MIN)).cancel?.cancellable).toBe(false);
      expect(renderState(take({ status: "running", provider }), at(30 * MIN)).cancel?.cancellable).toBe(false);
    }
  });

  test("someone else's take cannot be cancelled by this viewer", () => {
    expect(cancelOf(take({ status: "held", held: { why: "slots" }, mayCancel: false }))).toEqual({ cancellable: false, via: null, tooltip: CANCEL_NOT_YOURS, toast: null });
    expect(cancelOf(take({ status: "queued", atProvider: true, provider: "higgsfield", model: CINEMA, mayCancel: false }))?.cancellable).toBe(false);
  });

  test("settled takes offer no Cancel at all", () => {
    for (const status of ["succeeded", "failed", "cancelled"]) expect(renderState(take({ status }), at(MIN)).cancel).toBeNull();
  });
});

test.describe("Make tiles", () => {
  test("the prototype's two tile lines", () => {
    const rendering = renderState(take({ status: "running", kind: "image", model: NANO, provider: "google", price: { amount: 2, unit: "cr" } }), at(21 * S));
    expect(rendering.tile).toBe("Rendering · 0:21 so far · 2 cr held");
    const preparing = renderState(take({ status: "queued", kind: "image", model: NANO, provider: "google" }), at(5 * S));
    expect(preparing.tile).toBe("Preparing · Nano Banana 2 · usually 20–40 s");
    expect(renderState(take({ status: "failed", charged: { amount: 0, unit: "cr" } }), at(MIN)).tile).toBe("Didn’t finish · nothing billed");
    expect(renderState(take({ status: "succeeded" }), at(MIN)).tile).toBeNull();
  });
});

test.describe("batch summary", () => {
  const item = (name: string, fields: Partial<RenderTake>, ms = MIN) => ({ name, state: renderState(take(fields), at(ms)) });

  test("the prototype's batch: 3 of 8 ready · about N min left (the longest time left)", () => {
    const items = [
      item("Shot 1", { status: "succeeded" }), item("Shot 2", { status: "succeeded" }), item("Shot 3", { status: "succeeded" }),
      item("Shot 4", { status: "running", saving: true }), item("Shot 5", { status: "running" }, 2 * MIN), item("Shot 6", { status: "queued" }, 10 * S),
      item("Shot 7", { status: "held", held: { why: "slots" } }), item("Shot 8", { status: "held", held: { why: "slots" } }),
    ];
    expect(batchSummary(items)).toBe("3 of 8 ready · about 4 min left");
  });

  test("one take rendering is named", () => {
    const items = [item("Shot 1", { status: "succeeded" }), item("Shot 2", { status: "succeeded" }), item("Shot 3", { status: "running" }, 2 * MIN + 10 * S)];
    expect(batchSummary(items)).toBe("2 of 3 ready · Shot 3 rendering · about 2 min left");
  });

  test("slow and failed takes are named in plain words", () => {
    expect(batchSummary([item("Shot 1", { status: "succeeded" }), item("Shot 2", { status: "succeeded" }), item("Shot 3", { status: "running" }, 9 * MIN)]))
      .toBe("2 of 3 ready · Shot 3 is taking longer than usual");
    expect(batchSummary([item("Shot 1", { status: "succeeded" }), item("Shot 2", { status: "succeeded" }), item("Shot 3", { status: "failed", charged: { amount: 0, unit: "cr" } })]))
      .toBe("2 of 3 ready · Shot 3 didn’t finish · nothing billed");
    expect(batchSummary([item("Shot 1", { status: "succeeded" }), item("Shot 2", { status: "failed", charged: { amount: 43, unit: "cr" } }), item("Shot 3", { status: "failed", charged: { amount: 0, unit: "cr" } })]))
      .toBe("1 of 3 ready · 2 didn’t finish");
  });

  test("nothing running: ready to review", () => {
    expect(batchSummary([item("Shot 1", { status: "succeeded" }), item("Shot 2", { status: "succeeded" }), item("Shot 3", { status: "cancelled", charged: { amount: 0, unit: "cr" } })]))
      .toBe("2 of 3 ready to review");
    expect(batchSummary([])).toBeNull();
  });

  test("near the end it says so instead of a zero", () => {
    expect(batchSummary([item("Shot 1", { status: "succeeded" }), item("Shot 2", { status: "running" }, 4 * MIN)])).toBe("1 of 2 ready · Shot 2 rendering · almost done");
  });
});

test.describe("facts from a stored row (server side)", () => {
  const now = T0 + 10 * MIN;
  test("accepted by the provider: Ark task id, fal request id, API-key handle with its paid claim", () => {
    expect(renderFactsFromRow({ status: "running", created_at: T0, ark_task_id: "cgt-1" }, now).atProvider).toBe(true);
    expect(renderFactsFromRow({ status: "running", created_at: T0, params: JSON.stringify({ falRequestId: "r1" }) }, now).atProvider).toBe(true);
    expect(renderFactsFromRow({ status: "queued", created_at: T0, params: { higgsfieldVideoHandle: { ref: "h1" }, paidClaim: "c" } }, now).atProvider).toBe(true);
    expect(renderFactsFromRow({ status: "queued", created_at: T0, params: { higgsfieldVideoHandle: { ref: "h1" } } }, now).atProvider).toBe(false);
    expect(renderFactsFromRow({ status: "queued", created_at: T0, params: "{}" }, now).atProvider).toBe(false);
    expect(renderFactsFromRow({ status: "queued", created_at: T0, params: "not json" }, now).atProvider).toBe(false);
  });

  test("saving: a live store lease or a collected original, only while running", () => {
    expect(renderFactsFromRow({ status: "running", created_at: T0, params: { storeUntil: now + 30 * S } }, now).saving).toBe(true);
    expect(renderFactsFromRow({ status: "running", created_at: T0, params: { storeUntil: now - S } }, now).saving).toBe(false);
    expect(renderFactsFromRow({ status: "running", created_at: T0, params: { genjutsuOriginal: { bytes: 1 } } }, now).saving).toBe(true);
    expect(renderFactsFromRow({ status: "succeeded", created_at: T0, params: { genjutsuOriginal: { bytes: 1 } } }, now).saving).toBe(false);
  });

  test("discarded from discardedAt", () => {
    expect(renderFactsFromRow({ status: "cancelled", created_at: T0, params: { discardedAt: T0 } }, now).discarded).toBe(true);
    expect(renderFactsFromRow({ status: "cancelled", created_at: T0, params: {} }, now).discarded).toBe(false);
  });

  test("the facts carry no id, handle, lease or figure", () => {
    const facts = renderFactsFromRow({ status: "running", created_at: T0, ark_task_id: "secret-task", params: { storeUntil: now + S, paidClaim: "claim", falRequestId: "req" } }, now);
    expect(Object.keys(facts).sort()).toEqual(["atProvider", "discarded", "saving"]);
    expect(JSON.stringify(facts)).not.toMatch(/secret-task|claim|req/);
  });
});
