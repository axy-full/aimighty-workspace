import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { signInLocally, localPlatformDbUrl } from "./helpers/workbenchLocal";
import { newProject } from "../lib/workbench/studio";
import { node } from "./helpers/s03-board";

/**
 * The ten Studio stage pages are deleted (owner, 5 Oct night): every old address opens the one board, on the region that took the
 * page's job, for every workspace. Run at every size: the canvas, its side rail and its bottom tool row on a desktop; the board's own
 * compact layout on a phone. Local ENGINE_MOCK server; nothing is sent, no paid button is pressed.
 */
const ADDRESSES: { from: string; want: Record<string, string>; name: string }[] = [
  { name: "Brief", from: "suite=particl&page=brief", want: { view: "board", region: "brief" } },
  { name: "Beats", from: "suite=particl&page=brief&sp=beats", want: { view: "board", region: "storyboard" } },
  { name: "Beats graph", from: "suite=particl&page=brief&sp=beats&beats=graph", want: { view: "board" } },
  { name: "Storyboards", from: "suite=particl&page=boards", want: { view: "board", region: "storyboard" } },
  { name: "Environment", from: "suite=particl&page=boards&sp=environment", want: { view: "board", region: "cast" } },
  { name: "Cast", from: "suite=particl&page=cast", want: { view: "board", region: "cast" } },
  { name: "Astra 3D", from: "suite=particl&page=astra", want: { view: "board", region: "shots" } },
  { name: "Rig", from: "suite=particl&page=rig", want: { view: "board" } },
  { name: "Rig list", from: "suite=particl&page=rig&rig=list", want: { view: "board", list: "1" } },
  { name: "Takes", from: "suite=particl&page=takes", want: { view: "board", region: "shots" } },
  { name: "Edit & Sound", from: "suite=particl&page=edit", want: { view: "board", region: "cut" } },
  { name: "Deliver", from: "suite=particl&page=deliver", want: { view: "board", region: "deliver" } },
  /* The design file's spellings, and the shell's own `sp` for the page. */
  { name: "design: env", from: "suite=studio&page=env", want: { view: "board", region: "cast" } },
  { name: "design: beats", from: "suite=studio&page=beats", want: { view: "board", region: "storyboard" } },
  { name: "with the page's sp", from: "suite=particl&page=edit&sp=edit", want: { view: "board", region: "cut" } },
];

async function seed(page: Page) {
  const workspaceId = (await signInLocally(page.request, "Stage Redirects")).workspace.id;
  const me = await (await page.request.get("/api/me")).json() as { id: string };
  const scope = `particl-active-${workspaceId}-${me.id}`;
  const project = {
    ...newProject("Redirect fixture"), brief: "A short film about a morning market opening.",
    nodes: [node("node-brief01", "brief", "The brief", { text: "A morning market opens." }), node("node-shot0001", "scene", "Opening wide", { text: "Wide on the empty market." })],
  };
  const saved = await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.addInitScript(({ scope, id }) => { try { localStorage.setItem(scope, id); } catch { /* storage off */ } }, { scope, id: project.id });
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    await db.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)", args: [randomUUID(), workspaceId, 2000, "Redirect fixture", "manual", "test", 0] });
  } finally { db.close(); }
  const problems: string[] = [];
  const paid: string[] = [];
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && (path === "/api/generate" || (path.startsWith("/api/generate/") && !path.endsWith("/quote")))) paid.push(path);
  });
  return { project, problems, paid };
}
const here = (page: Page) => Object.fromEntries(new URL(page.url()).searchParams);
/** The shell's own compact query (lib/shell/use-compact.ts): a phone, or a short landscape touch screen. */
const compact = (page: Page) => page.evaluate(() => window.matchMedia("(max-width: 767px), (min-width: 768px) and (max-height: 500px) and (pointer: coarse)").matches);

/** The board is up: its root, and on a desktop its side rail and its bottom tool row (Select, Frame, Note, Text, Image, Video, Audio, Upload). */
async function boardIsUp(page: Page) {
  await expect(page.locator(".gx")).toHaveAttribute("data-screen", "board", { timeout: 90_000 });
  /* A phone mounts the phone app's own screens (stream 10) for the board's address; the board's root is the desktop's. */
  if (await compact(page)) return;
  await expect(page.getByTestId("board")).toBeVisible({ timeout: 90_000 });
  if (!(await compact(page))) {
    await expect(page.getByTestId("board-rail")).toBeVisible();
    /* The canvas draws the tool row; the List view (`list=1`) replaces the canvas, and the tool row with it. */
    if (new URL(page.url()).searchParams.get("list") !== "1") {
      await expect(page.getByTestId("board-tools")).toBeVisible();
      await expect(page.getByTestId("board-tools").getByRole("button")).toHaveCount(8);
    }
  }
}

test("every old Studio stage address opens the board on its region, and a reload of where it landed stays there", async ({ page }) => {
  test.setTimeout(600_000);
  const { project, problems, paid } = await seed(page);
  for (const { from, want, name } of ADDRESSES) {
    await page.goto(`/suites?project=${project.id}&${from}`);
    await boardIsUp(page);
    await expect.poll(() => { const now = here(page); return Object.entries(want).every(([k, v]) => now[k] === v) && now.project === project.id; }, { message: `${name}: ${page.url()}` }).toBe(true);
    /* The address is a board address, never a stage page: no `page=` the shell would read again as an old page. */
    expect(here(page).sp, `${name} leaves no sp behind`).toBeUndefined();
    /* A reload of the settled address is the same place (the state layer's own suite and page beside it do not send it back to a stage). */
    const settled = page.url();
    await page.reload();
    await boardIsUp(page);
    await expect.poll(() => { const now = here(page); return Object.entries(want).every(([k, v]) => now[k] === v); }, { message: `${name} after a reload: ${page.url()} (was ${settled})` }).toBe(true);
  }
  expect(problems).toEqual([]);
  expect(paid, "no paid request was made").toEqual([]);
});
