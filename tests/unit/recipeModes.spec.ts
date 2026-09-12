import { test, expect } from "@playwright/test";
import { effectiveMode, runTotal, asksCount, firstCheckpointCredits, planningCredits, MODE_WORD, PLATFORM_FLOOR_CREDITS } from "../../lib/runState";
import { PLATFORM_RECIPES, priceStages, unitCreditsFor, whoLine } from "../../lib/runs";
import { MODELS } from "../../lib/models";

/**
 * SOW surfaces 12d: what Atomik does at a stage, the platform floor that
 * overrides it, and the arithmetic on the whole-run card — the total, how
 * many checkpoints, and what `Run to first checkpoint` spends.
 */
const st = (name: string, credits: number, mode?: string, kind = "render") => ({ name, credits, mode, kind });

test("a stage's mode is its own until the floor says it asks", () => {
  expect(effectiveMode(st("Sketch boards", 25, "alone"))).toBe("alone");
  expect(effectiveMode(st("Draft takes", 60, "under_cap"))).toBe("under_cap");
  expect(effectiveMode(st("Keyframes", 20))).toBe("asks");                       // absent = asks
  expect(effectiveMode(st("Keyframes", 20, "nonsense"))).toBe("asks");
  expect(effectiveMode(st("Hero takes", PLATFORM_FLOOR_CREDITS + 1, "alone")), "over 200 cr always asks").toBe("asks");
  expect(effectiveMode(st("Train the face", 12, "alone")), "training always asks").toBe("asks");
  expect(effectiveMode(st("Publish to YouTube", 0, "alone"))).toBe("asks");
  expect(effectiveMode(st("Delete the drafts", 0, "alone"))).toBe("asks");
  expect(effectiveMode({ name: "Hero takes", credits: 28.6, floorCredits: 429, mode: "alone" }), "a dollar workspace's $28.60 is 429 cr: the floor reads credits").toBe("asks");
  expect(effectiveMode({ name: "Draft takes", credits: 12.5, floorCredits: 188, mode: "alone" })).toBe("alone");
  expect(MODE_WORD).toEqual({ asks: "Asks first", alone: "Runs alone", under_cap: "Runs under the cap" });
});

test("the whole-run card's arithmetic: total, checkpoints, the first checkpoint's spend, planning apart", () => {
  const stages = [st("Plan the shots", 3, "alone", "write"), st("Sketch boards", 25, "alone"), st("Keyframes", 20, "asks"), st("Draft takes", 60, "asks"), st("Hero takes", 95, "asks"), st("Sound and cut", 23, "asks")];
  expect(runTotal(stages)).toBe(226);
  expect(asksCount(stages)).toBe(4);
  expect(firstCheckpointCredits(stages), "every stage before the first that asks").toBe(28);
  expect(planningCredits(stages)).toBe(3);
  expect(firstCheckpointCredits(stages.map((s) => ({ ...s, mode: "alone" }))), "no checkpoint: the whole run").toBe(226);
  expect(firstCheckpointCredits([st("Keyframes", 20, "asks")]), "asks at once: nothing before it").toBe(0);
});

test("the platform's recipes name only registry engines and price from the rate table, never by hand", () => {
  expect(PLATFORM_RECIPES.map((r) => r.name)).toEqual(["30-second spot", "Product turntable"]);
  for (const r of PLATFORM_RECIPES) {
    expect(r.blurb.length).toBeGreaterThan(0);
    for (const s of r.stages) {
      expect(s.engine, `${r.name} · ${s.name} names its engine`).toBeTruthy();
      if (s.kind === "render") expect(MODELS.some((m) => m.id === s.engine), `${s.engine} is in the registry`).toBe(true);
      expect(s.credits, "no typed price").toBeUndefined();
      expect(s.unit).toBeTruthy();
    }
    const priced = priceStages(r.stages, 10);
    for (const s of priced) { expect(s.credits ?? 0, `${s.name} priced`).toBeGreaterThan(0); expect(s.units ?? 0).toBeGreaterThan(0); }
    const perShot = r.stages.filter((s) => s.perShot);
    for (const s of perShot) expect(priceStages([s], 3)[0].units, "a count that follows the shot list follows it").toBe(s.perShot! * 3);
  }
  expect(unitCreditsFor("gemini-3.1-flash-image", "render", "panel"), "a Nano Banana 2 panel is one credit (its smallest size)").toBe(1);
  expect(unitCreditsFor("gemini-3.1-flash-image", "render", "view"), "a view is a 1K still").toBeGreaterThan(1);
  expect(unitCreditsFor("nope", "render")).toBeNull();
  expect(whoLine("dreamina-seedance-2-5-260628")).toBe("Seedance 2.5 · ByteDance");
  expect(whoLine("fal-ai/kling-video/v3/standard")).toBe("Kling 3.0 · fal");
  expect(whoLine("gemini-3-pro-image")).toBe("Nano Banana Pro · Google");
  expect(whoLine("elevenlabs")).toBe("ElevenLabs · ElevenLabs");
  expect(whoLine("anthropic/claude-opus-5")).toBe("Claude Opus 5 · Vercel");
  expect(whoLine("")).toBe("—");
});
