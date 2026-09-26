import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { signInLocally } from "./helpers/workbenchLocal";
import { legacyShell } from "./helpers/legacyShell";
import { newProject, type Project } from "../lib/workbench/studio";
import { parseWorkflowCatalog } from "../lib/higgsfield-consumer/workflows";

/**
 * Audit fixes, 25 September, in the browser:
 * - Atomik › Recipes in the new shells (/workspace; /suites mounts the same
 *   tool): there is no Atomik rail, so the conversation is mounted beside the
 *   connected recipes and "Use in Atomik" writes into a composer that exists.
 *   Models no longer shows a picker that changed nothing.
 * - Workspace › General: the rule library can be read, written and switched.
 * - Treatment: a save made against a stale copy merges instead of erasing
 *   what another session saved.
 */
const recipes = parseWorkflowCatalog(JSON.parse(readFileSync("tests/fixtures/connected-workflows.json", "utf8")).catalog);
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function atomikFixture(page: Page, withStep = false) {
  await signInLocally(page.request);
  const project: Project = { ...newProject("Atomik film"), id: "atomik-draft", productionProjectId: "actual-production" };
  const quotes: Record<string, unknown>[] = [], patches: { url: string; body: unknown }[] = [], unexpected: string[] = [], errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => (["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort("blockedbyclient")));
  const step = { id: "astp_1", chatId: "ach_1", messageId: "amsg_1", position: 0, kind: "video", title: "Bottle hero", prompt: "A bottle on wet stone.", model: "dreamina-seedance-2-5-260628",
    params: { seconds: 20, resolution: "480p", ratio: "16:9" }, refs: [], status: "proposed", genId: null, estCostUsd: 1.2, error: null, createdAt: 1 };
  const chat = { id: "ach_1", projectId: "actual-production", title: "Bottle film", model: "auto", agentMode: "ask", status: "waiting", textCostUsd: 0.01, createdBy: "u", createdAt: 1, updatedAt: 2 };
  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const json = (value: unknown, status = 200) => route.fulfill({ status, json: value });
    if (path === "/api/atomik/recipes") return json({ recipes });
    if (path === "/api/atomik" && request.method() === "GET")
      return json({ chats: withStep ? [{ ...chat, needsApproval: true }] : [], models: { featured: [], rest: [] },
        engines: [{ id: "dreamina-seedance-2-5-260628", label: "Seedance 2.5", kind: "video", own: true, note: "", ratios: [], resolutions: [], durations: [], supportsAudio: true },
          { id: "fal-ai/kling-video/v3/standard", label: "Kling 3.0", kind: "video", own: true, note: "", ratios: [], resolutions: [], durations: [], supportsAudio: true }] });
    if (path === "/api/atomik" && request.method() === "POST") {
      quotes.push(request.postDataJSON());
      return json({ model: "auto", effort: "auto", estimateCredits: 3, estimateUsd: 0.3 });
    }
    if (path === "/api/atomik/ach_1" && request.method() === "GET")
      return json({ chat, messages: [{ id: "amsg_1", chatId: "ach_1", role: "assistant", text: "One hero shot of the bottle.", activity: [], ask: null, attachments: [], workedMs: 1, costUsd: 0.01, model: "auto", createdAt: 2 }], steps: [step] });
    if (path === "/api/atomik/steps/astp_1" && request.method() === "PATCH") {
      patches.push({ url: path, body: request.postDataJSON() });
      return json({ ...step, model: "fal-ai/kling-video/v3/standard", params: { seconds: 15, resolution: "1080p", ratio: "16:9" } });
    }
    if (path === "/api/workbench/projects") return json({ project, projects: [{ id: project.id, name: project.name }], revision: 1, productions: [] });
    if (path === "/api/workbench/atomik") return json({ configured: false, models: [], jobs: [] });
    if (path === "/api/projects") return json({ projects: [{ id: "actual-production", name: "Atomik film", description: "", createdAt: 1, genCount: 0, spend: 0 }] });
    if (path === "/api/pipelines") return json({ runs: [], publications: [], models: [], audioModels: { speech: [], sound: "", music: "" } });
    if (path === "/api/jobs") return json({ generations: [], nextCursor: null, nextPageCursor: null });
    if (path === "/api/settings") return json({ settings: {}, models: { image: "gemini-3-pro-image", video: "dreamina-seedance-2-5-260628", text: { shot: "auto" } } });
    if (request.method() !== "GET") { unexpected.push(`${request.method()} ${path}`); return json({ error: "No other mutation permitted." }, 409); }
    return route.fallback();
  });
  return { quotes, patches, unexpected, errors };
}

/* Recipes is a desktop page of /workspace: the phone shell shows the suite as
   spec cards, with no Use in Atomik, and its Ask Atomik is the action bar's. */
const PHONE_SHELL = "the phone shell has no Atomik suite tools";

test("Workspace › Atomik › Recipes: Use in Atomik writes the recipe into the conversation mounted beside it", async ({ page, isMobile }) => {
  test.skip(isMobile, PHONE_SHELL);
  const state = await atomikFixture(page);
  await page.goto("/workspace?project=atomik-draft&suite=atomik&page=recipes");
  const section = page.getByRole("region", { name: "Connected recipes", exact: true });
  await expect(section.getByRole("heading", { name: "/character-sheet", exact: true })).toBeVisible();
  const conversation = section.getByRole("region", { name: "Atomik conversation" });
  await expect(conversation).toBeVisible();
  await section.locator("article").filter({ hasText: "/character-sheet" }).getByRole("button", { name: "Use in Atomik", exact: true }).click();
  const composer = conversation.getByRole("textbox", { name: "Ask Atomik", exact: true });
  await expect(composer).toHaveValue("/character-sheet ");
  await expect(composer).toBeFocused();
  await expect(conversation.getByText("Recipe /character-sheet from the connected account · every paid step is priced for your approval.")).toBeVisible();
  // A bare /name is not priced; a brief is, and it is filed on this project's production.
  expect(state.quotes).toEqual([]);
  await composer.fill("/character-sheet a sailor in a yellow coat");
  await expect.poll(() => state.quotes.length).toBeGreaterThan(0);
  expect(state.quotes.at(-1)).toMatchObject({ quoteOnly: true, text: "/character-sheet a sailor in a yellow coat", projectId: "actual-production" });
  await expect(conversation.getByRole("button", { name: /Send · 3 cr estimated/ })).toBeEnabled();
  expect(await noOverflow(page)).toBeLessThanOrEqual(1);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("Atomik without a rail: a proposed step is re-engined from the inline card", async ({ page, isMobile }) => {
  test.skip(isMobile, PHONE_SHELL);
  const state = await atomikFixture(page, true);
  await page.goto("/workspace?project=atomik-draft&suite=atomik&page=recipes");
  const conversation = page.getByRole("region", { name: "Atomik conversation" });
  await expect(conversation.getByText("One hero shot of the bottle.")).toBeVisible();
  const card = conversation.getByRole("group", { name: "Checkpoint" });
  await expect(card.getByRole("button", { name: /Continue/ })).toBeVisible();
  for (const button of await card.getByRole("button").all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await card.getByRole("button", { name: "Change engine" }).click();
  await page.getByRole("menuitem", { name: "Kling 3.0" }).click();
  await expect.poll(() => state.patches.length).toBe(1);
  // The engine alone: the server snaps the settings to it and re-prices.
  expect(state.patches[0].body).toEqual({ model: "fal-ai/kling-video/v3/standard" });
  expect(await noOverflow(page)).toBeLessThanOrEqual(1);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("Suites › Atomik › Models: no thinking-model picker that nothing reads", async ({ page }) => {
  const state = await atomikFixture(page);
  await page.goto("/suites?suite=atomik&page=models&project=atomik-draft");
  await expect(page.getByRole("heading", { name: "Effective routing" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Atomik thinking" })).toHaveCount(0);
  expect(await noOverflow(page)).toBeLessThanOrEqual(1);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("Workspace › General: the rule library is read, written, switched and removed", async ({ page }) => {
  await signInLocally(page.request);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/suites?view=workspace&tab=general");
  const card = page.getByTestId("ws-rules");
  await expect(card).toBeVisible();
  await expect(card.getByRole("button", { name: /Show \d+ inherited/ })).toBeVisible();
  await card.getByRole("textbox", { name: "New rule" }).fill("No logos in the first frame.");
  await card.getByTestId("ws-rule-add").click();
  const mine = card.locator('[data-testid="ws-rule"][data-source="workspace"]');
  await expect(mine).toHaveCount(1);
  await expect(mine.getByRole("textbox", { name: "Rule" })).toHaveValue("No logos in the first frame.");
  const own = mine.getByRole("switch");
  await expect(own).toHaveAttribute("aria-checked", "true");
  await own.click();
  await expect(own).toHaveAttribute("aria-checked", "false");

  await card.getByRole("button", { name: /Show \d+ inherited/ }).click();
  const inherited = card.locator('[data-testid="ws-rule"][data-source="platform"]');
  await expect(inherited.first()).toBeVisible();
  const first = inherited.first().getByRole("switch");
  const was = await first.getAttribute("aria-checked");
  await first.click();
  await expect(first).toHaveAttribute("aria-checked", was === "true" ? "false" : "true");
  if (was === "true") await expect(card.getByRole("button", { name: /Hide \d+ inherited · 1 off/ })).toBeVisible();
  const phone = (page.viewportSize()?.width ?? 1440) < 768;
  if (phone) for (const control of [first, own, mine.getByRole("button", { name: "Remove" })]) expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await noOverflow(page)).toBeLessThanOrEqual(1);
  // Put the platform rule back, then remove our own (archived, not erased).
  await first.click();
  await mine.getByRole("button", { name: "Remove" }).click();
  await page.getByRole("button", { name: "Remove", exact: true }).last().click();
  await expect(mine).toHaveCount(0);
  expect(errors).toEqual([]);
});

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
