import { mkdirSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { everySpendButtonPriced, floors, noBannedNames, shoot, signedInWarm, watchErrors } from "./helpers/r1-gaps";
import { FINGERPRINT, SHOTS, desktop, emptyLibrary, json, seedBoard, stills, watchPaid } from "./helpers/gaps-l2";
import type { Project } from "../lib/workbench/studio";
import type { BeatSheet } from "../lib/production/beats";

/*
 * Gap screens, lane 2 · Line drawings (a card action on a storyboard frame). The price is the server's quote for the frame's own
 * still render, read for free before anything runs; a person's press sends exactly that price on the existing still path, with the
 * frame's current picture as its one reference; it runs on the card and lands as the frame's next version (v1 kept); the chips pick
 * which version the frame shows. The paid POST is answered by the spec: nothing is generated. The canvas is the desktop's: phone
 * widths open the project's Record (phone specs own them), so they skip with that reason.
 */
const SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const at = "2026-10-06T10:00:00.000Z";
const beats = (): BeatSheet => ({
  scriptSha256: SHA, updatedAt: at,
  scenes: [{
    id: "scene-a", heading: "EXT. HILLSIDE - DAWN", summary: "", beats: [], characters: [], locations: [], props: [],
    shots: [
      { id: "shot-a1", description: "Fog lifts off the valley.", framing: "Extreme wide", movement: "Locked off · 24mm", lighting: "", sound: "", duration: 4 },
      { id: "shot-a2", description: "A runner crests the hill.", framing: "Medium", movement: "Slow push · 35mm", lighting: "", sound: "", duration: 6 },
      { id: "shot-a3", description: "Her breath in the cold air.", framing: "Close-up", movement: "Held · 85mm", lighting: "", sound: "", duration: 5 },
    ],
  }],
});
const frame = (id: string, genId: string) => ({ prompt: `Frame ${id}`, takes: [{ genId, style: "live" as const, at }], selected: genId });
const build = (p: Project): Project => ({
  ...p,
  production: { beats: beats(), boards: { style: "live", model: "gemini-3.1-flash-image", frames: { "shot-a1": frame("1", "gen_f1"), "shot-a2": frame("2", "gen_f2"), "shot-a3": frame("3", "gen_f3") } } },
});

async function open(page: Page, price = 2) {
  const workspaceId = await signedInWarm(page, "Lines Tester");
  const errors = watchErrors(page);
  const { project } = await seedBoard(page, workspaceId, build, { generations: ["gen_f1", "gen_f2", "gen_f3"] });
  await emptyLibrary(page);
  await stills(page, { "**/api/media/gen_f*": "campaign/hero.webp", "**/api/media/gen_line*": "campaign/environment.webp" });
  const quoted: Record<string, unknown>[] = [];
  await page.route("**/api/generate/quote", (route) => { quoted.push(JSON.parse(route.request().postData() ?? "{}")); return json(route, { estimatedCredits: price, price, unit: "cr", fingerprint: FINGERPRINT }); });
  const paid = watchPaid(page);
  await page.goto(`/suites?project=${project.id}&view=board`);
  await expect(page.getByTestId("board")).toBeVisible();
  await page.locator('[data-region="storyboard"]').click();
  await page.waitForTimeout(700);
  return { paid, errors, quoted, project };
}
const frameCard = (page: Page, n: number) => page.locator('[data-card-kind="frame"]').nth(n);

test("Line drawings show their price on every frame with a picture before anything runs; nothing is sent until a person presses", async ({ page }, info) => {
  test.skip(!desktop(page), "the canvas is the desktop's; phone widths open the project's Record");
  const { paid, errors, quoted } = await open(page);
  await expect(page.locator('[data-card-kind="frame"]')).toHaveCount(3);
  for (const n of [0, 1, 2]) {
    const go = frameCard(page, n).getByTestId("frame-lines-go");
    await expect(go).toHaveText("Line drawings · 2 cr");
    await expect(go).toHaveAttribute("data-spend", "priced");
    await expect(go).toHaveAttribute("data-spend-price", "2 cr");
  }
  expect(quoted.length).toBeGreaterThanOrEqual(3);
  expect(quoted[0]).toMatchObject({ references: [{ genId: expect.stringMatching(/^gen_f/) }] });
  expect(String(quoted[0].prompt)).toContain("line drawing");
  expect(paid, "nothing paid before a person presses").toEqual([]);
  await everySpendButtonPriced(page);
  await noBannedNames(page, '[data-testid="board"]');
  await floors(page, '[data-testid="board"]', false);
  mkdirSync(SHOTS, { recursive: true });
  await shoot(page, info.project.name, "l2-lines-price");
  expect(errors).toEqual([]);
});

test("a press sends the price shown, runs on the card, lands as v2 with v1 kept, and the chips pick the version", async ({ page }, info) => {
  test.skip(!desktop(page), "the canvas is the desktop's; phone widths open the project's Record");
  const { paid } = await open(page);
  const bodies: Record<string, unknown>[] = [];
  let polls = 0;
  await page.route("**/api/generate", (route) => {
    if (route.request().method() !== "POST") return route.continue();
    bodies.push(JSON.parse(route.request().postData() ?? "{}"));
    return json(route, { id: "gen_line1", status: "queued" });
  });
  await page.route("**/api/jobs/gen_line1", (route) => json(route, { generation: { id: "gen_line1", status: ++polls < 3 ? "running" : "succeeded" } }));
  await frameCard(page, 1).getByTestId("frame-lines-go").click();
  const lines = frameCard(page, 1).getByTestId("frame-lines");
  await expect(lines).toHaveAttribute("data-phase", "running");
  await expect(lines).toContainText("Drawing the lines");
  await expect(lines.getByTestId("notify-when-done")).toHaveText("Notify me when done");
  await shoot(page, info.project.name, "l2-lines-running");
  await expect(lines).toHaveAttribute("data-phase", "done", { timeout: 30_000 });
  expect(paid).toEqual(["/api/generate"]);
  expect(bodies[0]).toMatchObject({ maxCredits: 2, references: [{ genId: "gen_f2" }] });
  await expect(lines).toContainText("Version 2 · line drawing");
  await expect(lines.getByTestId("frame-version")).toHaveText(["v1", "v2 · line drawing"]);
  await expect(lines.getByTestId("frame-version").nth(1)).toHaveAttribute("aria-pressed", "true");
  await expect(frameCard(page, 1)).toContainText("V2");
  /* The other two are offered at their own price, and not before. */
  const others = lines.getByTestId("frame-lines-others");
  await expect(others).toHaveText("Line drawings for the other 2 · 4 cr");
  await expect(others).toHaveAttribute("data-spend", "priced");
  await shoot(page, info.project.name, "l2-lines-done");
  /* v1 comes back with a free press. */
  await lines.getByTestId("frame-version").first().click();
  await expect(lines.getByTestId("frame-version").first()).toHaveAttribute("aria-pressed", "true");
  expect(paid).toEqual(["/api/generate"]);
  await everySpendButtonPriced(page);
});

test("a line drawing that fails says what the provider's outcome says, and the button becomes a priced Retry", async ({ page }) => {
  test.skip(!desktop(page), "the canvas is the desktop's; phone widths open the project's Record");
  await open(page);
  await page.route("**/api/generate", (route) => route.request().method() === "POST" ? json(route, { id: "gen_line2", status: "queued" }) : route.continue());
  await page.route("**/api/jobs/gen_line2", (route) => json(route, { generation: { id: "gen_line2", status: "failed", error: "The engine returned no image." } }));
  await frameCard(page, 0).getByTestId("frame-lines-go").click();
  const go = frameCard(page, 0).getByTestId("frame-lines-go");
  await expect(go).toHaveText("Retry · 2 cr", { timeout: 30_000 });
  await expect(go).toHaveAttribute("data-spend", "priced");
  /* With no billing outcome from the provider, nothing is claimed about the charge. */
  await expect(page.locator("body")).not.toContainText("Nothing billed");
});

test("a price that cannot be read says Try again, and the button stays off", async ({ page }) => {
  test.skip(!desktop(page), "the canvas is the desktop's; phone widths open the project's Record");
  const workspaceId = await signedInWarm(page, "Lines Quote");
  const { project } = await seedBoard(page, workspaceId, build, { generations: ["gen_f1", "gen_f2", "gen_f3"] });
  await emptyLibrary(page);
  await stills(page, { "**/api/media/gen_f*": "campaign/hero.webp" });
  await page.route("**/api/generate/quote", (route) => json(route, { error: "No confirmed price for this setting yet." }, 422));
  const paid = watchPaid(page);
  await page.goto(`/suites?project=${project.id}&view=board`);
  await expect(page.getByTestId("board")).toBeVisible();
  await page.locator('[data-region="storyboard"]').click();
  await page.waitForTimeout(700);
  const go = frameCard(page, 0).getByTestId("frame-lines-go");
  await expect(go).toBeDisabled();
  await expect(go).toHaveAttribute("data-spend", "unpriced");
  await expect(frameCard(page, 0).getByTestId("frame-lines-try-again")).toHaveText("Try again");
  expect(paid).toEqual([]);
});
