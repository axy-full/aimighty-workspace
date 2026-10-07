import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { legacyShell } from "./helpers/legacyShell";
import { isCompact } from "./helpers/shellMode";

/* Asking Atomik on a fresh project: the project saves itself, so no screen asks the person to save first.
   Nothing here presses a paid control: the estimate reads (quoteOnly) are free, and the run button is never pressed. */

const SAVE_FIRST = /Save (this|the|your) (project|work)|before asking Atomik|Save the project first/i;

function watch(page: Page) {
  const saves: string[] = [], refused: string[] = [], paid: string[] = [], quotes: string[] = [];
  page.on("response", async (response) => {
    const request = response.request(), path = new URL(response.url()).pathname;
    if (!path.startsWith("/api/")) return;
    if (request.method() === "PUT" && path === "/api/workbench/projects") saves.push(String(response.status()));
    if (response.status() >= 400) {
      const text = await response.text().catch(() => "");
      if (SAVE_FIRST.test(text)) refused.push(`${request.method()} ${path} ${response.status()}`);
    }
  });
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET") return;
    const body = request.postData() ?? "";
    if (path === "/api/workbench/atomik") {
      (/"quoteOnly":true/.test(body) ? quotes : paid).push(`${request.method()} ${path}`);
    } else if (/^\/api\/(generate|jobs|pipelines|workbench\/development|soul)/.test(path) && !/quoteOnly|"resume"/.test(body)) paid.push(`${request.method()} ${path}`);
  });
  return { saves, refused, paid, quotes };
}

async function textOf(page: Page) {
  return page.evaluate(() => document.body.innerText);
}

test("a fresh project saves itself before Atomik is asked, with no save-first line anywhere", async ({ page }, info) => {
  const seen = watch(page);
  await signInLocally(page.request);
  await page.goto(await legacyShell(page, "/workbench"));
  await page.getByRole("button", { name: "Start a project" }).first().click();
  await page.getByRole("dialog").getByRole("textbox").first().fill("Autosave film");
  await page.getByRole("dialog").getByRole("button", { name: /create|start|continue/i }).first().click();
  await expect(page.locator("#project-name")).toHaveValue("Autosave film");
  /* It is saved without a press, and promptly. */
  await expect.poll(() => seen.saves.length, { timeout: 5000 }).toBeGreaterThan(0);
  expect(seen.saves[0]).toBe("200");

  await page.getByRole("button", { name: "Toggle Atomik creative engine", exact: true }).filter({ visible: true }).click();
  const request = page.getByRole("textbox", { name: /Creative request/ });
  await request.fill("Plan a short film about a lighthouse keeper");
  /* The Atomik reads that follow the first save are quiet: no 404, no line. */
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: /Review agent quote/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect.poll(async () => (await dialog.innerText()).length).toBeGreaterThan(20);
  await page.waitForTimeout(1500);
  expect(await textOf(page)).not.toMatch(SAVE_FIRST);
  expect(seen.refused).toEqual([]);
  expect(seen.paid).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath("autosave-atomik-legacy.png") });
});

test("the Suites shell: a new project opens the board with Atomik's panel, without a save-first line", async ({ page }, info) => {
  test.skip(isCompact(info), "the phone app has no first-run card and no docked panel: its Home starts a project (r1-phone-start-workbench) and its Atomik sheet is priced before it is asked (demo-s10-phone-make-workbench)");
  const seen = watch(page);
  await signInLocally(page.request);
  /* Release 1: Studio's home is gone; an empty workspace's board shows the first-run card (New project, Explore the starter production). */
  await page.goto("/suites?view=board");
  await page.getByTestId("first-run-new").first().click({ timeout: 60_000 });
  await page.getByTestId("first-run-new-name").fill("Autosave suites film");
  await page.keyboard.press("Enter");
  await expect.poll(() => seen.saves.length, { timeout: 8000 }).toBeGreaterThan(0);
  /* Release 1: Atomik's old Agent page is gone; Atomik is the board's docked panel (its ask box and the price on its button). */
  await expect(page.getByTestId("board")).toBeVisible({ timeout: 60_000 });
  const dock = page.getByTestId("board-agent-dock");
  await expect(dock).toBeVisible();
  await expect(async () => {
    if ((await dock.getAttribute("data-open")) !== "true") await dock.getByTestId("agent-rail").click({ timeout: 3000 });
    await expect(dock).toHaveAttribute("data-open", "true", { timeout: 3000 });
  }).toPass({ timeout: 30_000 });
  const panel = page.getByTestId("board-agent-panel");
  await panel.getByTestId("agent-input").fill("Plan a short film about a lighthouse keeper");
  /* The ask is priced before it is pressed, and it is never pressed here. */
  await expect(panel.getByTestId("agent-ask")).toHaveText(/^Ask · up to [\d.,]+ cr$/, { timeout: 30_000 });
  await page.waitForTimeout(2500);
  expect(await textOf(page)).not.toMatch(SAVE_FIRST);
  expect(seen.refused).toEqual([]);
  expect(seen.paid).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath("autosave-atomik-suites.png") });
});
