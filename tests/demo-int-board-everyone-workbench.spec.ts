import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { signInLocally, localPlatformDbUrl } from "./helpers/workbenchLocal";
import { newProject } from "../lib/workbench/studio";
import { node } from "./helpers/s03-board";

/**
 * Integration · the board is one board for everyone (owner decision, 5 Oct): a workspace with the new-interface switch OFF
 * opens the same canvas, with its side rail and bottom tool row, wherever an old Studio stage, a Crew page or a Business Ads
 * page was linked; Home and Settings stay today's until the switch flips. Local ENGINE_MOCK server; nothing is sent.
 */
const SIZES = ["workbench-1440x900", "workbench-1920x1080"];

async function seed(page: Page) {
  const workspaceId = (await signInLocally(page.request, "Board Everyone")).workspace.id;
  const me = await (await page.request.get("/api/me")).json() as { id: string };
  const scope = `particl-active-${workspaceId}-${me.id}`;
  const project = {
    ...newProject("Everyone fixture"), brief: "A short film about a morning market opening.",
    nodes: [node("node-brief01", "brief", "The brief", { text: "A morning market opens." }), node("node-shot0001", "scene", "Opening wide", { text: "Wide on the empty market." })],
  };
  const saved = await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.addInitScript(({ scope, id }) => { try { localStorage.setItem(scope, id); } catch { /* storage off */ } }, { scope, id: project.id });
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    await db.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)", args: [randomUUID(), workspaceId, 2000, "Integration fixture", "manual", "test", 0] });
  } finally { db.close(); }
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(error.message));
  return { project, problems };
}
const here = (page: Page) => Object.fromEntries(new URL(page.url()).searchParams);

test("switch OFF: the old Studio stages, Crew and Ads pages open the one board, with its rail and tool row", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "the canvas is desktop only");
  test.setTimeout(300_000);
  const { project, problems } = await seed(page);
  const cases: [string, Record<string, string>][] = [
    [`/suites?project=${project.id}&suite=particl&page=rig`, { view: "board" }],
    [`/suites?project=${project.id}&suite=particl&page=edit`, { view: "board", region: "cut" }],
    [`/suites?project=${project.id}&suite=particl&page=takes`, { view: "board", region: "shots" }],
    [`/suites?project=${project.id}&suite=particl&page=cast`, { view: "board", region: "cast" }],
    [`/suites?project=${project.id}&suite=particl&page=deliver`, { view: "board", region: "deliver" }],
    [`/suites?project=${project.id}&suite=particl&page=brief`, { view: "board", region: "brief" }],
    [`/suites?project=${project.id}&view=board`, { view: "board" }],
    [`/suites?project=${project.id}&suite=moleculr&page=marketing&sp=dtc`, { view: "board", kind: "ads" }],
  ];
  for (const [path, want] of cases) {
    await page.goto(path);
    await expect(page.locator(".gx")).toHaveAttribute("data-screen", want.kind === "ads" ? "board-ads" : "board", { timeout: 60_000 });
    await expect.poll(() => { const now = here(page); return Object.entries(want).every(([k, v]) => now[k] === v); }, { message: path }).toBe(true);
    await expect(page.getByTestId("board-rail")).toBeVisible();
    /* The bottom tool row, always present: Select, Frame, Note, Text, Image, Video, Audio, Upload. */
    await expect(page.getByTestId("board-tools")).toBeVisible();
    await expect(page.getByTestId("board-tools").getByRole("button")).toHaveCount(8);
  }
  expect(problems).toEqual([]);
});

test("switch OFF: Home and the rest stay today's; the project segment opens the board; Make opens beside the board's dock", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "the canvas is desktop only");
  test.setTimeout(300_000);
  const { project, problems } = await seed(page);
  /* Home is behind the switch: a bare landing is today's Studio overview. */
  await page.goto(`/suites?project=${project.id}`);
  await expect(page.locator(".gx")).not.toHaveAttribute("data-screen", /.+/);
  await expect.poll(() => here(page).view ?? "suite").toBe("suite");
  await page.goto(`/suites?project=${project.id}&view=board&make=video`);
  await expect(page.getByTestId("board-rail")).toBeVisible({ timeout: 60_000 });
  const panel = page.locator(".gx-make");
  await expect(panel).toBeVisible({ timeout: 60_000 });
  const dock = page.locator(".bd-dock");
  await expect(dock).toBeVisible();
  const [m, d] = await Promise.all([panel.boundingBox(), dock.boundingBox()]);
  expect(m!.x + m!.width, "Make sits left of the board's dock, never under it").toBeLessThanOrEqual(d!.x + 1);
  expect(problems).toEqual([]);
});
