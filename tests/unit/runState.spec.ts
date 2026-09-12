import { test, expect } from "@playwright/test";
import {
  STATE_WORD, spentPct, remainingLine, holdingLine, stoppedStage,
  primaryFor, progressLine, progressPct, costLabel, cleanFailure, fixById,
  stoppedStages, chosenFix,
  type StageView, type RunView,
} from "../../lib/runState";

/* The run view (brief 3, surface 1a). The state vocabulary is short on
   purpose and a failure never restarts a run. */

const cr = (n: number) => `${n} cr`;

const stage = (over: Partial<StageView> = {}): StageView => ({
  id: "st1", num: 1, name: "Motion", sub: "12 shots · Seedance 2.5",
  state: "queued", credits: 87, spent: 0, doneUnits: 0, totalUnits: 12,
  hasOutput: false, failure: null, fixedWith: null, ...over,
});

const run = (stages: StageView[], over: Partial<RunView> = {}): RunView => ({
  id: "run1", num: 4, recipeId: "rec_1", projectId: "p1", projectName: "A production",
  state: "running", needsYou: stages.some((s) => s.state === "needs_you"), startedAt: 0, stages,
  spent: stages.reduce((n, s) => n + s.spent, 0),
  estimate: stages.reduce((n, s) => n + Math.max(s.credits, s.spent), 0),
  done: stages.filter((s) => s.state === "done").length,
  total: stages.length, ...over,
});

test("the state vocabulary is the design's, not English's", () => {
  expect(STATE_WORD.needs_you).toBe("Needs you");
  expect(STATE_WORD.queued).toBe("Queued");
  expect(STATE_WORD.running).toBe("Running");
  expect(STATE_WORD.done).toBe("Done");
});

test("the spent bar never runs off its track", () => {
  expect(spentPct(74, 118)).toBe(63);
  expect(spentPct(0, 118)).toBe(0);
  // A run that overran still reads as full rather than overflowing.
  expect(spentPct(200, 118)).toBe(100);
  // Nothing estimated is not a divide by zero.
  expect(spentPct(10, 0)).toBe(0);
});

/* When something is waiting on a person that is the only thing worth
   saying, because it is the only thing anybody can act on. */
test("the line beside the stage count says the one thing that can be acted on", () => {
  const stopped = stage({ state: "needs_you" });
  const running = stage({ state: "running" });
  const queued = stage({ state: "queued" });

  expect(remainingLine([stopped, running, queued])).toBe("1 stage needs you");
  expect(remainingLine([running, queued])).toBe("1 stage running");
  expect(remainingLine([queued, queued])).toBe("2 stages queued");
  expect(remainingLine([stage({ state: "done" })])).toBe("nothing left to run");
});

test("a stopped run says the rest is holding, and a finished one says nothing", () => {
  expect(holdingLine([stage({ state: "needs_you" }), stage({ state: "queued" })]))
    .toBe("One stage needs you. The rest of the run is holding, not lost.");
  expect(holdingLine([stage({ state: "needs_you" }), stage({ state: "needs_you" })]))
    .toContain("2 stages need you");
  expect(holdingLine([stage({ state: "done" })])).toBe("");
});

/* The first rule: a price is quoted before the button enables. "Whatever you
   would have picked" is not a price, so nothing is pressable until a way out
   is chosen. */
test("the bottom bar will not offer to fix until a way out has been picked", () => {
  const failure = {
    unit: "SH07",
    reason: "The upscaler refused SH07.",
    fixes: [
      { id: "resize", label: "Set Post height to 1088", note: "No re-render.", kind: "settings" as const, credits: 0 },
      { id: "rerender", label: "Re-render SH07 at 1080", note: "One shot.", kind: "rerender" as const, credits: 29 },
    ],
  };
  const stopped = run([stage({ state: "needs_you", failure }), stage({ state: "done", spent: 2, credits: 2 })]);

  expect(primaryFor(stopped, null)).toEqual({ label: "Fix and continue", credits: 0, enabled: false });
  expect(primaryFor(stopped, failure.fixes[1])).toEqual({ label: "Fix and continue", credits: 29, enabled: true });
  // A free way out is still a chosen one, and still enables the button.
  expect(primaryFor(stopped, failure.fixes[0])).toEqual({ label: "Fix and continue", credits: 0, enabled: true });

  /* With nothing stopped there is nothing here to press. The reference puts
     "Approve run · 118 cr" on this button; approving belongs with the runner,
     and an enabled priced button that does nothing is a worse lie than a
     disabled one that says what is happening. */
  const clean = run([stage({ state: "done", spent: 2, credits: 2 }), stage({ state: "queued", credits: 87 })]);
  expect(primaryFor(clean, null)).toEqual({ label: "Running", credits: 89, enabled: false });
  expect(primaryFor(run([stage({ state: "queued", credits: 9 })], { state: "paused" }), null))
    .toEqual({ label: "Run paused", credits: 9, enabled: false });
  expect(primaryFor(run([stage({ state: "done", spent: 5, credits: 5 })], { state: "done" }), null))
    .toEqual({ label: "Run finished", credits: 5, enabled: false });
});

/* Two stages can stop at once — holdingLine says so in words — and the
   design's fix ids are generic (`rerender`, `skip`), so they collide across
   stages by construction. A choice is a stage and a fix, never a fix alone. */
test("a choice names its stage, so a tap on one card cannot spend on another", () => {
  const post = stage({ id: "post", name: "Post", state: "needs_you", failure: {
    unit: "SH07", reason: "The upscaler refused SH07.",
    fixes: [{ id: "rerender", label: "Re-render SH07", note: "", kind: "rerender" as const, credits: 29 }],
  } });
  const audio = stage({ id: "audio", name: "Audio", state: "needs_you", failure: {
    unit: "SH03", reason: "The voice was refused.",
    fixes: [{ id: "rerender", label: "Re-render the bed", note: "", kind: "rerender" as const, credits: 9 }],
  } });
  const both = [post, audio];

  expect(stoppedStages(both).map((s) => s.id)).toEqual(["post", "audio"]);
  // The same fix id on the later card resolves to THAT card's price.
  expect(chosenFix(both, { stageId: "audio", fixId: "rerender" })?.fix.credits).toBe(9);
  expect(chosenFix(both, { stageId: "post", fixId: "rerender" })?.fix.credits).toBe(29);
  // A choice left behind when a stage stops needing anybody resolves to nothing.
  expect(chosenFix([{ ...post, state: "queued", failure: null }, audio], { stageId: "post", fixId: "rerender" })).toBeNull();
  expect(chosenFix(both, { stageId: "gone", fixId: "rerender" })).toBeNull();
  expect(chosenFix(both, null)).toBeNull();
});

test("the stopped stage is the one the screen opens", () => {
  const a = stage({ id: "a", state: "done" });
  const b = stage({ id: "b", state: "needs_you" });
  expect(stoppedStage([a, b])?.id).toBe("b");
  expect(stoppedStage([a])).toBeNull();
});

test("progress counts units, and a stage with no units shows none", () => {
  expect(progressLine(stage({ doneUnits: 3, totalUnits: 12 }))).toBe("3 of 12 · 25%");
  expect(progressPct(stage({ doneUnits: 3, totalUnits: 12 }))).toBe(25);
  expect(progressLine(stage({ totalUnits: 0 }))).toBe("");
  expect(progressPct(stage({ totalUnits: 0 }))).toBe(0);
});

/* A fraction is what a running stage has; a finished one has a figure and a
   queued one has an estimate. Showing a fraction for either would invent a
   precision neither has. */
test("only a running stage reads as a fraction", () => {
  expect(costLabel(stage({ state: "running", spent: 54, credits: 87 }), cr)).toBe("54 / 87 cr");
  expect(costLabel(stage({ state: "queued", credits: 87 }), cr)).toBe("87 cr");
  expect(costLabel(stage({ state: "done", spent: 84, credits: 87 }), cr)).toBe("84 cr");
  expect(costLabel(stage({ state: "skipped", spent: 0, credits: 6 }), cr)).toBe("0 cr");
  // A running stage that has not spent anything yet has no fraction to show.
  expect(costLabel(stage({ state: "running", spent: 0, credits: 87 }), cr)).toBe("87 cr");
});

/* A stage that says it needs a person and then offers nothing to do about it
   is worse than one that simply says it stopped. */
test("a failure with no way out is not a failure", () => {
  expect(cleanFailure(null)).toBeNull();
  expect(cleanFailure({ reason: "" })).toBeNull();
  expect(cleanFailure({ reason: "It stopped." })).toBeNull();
  expect(cleanFailure({ reason: "It stopped.", fixes: [] })).toBeNull();
  expect(cleanFailure({ reason: "It stopped.", fixes: [{ label: "no id" }] })).toBeNull();

  const ok = cleanFailure({
    unit: "SH07", reason: "The upscaler refused SH07.",
    fixes: [
      { id: "a", label: "Set the height", note: "No re-render.", kind: "settings", credits: 0 },
      { id: "a", label: "A duplicate id", kind: "skip", credits: 0 },
      { id: "b", label: "Re-render it", kind: "rerender", credits: 29.4 },
    ],
  });
  expect(ok?.unit).toBe("SH07");
  expect(ok?.fixes.map((f) => f.id)).toEqual(["a", "b"]);
  // Credits are whole and never negative, whatever was written down.
  expect(ok?.fixes[1].credits).toBe(29);
  expect(cleanFailure({ reason: "x", fixes: [{ id: "a", label: "b", credits: -5 }] })?.fixes[0].credits).toBe(0);
  // An unknown kind is the harmless one, not a re-render.
  expect(cleanFailure({ reason: "x", fixes: [{ id: "a", label: "b", kind: "nonsense" }] })?.fixes[0].kind).toBe("settings");
});

test("a fix is looked up by id, and nothing is chosen by default", () => {
  const f = cleanFailure({ reason: "x", fixes: [{ id: "a", label: "A", credits: 0 }] });
  expect(fixById(f, "a")?.label).toBe("A");
  expect(fixById(f, "b")).toBeNull();
  expect(fixById(f, null)).toBeNull();
  expect(fixById(null, "a")).toBeNull();
});
