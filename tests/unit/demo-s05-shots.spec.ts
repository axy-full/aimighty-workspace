import { test, expect } from "@playwright/test";
import type { RigAgentRunView } from "../../lib/workbench/rig-agent-plan";
import type { TakeVerification } from "../../lib/workbench/verify";
import {
  ESTIMATE_CAP, estimateWords, renderEstimate, renderKey, reviewStateOf, shotHistory, shotListRows, shotTakes, shotsHeader, shotsTakeOver,
  shownVersion, typicalRenderMs, verifyNote, withAnchors, engineLine, rejectReasonProblem, cleanRejectReason, REJECT_REASON_HINT,
} from "../../components/graphite/board/cards/take/take-model";
import { REVIEW_GROUP, SHOTS_GROUP, deriveShots } from "../../components/graphite/board/cards/take/shots-derive";
import { KLING, charged, entries, gen, project, unbilled } from "./demo-s05-fixtures";

/* Stream 5 · the board's Shots region (design/particl-graphite/README.md § 3.1 f and g), on today's data. */

const run = (over: Partial<RigAgentRunView> = {}): RigAgentRunView => ({
  id: "run1", state: "running", reason: null, goal: "", mine: true, proposal: null, steps: [], built: { cards: 0, wires: 0 }, held: [], undo: null,
  canUndo: false, credits: 50, money: null, paid: [], at: 0, ...over,
});
const render = (state: RigAgentRunView["paid"][number]["state"]) => ({ seq: 1, tool: "render" as const, title: "Shot", state, quote: 43, worst: 43, pause: null, charged: null, outcome: null, charge: null, reason: null, canRender: false, fingerprint: null });

test("shots come in draft order, named from the storyboard, with their time line", () => {
  const rows = shotTakes(project(), []);
  expect(rows.map((r) => r.nodeId)).toEqual(["n1", "n2", "n3"]);
  expect(rows.map((r) => r.title)).toEqual(["Shot 1 · Extreme wide", "Shot 2 · Medium", "Shot 3 · Close-up"]);
  expect(rows.map((r) => r.line)).toEqual(["1 · 0:00 · 4 s · Locked off", "2 · 0:04 · 6 s · Slow push", "3 · 0:10 · 5 s · Held"]);
  expect(rows[1].name).toBe("Medium, slow push");
  /* A shot card with no storyboard shot keeps its own title; a later time is not guessed past a shot without a length. */
  const p = project();
  p.nodes = [{ ...p.nodes[0], boardShotId: undefined, title: "Opening" }, ...p.nodes.slice(1)];
  const loose = shotTakes(p, []);
  expect(loose[0].title).toBe("Shot 1 · Opening");
  expect(loose[1].line).toBe("2 · 6 s · Slow push");
});

test("a shot's versions are its filed takes by version, and the board shows the right one", () => {
  const v1 = gen({ shotId: "s2", version: 1, reviewState: "changes" });
  const v2 = gen({ shotId: "s2", version: 2 });
  const other = gen({ shotId: null, version: 1 });
  const rows = shotTakes(project(), entries([v2, other, v1]));
  expect(rows[1].versions.map((v) => v.label)).toEqual(["v1", "v2"]);
  expect(rows[1].shown?.genId).toBe(v2.id);
  expect(rows[0].versions).toEqual([]);
  /* The newest in flight is the news; else the newest waiting; else the approved one; else the newest. */
  const [a, b] = shotTakes(project(), entries([gen({ shotId: "s1", version: 1, reviewState: "approved" }), gen({ shotId: "s1", version: 2, status: "running", storedUrl: null })]))[0].versions;
  expect(shownVersion([a, b])?.genId).toBe(b.genId);
  const approvedFirst = shotTakes(project(), entries([gen({ shotId: "s1", version: 1, reviewState: "approved" }), gen({ shotId: "s1", version: 2, reviewState: "changes" })]))[0];
  expect(approvedFirst.shown?.label).toBe("v1");
  const waiting = shotTakes(project(), entries([gen({ shotId: "s1", version: 1, reviewState: "approved" }), gen({ shotId: "s1", version: 2 })]))[0];
  expect(waiting.shown?.label).toBe("v2");
});

test("review marks map back to the trail's states for Undo", () => {
  expect([reviewStateOf("approved"), reviewStateOf("picked"), reviewStateOf("changes"), reviewStateOf("review"), reviewStateOf("failed")]).toEqual(["approved", "picked", "changes", "", ""]);
});

test("the engine line comes from the request; Topaz's upscale is never called Astra", () => {
  expect(engineLine(gen())).toBe("Seedance 2.5 · 1080p · 5 s");
  expect(engineLine(gen({ model: KLING, params: { duration: 5 }, durationS: null }))).toBe("Kling 3.0 · 5 s");
  expect(engineLine(gen({ model: "topaz/upscale/video/creative", params: { resolution: "4k" } }))).toBe("Topaz upscale · 4k · 5 s");
  expect(engineLine(gen({ kind: "image", model: "gemini-3-pro-image", params: { resolution: "1K" } }))).toBe("Nano Banana Pro · 1K");
});

test("an estimate needs three past renders of the same engine and settings, and never reads done early", () => {
  const done = (ms: number, over = {}) => gen({ durationMs: ms, ...over });
  const lib = entries([done(100_000), done(120_000), done(140_000), done(999_000, { model: KLING }), done(50_000, { params: { duration: 10, resolution: "1080p" } })]);
  const key = renderKey(gen());
  expect(typicalRenderMs(key, lib)).toBe(120_000);
  expect(typicalRenderMs(key, entries([done(100_000), done(120_000)]))).toBeNull();
  expect(renderEstimate(0, null, 10_000)).toBeNull();
  const early = renderEstimate(0, 120_000, 30_000)!;
  expect(early.fraction).toBeCloseTo(0.25);
  expect(estimateWords(early)).toBe("about 2 min left");
  expect(renderEstimate(0, 120_000, 119_000)!.fraction).toBeLessThanOrEqual(ESTIMATE_CAP);
  expect(estimateWords(renderEstimate(0, 120_000, 119_000)!)).toBe("about 1 min left");
  /* Past the usual time there is nothing honest to say: the bar goes back to indeterminate. */
  expect(renderEstimate(0, 120_000, 120_000)).toBeNull();
  expect(renderEstimate(0, 120_000, 500_000)).toBeNull();
  /* Only a take on the engine gets one: a queued take does not. */
  const lib2 = entries([done(100_000), done(120_000), done(140_000), gen({ shotId: "s1", version: 1, status: "running", storedUrl: null, durationMs: null, createdAt: 2_000_000 })]);
  expect(shotTakes(project(), lib2)[0].typicalMs).toBe(120_000);
  const queued = entries([done(100_000), done(120_000), done(140_000), gen({ shotId: "s1", version: 1, status: "queued", storedUrl: null, durationMs: null })]);
  expect(shotTakes(project(), queued)[0].typicalMs).toBeNull();
});

test("shot 1 is the look anchor only when another shot's take was made with it as a reference", () => {
  const first = gen({ shotId: "s1", version: 1 });
  const plain = shotTakes(project(), entries([first, gen({ shotId: "s2", version: 1 })]));
  expect(plain.map((r) => r.anchor)).toEqual([null, null, null]);
  const followed = shotTakes(project(), entries([first, gen({ shotId: "s2", version: 1, params: { duration: 5, references: [{ genId: first.id, role: "reference_image" }] } })]));
  expect(followed.map((r) => r.anchor)).toEqual(["anchor", "follows", null]);
  expect(withAnchors([])).toEqual([]);
});

test("the Shots group says what is happening, from the takes and the Board run", () => {
  const rows = shotTakes(project(), entries([gen({ shotId: "s1", version: 1, reviewState: "approved" }), gen({ shotId: "s2", version: 1, status: "running", storedUrl: null })]));
  const live = shotsHeader(rows, run({ paid: [render("rendering")] }));
  expect(live.title).toBe("Shots · rendering 2 of 3");
  expect(live.live).toBe(true);
  expect(live.stopRunId).toBe("run1");
  expect(live.summary).toBe("Rendering 2 of 3");
  /* No run working on them: no Stop (a take on its own cannot be stopped mid-render). */
  expect(shotsHeader(rows, null).stopRunId).toBeNull();
  expect(shotsHeader(rows, run({ state: "done", paid: [render("done")] })).stopRunId).toBeNull();
  const approved = shotTakes(project(), entries([gen({ shotId: "s1", version: 1, reviewState: "approved" }), gen({ shotId: "s2", version: 1 })]));
  expect(shotsHeader(approved, null)).toMatchObject({ title: "Shots · 1 of 3 approved", live: false, summary: "3 shots · 1 needs review" });
  expect(shotsHeader(approved, run({ state: "stopped", credits: 43 }))).toMatchObject({ title: "Shots · stopped", spent: 43, stopRunId: null });
});

test("money words: Nothing billed only when confirmed, else what the ledger says; Retry only for a recipe Make can take", () => {
  const [free] = shotTakes(project(), entries([gen({ shotId: "s1", version: 1, status: "failed", storedUrl: null, failure: unbilled(), creditsBilled: 0 })]));
  expect(free.shown).toMatchObject({ status: "failed", nothingBilled: true, retry: true });
  const [paid] = shotTakes(project(), entries([gen({ shotId: "s1", version: 1, status: "failed", storedUrl: null, failure: charged(43) })]));
  expect(paid.shown?.nothingBilled).toBe(false);
  expect(paid.shown?.charge).toBe("43 cr charged");
  const [unknown] = shotTakes(project(), entries([gen({ shotId: "s1", version: 1, status: "failed", storedUrl: null, failure: null, creditsBilled: null })]));
  expect(unknown.shown?.nothingBilled).toBe(false);
  expect(unknown.shown?.charge).toBeNull();
  const [edit] = shotTakes(project(), entries([gen({ shotId: "s1", version: 1, status: "failed", storedUrl: null, failure: unbilled(), task: "edit", params: { sourceGenId: "g0" } })]));
  expect(edit.shown?.retry).toBe(false);
  const [held] = shotTakes(project(), entries([gen({ shotId: "s1", version: 1, status: "held", storedUrl: null, params: { held: { needs: 12 } } })]));
  expect(held.shown).toMatchObject({ status: "held", needs: 12 });
});

test("the region appears once a shot has a take or a Board render is on its way, and holds frame g for the earliest waiting shot", () => {
  const src = (generations: Parameters<typeof entries>[0], agent: RigAgentRunView | null = null) => ({ kind: "studio" as const, project: project(), library: entries(generations), agent });
  /* Every shot card is drawn by this set (stream 3's node table); with no takes yet each shows its frame. */
  expect(deriveShots(src([])).map((c) => c.id)).toEqual([SHOTS_GROUP, "n1", "n2", "n3"]);
  expect(deriveShots({ ...src([]), project: { ...project(), nodes: [] } })).toEqual([]);
  expect(deriveShots({ ...src([gen({ shotId: "s1" })]), kind: "ads" })).toEqual([]);
  expect(shotsTakeOver(shotTakes(project(), []), run({ paid: [render("sending")] }))).toBe(true);
  expect(shotsTakeOver(shotTakes(project(), []), run({ paid: [render("waiting")] }))).toBe(false);

  const cards = deriveShots(src([gen({ shotId: "s1", version: 1, reviewState: "approved" }), gen({ shotId: "s2", version: 1, reviewState: "changes" }), gen({ shotId: "s2", version: 2 }), gen({ shotId: "s3", version: 1 })]));
  expect(cards.map((c) => [c.id, c.kind, c.group ?? null, c.state])).toEqual([
    [SHOTS_GROUP, "group", null, "empty"],
    ["n1", "take", SHOTS_GROUP, "done"],
    ["n2", "take", SHOTS_GROUP, "needs"],
    ["n3", "take", SHOTS_GROUP, "needs"],
    [REVIEW_GROUP, "group", null, "empty"],
    ["take-review:n2", "take-review", REVIEW_GROUP, "empty"],
    ["versions:n2", "versions", REVIEW_GROUP, "empty"],
  ]);
  /* The take cards draw their shot nodes; the derived cards draw none, so no node is drawn twice. */
  expect(cards.filter((c) => c.nodeId).map((c) => c.nodeId)).toEqual(["n1", "n2", "n3"]);
  expect(cards.find((c) => c.id === REVIEW_GROUP)?.data).toEqual({ title: "Shot 2 · review", meta: "v2 · needs you", columns: 2, gap: 24 });
  expect(cards.every((c) => c.region === "shots")).toBe(true);
  expect(JSON.parse(JSON.stringify(cards.map((c) => c.id)))).toEqual(cards.map((c) => c.id));
});

test("the List view's State column says what each shot's take is, by card and by storyboard shot", () => {
  const states = shotListRows(project(), entries([gen({ shotId: "s1", reviewState: "approved" }), gen({ shotId: "s2", status: "running", storedUrl: null }), gen({ shotId: "s3", status: "failed", storedUrl: null, failure: unbilled() })]));
  expect(states.get("n1")).toEqual({ word: "Approved", tone: "done" });
  expect(states.get("b1")).toEqual({ word: "Approved", tone: "done" });
  expect(states.get("b2")).toEqual({ word: "Rendering", tone: "live" });
  expect(states.get("n3")).toEqual({ word: "Failed", tone: "failed" });
});

test("Atomik's note is its newest check, in the judge's words; the history is newest first", () => {
  const check = (over: Partial<TakeVerification>): TakeVerification => ({
    id: "c", takeId: "generation:t1", verifyNodeId: "v", masterSet: "", rubric: 1, framesKey: "", masters: [], frames: [], checks: [], verdict: "pass",
    judgeModel: "", credits: 0, ownKey: false, createdAt: 10, ...over,
  } as TakeVerification);
  expect(verifyNote([check({})], "generation:t1")).toEqual({ text: "Verified", at: 10 });
  const failed = check({ verdict: "fail", createdAt: 20, checks: [{ check: "props", verdict: "fail", score: 0.1, reasons: ["feet slide", "reflection wrong."], frame: null }] });
  expect(verifyNote([check({}), failed], "generation:t1")?.text).toBe("Feet slide; reflection wrong.");
  expect(verifyNote([failed], "generation:other")).toBeNull();

  const t1 = gen({ id: "t1", shotId: "s1", version: 1, createdAt: 1_000, reviewState: "changes", reviewBy: "Person Two", updatedAt: 5_000 });
  const t2 = gen({ id: "t2", shotId: "s1", version: 2, createdAt: 6_000, task: "edit", prompt: "keep the feet planted", reviewState: "approved", approvedBy: "Person One", approvedAt: 7_000 });
  const [row] = shotTakes(project(), entries([t1, t2]));
  const rows = shotHistory(row.versions, { verifications: [{ ...failed, createdAt: 2_000 }], notes: new Map([["t1", [{ author: "Person Two", text: "Too fast", at: 4_000 }]]]) });
  expect(rows.map((r) => r.text)).toEqual([
    "v2 approved · Person One",
    "v2 · “keep the feet planted”",
    "v1 rejected · Person Two",
    "v1 · Person Two: Too fast",
    "v1 · Atomik: Feet slide; reflection wrong",
    "v1 · Seedance 2.5 · 1080p · 5 s",
  ]);
});

test("a reject needs a reason: one line of 3 to 500 characters", () => {
  expect(rejectReasonProblem("")).toBe(REJECT_REASON_HINT);
  expect(rejectReasonProblem("  ok ")).toBe(REJECT_REASON_HINT);
  expect(rejectReasonProblem("Too flat")).toBeNull();
  expect(rejectReasonProblem("x".repeat(500))).toBeNull();
  expect(rejectReasonProblem("x".repeat(501))).toBe(REJECT_REASON_HINT);
  expect(cleanRejectReason("  too\n flat  ")).toBe("too flat");
});
