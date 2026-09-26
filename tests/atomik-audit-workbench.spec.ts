import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { legacyShell } from "./helpers/legacyShell";

/**
 * Audit fixes, 25 September, in the browser:
 * - Treatment: a save made against a stale copy merges instead of erasing
 *   what another session saved.
 *
 * Suites › Atomik's Recipes and Models, and the rule library on Workspace ›
 * General, are main's (#361, #357) and are covered by its own specs.
 */
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test("Treatment: a save against a stale copy merges with what another session saved", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 1024, "the three-column treatment editor is a desktop surface");
  await signInLocally(page.request);
  const made = await page.request.post("/api/projects", { data: { name: "Merge film" } });
  expect(made.ok(), await made.text()).toBeTruthy();
  const { id } = await made.json() as { id: string };
  const doc = { title: "Merge film", logline: "A kitchen.", setup: {}, scenes: [{ n: 1, title: "Kettle", secs: 5, prose: "The kettle." }], notes: [] };
  const first = await page.request.put("/api/atomik/treatment", { data: { projectId: id, ...doc, expectedUpdatedAt: null } });
  expect(first.ok(), await first.text()).toBeTruthy();
  const loaded = (await first.json()).treatment as { updatedAt: number };
  await page.addInitScript((project) => { try { localStorage.setItem("aw_project", project); } catch { /* storage off */ } }, id);
  await page.goto(await legacyShell(page, "/atomik/treatment"));
  const logline = page.getByRole("textbox", { name: "Logline" });
  await expect(logline).toHaveValue("A kitchen.");

  // Another session saves a note and a new scene title in the meantime.
  const theirs = await page.request.put("/api/atomik/treatment", { data: { projectId: id, ...doc, scenes: [{ ...doc.scenes[0], title: "Kettle boils" }], notes: [{ id: "n_theirs", by: "Other", scene: 1, text: "Theirs.", at: 5 }], expectedUpdatedAt: loaded.updatedAt } });
  expect(theirs.ok(), await theirs.text()).toBeTruthy();
  // A stale save is refused outright over the API.
  expect((await page.request.put("/api/atomik/treatment", { data: { projectId: id, ...doc, expectedUpdatedAt: loaded.updatedAt } })).status()).toBe(409);

  await logline.fill("A kitchen at dawn.");
  await expect(page.getByRole("status").filter({ hasText: "Merged with another session" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Scene title" })).toHaveValue("Kettle boils");
  await expect.poll(async () => {
    const saved = await (await page.request.get(`/api/atomik/treatment?projectId=${encodeURIComponent(id)}`)).json();
    return { logline: saved.treatment.logline, title: saved.treatment.scenes[0]?.title, notes: saved.treatment.notes.map((n: { id: string }) => n.id) };
  }).toEqual({ logline: "A kitchen at dawn.", title: "Kettle boils", notes: ["n_theirs"] });
  expect(await noOverflow(page)).toBeLessThanOrEqual(1);
});
