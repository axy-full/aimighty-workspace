import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { legacyShell } from "./helpers/legacyShell";

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

test("the Suites shell: a new project opens Atomik's Agent without a save-first line", async ({ page }, info) => {
  const seen = watch(page);
  await signInLocally(page.request);
  await page.goto("/suites");
  await page.getByTestId("first-run-new").first().click();
  await page.getByTestId("first-run-new-name").fill("Autosave suites film");
  await page.keyboard.press("Enter");
  await expect.poll(() => seen.saves.length, { timeout: 8000 }).toBeGreaterThan(0);
  await page.goto("/suites?suite=atomik&page=agent");
  await expect(page.getByText("Production orchestrator")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(2500);
  expect(await textOf(page)).not.toMatch(SAVE_FIRST);
  expect(seen.refused).toEqual([]);
  expect(seen.paid).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath("autosave-atomik-suites.png") });
});
