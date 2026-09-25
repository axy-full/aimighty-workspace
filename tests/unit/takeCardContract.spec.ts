import { test, expect } from "@playwright/test";
import type { LibraryAsset } from "../../lib/genLibrary";
import type { Generation } from "../../lib/jobs";
import { entryFace, entryKind, libraryEntries, libraryView, mergeNewest, settling, tileAspect } from "../../lib/workspace/library";
import { failureReason, heldReason, projectTakes, takeChip, takeReasonLine, takeStage, takeStatusWord } from "../../lib/workspace/takes";

/**
 * One card contract for every grid of takes (Gen › Results, Library › Assets,
 * Studio › Takes): skeletons while the read is in flight, a banner when it
 * fails, a status chip on every take, one line on why a take failed or
 * waits, and "Preview unavailable" for a finished take with nothing stored.
 */

function gen(id: string, extra: Partial<Generation> = {}): Generation {
  return {
    id, projectId: "p", projectName: null, arkTaskId: null, kind: "image", reviewState: "", reviewBy: null, pickedBy: null, pickedAt: null,
    approvedBy: null, approvedAt: null, model: "gemini-3.1-flash-image", prompt: "A prompt", title: null, params: {}, status: "succeeded",
    sourceUrl: null, storedUrl: "/api/media/" + id, totalTokens: null, costUsd: null, creditsBilled: 1, refineCostUsd: null, refineModel: null,
    refineInTokens: null, refineOutTokens: null, error: null, createdBy: "u", authorName: null, shotId: null, shotCode: null, shotScene: null,
    shotTitle: null, version: 1, durationMs: null, durationS: null, provider: "mock", attempts: 1, task: "generate", sourceGenId: null,
    createdAt: 10, updatedAt: 10, ...extra,
  } as Generation;
}
const asset = (value: Generation): LibraryAsset => ({ origin: "generation", value });
const take = (value: Generation) => projectTakes([asset(value)])[0];

test("a render in flight is Queued, Rendering or Held — held for a slot is a place in the line", () => {
  expect(takeStage({ status: "queued", params: {} })).toBe("queued");
  expect(takeStage({ status: "running", params: {} })).toBe("rendering");
  expect(takeStage({ status: "held", params: { held: { why: "credits", needs: 12 } } })).toBe("held");
  expect(takeStage({ status: "held", params: { held: { why: "slots" } } })).toBe("queued");

  expect(take(gen("q", { status: "queued", creditsBilled: null }))).toMatchObject({ status: "rendering", stage: "queued", credits: null });
  expect(take(gen("q", { status: "queued" }))).not.toHaveProperty("reason");
  expect(take(gen("r", { status: "running", creditsBilled: null }))).toMatchObject({ status: "rendering", stage: "rendering" });
  expect(take(gen("h", { status: "held", params: { held: { why: "credits", needs: 11.2, estUsd: 0.7 } } })))
    .toMatchObject({ stage: "held", reason: "Needs 12 cr", detail: "Starts on its own when credits arrive." });
  expect(take(gen("s", { status: "held", params: { held: { why: "slots" } } }))).toMatchObject({ stage: "queued", reason: "Waiting for a free slot" });

  expect(heldReason({ held: { why: "credits", needs: 1200 } })).toEqual({ reason: "Needs 1,200 cr", detail: "Starts on its own when credits arrive." });
  expect(heldReason({ held: { why: "credits" } })).toEqual({ reason: "Waiting for credits" });
  expect(heldReason(null)).toEqual({ reason: "Waiting for credits" });
});

test("a failed take says why in one line; the row's own words ride along only when they say more", () => {
  expect(failureReason({ status: "failed", error: "Content policy: the prompt was blocked by the safety system. Ref 8812" }))
    .toEqual({ reason: "Refused by the content filter", detail: "Content policy: the prompt was blocked by the safety system." });
  expect(failureReason({ status: "failed", error: "fal.ai request timed out after 600s" })).toMatchObject({ reason: "The engine timed out" });
  expect(failureReason({ status: "failed", error: "ModelArk returned 502 {\"code\":\"upstream\"}" })).toEqual({ reason: "The engine hit an error", detail: "ModelArk returned 502" });
  expect(failureReason({ status: "failed", error: "Not enough credits to start this render." })).toMatchObject({ reason: "Out of credits" });
  expect(failureReason({ status: "failed", error: "The production is at its cap." })).toEqual({ reason: "The production is at its cap" });
  expect(failureReason({ status: "failed", error: null, params: { held: { why: "slots" } } })).toEqual({ reason: "Every render slot was busy" });
  expect(failureReason({ status: "cancelled", error: "" })).toEqual({ reason: "Cancelled before it rendered" });
  expect(failureReason({ status: "failed", error: null })).toEqual({ reason: "Did not render" });
  /* An unrecognised message is its own reason, first sentence only, no links. */
  expect(failureReason({ status: "failed", error: "The reference image is too small. See https://example.test/help for sizes." }))
    .toEqual({ reason: "The reference image is too small." });
  const long = failureReason({ status: "failed", error: "x".repeat(300) });
  expect(long.reason.length).toBeLessThanOrEqual(118);
  expect(long.reason.endsWith("…")).toBe(true);

  const refused = take(gen("f", { status: "failed", creditsBilled: 0, error: "Refused: prompt flagged by moderation." }));
  expect(refused).toMatchObject({ status: "failed", failedUnbilled: true, reason: "Refused by the content filter", detail: "Refused: prompt flagged by moderation." });
});

test("the chip names the status; the not-billed note moves to the reason line on a 2-up tile", () => {
  const failed = { status: "failed" as const, failedUnbilled: true as const, reason: "The engine timed out" };
  expect(takeChip(failed)).toEqual({ label: "Failed · not billed", tone: "failed" });
  expect(takeChip(failed, true)).toEqual({ label: "Failed", tone: "failed" });
  expect(takeReasonLine(failed)).toBe("The engine timed out");
  expect(takeReasonLine(failed, true)).toBe("Not billed · The engine timed out");
  /* Billed failure: never claims it was free. */
  expect(takeChip({ status: "failed" })).toEqual({ label: "Failed", tone: "failed" });
  expect(takeReasonLine({ status: "failed", reason: "Did not render" }, true)).toBe("Did not render");

  expect(takeChip({ status: "rendering", stage: "queued" })).toEqual({ label: "Queued", tone: "idle" });
  expect(takeChip({ status: "rendering", stage: "rendering" })).toEqual({ label: "Rendering", tone: "live" });
  expect(takeChip({ status: "rendering", stage: "held" })).toEqual({ label: "Held", tone: "waiting" });
  expect(takeChip({ status: "picked" })).toEqual({ label: "Picked", tone: "picked" });
  expect(takeChip({ status: "approved" })).toEqual({ label: "Approved", tone: "done" });
  expect(takeChip({ status: "changes" })).toEqual({ label: "Changes", tone: "waiting" });
  /* Waiting for review and uploads carry no chip: the grid stays quiet for the ordinary case. */
  expect(takeChip({ status: "review" })).toBeNull();
  expect(takeChip({ status: "uploaded" })).toBeNull();
  expect(takeReasonLine({ status: "review" })).toBeNull();

  expect(takeStatusWord({ status: "review" })).toBe("In review");
  expect(takeStatusWord({ status: "uploaded" })).toBe("Uploaded");
  expect(takeStatusWord({ status: "failed", failedUnbilled: true })).toBe("Failed · not billed");
  expect(takeStatusWord({ status: "rendering", stage: "held" })).toBe("Held");
});

test("a card's face: media, live, held, failed, or 'Preview unavailable' for a finished take with nothing stored", () => {
  const entries = libraryEntries({
    uploads: [],
    generations: [
      gen("ok"),
      gen("run", { status: "running", storedUrl: null }),
      gen("held", { status: "held", storedUrl: null, params: { held: { why: "credits", needs: 4 } } }),
      gen("fail", { status: "failed", storedUrl: null, kind: "video" }),
      gen("gone", { storedUrl: null }),
      gen("mesh", { kind: "model" as Generation["kind"], storedUrl: null }),
    ].map((g, i) => ({ ...g, createdAt: 100 - i })),
  });
  expect(entries.map((e) => [e.take.sourceId, entryFace(e)])).toEqual([
    ["ok", "media"], ["run", "live"], ["held", "held"], ["fail", "failed"], ["gone", "unavailable"], ["mesh", "file"],
  ]);
  /* Filed by what it is, whether or not it rendered: a failed clip is still Video. */
  expect(entryKind(entries[3])).toBe("video");
  expect(entries[3].media).toBeNull();
});

test("never 'nothing here' while reading or after a failed read; a failed read always offers a way back", () => {
  expect(libraryView({ status: "idle", error: null }, 0)).toEqual({ skeletons: true, banner: null, empty: false });
  expect(libraryView({ status: "loading", error: null }, 0)).toEqual({ skeletons: true, banner: null, empty: false });
  expect(libraryView({ status: "loading", error: null }, 3)).toEqual({ skeletons: false, banner: null, empty: false });
  expect(libraryView({ status: "error", error: "Library offline." }, 0)).toEqual({ skeletons: false, banner: { tone: "error", message: "Library offline." }, empty: false });
  expect(libraryView({ status: "error", error: null }, 0).banner?.message).toBe("The project library could not be loaded.");
  /* A later read failing keeps the cards and says they are not fresh. */
  expect(libraryView({ status: "ready", error: "More assets could not be loaded." }, 5)).toEqual({ skeletons: false, banner: { tone: "stale", message: "More assets could not be loaded." }, empty: false });
  expect(libraryView({ status: "ready", error: null }, 0)).toEqual({ skeletons: false, banner: null, empty: true });
  /* No project open: the project list still opening shows skeletons; a failed list shows nothing (the shell's banner says it). */
  expect(libraryView(null, 0, "loading")).toEqual({ skeletons: true, banner: null, empty: false });
  expect(libraryView(null, 0, "error")).toEqual({ skeletons: false, banner: null, empty: false });
  expect(libraryView(null, 0)).toEqual({ skeletons: false, banner: null, empty: true });
});

test("skeletons hold the project's frame, clamped so a tile stays a tile", () => {
  expect(tileAspect("16:9")).toBe("16 / 9");
  expect(tileAspect("9:16")).toBe("9 / 16");
  expect(tileAspect("2.39:1")).toBe("2 / 1");
  expect(tileAspect("1:3")).toBe("0.563 / 1");
  expect(tileAspect("1920x1080")).toBe("1920 / 1080");
  expect(tileAspect("4 / 5")).toBe("4 / 5");
  expect(tileAspect("")).toBeNull();
  expect(tileAspect(null)).toBeNull();
  expect(tileAspect("wide")).toBeNull();
  expect(tileAspect("0:9")).toBeNull();
});

test("a grid with a take in flight keeps re-reading; one held for credits waits on a top-up instead", () => {
  expect(settling([gen("a"), gen("b", { status: "failed" })])).toBe(false);
  expect(settling([gen("a"), gen("b", { status: "queued" })])).toBe(true);
  expect(settling([gen("a", { status: "running" })])).toBe(true);
  expect(settling([gen("a", { status: "held", params: { held: { why: "slots" } } })])).toBe(true);
  expect(settling([gen("a", { status: "held", params: { held: { why: "credits", needs: 3 } } })])).toBe(false);

  const loaded = [gen("b", { status: "running", createdAt: 9 }), gen("a", { createdAt: 8 }), gen("old", { createdAt: 1 })];
  const newest = [gen("c", { createdAt: 11 }), gen("b", { status: "succeeded", createdAt: 9 }), gen("a", { createdAt: 8 })];
  const merged = mergeNewest(loaded, newest);
  expect(merged.map((g) => [g.id, g.status])).toEqual([["c", "succeeded"], ["b", "succeeded"], ["a", "succeeded"], ["old", "succeeded"]]);
  /* Rows past the newest page stay as they were. */
  expect(merged[3]).toBe(loaded[2]);
});
