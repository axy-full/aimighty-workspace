import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { parseWorkflowCatalog } from "../lib/higgsfield-consumer/workflows";
import { legacyShell } from "./helpers/legacyShell";

/**
 * The connected account's workflows as Atomik recipes (A5 + A6): listed on the
 * Recipes page and in the composer's `/` menu, neutral in copy, and inserted
 * as `/name ` for the owner to add a brief. Running one is an ordinary
 * planning turn whose paid steps are each priced for approval.
 */
const recipes = parseWorkflowCatalog(JSON.parse(readFileSync("tests/fixtures/connected-workflows.json", "utf8")).catalog);
async function fixture(page: Page) {
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((response) => response.json());
  me.owner = true;
  const project: Project = { ...newProject("Atomik film"), id: "atomik-draft", productionProjectId: "actual-production" };
  const quotes: unknown[] = [], unexpected: string[] = [], errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => (["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort("blockedbyclient")));
  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const json = (value: unknown, status = 200) => route.fulfill({ status, json: value });
    if (path === "/api/me") return json(me);
    if (path === "/api/atomik/recipes") return json({ recipes });
    if (path === "/api/atomik" && request.method() === "GET") return json({ chats: [], models: { featured: [], rest: [] }, engines: [] });
    if (path === "/api/atomik" && request.method() === "POST") {
      const body = request.postDataJSON();
      quotes.push(body);
      return json({ model: "auto", effort: "auto", estimateCredits: 3, estimateUsd: 0.3 });
    }
    if (path === "/api/workbench/projects") return json({ project, projects: [{ id: project.id, name: project.name }], revision: 1, productions: [] });
    if (path === "/api/workbench/atomik") return json({ configured: false, models: [], jobs: [] });
    if (path === "/api/projects") return json({ projects: [] });
    if (path === "/api/pipelines") return json({ runs: [], publications: [], models: [], audioModels: { speech: [], sound: "", music: "" } });
    if (path === "/api/jobs") return json({ generations: [], nextCursor: null, nextPageCursor: null });
    if (path === "/api/settings") return json({ settings: {}, models: { image: "", video: "", text: {} } });
    if (request.method() !== "GET") { unexpected.push(`${request.method()} ${path}`); return json({ error: "No other mutation permitted." }, 409); }
    return json({});
  });
  return { quotes, unexpected, errors };
}
const composer = (page: Page) => page.getByRole("textbox", { name: "Ask Atomik", exact: true }).filter({ visible: true }).first();

test("connected recipes are listed neutrally and Use in Atomik starts a /recipe in the composer", async ({ page }) => {
  const state = await fixture(page);
  await page.goto(await legacyShell(page, "/atomik?project=atomik-draft&page=recipes"));
  const section = page.getByRole("region", { name: "Connected recipes", exact: true });
  await expect(section.getByRole("heading", { name: "/character-sheet", exact: true })).toBeVisible();
  await expect(section.locator("article")).toHaveCount(13);
  const copy = (await section.innerText()).toLowerCase();
  for (const word of ["higgsfield", "higgsedit", "supercomputer", "/subtitles", "/website-builder-flow", "/video-editing"]) expect(copy).not.toContain(word);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await section.locator("article").filter({ hasText: "/character-sheet" }).getByRole("button", { name: "Use in Atomik", exact: true }).click();
  await expect(composer(page)).toHaveValue("/character-sheet ");
  await expect(page.getByText("Recipe /character-sheet from the connected account · every paid step is priced for your approval.").filter({ visible: true }).first()).toBeVisible();
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("typing / in the composer offers the recipes and a pick inserts /name before any price is asked", async ({ page }) => {
  const state = await fixture(page);
  await page.goto(await legacyShell(page, "/atomik?project=atomik-draft&page=generate"));
  if (!(await composer(page).isVisible().catch(() => false)))
    await page.getByRole("button", { name: /Toggle Atomik creative engine|Ask Atomik/ }).filter({ visible: true }).first().click();
  await composer(page).fill("/ugc");
  const menu = page.getByRole("listbox", { name: "Recipes", exact: true }).filter({ visible: true }).first();
  await expect(menu.getByRole("option")).toHaveCount(6);
  await menu.getByRole("option", { name: /\/ugc-review-video/ }).click();
  await expect(composer(page)).toHaveValue("/ugc-review-video ");
  // A bare /name is not priced; a brief is.
  expect(state.quotes).toEqual([]);
  await composer(page).fill("/ugc-review-video a reusable bottle, 20 seconds");
  await expect.poll(() => state.quotes.length).toBeGreaterThan(0);
  expect(state.quotes.at(-1)).toMatchObject({ quoteOnly: true, text: "/ugc-review-video a reusable bottle, 20 seconds" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});
