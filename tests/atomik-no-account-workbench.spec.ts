import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { legacyShell } from "./helpers/legacyShell";

/**
 * Atomik without a signed-in account (owner, 28 September 2026: API-key and
 * loginless offerings only; Atomik plans on Claude, OpenAI and Grok).
 *
 * The agent's rail and phone sheet show an older plan made on the connected
 * account read-only — no Continue, no account price, no Change engine — and
 * nothing in Atomik asks the account: no connected step route, no recipes, no
 * account route at all. A chat saved on Gemini plans with Auto and says why;
 * the picker offers Claude, OpenAI and Grok; `/` is ordinary text. Atomik ›
 * Generate points to Gen. Every route is mocked in the page; nothing is priced
 * or sent.
 */
const SEEDANCE = "dreamina-seedance-2-5-260628";
const NOTE = "Gemini is no longer offered in Atomik, which now plans with Claude, OpenAI and Grok. This chat now uses Auto.";
const READ_ONLY = "Planned on the connected account, which Atomik no longer uses. Kept read-only.";
const meta = {
  model: "kling3_0", type: "video", modelName: "Kling 3.0", jobId: "11111111-1111-4111-8111-000000000001", draftId: "atomik-draft", credits: 42,
  workspaceId: "22222222-2222-4222-8222-222222222222", workspaceName: "Studio wallet", quoteExpiresAt: 1,
  input: { type: "video", model: "kling3_0", prompt: "A slow push in on a bottle.", parameters: { duration: 5 }, medias: [] },
};
const thinking = (id: string, name: string) => ({ id, name, owner: id.split("/")[0], description: "", band: "Medium cost", efforts: [{ value: "auto", label: "Auto" }], vision: true });

type Options = { steps?: "account" | "none"; modelNote?: boolean };
async function fixture(page: Page, options: Options = {}) {
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((response) => response.json());
  me.owner = true;
  const project: Project = { ...newProject("Atomik film"), id: "atomik-draft", productionProjectId: "actual-production" };
  const chat = { id: "ach_1", projectId: null, title: "Bottle spot", model: "auto", agentMode: "ask", status: "waiting", createdBy: me.id, createdAt: 1, updatedAt: 2,
    ...(options.modelNote ? { modelNote: NOTE } : {}) };
  const account = (id: string, position: number, status: string, genId: string | null) => ({
    id, chatId: "ach_1", messageId: "amsg_2", position, kind: "video", title: position ? "Pull out" : "Push in", prompt: "A slow push in on a bottle.",
    model: "connected:kling3_0", params: { connected: { ...meta, jobId: `11111111-1111-4111-8111-00000000000${position + 1}` } }, refs: [], status, genId, estCostUsd: null, error: null, createdAt: 3,
  });
  const steps = options.steps === "account" ? [account("astp_1", 0, "proposed", null), account("astp_2", 1, "done", "gen_kept")] : [];
  const messages = [
    { id: "amsg_1", chatId: "ach_1", role: "user", text: "A bottle spot.", activity: [], ask: null, attachments: [], workedMs: null, model: "", createdAt: 1 },
    { id: "amsg_2", chatId: "ach_1", role: "assistant", text: "Two shots.", activity: [], ask: null, attachments: [], workedMs: 1, model: "auto", createdAt: 2 },
  ];
  const engines = [{ id: SEEDANCE, label: "Seedance 2.5", kind: "video", note: "4-12s, 480p/720p/1080p", own: true, ratios: ["16:9"], resolutions: ["1080p"], durations: [5], supportsAudio: true }];
  const models = { featured: [thinking("anthropic/claude-sonnet-4.6", "Claude Sonnet 4.6"), thinking("openai/gpt-5.5", "GPT-5.5"), thinking("spacexai/grok-4.7", "Grok 4.7")], rest: [] };
  const unexpected: string[] = [], quotes: unknown[] = [], errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => (["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort("blockedbyclient")));
  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const json = (value: unknown, status = 200) => route.fulfill({ status, json: value });
    /* Nothing in Atomik may reach the account, its recipes or a connected step. */
    if (path.startsWith("/api/higgsfield/consumer/") || path === "/api/atomik/recipes" || path.endsWith("/connected")) {
      unexpected.push(`${request.method()} ${path}`);
      return json({ error: "Atomik reaches no signed-in account." }, 409);
    }
    if (path === "/api/me") return json(me);
    if (path === "/api/atomik") return json({ chats: [{ ...chat, needsApproval: false }], models, engines });
    if (path === "/api/atomik/ach_1") {
      if (request.method() === "POST" && request.postDataJSON()?.quoteOnly === true) {
        quotes.push(request.postDataJSON());
        return json({ model: "anthropic/claude-sonnet-4.6", effort: "auto", estimateCredits: 3 });
      }
      if (request.method() !== "GET") { unexpected.push(`${request.method()} ${path}`); return json({ error: "No turn is run here." }, 409); }
      return json({ chat, messages, steps });
    }
    if (path.startsWith("/api/atomik/steps/")) { unexpected.push(`${request.method()} ${path}`); return json({ error: "Read-only." }, 409); }
    if (path === "/api/workbench/projects") return json({ project, projects: [{ id: project.id, name: project.name }], revision: 1, productions: [] });
    if (path === "/api/workbench/atomik") return json({ configured: false, models: [], jobs: [] });
    if (path === "/api/projects") return json({ projects: [] });
    if (path === "/api/pipelines") return json({ runs: [], publications: [], models: [], audioModels: { speech: [], sound: "", music: "" } });
    if (path === "/api/jobs") return json({ generations: [], nextCursor: null, nextPageCursor: null });
    if (path === "/api/settings") return json({ settings: {}, models: { image: "", video: "", text: {} } });
    if (request.method() !== "GET") { unexpected.push(`${request.method()} ${path}`); return json({ error: "No other mutation permitted." }, 409); }
    return json({});
  });
  return { unexpected, quotes, errors };
}

const phone = (page: Page) => page.viewportSize()!.width < 760;
/** The rail on a desktop, the sheet on a phone: opened with ⌘J / Ctrl+J, as a person would. */
async function openAtomik(page: Page) {
  await page.keyboard.press("Control+j");
  const surface = phone(page) ? page.getByRole("dialog", { name: "Atomik" }) : page.getByRole("complementary", { name: "Atomik" });
  await expect(surface).toBeVisible();
  return surface;
}
const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test("an older plan made on the connected account is shown read-only: no Continue, no account price, and nothing asks the account", async ({ page }) => {
  const state = await fixture(page, { steps: "account" });
  await page.goto(await legacyShell(page, "/atomik?project=atomik-draft&page=generate"));
  /* Atomik › Generate points to Gen; it no longer generates on an account. */
  const moved = page.getByTestId("atomik-generate-moved");
  await expect(moved).toContainText("Single generations run in Gen, on Particl’s own engines");
  await expect(moved.getByRole("link", { name: "Open Gen" })).toHaveAttribute("href", "/suites?view=gen");

  const surface = await openAtomik(page);
  await expect(surface).toContainText("Read-only");
  await expect(surface).toContainText(READ_ONLY);
  await expect(surface.getByRole("button", { name: /^Continue/ })).toHaveCount(0);
  await expect(surface.getByRole("button", { name: "Change engine", exact: true })).toHaveCount(0);
  /* Expanded, each step is listed with what it was, read-only. */
  await surface.getByRole("button", { name: /^Expand/ }).click();
  const rows = page.locator("[data-read-only]");
  await expect(rows).toHaveCount(2);
  for (const row of await rows.all()) {
    await expect(row).toContainText("Read-only");
    await expect(row).toContainText("Connected account");
  }
  await expect(page.getByRole("button", { name: /^Continue/ })).toHaveCount(0);
  const copy = (await page.locator("body").innerText()).toLowerCase();
  expect(copy).not.toContain("connected cr");
  expect(copy).not.toContain("higgsfield");
  expect(copy).not.toContain("connected recipes");
  expect(copy).not.toContain("/ for recipes");
  expect(await noSideways(page)).toBeLessThanOrEqual(1);
  /* The composer is Particl's own: nothing is typed, so nothing is quoted. */
  expect(state.quotes).toEqual([]);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("a chat saved on Gemini plans with Auto and says why; the picker offers Claude, OpenAI and Grok; a slash is ordinary text", async ({ page }) => {
  const state = await fixture(page, { modelNote: true });
  await page.goto(await legacyShell(page, "/atomik?project=atomik-draft&page=generate"));
  const surface = await openAtomik(page);
  await expect(surface.getByTestId("atomik-model-note")).toHaveText(NOTE);
  const picker = surface.getByRole("button", { name: "Chat thinking model" });
  await expect(picker).toContainText("Auto");
  await picker.click();
  const families = page.getByRole("group", { name: "Filter thinking models by family" });
  await expect(families.getByRole("button")).toHaveText(["All", "Claude", "Grok", "OpenAI"]);
  await expect(page.getByRole("listbox", { name: "Thinking models" })).not.toContainText("Gemini");
  /* Choosing Auto on purpose closes the picker; the chat plans with it. */
  await page.getByRole("listbox", { name: "Thinking models" }).getByRole("option", { name: "Auto" }).click();
  await expect(page.getByRole("listbox", { name: "Thinking models" })).toHaveCount(0);

  /* No recipes: a message that starts with a slash is quoted and sent as it is. */
  const ask = surface.getByRole("textbox", { name: "Ask Atomik" });
  await expect(ask).toHaveAttribute("placeholder", "Ask Atomik…");
  await ask.fill("/character-sheet a hero for the bottle spot");
  await expect(surface.getByRole("listbox", { name: "Recipes" })).toHaveCount(0);
  await expect.poll(() => state.quotes.length).toBeGreaterThan(0);
  expect(state.quotes.at(-1)).toMatchObject({ text: "/character-sheet a hero for the bottle spot", model: "auto", quoteOnly: true });
  await expect(surface.getByRole("button", { name: /^Send · 3 cr/ })).toBeVisible();
  expect(await noSideways(page)).toBeLessThanOrEqual(1);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});
