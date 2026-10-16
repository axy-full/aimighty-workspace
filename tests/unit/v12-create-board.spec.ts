import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { CREATE_BOARD_TOOL, boardFromInput } from "../../lib/v12/tools/create-board";
import { newProjectRail } from "../../lib/v12/board/new-project";
import { NEW_PROJECT, newProjectFor, EMPTY_DRAFT, nameFromBrief } from "../../components/graphite/home/home-model";
import { seededProject } from "../../lib/shell/create-project";
import { projectSchema } from "../../lib/workbench/studio-schema";
import { TOOLS, runTool } from "../../lib/mcp";

/**
 * `create_board` (lib/v12/tools/create-board.ts; rule 11): the tool behind Home's "+ New project". The button, an outside agent over MCP and
 * Atomik make a board the same way; it is free, and a read-only token is refused.
 */
test("the tool is declared: an id, a route, free, no key, and who may call it", () => {
  expect(CREATE_BOARD_TOOL).toMatchObject({ id: "create_board", kind: "app", route: "/api/boards", price: "free", needs: [], provider: null });
  expect(CREATE_BOARD_TOOL.who).toContain("render-scope token");
  expect(TOOLS.find((t) => t.name === "create_board")?.description).toContain("nothing is billed");
});

test("an agent's board is the button's board: the same project, with the same rail", () => {
  const built = boardFromInput({});
  if (!built.ok) throw new Error(built.error);
  const button = seededProject(newProjectFor(NEW_PROJECT, EMPTY_DRAFT).name, newProjectFor(NEW_PROJECT, EMPTY_DRAFT).seed);
  const { id: _a, createdAt: _b, ...agent } = built.project;
  const { id: _c, createdAt: _d, ...human } = button;
  void _a; void _b; void _c; void _d;
  expect(agent).toEqual(human);
  expect(built.project.boardFlavor).toBe("film");
  expect(built.project.boardStages).toEqual(newProjectRail());
  expect(projectSchema.safeParse(built.project).success).toBe(true);
});

test("what is asked is carried: name, brief, aspect and length; the brief names it when no name is given", () => {
  const a = boardFromInput({ name: "  Harbour film  ", brief: "A harbour wakes up.", aspect: "9:16", length: "30 s" });
  if (!a.ok) throw new Error(a.error);
  expect(a.project).toMatchObject({ name: "Harbour film", brief: "A harbour wakes up.", aspect: "9:16", deliverables: "30 s" });
  const b = boardFromInput({ brief: "A harbour wakes up. One boat leaves." }, nameFromBrief);
  if (!b.ok) throw new Error(b.error);
  expect(b.project.name).toBe(nameFromBrief("A harbour wakes up. One boat leaves."));
});

test("nonsense is refused in words, and nothing is made", () => {
  expect(boardFromInput({ aspect: "3:2" })).toEqual({ ok: false, error: "Pick 16:9, 9:16, 1:1 or 4:5." });
  expect(boardFromInput({ length: "forever" })).toEqual({ ok: false, error: "Give a length such as 30 s." });
  expect(boardFromInput({ kind: "campaign" })).toEqual({ ok: false, error: "Only a film board can be made this way for now." });
  expect(boardFromInput({ name: 5 })).toEqual({ ok: false, error: "The name is words." });
  expect(boardFromInput({ brief: { x: 1 } })).toEqual({ ok: false, error: "The brief is words." });
});

test("an agent can run it over MCP: one call to the board route as the caller, and it says nothing was billed", async () => {
  const calls: { path: string; method?: string; body?: unknown }[] = [];
  const call = async (path: string, init: { method?: string; body?: unknown } = {}) => { calls.push({ path, ...init }); return { id: "b1", name: "Harbour film" }; };
  const text = await runTool("create_board", { name: "Harbour film", brief: "A harbour wakes up." }, call as never, "https://example.invalid");
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ path: "/api/boards", method: "POST", body: { kind: "film", name: "Harbour film", brief: "A harbour wakes up." } });
  expect(text).toContain("Harbour film");
  expect(text).toContain("Nothing was billed");
});

test("the route asks for the render scope and spends nothing: no engine, no meter, no price", () => {
  const route = readFileSync("app/api/boards/route.ts", "utf8");
  expect(route).toContain("requireRender");
  expect(route).not.toMatch(/maxCredits|quoteOnly|reserveGenerationSpend|withGenerationRequest|meter\(/);
});
