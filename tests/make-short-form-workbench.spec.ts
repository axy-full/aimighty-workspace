import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { forbidPaidWork, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";
import { newProject } from "../lib/workbench/studio";
import { projectName } from "./helpers/projectName";
import { openAdvanced } from "./helpers/makeAdvanced";
import { join } from "node:path";
import { tmpdir } from "node:os";

/* Make's short form: the output tabs, the words, the references, the aspect and the length, the engine line with its price and
   the priced Make button — then ONE folded Advanced, closed every time. Nothing here presses Make, and no Edit tab is left. */

/* Release 1: below the compact line the shell mounts the phone's own Make (phone-make-*; demo-s10-phone-make-workbench: its engine line with Change, References, the type, and Make at its price); this spec is the desktop panel's short form. */
const SIZES = ["workbench-1440x900", "workbench-1920x1080"];
const PRICE = 18;
const ENGINES = [
  { id: "dreamina-seedance-2-5-260628", kind: "video", resolutions: ["480p", "720p", "1080p"], ratios: ["16:9", "9:16", "1:1"], durations: [4, 5, 6, 7, 8, 9, 10, 11, 12], use: "Cinematic motion" },
];

async function open(page: Page) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: { ...newProject("Short form study"), id: "ws-short", productionProjectId: "prod-short", shotMappings: {} } });
  await mockLibrary(page, { uploads: [], generations: [] });
  await page.route("**/api/prompt/enhance", (route) => route.fulfill({ json: { model: "m", effort: "auto", estimateCredits: 1 } }));
  /* The rate list, and one take's live price at where the composer stands: a resolution or a length that moves changes it. */
  const reads: URLSearchParams[] = [];
  await page.route(/\/api\/workbench\/engines(\?.*)?$/, (route) => {
    const q = new URL(route.request().url()).searchParams;
    if (q.has("model")) reads.push(q);
    const credits = q.has("model") ? PRICE + (q.get("resolution") === "1080p" ? 10 : 0) : null;
    return route.fulfill({ json: { models: ENGINES, audio: null, credits } });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/suites?make=video");
  await expect(page.getByTestId("gen-view")).toBeVisible();
  await expect(projectName(page)).toHaveText("Short form study");
  await expect(page.getByTestId("make-engine-line")).toContainText("Seedance");
  return { errors, reads };
}

test("the short form: the essentials, a priced Make, and one folded Advanced", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "the desktop panel; the phone has its own Make");
  const { errors } = await open(page);
  const panel = page.getByTestId("make-panel");
  /* The type: Video, Image, Audio, and no Edit. */
  await expect(panel.getByRole("radiogroup", { name: "Type" }).getByRole("radio")).toHaveText(["Video", "Image", "Audio"]);
  await expect(page.getByTestId("gen-tab-edit")).toHaveCount(0);
  await expect(panel.getByRole("tab", { name: "Edit" })).toHaveCount(0);
  /* The essentials: the words, the references, the engine line with its price, and Make. */
  await expect(page.getByTestId("gen-prompt")).toBeVisible();
  await expect(page.getByTestId("make-add-reference")).toBeVisible();
  await expect(page.getByTestId("gen-model")).toBeVisible();
  await expect(page.getByTestId("make-engine-price")).toHaveText(`${PRICE} cr`, { timeout: 30_000 });
  await page.getByTestId("gen-prompt").fill("a fox crossing a frozen harbour");
  await expect(page.getByTestId("gen-generate")).toHaveText(`Make · ${PRICE} cr`, { timeout: 30_000 });
  /* Advanced sits under Change and is folded: its controls are not on the screen. */
  await expect(page.getByTestId("make-advanced-toggle")).toHaveCount(0);
  await page.getByTestId("gen-model").click();
  const toggle = page.getByTestId("make-advanced-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("make-advanced")).toHaveCount(0);
  for (const id of ["enhance", "gen-takes", "gen-film"]) await expect(page.getByTestId(id)).toHaveCount(0);
  await expect(panel.getByRole("group", { name: "Resolution" })).toHaveCount(0);
  /* One Advanced, and the price stays where the person can see it. */
  await expect(panel.getByTestId("make-advanced-toggle")).toHaveCount(1);
  await expect(page.getByTestId("make-engine-price")).toBeVisible();
  await expect(page.getByTestId("gen-generate")).toBeVisible();

  await page.screenshot({ path: join(tmpdir(), "claude-make-short-shots", `closed-${info.project.name}.png`) });

  /* Opening it shows the rest; the toggle says it is open. */
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("make-advanced")).toBeVisible();
  await expect(panel.getByRole("group", { name: "Resolution" })).toBeVisible();
  await expect(page.getByTestId("enhance")).toBeVisible();
  await expect(page.getByTestId("gen-takes")).toBeVisible();
  await expect(page.getByTestId("gen-film")).toBeVisible();
  /* A price is never inside the fold: the engine line and Make still carry it. */
  await expect(page.getByTestId("make-engine-price")).toBeVisible();
  await expect(page.getByTestId("gen-generate")).toContainText("cr");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: join(tmpdir(), "claude-make-short-shots", `open-${info.project.name}.png`) });

  /* Folding it again hides them and keeps the prices. */
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("make-advanced")).toHaveCount(0);
  await expect(page.getByTestId("gen-generate")).toContainText("cr");
  expect(errors).toEqual([]);
});

test("a value changed in Advanced moves the price, and the fold never hides it", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "the desktop panel; the phone has its own Make");
  const { errors, reads } = await open(page);
  await page.getByTestId("gen-prompt").fill("a fox crossing a frozen harbour");
  await expect(page.getByTestId("make-engine-price")).toHaveText(`${PRICE} cr`, { timeout: 30_000 });
  await openAdvanced(page);
  const toggle = page.getByTestId("make-advanced-toggle");
  await page.getByTestId("make-panel").getByRole("group", { name: "Resolution" }).getByRole("button", { name: "1080p", exact: true }).click();
  await expect(page.getByTestId("make-engine-price")).toHaveText(`${PRICE + 10} cr`, { timeout: 30_000 });
  await expect(page.getByTestId("gen-generate")).toHaveText(`Make · ${PRICE + 10} cr`, { timeout: 30_000 });
  expect(reads.some((q) => q.get("resolution") === "1080p")).toBe(true);
  /* Two takes: Make carries both. Folded, the summary names what the fold holds, and the price still shows. */
  await page.getByTestId("gen-takes-2").click();
  await expect(page.getByTestId("gen-generate")).toHaveText(`Make 2 takes · ${(PRICE + 10) * 2} cr`, { timeout: 30_000 });
  await toggle.click();
  await expect(page.getByTestId("make-advanced")).toHaveCount(0);
  await expect(page.getByTestId("make-advanced-notes")).toHaveText("2 takes");
  await expect(page.getByTestId("gen-generate")).toHaveText(`Make 2 takes · ${(PRICE + 10) * 2} cr`);
  await expect(page.getByTestId("make-engine-price")).toHaveText(`${PRICE + 10} cr`);
  expect(errors).toEqual([]);
});

test("Make opens with Advanced closed every time, and the Edit tab is not an address either", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "the desktop panel; the phone has its own Make");
  const { errors } = await open(page);
  await openAdvanced(page);
  await expect(page.getByTestId("make-advanced")).toBeVisible();
  await page.getByTestId("make-close").click();
  await expect(page.getByTestId("make-panel")).toHaveCount(0);
  await page.goto("/suites?make=video");
  await expect(page.getByTestId("gen-view")).toBeVisible();
  /* Closed again, and Change (which holds it) is closed too. */
  await expect(page.getByTestId("gen-model")).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("make-advanced-toggle")).toHaveCount(0);
  expect(errors).toEqual([]);
});
