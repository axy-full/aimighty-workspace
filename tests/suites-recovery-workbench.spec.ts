import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects, upload } from "./helpers/workspaceFixtures";

/**
 * The Suites shell recovers instead of sticking: Back leaves /suites after
 * the landing, a failed Library read says so with Retry, Load more reaches
 * takes past the first page, Recreate refills Gen while Gen is open, a plan that
 * cannot run says why (in its sheet, and under the stage strip once the sheet
 * is closed), and a failed Ads quote re-arms Generate on its own only when
 * the failure passes by itself; an idle page asks the account nothing. Every
 * reply is route-mocked; nothing paid is ever sent.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const WIDE = ["workbench-1440x900", "workbench-1920x1080"];
const fixture = (): Project => ({ ...newProject("Coastal light study"), id: "ws-recover", productionProjectId: "prod-ws", shotMappings: {} });

const takes = [
  generation({ id: "gen_harbour", title: "Harbour at dawn", prompt: "Harbour at dawn, enhanced", params: { rawPrompt: "harbour at dawn", ratio: "9:16", duration: 5 } }),
  generation({ id: "gen_alley", title: "Neon alley", prompt: "Neon alley in the rain", params: {} }),
  generation({ id: "gen_pier", title: "Pier at noon", prompt: "Pier at noon", params: {} }),
];
/* Audio takes as /api/audio stores them (lib/audioAdmission.ts): params.task is always set. */
const sounds = [
  generation({ id: "gen_score", kind: "audio", model: "eleven_music", title: "Harbour score", prompt: "Slow strings under gulls", params: { task: "music", lengthMs: 45_000, instrumental: true } }),
  generation({ id: "gen_talk", kind: "audio", model: "eleven_v3", title: "Two voices", prompt: "", params: { task: "dialogue", lines: [{ text: "Morning.", voiceId: "v1" }] } }),
];

async function open(page: Page, url: string, library: { pageSize?: number; failFirst?: () => boolean; generations?: ReturnType<typeof generation>[] } = {}) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  await mockLibrary(page, { uploads: [upload({ id: "up_plate", filename: "harbour-plate.webp" })], generations: library.generations ?? takes, pageSize: library.pageSize });
  /* Registered after mockLibrary, so it answers first: a failing read while the test says so. */
  await page.route("**/api/workbench/library**", (route) => {
    if (route.request().method() === "GET" && library.failFirst?.()) return route.fulfill({ status: 503, json: { error: "The library is busy. Try again shortly." } });
    return route.fallback();
  });
  await page.route("**/api/prompt/enhance", (route) => route.fulfill({ json: { model: "m", effort: "auto", estimateCredits: 1 } }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await expect(page.getByTestId("project-name")).toHaveText("Coastal light study");
  return { errors };
}

const openAssets = async (page: Page, wide: boolean) => {
  if (!wide) await page.getByTestId("toggle-library").click();
  await page.getByTestId("library").getByRole("tab", { name: /Assets/ }).click();
};

test("the landing replaces the entry URL: one Back leaves /suites", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  await page.goto("/api/me");
  const before = page.url();
  const { errors } = await open(page, "/suites?suite=particl");
  await expect(page).toHaveURL(/sp=/);
  await page.goBack();
  await expect.poll(() => page.url()).toBe(before);
  expect(errors).toEqual([]);
});

test("a failed Library read says so with Retry; Load more reaches takes past the first page", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  let failing = true;
  const { errors } = await open(page, "/suites?suite=particl&page=boards&sp=boards", { pageSize: 2, failFirst: () => failing });
  await openAssets(page, WIDE.includes(info.project.name));
  const library = page.getByTestId("library");
  await expect(library.getByTestId("library-error")).toContainText("The library is busy. Try again shortly.");
  await expect(library.getByText("Reading this project…")).toHaveCount(0);
  /* Said once: the end-of-list Load more stays out of the way while the first read has failed. */
  await expect(library.getByTestId("library-more-error")).toHaveCount(0);
  failing = false;
  await library.getByTestId("library-error").getByRole("button", { name: "Retry" }).click();
  const tiles = library.locator(".gx-asset-thumb[data-ctx^='asset:generation:']");
  await expect(tiles).toHaveCount(2);
  await expect(library.getByTestId("library-more-button")).toHaveText("Load more · 3 shown");
  const box = await library.getByTestId("library-more-button").boundingBox();
  if (!WIDE.includes(info.project.name)) expect(box!.height).toBeGreaterThanOrEqual(44);
  await library.getByTestId("library-more-button").click();
  await expect(tiles).toHaveCount(3);
  await expect(library.locator(".gx-asset-thumb[data-ctx='asset:generation:gen_pier']")).toHaveCount(1);
  await expect(library.getByTestId("library-more")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("Takes counts past the first page and loads the rest", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors } = await open(page, "/suites?suite=studio&page=takes", { pageSize: 2 });
  await expect(page.getByText("3+ in this project")).toBeVisible();
  await page.getByTestId("takes-more-button").click();
  await expect(page.getByText("4 in this project")).toBeVisible();
  await expect(page.getByTestId("takes-more")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("the Rig's own library pages on with Load more, from the same store as the Library panel", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors } = await open(page, "/suites?suite=studio&page=rig", { pageSize: 2 });
  const rig = page.getByTestId("rig-library");
  await expect(rig.getByTestId("rig-library-more-button")).toHaveText("Load more · 3 shown");
  const box = await rig.getByTestId("rig-library-more-button").boundingBox();
  if (!WIDE.includes(info.project.name)) expect(box!.height).toBeGreaterThanOrEqual(44);
  await rig.getByTestId("rig-library-more-button").click();
  await expect(rig.getByTestId("rig-library-more")).toHaveCount(0);
  await expect(rig.getByTestId("rig-library-Generations")).toHaveText("Generations · 3");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("Recreate on a music take opens Gen on Audio with its prompt; a dialogue says where it is made", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors } = await open(page, "/suites?view=gen", { generations: [...takes, ...sounds] });
  const gen = page.getByTestId("gen-view");
  const menu = page.getByTestId("context-menu");
  await gen.locator(".gx-asset-thumb[data-ctx='asset:generation:gen_talk']").click({ button: "right" });
  await expect(menu.getByRole("menuitem", { name: "Recreate" })).toBeDisabled();
  await expect(menu.getByRole("menuitem", { name: "Recreate" })).toHaveAttribute("title", "A dialogue is made in Edit & Sound, not Gen.");
  await page.keyboard.press("Escape");
  await gen.locator(".gx-asset-thumb[data-ctx='asset:generation:gen_score']").click({ button: "right" });
  await expect(menu.getByRole("menuitem", { name: "Recreate" })).toBeEnabled();
  await menu.getByRole("menuitem", { name: "Recreate" }).click();
  await expect(page.getByTestId("gen-prompt")).toHaveValue("Slow strings under gulls");
  await expect(gen.getByRole("tab", { name: "Audio" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("gen-recipe-name")).toHaveText("Harbour score");
  expect(errors).toEqual([]);
});

test("Recreate refills Gen while Gen is open, with that take's own inputs", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors } = await open(page, "/suites?view=gen");
  const gen = page.getByTestId("gen-view");
  await expect(gen.locator(".gx-asset-thumb[data-ctx='asset:generation:gen_harbour']")).toBeVisible();
  const menu = page.getByTestId("context-menu");
  await gen.locator(".gx-asset-thumb[data-ctx='asset:generation:gen_harbour']").click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Recreate" }).click();
  await expect(page.getByTestId("gen-prompt")).toHaveValue("harbour at dawn");
  await expect(page.getByTestId("gen-recipe-name")).toHaveText("Harbour at dawn");
  /* Again, from the same open Gen: the composer changes at once. */
  await gen.locator(".gx-asset-thumb[data-ctx='asset:generation:gen_alley']").click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Recreate" }).click();
  await expect(page.getByTestId("gen-prompt")).toHaveValue("Neon alley in the rain");
  await expect(page.getByTestId("gen-recipe-name")).toHaveText("Neon alley");
  expect(await page.evaluate(() => sessionStorage.getItem("particl-gen-preset"))).toBeNull();
  expect(errors).toEqual([]);
});

test("a plan that cannot run says why in its sheet, then under the stage strip once the sheet is closed, and the note can be dismissed", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors } = await open(page, "/suites?suite=moleculr&page=marketing&sp=ads");
  await page.getByTestId("primary-action").click();
  /* Run stage opens the page's sheet, which says why; one gate at a time, so the row waits while it is open. */
  const sheet = page.getByTestId("atomik-panel");
  await expect(sheet).toContainText("Needs Marketing Studio data");
  const notice = page.getByTestId("suites-atomik-notice");
  await expect(notice).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(notice).toContainText("Needs Marketing Studio data");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await notice.getByRole("button", { name: "Dismiss" }).click();
  await expect(notice).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("Ads: a failed quote re-arms Generate on its own, and Price again readies a finished ad for another take", async ({ page }, info) => {
  test.skip(!WIDE.includes(info.project.name) && info.project.name !== "workbench-390x844", "one phone and the desktops: this waits out the backoff");
  test.setTimeout(90_000);
  const me = async () => {
    const body = await page.request.get("/api/me").then((r) => r.json());
    await page.route("**/api/me", (route) => route.fulfill({ json: { ...body, owner: true } }));
  };
  await signInLocally(page.request);
  await me();
  await page.route("**/api/higgsfield/consumer/connection", (route) => route.fulfill({ json: { connected: true, requiresReconnect: false } }));
  const model = { id: "marketing_studio_video", name: "Marketing Studio", outputType: "video", aspectRatios: ["9:16", "16:9"], durationRange: { min: 4, max: 20 }, medias: [{ name: "medias", roles: ["image", "start_image"] }], parameters: [{ name: "resolution", options: ["720p", "1080p"] }] };
  const actions: string[] = [];
  let quotes = 0;
  await page.route("**/api/higgsfield/consumer/generation", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as { action: string; type?: string; input?: unknown };
    actions.push(body.action);
    if (body.action === "catalogue") return route.fulfill({ json: { catalogue: { models: body.type === "image" ? [] : [model], complete: true, fetchedAt: Date.now() } } });
    const job = (status: string) => ({ id: "9d2b3c4e-5f60-4a7b-8c9d-0e1f2a3b4c5d", draftId: "ws-recover", workflow: "generation", status, model, input: body.input ?? { type: "video", model: model.id, prompt: "p", parameters: {}, medias: [] }, workspaceId: "1f2e3d4c-5b6a-4798-8a9b-0c1d2e3f4a5b", workspaceName: "Wallet", quoteCredits: 40, creditUnit: "higgsfield_credits", quoteExpiresAt: Date.now() + 300_000, createdAt: Date.now(), providerJobId: status === "quoted" ? null : "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d", tool: null, result: null, originalAvailable: false, sources: [] });
    if (body.action === "quote") {
      quotes++;
      if (quotes === 1) return route.fulfill({ status: 503, json: { error: "The account is busy. Try again shortly." } });
      return route.fulfill({ json: { job: job("quoted") } });
    }
    if (body.action === "submit") return route.fulfill({ json: { job: job("accepted") } });
    if (body.action === "status") return route.fulfill({ json: { job: job("completed") } });
    return route.fulfill({ status: 400, json: { error: "unexpected" } });
  });
  await page.route("**/api/higgsfield/consumer/video", (route) => route.fulfill({ json: { connected: true, reads: [] } }));
  const { errors } = await open(page, "/suites?suite=moleculr&page=marketing&sp=ads");
  await page.getByTestId("ads-prompt").fill("Morning routine with the bottle on the sill.");
  await expect(page.getByTestId("ads-error-text")).toHaveText("The account is busy. Try again shortly.");
  /* It passes on its own: no Try again, the quote is simply taken again. */
  await expect(page.getByTestId("ads-error").getByRole("button", { name: "Try again" })).toHaveCount(0);
  await expect(page.getByTestId("ads-generate")).toBeDisabled();
  /* No edit: the quote is taken again after a short wait, and Generate wears the price. */
  await expect(page.getByTestId("ads-generate")).toHaveText("Generate ad · 40 cr", { timeout: 15_000 });
  await expect(page.getByTestId("ads-generate")).toBeEnabled();
  await page.getByTestId("ads-generate").click();
  await expect(page.getByTestId("ads-done")).toContainText("Rendered and filed to this project.", { timeout: 15_000 });
  /* The same ad again: a finished take never re-arms Generate by itself; Price again does, and the take stays beside the composer. */
  await expect(page.getByTestId("ads-generate")).toBeDisabled();
  await page.getByTestId("ads-requote").click();
  await expect(page.getByTestId("ads-generate")).toBeEnabled();
  await expect(page.getByTestId("ads-done")).toContainText("Rendered and filed to this project.");
  expect(quotes).toBe(3);
  expect(actions.filter((a) => a === "submit")).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("Ads: a refused quote waits for Try again, and an idle page asks the account nothing until the user comes back", async ({ page }, info) => {
  test.skip(!WIDE.includes(info.project.name) && info.project.name !== "workbench-390x844", "one phone and the desktops: this waits on real timers");
  test.setTimeout(90_000);
  await page.clock.install();
  await signInLocally(page.request);
  const body = await page.request.get("/api/me").then((r) => r.json());
  await page.route("**/api/me", (route) => route.fulfill({ json: { ...body, owner: true } }));
  await page.route("**/api/higgsfield/consumer/connection", (route) => route.fulfill({ json: { connected: true, requiresReconnect: false } }));
  const model = { id: "marketing_studio_video", name: "Marketing Studio", outputType: "video", aspectRatios: ["9:16", "16:9"], durationRange: { min: 4, max: 20 }, medias: [{ name: "medias", roles: ["image", "start_image"] }], parameters: [{ name: "resolution", options: ["720p", "1080p"] }] };
  let quotes = 0;
  const other: string[] = [];
  await page.route("**/api/higgsfield/consumer/generation", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const req = route.request().postDataJSON() as { action: string; type?: string; input?: unknown };
    if (req.action === "catalogue") return route.fulfill({ json: { catalogue: { models: req.type === "image" ? [] : [model], complete: true, fetchedAt: Date.now() } } });
    if (req.action !== "quote") { other.push(req.action); return route.fulfill({ status: 400, json: { error: "unexpected" } }); }
    quotes++;
    /* The route's refusal of the input itself (lib/higgsfield-consumer › CatalogueError): asking again is refused again. */
    if (quotes === 1) return route.fulfill({ status: 400, json: { code: "parameter_invalid", error: "The connected account refused a setting." } });
    return route.fulfill({ json: { job: { id: "9d2b3c4e-5f60-4a7b-8c9d-0e1f2a3b4c5d", draftId: "ws-recover", workflow: "generation", status: "quoted", model, input: req.input, workspaceId: "1f2e3d4c-5b6a-4798-8a9b-0c1d2e3f4a5b", workspaceName: "Wallet", quoteCredits: 40, creditUnit: "higgsfield_credits", quoteExpiresAt: Date.now() + 300_000, createdAt: Date.now(), providerJobId: null, tool: null, result: null, originalAvailable: false, sources: [] } } });
  });
  await page.route("**/api/higgsfield/consumer/video", (route) => route.fulfill({ json: { connected: true, reads: [] } }));
  const { errors } = await open(page, "/suites?suite=moleculr&page=marketing&sp=ads");
  await page.getByTestId("ads-prompt").fill("Morning routine with the bottle on the sill.");
  await expect(page.getByTestId("ads-error-text")).toHaveText("The connected account refused a setting.");
  /* Not asked again on its own, however long the page waits. */
  await page.clock.runFor(120_000);
  expect(quotes).toBe(1);
  const again = page.getByTestId("ads-error").getByRole("button", { name: "Try again" });
  if (!WIDE.includes(info.project.name)) expect((await again.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await again.click();
  await expect(page.getByTestId("ads-generate")).toHaveText("Generate ad · 40 cr");
  expect(quotes).toBe(2);
  /* Idle past the quote's lifetime: no timer re-prices it. */
  await page.clock.runFor(10 * 60_000);
  expect(quotes).toBe(2);
  /* Coming back to the page re-prices the stale quote once; Generate never submits a stale price. */
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => quotes).toBe(3);
  await expect(page.getByTestId("ads-generate")).toHaveText("Generate ad · 40 cr");
  expect(other).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});


test("Ads: a failing catalogue read is asked again a few times, then waits for Read again", async ({ page }, info) => {
  test.skip(!WIDE.includes(info.project.name) && info.project.name !== "workbench-390x844", "one phone and the desktops: this runs the clock");
  await page.clock.install();
  await signInLocally(page.request);
  const body = await page.request.get("/api/me").then((r) => r.json());
  await page.route("**/api/me", (route) => route.fulfill({ json: { ...body, owner: true } }));
  await page.route("**/api/higgsfield/consumer/connection", (route) => route.fulfill({ json: { connected: true, requiresReconnect: false } }));
  let reads = 0;
  let failing = true;
  const model = { id: "marketing_studio_video", name: "Marketing Studio", outputType: "video", aspectRatios: ["9:16"], durationRange: { min: 4, max: 20 }, medias: [], parameters: [] };
  await page.route("**/api/higgsfield/consumer/generation", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const req = route.request().postDataJSON() as { action: string; type?: string };
    if (req.action !== "catalogue") return route.fulfill({ status: 400, json: { error: "unexpected" } });
    if (req.type === "video") reads++;
    if (failing) return route.fulfill({ status: 503, json: { error: "The connected catalogue is unavailable." } });
    return route.fulfill({ json: { catalogue: { models: req.type === "image" ? [] : [model], complete: true, fetchedAt: Date.now() } } });
  });
  await page.route("**/api/higgsfield/consumer/video", (route) => route.fulfill({ json: { connected: true, reads: [] } }));
  const { errors } = await open(page, "/suites?suite=moleculr&page=marketing&sp=ads");
  await page.getByTestId("ads-prompt").fill("Morning routine with the bottle on the sill.");
  await expect(page.getByTestId("ads-blocked")).toHaveText("The connected catalogue is unavailable.");
  /* The first read and three more (5 s, 15 s, 45 s after each failure); then nothing until asked.
     Each wait is timed from a failure landing, which takes real time, so the clock moves a second at a
     time until the next read is asked rather than jumping past a retry that is not timed yet. */
  for (const count of [2, 3, 4])
    await expect.poll(async () => { await page.clock.runFor(1_000); return reads; }, { intervals: [50], timeout: 30_000 }).toBe(count);
  await page.clock.runFor(10 * 60_000);
  expect(reads).toBe(4);
  failing = false;
  await page.getByTestId("catalogue-again").click();
  await expect(page.getByText("The connected catalogue is unavailable.")).toHaveCount(0);
  await expect(page.getByTestId("catalogue-again")).toHaveCount(0);
  expect(reads).toBe(5);
  expect(errors).toEqual([]);
});
