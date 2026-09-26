import { test, expect } from "@playwright/test";
import {
  CREW_PRESETS, DEFAULT_SEATED, PHASE_INSTRUCTION, TEMPERATURE, callCostUsd, callsInRound, chairOf, memberNamed, parseChallenge, parseSolutions,
  roleCard, roundBlock, roundCeilingUsd, userMessage, ROUNDS_MAX, minutesFile, settleRound } from "../../lib/crew/room";
import { projectContext, readsLabel } from "../../lib/crew/context";
import { mockAnswer } from "../../lib/crew/mock";
import { newProject } from "../../lib/workbench/studio";

test("seven role cards, five seated by default, the Producer in the chair", () => {
  expect(CREW_PRESETS.map((p) => p.name)).toEqual(["Director", "DOP", "Production designer", "Costume stylist", "Editor", "Producer", "Continuity supervisor"]);
  expect([...DEFAULT_SEATED]).toEqual(["director", "dop", "designer", "editor", "producer"]);
  expect(new Set(CREW_PRESETS.map((p) => p.color)).size).toBe(7);
});

test("the role card and the phase instructions are the prototype's, word for word", () => {
  const card = roleCard({ id: "m", name: "DOP", department: "Camera & light", stance: "You think in lenses.", effort: "high" }, "Project: X", "propose");
  expect(card).toBe("You are DOP (Camera & light) in a film crew brainstorm. You think in lenses.\nProject: X\nReasoning effort: high.\nPHASE: PROPOSE. Give ONE concrete proposal answering the goal, ≤60 words, in first person, no preamble.");
  expect(PHASE_INSTRUCTION.challenge).toContain('start with "@Name —"');
  expect(PHASE_INSTRUCTION.converge).toContain("exactly 3 numbered solutions");
  expect(TEMPERATURE).toEqual({ propose: 0.7, challenge: 0.5, converge: 0.2 });
  expect(userMessage(" Find the ending ", [])).toBe("GOAL: Find the ending\n\nTRANSCRIPT SO FAR:\n(empty)");
  expect(userMessage("G", [{ name: "DOP", text: "24mm." }, { name: "Editor", to: "DOP", text: "Cut sooner." }], ["DOP", "Editor"])).toBe("GOAL: G\n\nTRANSCRIPT SO FAR:\nDOP: 24mm.\nEditor → DOP: Cut sooner.\n\nOTHER MEMBERS: DOP, Editor");
});

test("a challenge is addressed by @Name with a dash, a hyphen or a colon", () => {
  expect(parseChallenge("@DOP — let the colour arrive late.")).toEqual({ to: "DOP", text: "let the colour arrive late." });
  expect(parseChallenge("@Production designer - the tin stays.")).toEqual({ to: "Production designer", text: "the tin stays." });
  expect(parseChallenge("@Editor: cut on the drop.")).toEqual({ to: "Editor", text: "cut on the drop." });
  expect(parseChallenge("I agree with everyone.")).toEqual({ to: "", text: "I agree with everyone." });
  const seated = [{ name: "DOP" }, { name: "Production designer" }];
  expect(memberNamed(seated, " production DESIGNER ")).toBe(seated[1]);
  expect(memberNamed(seated, "Gaffer")).toBeNull();
});

test("only the chair's numbered lines become solutions", () => {
  expect(parseSolutions("Here you go:\n1. Locked frame — 24mm static.\n 2. Cut on the drop — at 0:04.\nnot this\n3.One render first — Sc 1A.")).toEqual(["Locked frame — 24mm static.", "Cut on the drop — at 0:04.", "One render first — Sc 1A."]);
  expect(parseSolutions("No list today.")).toEqual([]);
});

test("the chair is whoever holds it, else the last seated; a round is 2n + 1 requests", () => {
  const a = { id: "a", isChair: false }, b = { id: "b", isChair: true }, c = { id: "c", isChair: false };
  expect(chairOf([a, b, c])).toBe(b);
  expect(chairOf([a, c])).toBe(c);
  expect(chairOf([])).toBeNull();
  expect([0, 1, 5].map(callsInRound)).toEqual([0, 3, 11]);
});

test("Run round says why it cannot run, in the design's words", () => {
  const ok = { goal: "Find the ending", seated: 3, running: false, roundsRun: 0, keyConnected: true, hasProject: true };
  expect(roundBlock(ok)).toBeNull();
  expect(roundBlock({ ...ok, goal: "  " })).toBe("Write the goal.");
  expect(roundBlock({ ...ok, seated: 0 })).toBe("Seat at least one member.");
  expect(roundBlock({ ...ok, keyConnected: false })).toBe("Add key in Workspace › Engines.");
  expect(roundBlock({ ...ok, roundsRun: ROUNDS_MAX })).toContain("Start a new session");
  expect(roundBlock({ ...ok, running: true })).toBe("");
});

test("the ceiling covers every request at full length; the settled cost is the tokens reported", () => {
  const rate = { inputUsdPerToken: 2 / 1e6, outputUsdPerToken: 6 / 1e6 };
  const size = { goalChars: 120, contextChars: 1500, transcriptChars: 0, stanceChars: 200 };
  const five = roundCeilingUsd({ seated: 5, ...size }, rate);
  expect(five).toBeGreaterThan(0);
  expect(five).toBeGreaterThan(roundCeilingUsd({ seated: 2, ...size }, rate));
  expect(roundCeilingUsd({ seated: 5, ...size, transcriptChars: 9000 }, rate)).toBeGreaterThan(five);
  expect(roundCeilingUsd({ seated: 0, ...size }, rate)).toBe(0);
  /* A real call is far under its share of the ceiling. */
  expect(callCostUsd({ promptTokens: 900, completionTokens: 90 }, rate)).toBeLessThan(five / 11);
  expect(callCostUsd({ promptTokens: 1000, completionTokens: 100 }, rate)).toBeCloseTo(0.0026, 6);
});

test("the room reads only the sections it was told to, and says when one is empty", () => {
  const project = { ...newProject("Dawn"), brief: "One kitchen.", script: "" };
  const text = projectContext(project, { brief: true, script: true, boards: false, cast: false, rig: false });
  expect(text).toContain("Project: Dawn");
  expect(text).toContain("Brief: One kitchen.");
  expect(text).toContain("Script: (none written yet)");
  expect(text).not.toContain("Boards:");
  expect(text).not.toContain("Cast:");
  expect(readsLabel({ brief: true, script: false, boards: true, cast: false, rig: false })).toBe("Brief · Boards");
});

test("the mock room never addresses someone who is not seated", () => {
  expect(mockAnswer("director", "challenge", ["DOP", "Editor"])).toMatch(/^@DOP — /);
  expect(mockAnswer("director", "challenge", ["Producer"])).toBe("@Producer — agreed, with a smaller frame.");
  expect(parseSolutions(mockAnswer("producer", "converge", []))).toHaveLength(3);
});

test("a round settles at zero when the chair fails or nobody proposed; a converged round bills the tokens reported", () => {
  expect(settleRound({ converged: false, proposals: 0, spentUsd: 0.02 })).toEqual({ billed: false, spendUsd: 0, note: "Nobody in the room could answer — run again (not billed)" });
  expect(settleRound({ converged: false, proposals: 4, spentUsd: 0.02 })).toEqual({ billed: false, spendUsd: 0, note: "Converge failed — run again (not billed)" });
  expect(settleRound({ converged: true, proposals: 4, spentUsd: 0.0308 })).toEqual({ billed: true, spendUsd: 0.0308, note: null });
});

test("the minutes file is byte-identical markdown named by day and session", async () => {
  const file = minutesFile("# Minutes\n\n- one\n", "0f9d2c1a-7b6e-4c3d-9a1b-2c3d4e5f6a7b", new Date("2026-09-22T10:00:00Z"));
  expect(file.name).toBe("crew-minutes-2026-09-22-0f9d2c1a.md");
  expect(file.type).toBe("text/markdown");
  expect(await file.text()).toBe("# Minutes\n\n- one\n");
});

test("a room's rounds go to the model it was priced for, not whatever XAI_MODEL says now", async () => {
  const { askGrok } = await import("../../lib/crew/xai");
  const { quoteRound } = await import("../../lib/crew/round");
  const saved = { mock: process.env.ENGINE_MOCK, key: process.env.XAI_API_KEY, model: process.env.XAI_MODEL, fetch: globalThis.fetch };
  const sent: string[] = [];
  /* No request leaves the test: fetch is answered here, with a fake key. */
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    sent.push(String(JSON.parse(String(init?.body)).model));
    return new Response(JSON.stringify({ choices: [{ message: { content: "24mm." } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }), { status: 200 });
  }) as typeof fetch;
  process.env.ENGINE_MOCK = "0";
  process.env.XAI_API_KEY = "test-key-not-real";
  process.env.XAI_MODEL = "grok-newer";
  try {
    const answer = await askGrok({ system: "s", user: "u", phase: "propose", effort: "high", mock: () => "", model: "grok-4.6" });
    expect(answer.ok).toBe(true);
    await askGrok({ system: "s", user: "u", phase: "propose", effort: "high", mock: () => "" });
    expect(sent).toEqual(["grok-4.6", "grok-newer"]);
    const session = { id: "s", projectId: "p", goal: "Find the ending", context: { brief: false, script: false, boards: false, cast: false, rig: false }, model: "grok-4.6", roundsRun: 0, spendCr: null, spendUsd: 0, createdBy: "u", createdAt: 0 };
    const quote = quoteRound({ session, project: newProject("Dawn"), active: [{ id: "m", name: "DOP", department: "Camera", stance: "Lenses.", effort: "high", color: "#fff", presetId: "dop", active: true, isChair: true, position: 0 }] as never, transcriptChars: 0, rate: { inputUsdPerToken: 2 / 1e6, outputUsdPerToken: 6 / 1e6 } });
    expect(quote.model).toBe("grok-4.6");
  } finally {
    globalThis.fetch = saved.fetch;
    for (const [key, value] of [["ENGINE_MOCK", saved.mock], ["XAI_API_KEY", saved.key], ["XAI_MODEL", saved.model]] as const)
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test("a room whose engine can no longer be priced says so, and names the engine to move it to", async () => {
  const { roomRate } = await import("../../lib/crew/round");
  const saved = process.env.XAI_MODEL;
  process.env.XAI_MODEL = "grok-newer";
  try {
    const rate = { inputUsdPerToken: 1 / 1e6, outputUsdPerToken: 2 / 1e6 };
    // Still priced: the room keeps its own engine and its own rate.
    expect(await roomRate("grok-4.6", async (model) => (model === "grok-4.6" ? rate : null))).toBe(rate);
    // The deployment moved on and the room's engine has no price: the room says where to move, never switches by itself.
    await expect(roomRate("grok-4.6", async () => null)).rejects.toMatchObject({ status: 409, message: "This room runs on grok-4.6, which can no longer be priced. Move it to grok-newer to run." });
    // The current engine itself unpriced is the old refusal.
    await expect(roomRate("grok-newer", async () => null)).rejects.toMatchObject({ status: 503, message: "This engine cannot be priced right now, so the room will not run." });
  } finally {
    if (saved === undefined) delete process.env.XAI_MODEL; else process.env.XAI_MODEL = saved;
  }
});
