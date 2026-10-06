import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject } from "../lib/workbench/studio";
import { DESKTOP, PHONE, forbidPaidWork } from "./helpers/workspaceFixtures";

/*
 * Release 1 CI, C3 · Make keeps the words a person typed. The panel (and the phone's screen) unmount when Make is closed,
 * when the page reloads (a dev server that has just compiled a route, a deploy) and when a failed tile's Try again
 * refreshes the route; the words used to go with them. They are kept per person and workspace (lib/draft.ts, the same
 * store the old composer used) and cleared only when a render is accepted. Nothing is sent: forbidPaidWork.
 */
const WORDS = "a fox crossing a frozen harbour";

async function setUp(page: Page) {
  const workspaceId = (await signInLocally(page.request, "Words Tester")).workspace.id;
  const me = await (await page.request.get("/api/me")).json() as { id: string };
  const scope = `particl-active-${workspaceId}-${me.id}`;
  const project = newProject("Words fixture");
  const saved = await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.addInitScript(({ scope, id }) => { try { if (!sessionStorage.getItem("seeded")) { localStorage.setItem(scope, id); sessionStorage.setItem("seeded", "1"); } } catch { /* storage off */ } }, { scope, id: project.id });
  await forbidPaidWork(page);
}
/** Draft writes wait a beat (lib/draft.ts); a reload before they land would be the test's doing, not Make's. */
const written = (page: Page) => page.waitForFunction((words) => Object.entries(localStorage).some(([key, value]) => key.startsWith("aw_draft:make:") && value === words), WORDS);

test("desktop: the words are still in Make after closing it, after Recent, and after a reload", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "the panel (the phone's Make is the next test)");
  await setUp(page);
  await page.goto("/suites?make=video");
  /* The project has opened (the page is hydrated and settled): typing before that is the page's own race, not Make's. */
  await expect(page.locator('[data-suite-tab="project"]')).toContainText("Words fixture");
  const prompt = page.getByTestId("gen-prompt");
  await prompt.fill(WORDS);

  await page.getByTestId("make-tab-recent").click();
  await page.getByTestId("make-tab-make").click();
  await expect(prompt, "Make, Recent, Make").toHaveValue(WORDS);

  await written(page);
  await page.getByTestId("make-close").click();
  await expect(page.getByTestId("make-panel")).toHaveCount(0);
  await page.locator('[data-suite-tab="make"]').click();
  await expect(page.getByTestId("gen-prompt"), "closed and opened again").toHaveValue(WORDS);

  await page.reload();
  await expect(page.getByTestId("gen-prompt"), "after a reload").toHaveValue(WORDS);
  await expect(page.getByTestId("gen-generate")).toBeVisible();
});

test("phone: the words are still in Make after a reload", async ({ page }, info) => {
  test.skip(!PHONE.includes(info.project.name), "phone widths");
  await setUp(page);
  await page.goto("/suites?screen=make");
  await expect(page.getByTestId("phone-make-go")).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.has("project")).toBe(true);
  await page.getByTestId("phone-make-prompt").fill(WORDS);
  await written(page);
  await page.reload();
  await expect(page.getByTestId("phone-make-prompt")).toHaveValue(WORDS);
});
