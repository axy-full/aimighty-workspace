import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { EMPTY_DRAFT, GOAL_MAX, goalFor, waitedAt, waitingLine, withAspect, withLength } from "../../components/graphite/home/home-model";
import { THINKING_READ_FAILED, thinkingFrom } from "../../components/graphite/home/use-thinking-price";

/** Start · up to N cr (the master's Home): what Atomik is asked, and the figure on the button. */
test("Start asks with the brief and the chips' aspect and length, cut to Atomik's limit at a word", () => {
  expect(goalFor(EMPTY_DRAFT)).toBeNull();
  expect(goalFor({ ...EMPTY_DRAFT, text: " ok " })).toBeNull();
  expect(goalFor({ ...EMPTY_DRAFT, text: "A kettle\n on a stove." })).toBe("A kettle on a stove. · 16:9 · 15 s");
  expect(goalFor(withLength(withAspect({ ...EMPTY_DRAFT, text: "Steam rises" }, "9:16"), "6 s"))).toBe("Steam rises · 9:16 · 6 s");
  const long = goalFor({ ...EMPTY_DRAFT, text: "word ".repeat(1000) })!;
  expect(long.length).toBeLessThanOrEqual(GOAL_MAX);
  expect(long.endsWith("word · 16:9 · 15 s")).toBe(true);
});

test("the thinking figure is the server's: a number to show, off, unpriced, or a read that failed", () => {
  expect(thinkingFrom({ agent: { enabled: true, run: null, ask: { limit: 200, jobCeiling: 200, planning: 14 } } })).toEqual({ state: "ready", credits: 14 });
  expect(thinkingFrom({ agent: { enabled: false, run: null, ask: null } })).toEqual({ state: "off" });
  expect(thinkingFrom({ agent: { enabled: true, run: null, ask: { limit: 200, jobCeiling: 200, planning: null } } })).toEqual({ state: "unpriced" });
  expect(thinkingFrom({ agent: { enabled: true, run: null, ask: null } })).toEqual({ state: "unpriced" });
  expect(thinkingFrom({ agent: { enabled: true, ask: { planning: 0 } } })).toEqual({ state: "unpriced" });
  expect(thinkingFrom(null)).toEqual({ state: "error", message: THINKING_READ_FAILED });
});

test("a waiting row says where and when: the project, the place, a plan's step, the clock today or the day", () => {
  const now = new Date(2026, 9, 5, 12, 0).getTime();
  expect(waitedAt(new Date(2026, 9, 5, 9, 40).getTime(), now)).toBe("09:40");
  expect(waitedAt(new Date(2026, 9, 4, 18, 5).getTime(), now)).toBe("4 Oct");
  const item = { project: { productionId: "p", draftId: "d", name: "Harbour test" }, where: "Board", step: null, at: new Date(2026, 9, 5, 9, 40).getTime() };
  expect(waitingLine(item, now)).toBe("Harbour test · Board · 09:40");
  expect(waitingLine({ ...item, where: "Atomik", step: { n: 1, of: 3 } }, now)).toBe("Harbour test · Atomik · step 1 of 3 · 09:40");
  expect(waitingLine({ ...item, project: { productionId: null, draftId: null, name: null } }, now)).toBe("No project · Board · 09:40");
});

test("a new board's figure is read only: off when building is off, and asked through nothing else", async () => {
  const before = process.env.RIG_AGENT_ENABLED;
  process.env.RIG_AGENT_ENABLED = "0";
  try {
    const { newBoardAskTerms } = await import("../../lib/workbench/rig-agent");
    expect(await newBoardAskTerms()).toEqual({ enabled: false, run: null, ask: null });
  } finally {
    if (before === undefined) delete process.env.RIG_AGENT_ENABLED; else process.env.RIG_AGENT_ENABLED = before;
  }
  /* The route answers it inside GET, after the people-only check (requireSession refuses API tokens), and never from POST. */
  const route = readFileSync("app/api/workbench/team-canvas/route.ts", "utf8");
  const get = route.slice(route.indexOf("export const GET"), route.indexOf("export const POST") > route.indexOf("export const GET") ? route.indexOf("export const POST") : undefined);
  expect(get.indexOf('get("board") === "new"')).toBeGreaterThan(get.indexOf("await caller(req, false)"));
  expect(get.indexOf("await caller(req, false)")).toBeGreaterThan(0);
  expect(route.slice(route.indexOf("export const POST"))).not.toContain("newBoardAskTerms");
  /* The figure comes from the same pricing a saved project's ask uses; the function reserves and writes nothing. */
  const agent = readFileSync("lib/workbench/rig-agent.ts", "utf8");
  const body = agent.slice(agent.indexOf("export async function newBoardAskTerms"), agent.indexOf("export async function newBoardAskTerms") + 600);
  expect(body).toContain("planningCredits(newProject(\"\")");
  expect(body).not.toMatch(/reserve|meter|INSERT|execute|askRigAgent/);
});
