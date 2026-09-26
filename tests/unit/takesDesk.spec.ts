import { test, expect } from "@playwright/test";
import type { LibraryUpload } from "../../lib/genLibrary";
import type { Generation } from "../../lib/jobs";
import { rowRanges } from "../../components/workspace/VirtualItems";
import { applyReview, libraryEntries, loadProjectLibrary, projectLibraryState, reviewProjectTake } from "../../lib/workspace/library";
import { DESK_FILTERS, inDeskFilter, nextReview, reviewSaid } from "../../lib/workspace/takes";
import {
  countLabel, decidedBatches, deskCounts, deskEmpty, deskItems, deskTakes, inDesk, inDeskKind, inDeskSearch, openable, reviewable, rigShotOrder, stepTake,
  type DeskItem,
} from "../../lib/workspace/takes-desk";

/**
 * Studio › Takes as the review desk: status filters read the chips' own
 * fields, takes group by shot (the Rig's order) and then by batch, Next walks
 * the takes shown, a review is written through the existing route and shows
 * in every grid at once, and a windowed grid gives a heading a row of its own.
 */

function gen(id: string, extra: Partial<Generation> = {}): Generation {
  return {
    id, projectId: "p", projectName: null, arkTaskId: null, kind: "image", reviewState: "", reviewBy: null, pickedBy: null, pickedAt: null,
    approvedBy: null, approvedAt: null, model: "gemini-3.1-flash-image", prompt: "", title: id, params: {}, status: "succeeded",
    sourceUrl: null, storedUrl: "/api/media/" + id, totalTokens: null, costUsd: null, creditsBilled: 1, refineCostUsd: null, refineModel: null,
    refineInTokens: null, refineOutTokens: null, error: null, createdBy: "u", authorName: null, shotId: null, shotCode: null, shotScene: null,
    shotTitle: null, version: 1, durationMs: null, durationS: null, provider: "mock", attempts: 1, task: "generate", sourceGenId: null,
    createdAt: 100, updatedAt: 100, ...extra,
  } as Generation;
}
const up = (id: string, createdAt: number, mime = "image/png"): LibraryUpload =>
  ({ id, createdAt, filename: `${id}.png`, mime, kind: mime.startsWith("audio/") ? "audio" : "image", bytes: 1, width: 10, height: 10, durationS: null, sha256: "b".repeat(64), url: `/api/uploads/${id}` });
const dusk = { shotId: "s_dusk", shotCode: "SH010", shotTitle: "Dusk" };
const storm = { shotId: "s_storm", shotCode: "SH020", shotTitle: "Storm" };

/** Newest first: a batch of three on dusk (one picked), an approved single, a held and a failed take on storm, loose takes, an upload. */
function entries() {
  return libraryEntries({
    generations: [
      gen("b1", { createdAt: 99, ...dusk, params: { batchId: "b_lantern1" } }),
      gen("b2", { createdAt: 98, ...dusk, params: { batchId: "b_lantern1" }, reviewState: "picked" }),
      gen("b3", { createdAt: 97, ...dusk, params: { batchId: "b_lantern1" } }),
      gen("gull", { createdAt: 96, ...dusk, reviewState: "approved" }),
      gen("held", { createdAt: 95, ...storm, kind: "video", status: "held", storedUrl: null, params: { held: { why: "credits", needs: 4 } } }),
      gen("slot", { createdAt: 94, ...storm, status: "held", storedUrl: null, params: { held: { why: "slots" } } }),
      gen("fail", { createdAt: 93, ...storm, status: "failed", storedUrl: null, creditsBilled: 0, error: "Refused by moderation." }),
      gen("stop", { createdAt: 92, status: "cancelled", storedUrl: null, error: "Discarded before it started." }),
      gen("changes", { createdAt: 91, reviewState: "changes", prompt: "the pier at first light", authorName: "Studio lead" }),
      gen("voice", { createdAt: 90, kind: "audio", model: "eleven_v3" }),
      gen("gone", { createdAt: 89, storedUrl: null }),
    ],
    uploads: [up("plate", 80)],
  });
}
const ids = (items: readonly { take: { sourceId: string } }[]) => items.map((e) => e.take.sourceId);
const shape = (items: DeskItem[]) => items.map((i) => (i.type === "take" ? `${i.entry.take.sourceId}${i.first ? "^" : ""}` : `[${i.label}]`));

test("the status filters read the chips' own fields: Held is the chip that says Held, Failed holds what did not render", () => {
  const all = entries();
  const pick = (f: (typeof DESK_FILTERS)[number]["id"]) => ids(all.filter((e) => inDeskFilter(e.take, f)));
  expect(pick("all")).toHaveLength(12);
  expect(pick("review")).toEqual(["b1", "b3", "voice", "gone"]);
  expect(pick("picked")).toEqual(["b2"]);
  expect(pick("approved")).toEqual(["gull"]);
  expect(pick("changes")).toEqual(["changes"]);
  /* Held for credits is Held; held for a slot is Queued, as its chip says. */
  expect(pick("held")).toEqual(["held"]);
  /* A take stopped before it rendered wears Cancelled and is filed under failed. */
  expect(pick("failed")).toEqual(["fail", "stop"]);
  expect(deskCounts(all, null, "")).toEqual({ all: 12, review: 4, picked: 1, approved: 1, changes: 1, held: 1, failed: 2 });
  /* Counts follow the kind and the search already chosen. */
  expect(deskCounts(all, "video", "")).toMatchObject({ all: 1, held: 1, review: 0 });
  expect(deskCounts(all, null, "first light")).toMatchObject({ all: 1, changes: 1 });
  expect(countLabel(4, false)).toBe("4");
  expect(countLabel(4, true)).toBe("4+");
  expect(countLabel(0, false)).toBe("0");
  /* A zero with older pages unread may not be one. */
  expect(countLabel(0, true)).toBe("");
});

test("kind chips file a take by what it is; a search finds a name, a prompt, a shot or who made it", () => {
  const all = entries();
  const byKind = (k: Parameters<typeof inDeskKind>[1]) => ids(all.filter((e) => inDeskKind(e, k)));
  expect(byKind("video")).toEqual(["held"]);
  expect(byKind("audio")).toEqual(["voice"]);
  expect(byKind("upload")).toEqual(["plate"]);
  /* A failed still is a still. */
  expect(byKind("image")).toContain("fail");
  expect(byKind(null)).toHaveLength(12);
  const find = (q: string) => ids(all.filter((e) => inDeskSearch(e, q)));
  expect(find("  ")).toHaveLength(12);
  expect(find("GULL")).toEqual(["gull"]);
  expect(find("first light")).toEqual(["changes"]);
  expect(find("sh020")).toEqual(["held", "slot", "fail"]);
  expect(find("studio lead")).toEqual(["changes"]);
  expect(ids(all.filter((e) => inDesk(e, { filter: "review", kind: "image", query: "sh010" })))).toEqual(["b1", "b3"]);
});

test("takes group by shot in the Rig's order and name, then by batch; loose takes, then uploads, last", () => {
  const all = entries();
  const shots = rigShotOrder({
    nodes: [
      { id: "n_note", title: "A note", type: "note", x: 0, y: 0, width: 1, linked: [] },
      { id: "n_storm", title: "Storm over the harbour", type: "scene", x: 0, y: 0, width: 1, linked: [] },
      { id: "n_dusk", title: "", type: "generate", x: 0, y: 0, width: 1, linked: [] },
    ],
    shotMappings: { n_note: "s_note", n_storm: "s_storm", n_dusk: "s_dusk" },
  });
  /* Only shots are in the order; a note is not one. */
  expect([...shots.entries()]).toEqual([["s_storm", { at: 0, name: "Storm over the harbour" }], ["s_dusk", { at: 1, name: "" }]]);
  const items = deskItems(all, shots);
  expect(shape(items)).toEqual([
    "[SH020 · Storm over the harbour]", "held^", "slot", "fail",
    /* An untitled Rig shot keeps the shot's own title. A batch with a pick is decided; the single after it starts a row. */
    "[SH010 · Dusk]", "[Batch of 3]", "b1^", "b2", "b3", "gull^",
    "[Not on a shot]", "stop^", "changes", "voice", "gone",
    "[Uploads]", "plate^",
  ]);
  expect(items.filter((i) => i.type === "shot").map((i) => i.type === "shot" && i.count)).toEqual([3, 4, 4, 1]);
  /* Without the Rig: by shot code. A batch whose pick is filtered out still knows it is decided. */
  const review = all.filter((e) => inDeskFilter(e.take, "review"));
  expect(shape(deskItems(review, new Map(), decidedBatches(all)))).toEqual(["[SH010 · Dusk]", "[Batch of 2]", "b1^", "b3", "[Not on a shot]", "voice^", "gone"]);
  expect(shape(deskItems(review))).toEqual(["[SH010 · Dusk]", "[Batch of 2 · pick one]", "b1^", "b3", "[Not on a shot]", "voice^", "gone"]);
  /* Singles between two batches keep their own rows. */
  const mixed = libraryEntries({ uploads: [], generations: [
    gen("x1", { createdAt: 9, params: { batchId: "b_first1" } }), gen("x2", { createdAt: 8, params: { batchId: "b_first1" } }),
    gen("s1", { createdAt: 7 }), gen("s2", { createdAt: 6 }),
    gen("y1", { createdAt: 5, params: { batchId: "b_second" } }), gen("y2", { createdAt: 4, params: { batchId: "b_second" } }),
    gen("s3", { createdAt: 3 }),
  ] });
  const runs = deskItems(mixed).flatMap((i) => (i.type === "take" ? [`${i.entry.take.sourceId}:${i.run}`] : []));
  expect(runs).toEqual(["x1:strip:b_first1", "x2:strip:b_first1", "s1:loose#1", "s2:loose#1", "y1:strip:b_second", "y2:strip:b_second", "s3:loose#2"]);
  expect(deskTakes(deskItems(mixed)).map((e) => e.take.sourceId)).toEqual(["x1", "x2", "s1", "s2", "y1", "y2", "s3"]);
});

test("what opens in the editor, what can be judged, and where Next goes", () => {
  const all = entries();
  const by = (id: string) => all.find((e) => e.take.sourceId === id)!;
  /* A finished picture or sound opens; a take that did not render, waits, or has no stored copy does not. */
  expect(["b1", "voice", "plate"].map((id) => openable(by(id)))).toEqual([true, true, true]);
  expect(["held", "fail", "stop", "gone"].map((id) => openable(by(id)))).toEqual([false, false, false, false]);
  /* An upload is a source: it opens, but carries no review. A finished sound is judged like any take. */
  expect(["b1", "voice", "gull"].map((id) => reviewable(by(id)))).toEqual([true, true, true]);
  expect(["plate", "held", "fail", "gone"].map((id) => reviewable(by(id)))).toEqual([false, false, false, false]);

  const order = deskTakes(deskItems(all));
  const shown = new Set(all.filter((e) => inDeskFilter(e.take, "review")).map((e) => e.take.id));
  const step = (from: string | null, dir: 1 | -1) => stepTake(order, shown, from ? `generation:${from}` : null, dir)?.take.sourceId ?? null;
  /* Among the takes that need review, skipping one whose copy has not landed. */
  expect(step("b1", 1)).toBe("b3");
  expect(step("b3", 1)).toBe("voice");
  expect(step("voice", 1)).toBeNull();
  expect(step("b3", -1)).toBe("b1");
  /* A take that just left the filter (approved under Needs review) keeps its place: Next goes on from it. */
  expect(step("b2", 1)).toBe("b3");
  expect(step("b2", -1)).toBe("b1");
  expect(step(null, 1)).toBe("b1");
  expect(step(null, -1)).toBe("voice");
});

test("a review press sets the state, a second press clears it, and each says what happened", () => {
  expect(nextReview("review", "picked")).toBe("picked");
  expect(nextReview("picked", "approved")).toBe("approved");
  expect(nextReview("approved", "approved")).toBe("");
  expect(nextReview("changes", "changes")).toBe("");
  expect(nextReview("approved", "changes")).toBe("changes");
  expect(reviewSaid("Gull", "picked")).toBe("Gull is picked. It waits under Picked for approval.");
  expect(reviewSaid("Gull", "approved")).toBe("Gull is approved.");
  expect(reviewSaid("Gull", "changes")).toBe("Changes requested on Gull. It waits under Changes.");
  expect(reviewSaid("Gull", "")).toBe("Gull is back in Needs review.");
  expect(deskEmpty({ filter: "review", kind: null, query: "" }, 60, true)).toBe("No takes need review in the 60 loaded.");
  expect(deskEmpty({ filter: "failed", kind: null, query: "" }, 12, false)).toBe("No failed takes.");
  expect(deskEmpty({ filter: "failed", kind: null, query: " dusk " }, 12, false)).toBe("Nothing matches “dusk” under Failed.");
  expect(deskEmpty({ filter: "all", kind: "audio", query: "" }, 1_200, true)).toBe("No audio here in the 1,200 loaded.");
});

test("a windowed grid gives a heading its own row and starts each run on a new one", () => {
  const n = (k: number) => Array.from({ length: k }, (_, i) => i);
  /* Without headings or runs: rows of `columns`, as before. */
  expect(rowRanges(n(7), 3)).toEqual([[0, 3], [3, 6], [6, 7]]);
  expect(rowRanges([], 3)).toEqual([]);
  const items = ["H1", "a", "b", "c", "d", "S", "e", "f", "g", "H2", "h"];
  const heading = (x: string) => x.startsWith("H") || x === "S";
  const run = (x: string) => (["a", "b", "c", "d"].includes(x) ? "one" : ["e", "f", "g"].includes(x) ? "batch" : x);
  expect(rowRanges(items, 3, heading, run).map(([s, e]) => items.slice(s, e).join(""))).toEqual(["H1", "abc", "d", "S", "efg", "H2", "h"]);
  expect(rowRanges(items, 2, heading, run).map(([s, e]) => items.slice(s, e).join(""))).toEqual(["H1", "ab", "cd", "S", "ef", "g", "H2", "h"]);
});

test("a review is written through the route, shows in the store at once, and a refusal leaves it as it was", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const reply: { next: () => Response | Promise<Response> } = { next: () => Response.json({}) };
  const rows = [gen("r1", { createdAt: 3 }), gen("r2", { createdAt: 2, reviewState: "picked", pickedBy: "Studio lead" })];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith("/api/workbench/library"))
      return Response.json(new URL(String(url), "http://x").searchParams.get("source") === "uploads" ? { uploads: [], nextCursor: null } : { generations: rows, nextPageCursor: null });
    return reply.next();
  }) as typeof fetch;
  try {
    await loadProjectLibrary("scope-a", "proj-review");
    const reads = () => calls.filter((c) => c.url.startsWith("/api/workbench/library")).length;
    const before = reads();
    const state = () => projectLibraryState("scope-a", "proj-review").generations;

    reply.next = () => Response.json({ ok: true, review: { reviewState: "approved", reviewBy: "Studio lead", approvedBy: "Studio lead", approvedAt: 5, updatedAt: 6 } });
    const review = await reviewProjectTake("scope-a", "proj-review", "r1", "approved");
    expect(review).toMatchObject({ reviewState: "approved", approvedBy: "Studio lead" });
    const sent = calls.at(-1)!;
    expect(sent.url).toBe("/api/jobs/r1");
    expect(sent.init?.method).toBe("PATCH");
    expect(new Headers(sent.init?.headers).get("X-Workbench-Scope")).toBe("scope-a");
    expect(JSON.parse(String(sent.init?.body))).toEqual({ reviewState: "approved" });
    expect(state().find((g) => g.id === "r1")).toMatchObject({ reviewState: "approved", approvedBy: "Studio lead", updatedAt: 6 });
    expect(state().find((g) => g.id === "r2")).toMatchObject({ reviewState: "picked" });
    /* Written in place: no re-read of the library. */
    expect(reads()).toBe(before);

    /* A refusal throws the route's own words and changes nothing. */
    reply.next = () => Response.json({ error: "Only a finished take can be picked, approved or sent back." }, { status: 409 });
    await expect(reviewProjectTake("scope-a", "proj-review", "r2", "")).rejects.toThrow("Only a finished take can be picked, approved or sent back.");
    expect(state().find((g) => g.id === "r2")).toMatchObject({ reviewState: "picked" });
    /* A take that is gone is read out of the library. */
    reply.next = () => Response.json({ error: "This take is no longer in the project." }, { status: 404 });
    await expect(reviewProjectTake("scope-a", "proj-review", "r2", "approved")).rejects.toThrow("This take is no longer in the project.");
    await expect.poll(reads).toBe(before + 2);
    /* A dropped connection says so. */
    reply.next = () => { throw new TypeError("Failed to fetch"); };
    await expect(reviewProjectTake("scope-a", "proj-review", "r1", "")).rejects.toThrow("The review was not saved: the connection dropped.");

    /* A full read already out when a review lands began before it: it is read once more after it. */
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow = globalThis.fetch;
    let held = true;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (held && String(url).startsWith("/api/workbench/library")) await gate;
      return slow(url, init);
    }) as typeof fetch;
    const reading = loadProjectLibrary("scope-a", "proj-review");
    const count = reads();
    applyReview("scope-a", "proj-review", "r1", { reviewState: "changes" });
    expect(state().find((g) => g.id === "r1")).toMatchObject({ reviewState: "changes" });
    held = false;
    release();
    await reading;
    await expect.poll(reads).toBeGreaterThanOrEqual(count + 4);
  } finally {
    globalThis.fetch = original;
  }
});
