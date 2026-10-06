import { mkdirSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { everySpendButtonPriced, floors, noBannedNames, shoot, signedInWarm, watchErrors } from "./helpers/r1-gaps";
import { FINGERPRINT, SHOTS, desktop, emptyLibrary, json, seedBoard, stills, watchPaid } from "./helpers/gaps-l2";
import type { Asset, CanvasNode, Project } from "../lib/workbench/studio";

/*
 * Gap screens, lane 2 · Cut-out (a card action on a still, on the Cast card). The price is the server's quote, read for free
 * before anything runs; a person's press sends exactly that price through the existing cut-out path (RigContext.startCutout);
 * the finished cut-out is a new version of the card's source with the original kept, and a Before and After toggle.
 * "Nothing billed" is said only when the job's own settled figure is 0. The paid POST is answered by the spec (nothing is generated).
 * The canvas is the desktop's: phone widths open the project's Record (phone specs own them), so they skip with that reason.
 */
const image = (id: string, name: string, extra: Partial<Asset> = {}): Asset => ({ id, uploadId: `up-${id}`, name, kind: "image", category: "Cast", url: `/api/uploads/up-${id}`, description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [], mime: "image/webp", ...extra });
const ref = (id: string, title: string, type: CanvasNode["type"], assetId: string, refKind: CanvasNode["refKind"]): CanvasNode => ({ id, title, type, x: 0, y: 0, width: 308, linked: [], assetId, refKind } as CanvasNode);

const build = (p: Project): Project => ({
  ...p,
  assets: [image("lead", "Lead.webp"), image("sphere", "Mirror sphere.webp"), image("ridge", "Dune ridge.webp")],
  nodes: [ref("node-lead", "Lead", "character", "lead", "cast"), ref("node-sphere", "Mirror sphere", "element", "sphere", "element"), ref("node-ridge", "Dune ridge", "element", "ridge", "environment")],
});

async function open(page: Page, price = 4) {
  const workspaceId = await signedInWarm(page, "Cutout Tester");
  const errors = watchErrors(page);
  const { project } = await seedBoard(page, workspaceId, build);
  await emptyLibrary(page);
  await stills(page, { "**/api/uploads/up-*": "campaign/character.webp", "**/api/media/gen_cut*": "campaign/hero.webp" });
  /* The server's price is answered here so the spec holds a figure; the paid POST is answered below, never by a provider. */
  await page.route("**/api/generate/quote", (route) => json(route, { estimatedCredits: price, price, unit: "cr", fingerprint: FINGERPRINT }));
  const paid = watchPaid(page);
  await page.goto(`/suites?project=${project.id}&view=board`);
  await expect(page.getByTestId("board")).toBeVisible();
  return { paid, errors, project };
}
const lead = (page: Page) => page.getByTestId("cast-card").filter({ hasText: "Lead" }).first();

test("Cut-out shows its price before it runs, on a person and a thing but not a place; nothing is sent until a person presses", async ({ page }, info) => {
  test.skip(!desktop(page), "the canvas is the desktop's; phone widths open the project's Record");
  const { paid, errors } = await open(page);
  await expect(page.getByTestId("cast-card")).toHaveCount(3);
  await expect(lead(page).getByTestId("cutout-go")).toHaveText("Cut-out · 4 cr");
  await expect(lead(page).getByTestId("cutout-go")).toHaveAttribute("data-spend", "priced");
  await expect(lead(page).getByTestId("cutout-go")).toHaveAttribute("data-spend-price", "4 cr");
  await expect(page.getByTestId("cast-card").filter({ hasText: "Mirror sphere" }).getByTestId("cutout-go")).toHaveText("Cut-out · 4 cr");
  /* A place is not cut out. */
  await expect(page.getByTestId("cast-card").filter({ hasText: "Dune ridge" }).getByTestId("cutout-go")).toHaveCount(0);
  expect(paid, "nothing paid before a person presses").toEqual([]);
  await everySpendButtonPriced(page);
  await noBannedNames(page, '[data-testid="board"]');
  await floors(page, '[data-testid="board"]', false);
  mkdirSync(SHOTS, { recursive: true });
  await page.locator('[data-region="cast"]').click();
  await page.waitForTimeout(700);
  await shoot(page, info.project.name, "l2-cutout-price");
  expect(errors).toEqual([]);
});

test("a person's press sends the price shown; it runs on the card, lands as a new version, and the toggle shows before and after", async ({ page }, info) => {
  test.skip(!desktop(page), "the canvas is the desktop's; phone widths open the project's Record");
  const { paid } = await open(page);
  let polls = 0;
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/generate", (route) => {
    if (route.request().method() !== "POST") return route.continue();
    bodies.push(JSON.parse(route.request().postData() ?? "{}"));
    return json(route, { id: "gen_cut1", status: "queued" });
  });
  await page.route("**/api/jobs/gen_cut1", (route) => json(route, { generation: { id: "gen_cut1", status: ++polls < 3 ? "running" : "succeeded", creditsBilled: polls < 3 ? null : 4 } }));
  await lead(page).getByTestId("cutout-go").click();
  await expect(lead(page).getByTestId("cutout-running")).toBeVisible();
  await expect(lead(page).getByTestId("cutout-running")).toContainText("Cutting out the background");
  await page.locator('[data-region="cast"]').click();
  await page.waitForTimeout(700);
  await shoot(page, info.project.name, "l2-cutout-running");
  await expect(lead(page).getByTestId("cutout-done")).toBeVisible({ timeout: 30_000 });
  expect(paid).toEqual(["/api/generate"]);
  expect(bodies[0]).toMatchObject({ maxCredits: 4, model: { id: expect.any(String) }, references: [{ uploadId: "up-lead" }] });
  await expect(lead(page).getByTestId("cutout-done")).toContainText("Cut-out · v2 · background removed");
  await expect(lead(page).getByTestId("cutout-after")).toHaveAttribute("aria-pressed", "true");
  await expect(lead(page).locator(".gx-cast-well")).toHaveAttribute("data-transparent", "");
  await shoot(page, info.project.name, "l2-cutout-after");
  await lead(page).getByTestId("cutout-before").click();
  await expect(lead(page).getByTestId("cutout-before")).toHaveAttribute("aria-pressed", "true");
  await expect(lead(page).locator(".gx-cast-well")).not.toHaveAttribute("data-transparent", "");
  await shoot(page, info.project.name, "l2-cutout-before");
  await everySpendButtonPriced(page);
});

test("a failed cut-out says Nothing billed only when its settled figure is 0, and Retry carries a price", async ({ page }, info) => {
  test.skip(!desktop(page), "the canvas is the desktop's; phone widths open the project's Record");
  await open(page);
  await page.route("**/api/generate", (route) => route.request().method() === "POST" ? json(route, { id: "gen_cut2", status: "queued" }) : route.continue());
  await page.route("**/api/jobs/gen_cut2", (route) => json(route, { generation: { id: "gen_cut2", status: "failed", error: "The engine returned no image.", creditsBilled: 0 } }));
  await lead(page).getByTestId("cutout-go").click();
  const action = lead(page).getByTestId("cutout-action");
  await expect(action).toContainText("Nothing billed", { timeout: 30_000 });
  await expect(action.getByTestId("cutout-go")).toHaveText("Retry · 4 cr");
  await expect(action.getByTestId("cutout-go")).toHaveAttribute("data-spend", "priced");
  await page.locator('[data-region="cast"]').click();
  await page.waitForTimeout(700);
  await shoot(page, info.project.name, "l2-cutout-failed");
});

test("a price that cannot be read says Try again, and the button stays off", async ({ page }) => {
  test.skip(!desktop(page), "the canvas is the desktop's; phone widths open the project's Record");
  const workspaceId = await signedInWarm(page, "Cutout Quote");
  const { project } = await seedBoard(page, workspaceId, build);
  await emptyLibrary(page);
  await stills(page, { "**/api/uploads/up-*": "campaign/character.webp" });
  await page.route("**/api/generate/quote", (route) => json(route, { error: "No confirmed price for this setting yet." }, 422));
  const paid = watchPaid(page);
  await page.goto(`/suites?project=${project.id}&view=board`);
  const go = lead(page).getByTestId("cutout-go");
  await expect(go).toBeDisabled();
  await expect(go).toHaveAttribute("data-spend", "unpriced");
  await expect(lead(page).getByTestId("cutout-try-again")).toHaveText("Try again");
  expect(paid).toEqual([]);
});
