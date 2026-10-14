import { test, expect, type Page } from "@playwright/test";
import { filmBoard, openBoard } from "./helpers/boardV12";
import { forbidPaidWork, mockMedia } from "./helpers/workspaceFixtures";
import type { CanvasNode } from "../lib/workbench/studio";

/**
 * Saved mode (no live room): two windows edit the same card's text. The second to save is not written over the first on the shared canvas, holds its own
 * version, and asks (Reload or Keep my version); nothing of the first is lost. Desktop only; phones keep today's board.
 */
const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const NOTE = "node-note-cas1";
const withNote = () => {
  const film = filmBoard();
  const note: CanvasNode = { id: NOTE, title: "Note", type: "note", x: 96, y: 72, width: 254, linked: [], text: "Start from the harbour." };
  return { project: { ...film, nodes: [...film.nodes, note] } };
};
const noteText = (page: Page) => page.locator(`[data-card-id="${NOTE}"] .bd-note-text`);
const canvasText = async (page: Page, productionId: string) => {
  const answer = await (await page.request.get(`/api/workbench/team-canvas?productionId=${productionId}`)).json() as { canvas: { nodes: Record<string, { text?: string }> } };
  return answer.canvas.nodes[NOTE]?.text;
};

type Refused = { nodeId: string; fields: string[]; by: string | null }[];
/** Every answer to this page's canvas edits, as it arrives (the edit that matters may not be the first one sent). */
function watchAnswers(page: Page) {
  const seen: { refused?: Refused }[] = [];
  page.on("response", (r) => {
    if (r.url().includes("/api/workbench/team-canvas") && r.request().method() === "PATCH") void r.json().then((body) => { seen.push(body); }, () => {});
  });
  return seen;
}

async function writeNote(page: Page, text: string) {
  await page.locator(`[data-card-id="${NOTE}"]`).dblclick();
  const editor = page.getByRole("textbox", { name: "Note" });
  await expect(editor).toBeFocused();
  await editor.fill(text);
  await editor.press("Meta+Enter");
  await expect(noteText(page)).toContainText(text);
}

test.beforeEach(({}, info) => test.skip(!DESKTOP.includes(info.project.name), "desktop sizes"));

test("two windows write the same note: the second is held with the choice, the first stands on the canvas; Keep my version then writes the second", async ({ page, context }) => {
  const { project } = await openBoard(page, "/suites?view=board&stage=storyboard", withNote());
  await expect(noteText(page)).toContainText("Start from the harbour.", { timeout: 60_000 });
  const other = await context.newPage();
  await forbidPaidWork(other);
  await mockMedia(other);
  await other.goto("/suites?view=board&stage=storyboard");
  await expect(noteText(other)).toContainText("Start from the harbour.", { timeout: 60_000 });
  /* The first window writes; its edit reaches the canvas. */
  const firstAnswers = watchAnswers(other);
  await writeNote(other, "Ana's line");
  const production = project.productionProjectId ?? (await (await page.request.get("/api/workbench/projects?id=" + project.id)).json() as { project: { productionProjectId: string } }).project.productionProjectId;
  await expect.poll(() => canvasText(page, production), { timeout: 30_000 }).toBe("Ana's line");
  expect(firstAnswers.some((a) => a.refused), "the first window's edit was not refused").toBe(false);
  /* The second window had not heard of it: its write is refused on the canvas, it holds. */
  const secondAnswers = watchAnswers(page);
  await writeNote(page, "Bo's line");
  await expect.poll(() => secondAnswers.find((a) => a.refused)?.refused, { timeout: 30_000 }).toMatchObject([{ nodeId: NOTE, fields: ["text"] }]);
  const bar = page.getByTestId("v12-changed-bar");
  await expect(bar).toBeVisible({ timeout: 30_000 });
  await expect(bar).toContainText("is kept until you choose");
  await expect(noteText(page), "this window's version stays on screen").toContainText("Bo's line");
  expect(await canvasText(page, production), "nothing was written over the first").toBe("Ana's line");
  /* Keep my version: it is written, with no compare. */
  const kept = page.waitForResponse((r) => r.url().includes("/api/workbench/team-canvas") && r.request().method() === "PATCH" && r.ok(), { timeout: 30_000 });
  await page.getByTestId("v12-changed-keep").click();
  await kept;
  await expect(bar).toHaveCount(0);
  await expect.poll(() => canvasText(page, production), { timeout: 30_000 }).toBe("Bo's line");
});

test("Reload takes the first window's note", async ({ page, context }) => {
  const { project } = await openBoard(page, "/suites?view=board&stage=storyboard", withNote());
  await expect(noteText(page)).toContainText("Start from the harbour.", { timeout: 60_000 });
  const other = await context.newPage();
  await forbidPaidWork(other);
  await mockMedia(other);
  await other.goto("/suites?view=board&stage=storyboard");
  await expect(noteText(other)).toContainText("Start from the harbour.", { timeout: 60_000 });
  await writeNote(other, "Ana's line");
  const production = (await (await page.request.get("/api/workbench/projects?id=" + project.id)).json() as { project: { productionProjectId: string } }).project.productionProjectId;
  await expect.poll(() => canvasText(page, production), { timeout: 30_000 }).toBe("Ana's line");
  await writeNote(page, "Bo's line");
  await expect(page.getByTestId("v12-changed-bar")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("v12-changed-reload").click();
  await expect(page.getByTestId("v12-changed-bar")).toHaveCount(0);
  await expect(noteText(page)).toContainText("Ana's line");
});
