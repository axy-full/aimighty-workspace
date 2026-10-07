import { mkdirSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { everySpendButtonPriced, floors, noBannedNames } from "./helpers/r1-gaps";
import { SHOTS, desktop, seedCut, shoot, watchErrors } from "./helpers/gaps-l3";

/*
 * Gap screens, lane 3 · Edit & Sound (Gaps A frames, the Cut region). The Cut card opens the editor: the cut's approved takes
 * in order with their trims, the sound lanes, no captions lane (Cut cannot show captions), the loudness check as a choice per
 * deliverable (Broadcast −23 LUFS or Web & social −14 LUFS, measured in the browser on the mix the export encodes), and the
 * export, which is the browser export and says so: free, rendered in this browser, keep the page open. Nothing claims a server
 * render. The board is the desktop's: phone widths open the project's Record (the phone specs own them), so they skip.
 */
const NAMED_PHONE = "the canvas and its Edit & Sound are the desktop's; phone widths open the project's Record (phone Cut is its own spec)";

async function open(page: Page, options: Parameters<typeof seedCut>[2] = {}) {
  const seeded = await seedCut(page, "Edit Tester", options);
  const errors = watchErrors(page);
  await page.goto(`/suites?project=${seeded.project.id}&view=board`);
  await expect(page.getByTestId("cut-card")).toBeVisible();
  await page.locator('[data-region="cut"]').click();
  await page.waitForTimeout(700);
  await page.getByTestId("cut-open-edit").click();
  await expect(page.getByTestId("es")).toBeVisible();
  return { ...seeded, errors };
}

test("the screen: approved takes in order with trims, the lanes, no captions, the export labelled as what it is", async ({ page }, info) => {
  test.skip(!desktop(page), NAMED_PHONE);
  const { paid } = await open(page, { music: true });
  const es = page.getByTestId("es");
  await expect(es.getByTestId("es-meta")).toContainText("0:10");
  const clips = es.getByTestId("es-clip");
  await expect(clips).toHaveCount(2);
  await expect(clips.nth(0)).toContainText("Shot 1");
  await expect(clips.nth(1)).toContainText("Shot 2");
  await expect(clips.nth(1)).toContainText("trimmed");
  await expect(es.getByTestId("es-waiting")).toHaveText("Shot 3 needs review");
  await expect(es.getByTestId("es-trim-in")).toHaveText("0:00.00");
  await expect(es.getByTestId("es-trim-out")).toHaveText("0:05.00");
  await clips.nth(1).click();
  await expect(es.getByTestId("es-trim-in")).toHaveText("0:01.00");
  await expect(es.getByTestId("es-trim-out")).toHaveText("0:06.00");
  await expect(es.getByTestId("es-lane-dialogue")).toBeVisible();
  await expect(es.getByTestId("es-lane-music")).toContainText("Music sketch");
  await expect(es.getByTestId("es-lane-sfx")).toHaveCount(0);

  /* Cut cannot show captions: no lane and no control. */
  await expect(es).not.toContainText(/caption/i);
  /* The export is what exists: the browser export, free, with nothing claimed about a server or a device. */
  const exportBtn = es.getByTestId("es-export");
  await expect(exportBtn).toHaveText("Export the cut · free");
  await expect(es.getByTestId("es-export-words")).toContainText("rendered in your browser · keep this page open");
  await expect(es).not.toContainText(/Render master|on this device/i);
  await expect(es).not.toContainText(/server render is|rendered on our servers/i);
  await everySpendButtonPriced(page, '[data-testid="es"]');
  await noBannedNames(page, '[data-testid="es"]');
  await floors(page, '[data-testid="es"]', false);
  mkdirSync(SHOTS, { recursive: true });
  await shoot(page, info.project.name, "edit-open");
  expect(paid, "nothing paid before a person presses").toEqual([]);
});

test("loudness is a choice per deliverable and a check that measures the mix; Normalise brings it to the target; Deliver reads it", async ({ page }, info) => {
  test.skip(!desktop(page), NAMED_PHONE);
  const { paid, errors } = await open(page, { music: true, musicDbfs: -23 });
  const es = page.getByTestId("es");
  await expect(es.getByTestId("es-loudness-result")).toHaveText("Not checked");
  await expect(es.getByTestId("es-target-broadcast")).toHaveText("✓ Broadcast −23 LUFS");
  await expect(es.getByTestId("es-target-web")).toHaveText("Web & social −14 LUFS");
  await es.getByTestId("es-loudness-check").click();
  await expect(es.getByTestId("es-loudness-result")).toHaveText(/^−2[23]\.\d LUFS ✓$/, { timeout: 60_000 });
  await shoot(page, info.project.name, "edit-check");

  /* The other deliverable: the same measurement, another verdict. */
  await es.getByTestId("es-target-web").click();
  await expect(es.getByTestId("es-loudness-result")).toHaveText(/LU too quiet$/);
  await expect(es.getByTestId("es-normalise")).toHaveText("Normalise · free");

  /* The Deliver card reads the deliverable's target and what the check found for the sound the cut holds. */
  await page.keyboard.press("Escape");
  await expect(es).toHaveCount(0);
  await expect(page.getByTestId("deliver-loudness")).toContainText(/−2[23]\.\d LUFS · Web & social/);
  await expect(page.getByTestId("deliver-loudness")).toContainText(/LU too quiet/);
  await page.getByTestId("cut-open-edit").click();
  await expect(es).toBeVisible();

  /* Normalise moves the sound lanes to the target and checks again. */
  await es.getByTestId("es-normalise").click();
  await expect(es.getByTestId("es-loudness-result")).toHaveText(/^−1[34]\.\d LUFS ✓$/, { timeout: 60_000 });
  await shoot(page, info.project.name, "edit-normalised");
  expect(paid).toEqual([]);
  expect(errors).toEqual([]);
});

test("a cut with no sound says there is nothing to measure; Check loudness is free", async ({ page }) => {
  test.skip(!desktop(page), NAMED_PHONE);
  await open(page);
  const es = page.getByTestId("es");
  await expect(es.getByTestId("es-loudness-check")).toHaveText("Check loudness · free");
  await expect(es.getByTestId("es-loudness-check")).toBeEnabled();
  await es.getByTestId("es-loudness-check").click();
  await expect(es.getByTestId("es-loudness-result")).toHaveText("Nothing to measure · the cut has no sound", { timeout: 30_000 });
});

test("Export the cut renders in the browser with progress, Cancel and a download, and costs nothing", async ({ page }, info) => {
  test.skip(!desktop(page), NAMED_PHONE);
  test.setTimeout(180_000);
  const { paid } = await open(page);
  const es = page.getByTestId("es");
  const go = es.getByTestId("es-export");
  /* The encoders are asked once; the button stays off until the answer is in. */
  await expect(go.or(es.getByRole("alert"))).toBeVisible();
  await page.waitForFunction(() => { const b = document.querySelector<HTMLButtonElement>("[data-testid=es-export]"); return !b || !b.disabled || /encoders|could not be loaded/.test(document.body.innerText); }, null, { timeout: 30_000 });
  const can = await go.isEnabled();
  if (!can) {
    /* A browser without the encoders says so, and the button stays off: nothing to press. */
    await expect(es).toContainText(/does not offer the video and audio encoders|Video encoding could not be loaded/);
    await shoot(page, info.project.name, "edit-export-unavailable");
    return;
  }
  await go.click();
  await expect(es.getByTestId("es-progress")).toContainText("Rendering the movie");
  await expect(es.getByTestId("es-veil")).toContainText("keep this page open");
  await shoot(page, info.project.name, "edit-render");
  await expect(es.getByTestId("es-download")).toBeVisible({ timeout: 150_000 });
  await expect(es.getByTestId("es-done")).toContainText(/MP4|WebM/);
  await expect(es.getByTestId("es-export")).toHaveText("Export the cut · free");
  expect(paid).toEqual([]);
});

test("Esc closes Edit & Sound and the board comes back; New voice line opens a composer that prices before it spends", async ({ page }) => {
  test.skip(!desktop(page), NAMED_PHONE);
  const { paid } = await open(page);
  const es = page.getByTestId("es");
  await es.getByTestId("es-new-voice").click();
  await expect(es.getByTestId("es-compose")).toBeVisible();
  await everySpendButtonPriced(page, '[data-testid="es"]');
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("edit-sound")).toHaveCount(0);
  await expect(page.getByTestId("cut-card")).toBeVisible();
  expect(paid).toEqual([]);
});
