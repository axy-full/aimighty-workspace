import { test, expect } from "@playwright/test";
import {
  CREW_PRESETS, DEFAULT_SEATED, PHASE_INSTRUCTION, TEMPERATURE, callCostUsd, callsInRound, chairOf, memberNamed, parseChallenge, parseSolutions,
  roleCard, roundBlock, roundCeilingUsd, userMessage, ROUNDS_MAX,
} from "../../lib/crew/room";
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
