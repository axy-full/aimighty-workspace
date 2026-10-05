import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type CanvasNode } from "../lib/workbench/studio";

/*
 * Stream 3 · the board canvas (design/particl-graphite/README.md § 1.1, § 3.1),
 * behind the new-interface switch. A production with today's canvas nodes
 * opens as a board: the outline rail, its regions arranged in bands, the
 * shared group frames, free notes where they were saved, the dot grid. Nothing
 * paid is sent. Neutral names only.
 */
const SHOTS = process.env.S03_SHOTS || "/private/tmp/claude-s03-shots";

const node = (id: string, type: CanvasNode["type"], title: string, extra: Partial<CanvasNode> = {}): CanvasNode =>
  ({ id, title, type, x: 0, y: 0, width: 254, linked: [], ...extra });

async function seedBoard(page: Page) {
  const workspaceId = (await signInLocally(page.request, "Board Tester")).workspace.id;
  const me = await (await page.request.get("/api/me")).json() as { id: string };
  const scope = `particl-active-${workspaceId}-${me.id}`;
  const project = {
    ...newProject("Board fixture"),
    brief: "A short film about a morning market opening.",
    nodes: [
      node("node-brief01", "brief", "The brief", { text: "A morning market opens; light comes up on the stalls." }),
      node("node-look0001", "moodboard", "Morning light", { text: "Low sun, warm stalls." }),
      node("node-cast0001", "character", "Lead", { refKind: "cast" }),
      node("node-place001", "element", "The market", { refKind: "environment" }),
      node("node-shot0001", "scene", "Opening wide", { text: "Wide on the empty market at first light.", linked: ["node-look0001"] }),
      node("node-shot0002", "scene", "The first stall", { text: "Hands lift the shutter of the first stall." }),
      node("node-grade001", "grade", "Colour", { linked: ["node-shot0001"] }),
      node("node-note0001", "note", "Note", { text: "Keep the camera low.", x: 96, y: 72 }),
    ],
  };
  const saved = await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.addInitScript(({ scope, id }) => { try { localStorage.setItem(scope, id); } catch { /* storage off */ } }, { scope, id: project.id });
  const paid: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && (path === "/api/generate" || path.startsWith("/api/generate/"))) paid.push(path);
  });
  return { project, paid };
}

const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1280;

test("a production opens as a board: rail, regions in bands, groups, free notes", async ({ page }, info) => {
  test.skip(!desktop(page), "phone widths open the project's Record (stream 10); the canvas is desktop only");
  const { project, paid } = await seedBoard(page);
  await page.goto(`/suites?project=${project.id}&view=board`);
  const board = page.getByTestId("board");
  await expect(board).toBeVisible();
  await expect(page.getByTestId("board-canvas").locator(".react-flow__node").first()).toBeVisible();

  /* The rail: seven sections, Library and History; a section with cards reads its status. */
  const rail = page.getByTestId("board-rail");
  for (const label of ["Brief", "Looks", "Storyboard", "Shots", "Cast", "Cut", "Deliver", "Library", "History"])
    await expect(rail.getByRole("button", { name: new RegExp(`^${label}`) })).toBeVisible();

  /* Arranged: the shots sit in the Shots frame, the cast in "Cast, environment and elements"; the note stays free. */
  await expect(page.locator('[data-card-id="group:shots"]')).toBeVisible();
  await expect(page.locator('[data-card-id="group:cast"]')).toBeVisible();
  for (const id of ["node-shot0001", "node-shot0002", "node-cast0001", "node-place001", "node-look0001", "node-brief01", "node-grade001", "node-note0001"])
    await expect(page.locator(`[data-card-id="${id}"]`)).toHaveCount(1);
  await expect(page.locator('[data-card-id="node-note0001"]')).toHaveAttribute("data-free", "true");

  /* The dot grid is an SVG pattern (README § 2; answer 4.3 Q5). */
  await expect(page.locator(".react-flow__background pattern circle")).toHaveCount(1);

  /* No horizontal overflow; nothing paid was sent. */
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  expect(paid).toEqual([]);

  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/board-${info.project.name.replace("workbench-", "")}.png` });
});
