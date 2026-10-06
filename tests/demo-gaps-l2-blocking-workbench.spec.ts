import { mkdirSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { everySpendButtonPriced, floors, noBannedNames, shoot, signedInWarm, watchErrors } from "./helpers/r1-gaps";
import { SHOTS, desktop, emptyLibrary, gotoBoard, seedBoard, watchPaid } from "./helpers/gaps-l2";
import type { CanvasNode, Project } from "../lib/workbench/studio";
import type { BeatSheet } from "../lib/production/beats";
import { sceneFromShot } from "../lib/production/blocking";

/*
 * Gap screens, lane 2 · 3D blocking (a card in the Storyboard and Shots regions that opens a full-screen overlay). Empty scene, then
 * "Add from Shot 1 · free" builds one from the beat sheet (a figure for each character, a prop for each prop, the place, a sun, a camera
 * from the shot's words); the camera's position, height, tilt and lens, the frame guide and a push on a timeline; "Use as reference for
 * Shot 1 · free" saves the frame to the shot, and the shot's own card shows it with Remake Shot 1 priced from the server's estimate.
 * Nothing is paid in any of it. "Prop from a photo" has no price and no provider: it is disabled, "price pending". The canvas is the
 * desktop's; phone widths skip (a phone spec owns them).
 */
const SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const beats = (): BeatSheet => ({
  scriptSha256: SHA, updatedAt: "2026-10-06T10:00:00.000Z",
  scenes: [{
    id: "scene-a", heading: "EXT. HILLSIDE - DAWN", summary: "", beats: [], characters: ["Runner", "Guide"], locations: ["Hillside"], props: ["Lantern"],
    shots: [
      { id: "shot-a1", description: "A runner crests the hill.", framing: "Close-up", movement: "Slow push · 85mm", lighting: "", sound: "", duration: 5 },
      { id: "shot-a2", description: "Fog lifts off the valley.", framing: "Extreme wide", movement: "Locked off · 24mm", lighting: "", sound: "", duration: 4 },
    ],
  }],
});
const shot = (id: string, title: string, boardShotId: string): CanvasNode => ({ id, title, type: "scene", x: 0, y: 0, width: 344, linked: [], boardShotId } as CanvasNode);
const build = (p: Project): Project => ({ ...p, nodes: [shot("node-shot0001", "Close on the runner", "shot-a1"), shot("node-shot0002", "The valley", "shot-a2")], production: { beats: beats() } });

async function open(page: Page) {
  const workspaceId = await signedInWarm(page, "Blocking Tester");
  const errors = watchErrors(page);
  const { project, scope } = await seedBoard(page, workspaceId, build);
  await emptyLibrary(page);
  const paid = watchPaid(page);
  await gotoBoard(page, project.id);
  await page.locator('[data-region="shots"]').click();
  await page.waitForTimeout(700);
  return { paid, errors, project, scope };
}
const overlay = (page: Page) => page.getByTestId("blocking-overlay");

test("the 3D blocking card sits in the Shots region; the empty overlay offers Add from the shot, and Prop from a photo is off with its reason", async ({ page }, info) => {
  test.skip(!desktop(page), "the canvas is the desktop's; phone widths open the project's Record");
  const { paid, errors } = await open(page);
  const card = page.locator('[data-card-id="blocking:shots"]');
  await expect(card).toBeVisible();
  await expect(card).toContainText("3D blocking");
  await expect(card).toContainText("Not saved to a shot yet");
  mkdirSync(SHOTS, { recursive: true });
  await shoot(page, info.project.name, "l2-blocking-card");
  await card.getByTestId("blocking-open").click();
  await expect(overlay(page)).toBeVisible();
  await expect(overlay(page)).toHaveAttribute("data-state", "empty");
  await expect(page.getByTestId("blocking-empty")).toContainText("An empty scene");
  await expect(page.getByTestId("blocking-from-shot")).toHaveText("Add from Shot 1 · free");
  const photo = page.getByTestId("blocking-add-photo");
  await expect(photo).toBeDisabled();
  await expect(photo).toHaveAttribute("data-spend", "unpriced");
  await expect(photo).toContainText("price pending");
  await shoot(page, info.project.name, "l2-blocking-empty");
  await everySpendButtonPriced(page);
  await noBannedNames(page, '[data-testid="blocking-overlay"]');
  await floors(page, '[data-testid="blocking-overlay"]', false);
  expect(paid).toEqual([]);
  expect(errors).toEqual([]);
});

test("Add from the shot builds the scene from the beat sheet; the camera, lens and a push are set; Use as reference saves the frame to the shot, free", async ({ page }, info) => {
  test.skip(!desktop(page), "the canvas is the desktop's; phone widths open the project's Record");
  const { paid, project, scope } = await open(page);
  await page.locator('[data-card-id="blocking:shots"]').getByTestId("blocking-open").click();
  await page.getByTestId("blocking-from-shot").click();
  await expect(overlay(page)).toHaveAttribute("data-state", "building");
  const objects = page.getByTestId("blocking-objects");
  await expect(objects).toContainText("Runner");
  await expect(objects).toContainText("Guide");
  await expect(objects).toContainText("Lantern");
  await expect(objects).toContainText("Hillside");
  await expect(page.getByTestId("blocking-sub")).toContainText("Shot 1");
  /* The shot's own words set the lens and the move: 85mm and a push. */
  await expect(page.getByTestId("blocking-lens-85")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("blocking-move-push")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("blocking-guide")).toHaveText("16:9 · from the brief");
  /* Objects can be hidden, a figure added, the lens changed. */
  await page.getByTestId("blocking-toggle").nth(1).click();
  await expect(page.getByTestId("blocking-toggle").nth(1)).toHaveText("Hidden");
  await page.getByTestId("blocking-add-figure").click();
  await expect(objects).toContainText("Figure 3");
  await page.getByTestId("blocking-lens-50").click();
  await expect(page.getByTestId("blocking-lens-50")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("blocking-lens-85").click();
  /* The 3D view is up (WebGL) once its camera can be played. */
  await expect(page.getByTestId("blocking-play")).toBeEnabled({ timeout: 30_000 });
  await page.getByTestId("blocking-scrub").fill("500");
  await shoot(page, info.project.name, "l2-blocking-building");
  await expect(page.getByTestId("blocking-save")).toHaveText("Use as reference for Shot 1 · free");
  await everySpendButtonPriced(page);
  await page.getByTestId("blocking-save").click();
  await expect(overlay(page)).toHaveCount(0, { timeout: 30_000 });
  /* The shot's own card carries the blocking frame, and Remake is priced from the server's estimate: pressing it spends nothing here. */
  const strip = page.locator('[data-card-id="node-shot0001"]').getByTestId("shot-blocking");
  await expect(strip).toBeVisible();
  await expect(strip).toContainText("3D blocking · 85mm");
  await expect(strip).toContainText(/Reference · saved \d\d:\d\d · free/);
  const remake = strip.getByTestId("blocking-remake");
  await expect(remake).toHaveText(/^Remake Shot 1 · [\d.,]+ cr$/);
  await expect(remake).toHaveAttribute("data-spend", "priced");
  await shoot(page, info.project.name, "l2-blocking-saved");
  expect(paid, "saving is free: nothing was sent to a paid route").toEqual([]);
  /* It is on the project: the scene, the move, and a frame filed as the shot's input. */
  await expect.poll(async () => {
    const r = await page.request.get(`/api/workbench/projects?id=${project.id}`, { headers: { "X-Workbench-Scope": scope } });
    const body = (await r.json()) as { project: Project };
    const entry = body.project.production?.blocking?.["node-shot0001"];
    const input = body.project.nodes.find((n) => n.id === "node-shot0001")?.linked.length ?? 0;
    return entry ? { lens: entry.scene.camera.focalLength, move: entry.move.kind, objects: entry.scene.objects.length, frame: Boolean(entry.frameAssetId), input } : null;
  }, { timeout: 20_000 }).toMatchObject({ lens: 85, move: "push", frame: true, input: 1 });
  /* A reload keeps it, and the overlay opens on what was saved. */
  await page.reload();
  await expect(page.getByTestId("board")).toBeVisible();
  await page.locator('[data-region="shots"]').click();
  await page.waitForTimeout(700);
  await page.locator('[data-card-id="node-shot0001"]').getByTestId("blocking-reopen").click();
  await expect(page.getByTestId("blocking-objects")).toContainText("Runner");
  await expect(page.getByTestId("blocking-lens-85")).toHaveAttribute("aria-pressed", "true");
});

test("on a phone the saved 3D blocking is shown on the Record, view only: its lens, its move and what is in the scene, with no way to change it", async ({ page }, info) => {
  test.skip(desktop(page), "the phone's Record is for phone widths; the desktop specs above own the canvas");
  const workspaceId = await signedInWarm(page, "Blocking Phone");
  const errors = watchErrors(page);
  const { project } = await seedBoard(page, workspaceId, (p) => {
    const nodes = [shot("node-shot0001", "Close on the runner", "shot-a1")];
    const base = { ...p, nodes, production: { beats: beats() } } as Project;
    const made = sceneFromShot(base, "node-shot0001");
    return { ...base, production: { ...base.production, blocking: { "node-shot0001": { scene: made.scene, move: made.move, savedAt: "2026-10-06T10:20:00.000Z" } } } };
  });
  await emptyLibrary(page);
  const paid = watchPaid(page);
  await page.goto(`/suites?project=${project.id}&view=board`);
  const section = page.getByTestId("phone-blocking");
  await expect(section).toBeVisible({ timeout: 60_000 });
  await expect(section).toContainText("view only on the phone");
  await expect(section.getByTestId("phone-blocking-shot")).toContainText("Shot 1 · 3D blocking");
  await expect(section.getByTestId("phone-blocking-shot")).toContainText("85mm · Slow push · 1.2 m");
  await expect(section).toContainText("Runner · figure");
  await expect(section.locator("button, input, select, textarea, a")).toHaveCount(0);
  await noBannedNames(page, '[data-testid="phone-record"]');
  await floors(page, '[data-testid="phone-record"]', true);
  mkdirSync(SHOTS, { recursive: true });
  await shoot(page, info.project.name, "l2-blocking-phone");
  expect(paid).toEqual([]);
  expect(errors).toEqual([]);
});
