import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { joinLocallyAsMember, signInLocally } from "./helpers/workbenchLocal";
import { thinkingModelNames } from "./helpers/uiStrings";
import { smallTargets, smallText } from "./phoneFloors";

/*
 * Atomik's Thinking for the workspace (design/particl-v31.16/README.txt: "Settings › Workspace has 'Thinking · default for new
 * productions · admins only'. No vendor, version or effort is named."), drawn today in Settings › Advanced › Workspace, on the real
 * routes of the local ENGINE_MOCK=1 server with nothing answered by the browser:
 *  - an admin picks High · Medium · Low; it saves itself (PATCH /api/settings `atomikThinking`), persists across a reload, and the
 *    toast's Undo puts the old level back (rule 13: Undo, never a confirmation);
 *  - a member reads the level and has nothing to press, and the route refuses a member's write (403);
 *  - no thinking model, version or effort is on the screen, and no model or effort word;
 *  - Settings' floors: no horizontal scroll, text 12 px and up and at least 55% white, 44 px targets on a phone (rules 7, 15).
 * Nothing here spends: the level changes what a later Atomik turn is quoted at, and nothing is quoted or run.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const compact = (page: Page) => (page.viewportSize()?.width ?? 1440) < 768 || (page.viewportSize()?.height ?? 900) <= 500;
const PAGE = "/suites?view=workspace&tab=advanced&open=workspace";

async function settingsOf(api: APIRequestContext) {
  const body = await (await api.get("/api/settings")).json() as { settings: Record<string, string>; defaults: Record<string, string> };
  return body;
}
const levelOf = async (api: APIRequestContext) => { const body = await settingsOf(api); return body.settings.atomikThinking ?? body.defaults.atomikThinking; };

async function floors(page: Page, where: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${where}: no horizontal page scroll`).toBe(true);
  expect(await smallText(page, ".gx-header, header"), `${where}: text under 12px`).toEqual([]);
  if (compact(page)) expect(await smallTargets(page, ".gs"), `${where}: targets under 44×44`).toEqual([]);
  /* The row's words: at least 12 px and at least 55% white on the page's black (rule 15). */
  const dim = await page.getByTestId("settings-thinking").evaluate((row) => [...row.querySelectorAll<HTMLElement>(".gs-row-name, .gs-row-line, .gs-row-v, button:not(:disabled)")].flatMap((el) => {
    const style = getComputedStyle(el);
    const [r, g, b, a = 1] = (style.color.match(/[\d.]+/g) ?? []).map(Number);
    const white = (Math.max(r, g, b) / 255) * a;
    return white < 0.55 || parseFloat(style.fontSize) < 12 ? [`${el.textContent}: ${style.color} ${style.fontSize}`] : [];
  }));
  expect(dim, `${where}: dim or small words in the Thinking row`).toEqual([]);
}

/** No thinking model, version or effort setting in what the person reads, and no model or effort word in the Workspace fold. */
async function namesNoModel(page: Page) {
  expect(thinkingModelNames(await page.getByTestId("settings-view").innerText())).toEqual([]);
  await expect(page.getByTestId("settings-fold-workspace")).not.toContainText(/\bmodels?\b|\beffort\b/i);
}

test("an admin sets Thinking High · Medium · Low: it saves itself, Undo puts it back, and it persists", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  await signInLocally(page.request, "Thinking Admin");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(PAGE);
  const row = page.getByTestId("settings-thinking");
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row).toContainText("Thinking");
  await expect(row).toContainText("Default for new productions · admins only");
  await expect(row.getByRole("radio")).toHaveText(["High", "Medium", "Low"]);
  /* Medium is the default, as the server reads it (lib/atomikThinking.ts). */
  await expect(page.getByTestId("settings-thinking-medium")).toHaveAttribute("aria-checked", "true");
  await floors(page, "Thinking (admin)");
  await namesNoModel(page);
  /* A keyboard reaches it, with a visible ring. */
  await page.getByTestId("settings-thinking-high").focus();
  expect(await page.getByTestId("settings-thinking-high").evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe("none");

  /* High saves itself; the toast offers Undo, which writes Medium back. */
  await page.getByTestId("settings-thinking-high").click();
  await expect.poll(() => levelOf(page.request)).toBe("high");
  await expect(page.getByTestId("settings-thinking-high")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("toast")).toContainText("Thinking: High.");
  await page.getByTestId("toast").getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => levelOf(page.request)).toBe("medium");
  await expect(page.getByTestId("settings-thinking-medium")).toHaveAttribute("aria-checked", "true");

  /* Low, then a reload: what was saved is what is shown. */
  await page.getByTestId("settings-thinking-low").click();
  await expect.poll(() => levelOf(page.request)).toBe("low");
  await page.reload();
  await expect(page.getByTestId("settings-thinking-low")).toHaveAttribute("aria-checked", "true", { timeout: 20_000 });
  /* What the settings read sends for it is the level, never a model or an effort. */
  const read = await settingsOf(page.request);
  expect(thinkingModelNames(JSON.stringify([read.settings, read.defaults]))).toEqual([]);

  /* Tools › Thinking opens the Workspace fold's Thinking, from inside Advanced too. */
  await page.goto("/suites?view=workspace&tab=advanced");
  await expect(page.getByTestId("settings-fold-workspace")).not.toHaveAttribute("data-open", "true", { timeout: 20_000 });
  await page.getByTestId("settings-fold-tools-toggle").click();
  const reach = page.getByTestId("settings-reach").filter({ hasText: "High · Medium · Low, for every production" });
  await expect(reach).toHaveCount(1);
  await expect(page.getByTestId("settings-fold-tools")).not.toContainText(/thinking models?|how hard it thinks/i);
  await reach.getByTestId("settings-reach-open").click();
  await expect(page.getByTestId("settings-fold-workspace")).toHaveAttribute("data-open", "true");
  await expect(page.getByTestId("settings-thinking-low")).toHaveAttribute("aria-checked", "true");
  expect(errors).toEqual([]);
});

test("a member reads Thinking and has nothing to press; the route refuses a member's write", async ({ page, playwright }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const owner = await playwright.request.newContext({ baseURL: process.env.PW_BASE_URL });
  try {
    const { workspace } = await joinLocallyAsMember(owner, page.request);
    const ownerMe = await (await owner.get("/api/me")).json() as { id: string };
    const set = await owner.patch("/api/settings", { headers: { "X-Workbench-Scope": `particl-active-${workspace.id}-${ownerMe.id}` }, data: { atomikThinking: "high" } });
    expect(set.ok(), await set.text()).toBe(true);
    const me = await (await page.request.get("/api/me")).json() as { id: string };
    const refused = await page.request.patch("/api/settings", { headers: { "X-Workbench-Scope": `particl-active-${workspace.id}-${me.id}` }, data: { atomikThinking: "low" } });
    expect(refused.status()).toBe(403);
    expect(await levelOf(page.request)).toBe("high");

    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(PAGE);
    const row = page.getByTestId("settings-thinking");
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row.locator(".gs-row-v")).toHaveText("High");
    await expect(row).toContainText("admins only");
    await expect(row.getByRole("radio")).toHaveCount(0);
    await expect(row.getByRole("button")).toHaveCount(0);
    await floors(page, "Thinking (member)");
    await namesNoModel(page);
    expect(errors).toEqual([]);
  } finally {
    await owner.dispose();
  }
});
