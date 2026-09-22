import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects, upload } from "./helpers/workspaceFixtures";

/**
 * Gen from the live catalogue (FINAL_SPEC §3–4): the Higgsfield group's
 * chips come from each model's own entry — every second for a range, the
 * closed list otherwise, roles per family, no well for prompt-only models —
 * and Auto sends `enhance_prompt: true` only where the schema declares it,
 * never for a raw: prompt.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const fixture = (): Project => ({ ...newProject("Coastal light study"), id: "ws-gen-cat", productionProjectId: "prod-ws", shotMappings: {} });
const MODELS = [
  { id: "seedance_2_5", name: "Seedance 2.5", outputType: "video", description: "Text-to-video and omni-reference", aspectRatios: ["auto", "16:9", "9:16"], durationRange: { min: 4, max: 30 }, medias: [{ name: "medias", roles: ["start_image", "end_image", "image_references"] }], parameters: [{ name: "resolution", options: ["480p", "720p", "1080p"] }] },
  { id: "veo_3_1", name: "Veo 3.1", outputType: "video", aspectRatios: ["16:9", "9:16"], durations: [4, 6, 8], medias: [{ name: "start_image", roles: ["start_image"], max: 1 }], parameters: [{ name: "enhance_prompt", type: "bool" }] },
  { id: "z_image", name: "Z Image", outputType: "image", aspectRatios: ["1:1", "16:9"], medias: [], parameters: [] },
  { id: "soul_2", name: "Soul 2", outputType: "image", description: "A trained identity in any scene", aspectRatios: ["1:1", "3:4"], medias: [{ name: "image", roles: ["image_references"], max: 1 }], parameters: [{ name: "soul_id", type: "string" }] },
];

async function open(page: Page) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  await mockLibrary(page, { uploads: [upload({ id: "up_plate", filename: "harbour-plate.webp" })], generations: [generation({ id: "gen_wide", title: "Wide on the water", prompt: "Wide on the water" })] });
  await page.route(/\/api\/uploads\/up_plate\/metadata$/, (route) => route.fulfill({ json: { upload: upload({ id: "up_plate", filename: "harbour-plate.webp" }) } }));
  const me = await page.request.get("/api/me").then((r) => r.json());
  await page.route("**/api/me", (route) => route.fulfill({ json: { ...me, owner: true } }));
  await page.route("**/api/higgsfield/consumer/connection", (route) => route.fulfill({ json: { connected: true, requiresReconnect: false } }));
  const quotes: Record<string, unknown>[] = [];
  await page.route("**/api/higgsfield/consumer/generation", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (body.action === "catalogue") return route.fulfill({ json: { catalogue: { models: MODELS, unlim: { available: false, remaining: null, expiresAt: null }, complete: true, fetchedAt: Date.now() } } });
    if (body.action === "characters") return route.fulfill({ json: { connected: true, available: true, characters: [
      { soulId: "soul_9f2a", name: "Mira / character study", type: "soul_2", status: "ready", previewUrl: null },
      { soulId: "soul_44c1", name: "Jonah", type: "soul_2", status: "training", previewUrl: null },
    ] } });
    if (body.action === "quote") {
      quotes.push(body);
      const input = body.input as { model: string };
      return route.fulfill({ json: { job: { id: "9d2b3c4e-5f60-4a7b-8c9d-0e1f2a3b4c5d", draftId: "ws-gen-cat", status: "quoted", model: MODELS.find((m) => m.id === input.model), input: body.input, workspaceId: "1f2e3d4c-5b6a-4798-8a9b-0c1d2e3f4a5b", workspaceName: "Northline wallet", quoteCredits: 43, creditUnit: "higgsfield_credits", quoteExpiresAt: Date.now() + 300_000, createdAt: Date.now(), providerJobId: null, tool: null, sources: [] } } });
    }
    return route.fulfill({ status: 400, json: { error: "unexpected" } });
  });
  await page.route("**/api/prompt/enhance", (route) => route.fulfill({ json: { model: "m", effort: "auto", estimateCredits: 1 } }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/suites?view=gen");
  await expect(page.getByTestId("gen-view")).toBeVisible();
  await expect(page.getByTestId("project-name")).toHaveText("Coastal light study");
  return { errors, quotes };
}

const pickCatalogue = async (page: Page, name: string) => {
  await page.getByTestId("gen-model").click();
  const sheet = page.getByRole("dialog", { name: "Choose a model" });
  await sheet.getByRole("tab", { name: "Higgsfield catalogue" }).click();
  await sheet.getByRole("option", { name: new RegExp(`^${name}`) }).click();
  await expect(sheet).toHaveCount(0);
};

test("Length is every second for a range and exactly the closed list otherwise; a prompt-only model hides the well", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors } = await open(page);
  await pickCatalogue(page, "Seedance 2.5");
  const seconds = await page.getByTestId("gen-length").locator("option").evaluateAll((o) => o.map((x) => Number((x as HTMLOptionElement).value)));
  expect(seconds).toEqual(Array.from({ length: 27 }, (_, i) => 4 + i));
  await expect(page.getByRole("group", { name: "Resolution" }).getByRole("button")).toHaveText(["480p", "720p", "1080p"]);
  await expect(page.getByRole("group", { name: "Aspect" }).getByRole("button")).toHaveText(["auto", "16:9", "9:16"]);
  await pickCatalogue(page, "Veo 3.1");
  expect(await page.getByTestId("gen-length").locator("option").evaluateAll((o) => o.map((x) => Number((x as HTMLOptionElement).value)))).toEqual([4, 6, 8]);
  await expect(page.getByRole("group", { name: "Resolution" })).toHaveCount(0);
  await page.getByRole("tab", { name: "Images" }).click();
  await pickCatalogue(page, "Z Image");
  await expect(page.getByTestId("gen-prompt-only")).toHaveText("Z Image takes a prompt only — no references.");
  await expect(page.getByTestId("gen-well")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("the quote carries the entry's settings and the reference role; Auto sends enhance_prompt only where declared and never for raw:", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { quotes } = await open(page);
  await pickCatalogue(page, "Veo 3.1");
  await page.getByTestId("gen-well").evaluate((well) => { const d = new DataTransfer(); d.setData("text/plain", "upload:up_plate"); well.dispatchEvent(new DragEvent("drop", { dataTransfer: d, bubbles: true, cancelable: true })); });
  await expect(page.getByTestId("gen-well")).toContainText("harbour-plate.webp");
  await page.getByTestId("gen-length").selectOption("6");
  await page.getByTestId("gen-prompt").fill("A fox crossing a frozen harbour");
  await expect(page.getByTestId("gen-generate")).toHaveText(/43/);
  /* Takes: the stepper multiplies the take's price on the button; each take is its own quoted job. */
  await page.getByTestId("gen-takes").getByRole("button", { name: "More" }).click();
  await expect(page.getByTestId("gen-takes-count")).toHaveText("2");
  await expect(page.getByTestId("gen-generate")).toHaveText("Generate 2 takes · 86 connected cr");
  await page.getByTestId("gen-takes").getByRole("button", { name: "Fewer" }).click();
  await expect(page.getByTestId("gen-takes").getByRole("button", { name: "Fewer" })).toBeDisabled();
  await expect(page.getByTestId("gen-generate")).toHaveText(/^Generate · 43/);
  let quote = quotes.at(-1) as { input: { parameters: Record<string, unknown>; medias: { role: string }[] } };
  expect(quote.input.parameters).toEqual({ aspect_ratio: "16:9", duration: 6, enhance_prompt: false });
  expect(quote.input.medias.map((m) => m.role)).toEqual(["start_image"]);
  /* Auto on: the account is asked to enhance. */
  await page.getByRole("switch", { name: "Auto" }).click();
  await expect.poll(() => (quotes.at(-1) as { input: { parameters: Record<string, unknown> } }).input.parameters.enhance_prompt).toBe(true);
  /* raw: is never rewritten, locally or on the account; the prefix is stripped. */
  await page.getByTestId("gen-prompt").fill("raw: exactly these words");
  await expect.poll(() => (quotes.at(-1) as { input: { prompt: string; parameters: Record<string, unknown> } }).input.prompt).toBe("exactly these words");
  quote = quotes.at(-1) as typeof quote;
  expect(quote.input.parameters.enhance_prompt).toBe(false);
  /* Seedance declares no enhance_prompt: none is sent; a second reference can take another role. */
  await pickCatalogue(page, "Seedance 2.5");
  await page.getByTestId("gen-prompt").fill("A fox crossing a frozen harbour");
  await page.getByTestId("gen-ref-role").click();
  await expect(page.getByTestId("gen-ref-role")).toHaveText("end_image");
  /* Wait for the quote that carries the cycled role, not merely the first Seedance one. */
  await expect.poll(() => { const last = quotes.at(-1) as { input: { model: string; medias: { role: string }[] } }; return `${last.input.model}:${last.input.medias[0]?.role}`; }).toBe("seedance_2_5:end_image");
  quote = quotes.at(-1) as typeof quote;
  /* The 6 s picked for Veo is inside Seedance's range, so it is kept; the resolution is the entry's first. */
  expect(quote.input.parameters).toEqual({ aspect_ratio: "16:9", duration: 6, resolution: "480p" });
  expect(quote.input.medias.map((m) => m.role)).toEqual(["end_image"]);
});

test("a Soul model carries a trained character: the account's list is read, a pick goes into the quote as soul_id, training ones cannot be picked", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, quotes } = await open(page);
  await page.getByRole("tab", { name: "Images" }).click();
  await pickCatalogue(page, "Soul 2");
  await expect(page.getByTestId("gen-identity")).toBeVisible();
  await expect(page.getByTestId("gen-identity-note")).toContainText("1 trained identity on the account.");
  await expect(page.getByTestId("gen-identity-pick").locator("option", { hasText: "Jonah · training" })).toBeDisabled();
  await page.getByTestId("gen-prompt").fill("Mira on the mirrored dunes at dusk");
  await expect.poll(() => quotes.length).toBeGreaterThan(0);
  expect((quotes.at(-1) as { input: { parameters: Record<string, unknown> } }).input.parameters).not.toHaveProperty("soul_id");
  await page.getByTestId("gen-identity-pick").selectOption("soul_9f2a");
  await expect.poll(() => (quotes.at(-1) as { input: { parameters: Record<string, unknown> } }).input.parameters.soul_id).toBe("soul_9f2a");
  /* Prompt only again: the identity leaves the request. */
  await page.getByTestId("gen-identity-pick").selectOption("");
  await expect.poll(() => (quotes.at(-1) as { input: { parameters: Record<string, unknown> } }).input.parameters.soul_id).toBeUndefined();
  await page.getByTestId("gen-identity-note").getByRole("button", { name: "Build identity in Cast" }).click();
  await expect(page.getByTestId("page-title")).toHaveText("Cast & Elements");
  expect(errors).toEqual([]);
});
