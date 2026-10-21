import { test, expect, type Page } from "@playwright/test";
import { isCompact } from "./helpers/shellMode";

/*
 * The v25 rail, edited by the person (v25 PR 7; Opus's items on #750): the steps are the board's own stages (lib/v12/board/stages.ts), so a rename, a skip, a new
 * order and a REMOVED step are the ones the draft keeps; drag a step (or Alt+↑ / Alt+↓ on it) to reorder; right-click it (or the menu key) to Rename, Skip or Put it
 * back, or Remove; "Add step" is a 44 px target on a touch screen. On the test-only page app/(test)/v25-rail-parts (a 404 outside a local ENGINE_MOCK=1 server).
 */
test.beforeEach(async ({ page }) => {
  const res = await page.goto("/v25-rail-parts");
  test.skip(res?.status() === 404, "requires a local ENGINE_MOCK=1 development server");
  await expect(page.getByTestId("v25-rail-editable")).toBeVisible();
  /* The rail lays itself out from its box's height (it reads it after the page hydrates): wait until it has stopped moving, so a hover or a drag lands where the steps are. */
  await expect(async () => {
    const a = await page.locator('[data-testid="v25-rail-editable"] .v12-steprail-step').last().boundingBox();
    await page.waitForTimeout(250);
    const b = await page.locator('[data-testid="v25-rail-editable"] .v12-steprail-step').last().boundingBox();
    expect(a && b && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.height - b.height) < 0.5).toBe(true);
  }).toPass({ timeout: 15_000 });
});
const frame = (page: Page) => page.getByTestId("v25-rail-editable");
const step = (page: Page, id: string) => frame(page).locator(`[data-step="${id}"]`);
const order = (page: Page) => frame(page).getByTestId("v25-rail-order");
const FILM = "treatment pitch brief script cast locations elements storyboard shots edit deliver";
async function menu(page: Page, id: string, item: string) {
  await step(page, id).click({ button: "right" });
  await page.getByTestId("v12-steprail-menu").getByRole("menuitem", { name: item }).click();
}

test("the rail is the Film stages: eleven steps, in order, Treatment and Pitch optional", async ({ page }) => {
  await expect(order(page)).toHaveText(FILM);
  await expect(frame(page).locator(".v12-steprail-step")).toHaveCount(11);
  await step(page, "pitch").hover();
  await expect(page.getByTestId("v12-tooltip")).toContainText("Optional · Not started");
  /* A skipped step keeps its colour: it can still be pressed, so its words stay at the readable floor (no opacity over the muted colour). */
});

test("drag a step above another to reorder; Alt+↑ and Alt+↓ do the same from the keyboard", async ({ page }, info) => {
  test.skip(isCompact(info), "a touch screen reorders from the menu's keyboard path, not by drag");
  await step(page, "edit").dragTo(step(page, "shots"), { targetPosition: { x: 20, y: 6 } });
  await expect(order(page)).toHaveText("treatment pitch brief script cast locations elements storyboard edit shots deliver");
  await step(page, "deliver").focus();
  await page.keyboard.press("Alt+ArrowUp");
  await expect(order(page)).toHaveText("treatment pitch brief script cast locations elements storyboard edit deliver shots");
  await step(page, "deliver").focus();
  await page.keyboard.press("Alt+ArrowDown");
  await expect(order(page)).toHaveText("treatment pitch brief script cast locations elements storyboard edit shots deliver");
});

test("Rename, Skip and Put it back are in a step's menu; a skipped step is muted and says so", async ({ page }) => {
  await menu(page, "script", "Rename");
  const field = page.getByTestId("v12-steprail-rename");
  await expect(field).toBeFocused();
  await field.fill("Story");
  await field.press("Enter");
  await expect(step(page, "script").locator(".v12-steprail-label")).toHaveText("Story");
  /* Esc leaves the name as it was. */
  await menu(page, "script", "Rename");
  await page.getByTestId("v12-steprail-rename").fill("Nope");
  await page.keyboard.press("Escape");
  await expect(step(page, "script").locator(".v12-steprail-label")).toHaveText("Story");
  await menu(page, "pitch", "Skip this step");
  await expect(step(page, "pitch")).toHaveAttribute("data-skipped", "");
  await expect(step(page, "pitch")).toHaveCSS("opacity", "1");
  await expect(step(page, "pitch")).toHaveAttribute("aria-label", "Pitch, skipped");
  await step(page, "pitch").hover();
  await expect(page.getByTestId("v12-tooltip")).toContainText("Optional · Skipped");
  await menu(page, "pitch", "Put it back");
  await expect(step(page, "pitch")).not.toHaveAttribute("data-skipped", /.*/);
});

test("Remove takes a step off the rail for good: it stays off through the next edits, and Add step offers the board's presets and puts the pick after the current step", async ({ page }) => {
  await menu(page, "locations", "Remove");
  await expect(order(page)).toHaveText("treatment pitch brief script cast elements storyboard shots edit deliver");
  /* More edits after it: still gone, and nothing else came back. */
  await menu(page, "cast", "Rename");
  await page.getByTestId("v12-steprail-rename").fill("People");
  await page.keyboard.press("Enter");
  await menu(page, "brief", "Skip this step");
  await expect(order(page)).toHaveText("treatment pitch brief script cast elements storyboard shots edit deliver");
  await expect(step(page, "locations")).toHaveCount(0);
  /* Add step opens the board's presets and "Custom…"; the pick goes after the current step (Shots) and becomes the current one. */
  await frame(page).getByTestId("v12-steprail-add").click();
  const presets = page.getByRole("menu", { name: "Add a step" });
  await expect(presets.getByRole("menuitem")).toHaveText([/Moodboard/, /Recce/, /Client review/, /Animatic/, /Custom/]);
  await presets.getByRole("menuitem", { name: /Recce/ }).click();
  const added = frame(page).locator(".v12-steprail-step").nth(8);
  await expect(added.locator(".v12-steprail-label")).toHaveText("Recce");
  await expect(added).toHaveAttribute("aria-current", "step");
});

test("Add step is a 44 px target on a touch screen", async ({ page }, info) => {
  test.skip(!isCompact(info), "the 44 px floor is the touch screen's");
  await frame(page).getByTestId("v12-steprail-add").scrollIntoViewIfNeeded();
  const box = (await frame(page).getByTestId("v12-steprail-add").boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(43.5);
  expect(box.width).toBeGreaterThanOrEqual(43.5);
  for (const b of await frame(page).locator(".v12-steprail-step").all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
});
