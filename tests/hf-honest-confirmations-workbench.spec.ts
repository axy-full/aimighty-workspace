import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { signInLocally } from "./helpers/workbenchLocal";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects, upload } from "./helpers/workspaceFixtures";
import { newProject, type Project } from "../lib/workbench/studio";
import { GEN_PRESET_KEY } from "../lib/shell/assets";

/**
 * Idea 18 — confirmations say exactly what happened and link to it, in the
 * browser, against the real routes of a local ENGINE_MOCK server (the Crew
 * round is the mock room; nothing reaches an engine). Crew's → Rig writes a
 * draft shot on the Rig, so the toast says Rig and its Open lands on that
 * shot, selected — on a Rig that has read the saved draft again. → Brief
 * says Brief and opens it; the room stays put for the next solution. Open in
 * Gen goes to Gen with the solution as the prompt, and says only that. Filed
 * minutes open the Library.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844"];
const TOUCH = [...PHONES, "workbench-844x390"];
const SHOT_AT: Record<string, string> = { "workbench-1440x900": "1440x900", "workbench-390x844": "390x844", "workbench-360x640": "360x640" };
const SHOTS = "/private/tmp/particl-suites/hf-connected/shots";
const GOAL = "Open the film without dialogue and still make the product unmistakable inside the first four seconds.";

async function shot(page: Page, name: string, project: string) {
  const size = SHOT_AT[project];
  if (!size) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/honest-${name}-${size}.png` });
}
/** Wait for the page's enter animations, so a screenshot shows the settled page. */
async function settle(page: Page) {
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => !(a.effect instanceof KeyframeEffect && a.effect.getComputedTiming().iterations === Infinity)).map((a) => a.finished.catch(() => undefined))));
}
/** React has attached to the element: a fill or click before that is lost on a cold server. */
async function hydrated(target: Locator) {
  await expect.poll(() => target.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps"))), { timeout: 30_000 }).toBe(true);
}
async function noSideScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), "no horizontal page scroll").toBeLessThanOrEqual(1);
}

/** A saved project, the Crew room open on it, one round run: three solutions from the mock chair. */
async function roomWithSolutions(page: Page) {
  const account = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${account.workspace.id}-${me.id}` };
  const project = { ...newProject("Dune Studies"), brief: "One kitchen, one rainy dawn.", script: "INT. KITCHEN - DAWN\n\nRain on the window." };
  expect((await page.request.put("/api/workbench/projects", { headers, data: { project, revision: 0 } })).ok()).toBe(true);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (m) => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text().slice(0, 200)); });
  await page.goto(`/suites?project=${project.id}&view=crew`);
  await expect(page.getByTestId("crew-view")).toBeVisible();
  await expect(page.locator(".cw-project")).toContainText("Dune Studies");
  /* The shell writes its own params into the URL once it settles (cp=room); on a cold server that lands after hydration and
     resets the room, so a goal typed before it is lost. Wait for it, and type again if it still went. */
  await page.waitForURL(/[?&]cp=room\b/);
  await hydrated(page.getByTestId("crew-goal"));
  await expect(async () => {
    await page.getByTestId("crew-goal").fill(GOAL);
    await expect(page.getByTestId("crew-run")).toHaveText(/^Run round · \d+ cr$/, { timeout: 4_000 });
  }).toPass({ timeout: 30_000 });
  await page.getByTestId("crew-run").click();
  const solutions = page.getByTestId("crew-solutions").locator(".cw-solution");
  await expect(solutions).toHaveCount(3, { timeout: 45_000 });
  await expect(page.getByTestId("crew-run")).toHaveText(/^Run round · \d+ cr$/);
  return { errors, project, headers, solutions };
}

/** The Uploads chip: once anything was uploaded (filing the minutes is an upload) it floats over the page's bottom right. */
const uploadsChip = (page: Page) => page.locator("details", { has: page.locator('section[aria-label="Upload recovery"]') });

/**
 * A phone's Open is a whole target: 44px, and every point of it is the Open —
 * nothing floats over any part of it (the tab bar, the Uploads chip). The
 * toast sits clear of the tab bar, the home indicator and, on a phone, the chip.
 */
async function reachable(page: Page, open: Locator, name: string) {
  await settle(page);
  const box = (await open.boundingBox())!;
  if (TOUCH.includes(name)) expect(box.height, "Open is a 44px target").toBeGreaterThanOrEqual(44);
  const covered = await open.evaluate((el) => {
    const b = el.getBoundingClientRect(), misses: string[] = [];
    /* The pill's straight run and its whole height (the rounded ends are not the button's to hit). */
    for (let i = 0; i <= 10; i++) for (let j = 0; j <= 6; j++) {
      const x = b.left + b.height / 2 + (b.width - b.height) * i / 10, y = b.top + 2 + (b.height - 4) * j / 6;
      const hit = document.elementFromPoint(x, y);
      if (!hit || !el.contains(hit)) misses.push(`${Math.round(x)},${Math.round(y)} → ${hit ? hit.tagName.toLowerCase() : "nothing"}`);
    }
    return misses;
  });
  expect(covered, "no part of the Open is under something else").toEqual([]);
  const toast = (await page.getByTestId("toast").boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(toast.x).toBeGreaterThanOrEqual(0);
  expect(toast.x + toast.width).toBeLessThanOrEqual(viewport.width);
  expect(toast.y + toast.height).toBeLessThanOrEqual(viewport.height);
  const bar = page.locator(".gx-tabbar");
  if (await bar.isVisible()) {
    const tabs = (await bar.boundingBox())!;
    expect(toast.y + toast.height, "the toast clears the tab bar").toBeLessThanOrEqual(tabs.y);
  }
  const chip = uploadsChip(page);
  if (PHONES.includes(name) && await chip.isVisible()) expect(toast.y + toast.height, "on a phone the toast sits above the Uploads chip").toBeLessThanOrEqual((await chip.boundingBox())!.y);
}

test("Crew › → Rig says Rig, and its Open lands on that shot, selected, on a Rig that read the saved draft", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, project, headers, solutions } = await roomWithSolutions(page);
  const toast = page.getByTestId("toast");

  /* Filed minutes leave the Uploads chip on screen for good (a finished upload stays listed): every toast after it must clear it. */
  const file = page.getByTestId("crew-file-minutes");
  await expect(file).toHaveText("File minutes in the Library · free");
  await file.scrollIntoViewIfNeeded();
  await file.click();
  /* The pointer leaves: a mouse resting on a toast holds it, and this one has to time out. */
  await page.mouse.move(1, 1);
  await expect(toast).toContainText("Minutes filed in the Library");
  await expect(uploadsChip(page)).toBeVisible();
  await expect(page.getByTestId("toast-open")).toHaveText("Open Library");
  await reachable(page, page.getByTestId("toast-open"), info.project.name);
  await shot(page, "minutes-toast", info.project.name);
  /* It times out on its own (a tap never holds it); the next toast replaces it anyway. */
  await expect(toast).toHaveCount(0, { timeout: 10_000 });

  const second = solutions.nth(1);
  await expect(second.getByRole("button", { name: "→ Rig" })).toBeVisible();
  await expect(page.getByTestId("crew-view").getByRole("button", { name: "Board it" })).toHaveCount(0);

  const routed = page.waitForResponse((r) => /\/api\/crew\/solutions\/[^/]+\/route$/.test(new URL(r.url()).pathname) && r.request().method() === "POST");
  await second.getByRole("button", { name: "→ Rig" }).click();
  const reply = await (await routed).json() as { status: string; nodeId: string; title: string };
  expect(reply).toMatchObject({ status: "boarded", title: "Cut on the drop" });

  /* The toast names the Rig and the shot; nothing about Boards or frames. The room stays where it was. */
  await expect(toast).toContainText("Added to Rig · Cut on the drop");
  await expect(toast).not.toContainText(/Board|frame/);
  const open = page.getByTestId("toast-open");
  await expect(open).toHaveText("Open Rig");
  await expect(second.getByTestId("crew-solution-status")).toHaveText("Added to Rig");
  /* A second press would add a second shot: the button says so. */
  await expect(second.getByRole("button", { name: "→ Rig again" })).toBeVisible();
  await expect(page.getByTestId("crew-view")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("view")).toBe("crew");
  await reachable(page, open, info.project.name);
  await noSideScroll(page);
  await settle(page);
  await shot(page, "crew-rig-toast", info.project.name);

  /* It really is on the saved project's Rig. */
  const saved = (await page.request.get(`/api/workbench/projects?id=${project.id}`, { headers }).then((r) => r.json())).project as { nodes: { id: string; title: string; type: string }[] };
  expect(saved.nodes.find((n) => n.id === reply.nodeId)).toMatchObject({ title: "Cut on the drop", type: "scene" });

  await open.click();
  await expect(page.getByTestId("page-title")).toHaveText("Rig");
  await expect(toast).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).searchParams.get("sel")).toBe(`shot:${reply.nodeId}`);
  /* The Rig read the saved draft again: the shot is listed, and it is the one selected. */
  const row = page.locator(`.pxw-rig-row[data-shot-id="${reply.nodeId}"]`);
  await expect(row).toHaveAttribute("aria-pressed", "true");
  await expect(row).toContainText("Cut on the drop");
  /* …in view, and clear of a phone's tab bar. */
  await settle(page);
  await expect(row).toBeInViewport();
  const bar = page.locator(".gx-tabbar");
  if (await bar.isVisible()) expect((await row.boundingBox())!.y + (await row.boundingBox())!.height).toBeLessThanOrEqual((await bar.boundingBox())!.y);
  await noSideScroll(page);
  await shot(page, "rig-opened", info.project.name);
  expect(errors).toEqual([]);
});

test("Crew › → Brief confirms with an Open to Brief; Open in Gen fills Gen's prompt and says only that; filed minutes open the Library", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  const { errors, project, headers, solutions } = await roomWithSolutions(page);

  await solutions.first().getByRole("button", { name: "→ Brief" }).click();
  await expect(page.getByTestId("toast")).toContainText("Added to the Brief");
  await expect(page.getByTestId("toast-open")).toHaveText("Open Brief");
  await expect(solutions.first().getByTestId("crew-solution-status")).toHaveText("Added to the Brief");
  const saved = (await page.request.get(`/api/workbench/projects?id=${project.id}`, { headers }).then((r) => r.json())).project as { brief: string };
  expect(saved.brief).toContain("Crew · Locked dawn frame — ");

  /* Minutes: filed in this project's Library, and the toast opens it. */
  const file = page.getByTestId("crew-file-minutes");
  await file.scrollIntoViewIfNeeded();
  await file.click();
  await expect(page.getByTestId("toast")).toContainText("Minutes filed in the Library");
  /* Crew has no Library of its own: Open leaves the room for the suite page, with the Library's assets showing the file. */
  await expect(page.getByTestId("toast-open")).toHaveText("Open Library");
  await page.getByTestId("toast-open").click();
  const library = page.getByTestId("library");
  await expect(library).toBeVisible();
  await expect(library.getByRole("tab", { name: /Assets/ })).toHaveAttribute("aria-selected", "true");
  await expect(library).toContainText("crew-min");
  expect(new URL(page.url()).searchParams.get("view")).toBeNull();
  if (info.project.name === "workbench-390x844") await library.getByRole("button", { name: "Close" }).click();
  await page.getByRole("tablist", { name: "Suites" }).getByRole("tab", { name: "Crew" }).click();
  await expect(solutions).toHaveCount(3);

  /* Open in Gen goes to Gen: the solution is the prompt, and the toast does not ask for a paste. */
  const third = solutions.nth(2);
  const text = (await third.locator("p").innerText()).replace(/^3/, "").trim();
  await third.getByRole("button", { name: "Open in Gen" }).click();
  await expect(page.getByTestId("gen-view")).toBeVisible();
  await expect(page.getByTestId("gen-prompt")).toHaveValue(text);
  await expect(page.getByTestId("gen-preset-note")).toHaveText("Crew · solution");
  await expect(page.getByTestId("toast")).toHaveText("The solution is Gen’s prompt");
  await expect(page.getByTestId("toast-open"), "already there: no Open").toHaveCount(0);
  await noSideScroll(page);
  await settle(page);
  await shot(page, "gen-from-crew", info.project.name);
  expect(errors).toEqual([]);
});

test("Crew › Open in Gen when the browser will not store the preset: Gen opens empty and the toast says the solution did not carry", async ({ page }, info) => {
  test.skip(!["workbench-360x640", "workbench-1440x900"].includes(info.project.name), "the narrowest phone, one desktop");
  const { errors, solutions } = await roomWithSolutions(page);
  /* Storage blocked for the preset only (a private window, a full quota): everything else keeps working. */
  await page.evaluate((key) => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (this: Storage, name: string, value: string) {
      if (name === key) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      return set.call(this, name, value);
    };
  }, GEN_PRESET_KEY);
  await solutions.nth(2).getByRole("button", { name: "Open in Gen" }).click();
  await expect(page.getByTestId("gen-view")).toBeVisible();
  await expect(page.getByTestId("toast")).toHaveText("The solution could not be carried to Gen");
  await expect(page.getByTestId("toast")).not.toContainText("Gen’s prompt");
  await expect(page.getByTestId("gen-prompt")).toHaveValue("");
  await expect(page.getByTestId("gen-preset-note")).toHaveCount(0);
  await noSideScroll(page);
  await settle(page);
  await shot(page, "gen-not-carried", info.project.name);
  expect(errors).toEqual([]);
});

test("Crew › → Rig with a long pinned line: the shot is named to a word with an ellipsis, and the toast is two lines at most", async ({ page }, info) => {
  test.skip(!["workbench-360x640", "workbench-1440x900"].includes(info.project.name), "the narrowest phone, one desktop");
  const { errors, project, headers, solutions } = await roomWithSolutions(page);
  /* The DOP's proposal has no " — ": the whole line would be the title. */
  await page.getByTestId("crew-message").filter({ hasText: "24mm, camera locked" }).getByRole("button", { name: "Pin" }).click();
  await expect(solutions).toHaveCount(4);
  const routed = page.waitForResponse((r) => /\/api\/crew\/solutions\/[^/]+\/route$/.test(new URL(r.url()).pathname) && r.request().method() === "POST");
  await solutions.nth(3).getByRole("button", { name: "→ Rig" }).click();
  const reply = await (await routed).json() as { nodeId: string; title: string };
  expect(reply.title).toBe("24mm, camera locked, dawn coming up behind the bottle so it silhouettes then…");
  const saved = (await page.request.get(`/api/workbench/projects?id=${project.id}`, { headers }).then((r) => r.json())).project as { nodes: { id: string; title: string; text: string }[] };
  expect(saved.nodes.find((n) => n.id === reply.nodeId)).toMatchObject({ title: reply.title, text: expect.stringContaining("fills with colour over four seconds") });

  const text = page.getByTestId("toast").locator(".gx-toast-text");
  await expect(text).toHaveText(`Added to Rig · ${reply.title}`);
  await reachable(page, page.getByTestId("toast-open"), info.project.name);
  const lines = await text.evaluate((el) => Math.round(el.clientHeight / parseFloat(getComputedStyle(el).lineHeight)));
  expect(lines, "two lines at most").toBeLessThanOrEqual(2);
  await noSideScroll(page);
  await shot(page, "long-rig-toast", info.project.name);
  expect(errors).toEqual([]);
});

test("Crew › → Rig, then an edit on the Rig while it is still reading the saved draft: the edit is never silently replaced", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one desktop: the Rig's shot list and its Add shot");
  const { errors, project, headers, solutions } = await roomWithSolutions(page);
  /* From here every read of the saved draft is held, so Open Rig lands before the Rig has the new shot. */
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  await page.route(`**/api/workbench/projects?id=${project.id}`, async (route) => {
    if (route.request().method() === "GET") { reads += 1; await held; }
    return route.fallback();
  });
  await solutions.nth(1).getByRole("button", { name: "→ Rig" }).click();
  await expect(page.getByTestId("toast")).toContainText("Added to Rig · Cut on the drop");
  await page.getByTestId("toast-open").click();
  await expect(page.getByTestId("page-title")).toHaveText("Rig");
  const rows = page.locator(".pxw-rig-row");
  await expect(rows, "the Rig has not read the new shot yet").toHaveCount(0);
  expect(reads, "the Rig is reading the saved draft again").toBeGreaterThan(0);
  /* An edit, and the read comes back straight after it — before the edit's own save goes out. */
  await page.getByRole("button", { name: "+ Add shot" }).click();
  release();
  await expect(rows).toHaveCount(1);

  /* The read is not taken over the edit. The edit's save meets the newer revision, is refused, and the Rig
     reloads the saved version — and says so, rather than dropping the edit quietly. */
  await expect(page.getByTestId("toast")).toHaveText("This project changed elsewhere. Rig reloaded the saved version.", { timeout: 15_000 });
  await page.unroute(`**/api/workbench/projects?id=${project.id}`);
  const saved = (await page.request.get(`/api/workbench/projects?id=${project.id}`, { headers }).then((r) => r.json())).project as { nodes: { title: string }[] };
  await expect.poll(() => rows.allInnerTexts().then((all) => all.length)).toBe(saved.nodes.length);
  await expect(rows.first()).toContainText("Cut on the drop");
  expect(errors).toEqual([]);
});

const TAKE = `gen_hfc_${"d".repeat(40)}`;
const IMAGE_MODEL = { id: "marketing_studio_image", name: "Marketing Studio Image", outputType: "image", aspectRatios: ["auto", "1:1", "9:16"], medias: [{ name: "medias", roles: ["image"] }], parameters: [{ name: "resolution", options: ["1k", "2k", "4k"] }] };

test("Business › a finished image ad's Open in Takes lands on that take, not on the newest one", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  const fixture: Project = { ...newProject("Coastal light study"), id: "ws-honest", productionProjectId: "prod-ws", shotMappings: {} };
  await mockProjects(page, { current: fixture });
  const now = Date.now();
  /* The ad lands filed in the project; a newer take sits above it, so landing on the ad is not luck. */
  await mockLibrary(page, {
    uploads: [upload({ id: "up_plate", filename: "harbour-plate.webp" })],
    generations: [generation({ id: "g_newer", title: "Evening pass", createdAt: now + 60_000 }), generation({ id: TAKE, title: "Marble hero", createdAt: now - 1_000 })],
  });
  const me = await page.request.get("/api/me").then((r) => r.json());
  await page.route("**/api/me", (route) => route.fulfill({ json: { ...me, owner: true } }));
  await page.route("**/api/higgsfield/consumer/connection", (route) => route.fulfill({ json: { connected: true, requiresReconnect: false } }));
  let quoted: unknown = null;
  await page.route("**/api/higgsfield/consumer/generation", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (body.action === "quote") quoted = body.input;
    if (body.action === "catalogue") return route.fulfill({ json: { catalogue: { models: [IMAGE_MODEL], unlim: { available: false, remaining: null, expiresAt: null }, complete: true, fetchedAt: Date.now() } } });
    const job = (status: string) => ({ id: "5d2b3c4e-5f60-4a7b-8c9d-0e1f2a3b4c5d", draftId: fixture.id, workflow: "generation", status, model: IMAGE_MODEL, input: quoted, workspaceId: "1f2e3d4c-5b6a-4798-8a9b-0c1d2e3f4a5b", workspaceName: "Connected wallet", quoteCredits: 40, creditUnit: "higgsfield_credits", quoteExpiresAt: Date.now() + 300_000, createdAt: now, providerJobId: status === "quoted" ? null : "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d", tool: null, result: null, originalAvailable: false, sources: [] });
    if (body.action === "quote") return route.fulfill({ json: { job: job("quoted") } });
    if (body.action === "submit") return body.credits === 40 ? route.fulfill({ json: { job: job("accepted") } }) : route.fulfill({ status: 409, json: { error: "Review the quote again." } });
    if (body.action === "status") {
      const done = job("completed");
      const original = { generationId: TAKE, providerJobId: done.providerJobId, creditUnit: "higgsfield_credits", credits: 40, sha256: "b".repeat(64), bytes: 2048, asset: { generationId: TAKE, mime: "image/webp", url: `/api/media/${TAKE}`, kind: "image" } };
      return route.fulfill({ json: { job: { ...done, originalAvailable: true, originalAvailability: "available", result: { original } } } });
    }
    return route.fulfill({ status: 400, json: { error: "Nothing else is priced or sent in this spec." } });
  });
  await page.route("**/api/higgsfield/consumer/marketing-templates**", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: { connection: { connected: true, requiresReconnect: false }, capabilities: {}, jobs: [] } })
    : route.fulfill({ json: { catalogue: { templates: [], matched: 0, total: 0, loaded: 0, complete: true, fetchedAt: Date.now(), categories: [], costsVersion: "v1" } } }));
  await page.route("**/api/higgsfield/consumer/video", (route) => route.fulfill({ json: { connected: true, reads: [] } }));
  await page.route("**/api/prompt/enhance", (route) => route.fulfill({ json: { model: "m", effort: "auto", estimateCredits: 1 } }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/suites?suite=moleculr&page=marketing&sp=dtc");
  await expect(page.getByTestId("project-name")).toHaveText("Coastal light study");
  await hydrated(page.getByTestId("dtc-prompt"));
  await page.getByTestId("dtc-prompt").fill("Bold hero shot on marble");
  await expect(page.getByTestId("dtc-generate")).toContainText("40 cr");
  await page.getByTestId("dtc-generate").click();
  const done = page.getByTestId("dtc-done");
  await expect(done.getByTestId("dtc-done-take").locator("img")).toBeVisible({ timeout: 15_000 });
  const open = done.getByTestId("dtc-done-open");
  await expect(open).toHaveText("Open in Takes");
  if (TOUCH.includes(info.project.name)) expect((await open.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await open.click();
  await expect(page.getByTestId("page-title")).toHaveText("Takes");
  await expect(page.getByTestId("edit-takes").locator('[data-testid="edit-take"][aria-checked="true"]')).toContainText("Marble hero");
  expect(new URL(page.url()).searchParams.get("sel")).toBe(`take:generation:${TAKE}`);
  await noSideScroll(page);
  expect(errors).toEqual([]);
});
