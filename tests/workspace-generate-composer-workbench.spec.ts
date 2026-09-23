import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { signInLocally, localPlatformDbUrl } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { displayModelName } from "../lib/models";

/**
 * /workspace — the global Generate composer. Real local routes against an
 * ENGINE_MOCK server: the composer reads the account's own engine catalogue,
 * prices through GET /api/workbench/engines, re-quotes POST
 * /api/generate/quote and dispatches a mocked render through POST
 * /api/generate. Only the connected account and the moved-price case are
 * intercepted, because neither can happen against the local mock.
 *
 * Desktop asserts this overlay; phones assert that they get the docked
 * composer on Make instead, over the same host.
 */

const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const PHONE = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
/* The named image default (FINAL_SPEC §3: GPT Image 2.5), on the OpenAI API. */
const IMAGE_ENGINE = "gpt-image-2.5-flare";

async function account(page: Page) {
  const signed = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  const db = createClient({ url: localPlatformDbUrl() });
  try {
    await db.execute({
      sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
      args: [randomUUID(), signed.workspace.id, 2000, "Local mock composer fixture", "admin", "test", Date.now()],
    });
  } finally {
    db.close();
  }
  return { scope, workspaceName: String(signed.workspace.name) };
}

/** An empty saved project: the composer supplies the shot its take lives in. */
async function seeded(page: Page) {
  const { scope, workspaceName } = await account(page);
  const project: Project = newProject(`Composer fixture ${randomUUID().slice(0, 6)}`);
  const saved = await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  await page.addInitScript(({ scope, id }) => localStorage.setItem(scope, id), { scope, id: project.id });
  return { project, scope, workspaceName };
}

const url = (id: string, suite = "particl", pageId = "rig") => `/workspace?project=${id}&suite=${suite}&page=${pageId}`;
const composer = (page: Page) => page.getByTestId("generate-composer");
const generateButton = (page: Page) => composer(page).getByTestId("composer-generate");
const priced = /^Generate · \d[\d,]* cr$/;

/** Every POST that could spend money, in the order it was sent. */
function watchPaid(page: Page) {
  const sent: { path: string; body: Record<string, unknown> }[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== "POST") return;
    if (["/api/generate", "/api/generate/quote", "/api/audio", "/api/higgsfield/consumer/generation"].includes(path))
      sent.push({ path, body: request.postDataJSON() });
  });
  return sent;
}

/** A connected account with a two-model catalogue, which the local mock has none of. */
async function mockConnected(page: Page) {
  const wallet = "22222222-2222-4222-8222-222222222222";
  const posts: Record<string, unknown>[] = [];
  await page.route("**/api/higgsfield/consumer/connection", (route) => route.fulfill({ json: { connected: true, requiresReconnect: false } }));
  await page.route("**/api/higgsfield/consumer/generation", async (route) => {
    const body = route.request().postDataJSON();
    posts.push(body);
    if (body.action === "catalogue")
      return route.fulfill({
        json: {
          catalogue: {
            models: [
              { id: "connected-still", name: "Still 1", description: "", outputType: "image", parameters: [], medias: [], aspectRatios: ["16:9"], tags: [], supportsUnlim: false },
              { id: "connected-still-pro", name: "Still 1 Pro", description: "", outputType: "image", parameters: [], medias: [], aspectRatios: ["16:9"], tags: [], supportsUnlim: false },
              { id: "connected-motion", name: "Motion 1", description: "", outputType: "video", parameters: [], medias: [], aspectRatios: ["16:9"], tags: [], supportsUnlim: false },
            ],
            unlim: { available: false, remaining: null, expiresAt: null },
            complete: true,
            fetchedAt: Date.now(),
          },
        },
      });
    if (body.action === "quote")
      return route.fulfill({
        json: {
          job: {
            id: `11111111-1111-4111-8111-${String(posts.length).padStart(12, "0")}`, draftId: body.draftId, status: "quoted", input: body.input,
            model: { id: body.input.model, name: "Still 1", outputType: "image" }, workspaceId: wallet, workspaceName: "Studio wallet",
            quoteCredits: 9, creditUnit: "higgsfield_credits", quoteExpiresAt: Date.now() + 300_000, providerJobId: null, result: null, createdAt: Date.now(),
          },
        },
      });
    return route.fulfill({ status: 409, json: { error: "This spec submits nothing to the connected account." } });
  });
  return posts;
}

/** Nothing in the composer may clip, and the page may never scroll sideways. */
async function assertNoClipping(page: Page) {
  const problems = await page.evaluate(() => {
    const out: string[] = [];
    const panel = document.querySelector<HTMLElement>(".pxw-composer-panel");
    if (!panel) return ["the composer is not open"];
    if (panel.getBoundingClientRect().bottom > innerHeight + 0.5) out.push("the composer runs off the bottom");
    if (panel.getBoundingClientRect().right > innerWidth + 0.5) out.push("the composer runs off the right");
    for (const element of Array.from(panel.querySelectorAll<HTMLElement>("button, select, .pxw-composer-title, .pxw-composer-billing")))
      if (element.scrollWidth > element.clientWidth + 0.5) out.push(`clipped: ${element.className || element.tagName}`);
    if (document.documentElement.scrollWidth > innerWidth + 1) out.push("the document scrolls horizontally");
    return out;
  });
  expect(problems).toEqual([]);
}

test("phones get the phone's own composer, not this overlay", async ({ page }, info) => {
  test.skip(!PHONE.includes(info.project.name), "phone viewports");
  const { project } = await seeded(page);
  await page.goto(url(project.id));
  /* /workspace is the phone's surface below 768px (wave M-A), and the phone
     skins the same composer host as a docked card on Make (wave M-C) — this
     desktop overlay is never mounted there. */
  await expect(page.locator(".pxw-phone")).toHaveCount(1);
  await expect(page.getByTestId("phone-shell")).toBeVisible();
  await expect(page.getByTestId("generate-composer")).toHaveCount(0);
  await expect(page.getByTestId("topbar-generate")).toHaveCount(0);
  await page.locator('[data-tab="make"]').click();
  await expect(page.getByTestId("mobile-composer-card")).toBeVisible();
});

test("the top-bar button opens the composer in every suite, Esc closes it and returns focus", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { project } = await seeded(page);

  for (const [suite, pageId] of [["particl", "rig"], ["atomik", "runs"], ["moleculr", "marketing"], ["subatomik", "motion"]] as const) {
    await page.goto(url(project.id, suite, pageId));
    const opener = page.getByTestId("topbar-generate");
    await expect(opener).toBeVisible();
    /* Left of the credits it spends. */
    const order = await page.evaluate(() => {
      const bar = document.querySelector('[data-row="topbar"]')!;
      const button = bar.querySelector('[data-testid="topbar-generate"]')!.getBoundingClientRect();
      const credits = bar.querySelector('[data-testid="workspace-credits"]')?.getBoundingClientRect();
      return credits ? button.right <= credits.left + 0.5 : true;
    });
    expect(order, `Generate sits left of the credits in ${suite}`).toBe(true);

    await opener.click();
    await expect(composer(page)).toBeVisible();
    /* The composer is an overlay: the suite underneath has not changed. */
    await expect(page).toHaveURL(new RegExp(`suite=${suite}`));
    await expect(composer(page).getByRole("dialog", { name: "Generate" })).toBeVisible();
    /* Nothing written yet: the button carries no figure and refuses to send. */
    await expect(generateButton(page)).toHaveText("Generate");
    await expect(generateButton(page)).toBeDisabled();
    await composer(page).getByTestId("composer-prompt").fill("A red lighthouse under a flat grey sky.");
    await expect(generateButton(page)).toHaveText(priced, { timeout: 30_000 });
    await assertNoClipping(page);

    await page.keyboard.press("Escape");
    await expect(composer(page)).toHaveCount(0);
    await expect(opener).toBeFocused();
  }
  /* The connected account is never named, here or anywhere (#262 keeps the
     connected catalogue neutral while the integrated models carry their names). */
  await page.getByTestId("topbar-generate").click();
  await expect(composer(page)).toBeVisible();
  await expect(composer(page)).not.toContainText(/Higgsfield/i);
  expect(errors).toEqual([]);
});

test("⌘K shows Generate… first, and G with no shot selected opens the composer", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  const { project } = await seeded(page);
  await page.goto(url(project.id, "particl", "takes"));
  await expect(page.getByTestId("page-title")).toHaveText("Takes");

  await page.keyboard.press("Meta+k");
  await expect(page.getByTestId("palette")).toBeVisible();
  const rows = page.getByTestId("palette-row");
  await expect(rows.first()).toContainText("Generate…");
  await rows.first().click();
  await expect(composer(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(composer(page)).toHaveCount(0);

  /* This project has no shots, so G has nothing to select and opens the composer. */
  await page.locator("body").press("g");
  await expect(composer(page)).toBeVisible();
});

test("typing in the prompt never fires G, I or A", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  const { project } = await seeded(page);
  await page.goto(url(project.id));
  /* The shell has to be up before anything is measured against it: an
     Inspector counted mid-hydration is absent for reasons that have nothing
     to do with the keyboard. */
  await expect(page.getByTestId("page-title")).toHaveText("Rig");
  await expect(page.getByTestId("inspector")).toBeVisible();
  const inspectorWasOpen = await page.getByTestId("inspector").count();
  expect(inspectorWasOpen).toBe(1);

  await page.getByTestId("topbar-generate").click();
  const prompt = composer(page).getByTestId("composer-prompt");
  await expect(prompt).toBeFocused();
  await prompt.fill("");
  await prompt.pressSequentially("a gantry in fog");
  /* Every letter landed in the field, including the three that are shortcuts. */
  await expect(prompt).toHaveValue("a gantry in fog");
  await expect(prompt).toBeFocused();

  /* And with focus on a control inside the composer — a button is not a field,
     so only the overlay guard keeps the shell's keys out. */
  const typeGroup = composer(page).getByRole("group", { name: "Output type" }).getByRole("button", { name: "Video" });
  await typeGroup.click();
  await expect(typeGroup).toBeFocused();
  for (const key of ["g", "i", "a", "3", " "]) await page.keyboard.press(key);

  /* The composer stayed open, no panel opened, and the Inspector did not toggle. */
  await expect(composer(page)).toBeVisible();
  await expect(page.getByTestId("atomik-button")).toHaveAttribute("aria-expanded", "false");
  await expect(page).toHaveURL(/[?&]page=rig(&|$)/);
  expect(await page.getByTestId("inspector").count()).toBe(inspectorWasOpen);

  /* Esc still gets through from inside the composer, and focus goes back. */
  await page.keyboard.press("Escape");
  await expect(composer(page)).toHaveCount(0);
  await expect(page.getByTestId("topbar-generate")).toBeFocused();
});

test("a mocked image generation shows its price, runs to completion and files a take", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  test.setTimeout(180_000);
  const { project, scope } = await seeded(page);
  const sent = watchPaid(page);
  await page.goto(url(project.id));
  await page.getByTestId("topbar-generate").click();

  /* Type first, model second and already defaulted: the composer works untouched. */
  await expect(composer(page).getByRole("group", { name: "Output type" }).getByRole("button", { name: "Image" })).toHaveAttribute("aria-pressed", "true");
  await expect(composer(page).getByTestId("composer-model")).toHaveValue(IMAGE_ENGINE);
  /* The default's label reads through the catalogue's own display name, never a
     label written in the composer — so a renaming PR renames it here too. */
  const defaultLabel = await composer(page).getByTestId("composer-model").locator("option[value='" + IMAGE_ENGINE + "']").textContent();
  expect(defaultLabel).toBe(displayModelName(IMAGE_ENGINE));
  /* This workspace's credits are the default, and the composer says so. */
  await expect(composer(page).getByRole("group", { name: "Credits used" }).getByRole("button", { name: "This workspace’s credits" })).toHaveAttribute("aria-pressed", "true");
  await expect(composer(page).getByTestId("composer-billing")).toContainText("credits");

  /* Nothing written: blocked, with a reason. */
  await expect(composer(page).getByTestId("composer-blocked")).toHaveText("Write what to generate.");
  await expect(generateButton(page)).toBeDisabled();

  await composer(page).getByTestId("composer-prompt").fill("A red lighthouse under a flat grey sky.");
  await expect(generateButton(page)).toHaveText(priced, { timeout: 30_000 });
  await expect(generateButton(page)).toBeEnabled();
  const credits = Number((await generateButton(page).textContent())!.replace(/\D/g, ""));
  expect(credits).toBeGreaterThan(0);

  await generateButton(page).click();

  /* Progress comes from the real job, through the shell's own strip. */
  const strip = page.locator(".pxw-gen");
  await expect(strip).toBeVisible({ timeout: 30_000 });
  await expect(strip).toContainText(displayModelName(IMAGE_ENGINE));
  await expect.poll(() => sent.map((s) => s.path)).toEqual(["/api/generate/quote", "/api/generate"]);
  const [quoted, dispatched] = sent.map((s) => s.body);
  /* The same body is quoted and sent; the approved ceiling and the fingerprint ride along. */
  expect(quoted.maxCredits).toBeUndefined();
  expect(dispatched).toMatchObject({ model: IMAGE_ENGINE, refine: false, maxCredits: credits, prompt: "A red lighthouse under a flat grey sky." });
  expect(dispatched.quoteFingerprint).toMatch(/^[a-f0-9]{64}$/);
  const rest = { ...dispatched };
  delete rest.maxCredits;
  delete rest.quoteFingerprint;
  expect(rest).toEqual(quoted);

  await expect(page.getByRole("status").filter({ hasText: /rendered\. Filed in Takes/ })).toBeVisible({ timeout: 90_000 });

  /* The output is in this project's library, and in Takes. */
  await expect.poll(async () => {
    const library = await page.request.get(`/api/workbench/library?projectId=${project.id}&source=generations`, { headers: { "X-Workbench-Scope": scope } }).then((r) => r.json());
    return (library.generations ?? []).filter((g: { status: string }) => g.status === "succeeded").length;
  }, { timeout: 30_000 }).toBe(1);
  await page.keyboard.press("Escape");
  await page.getByRole("navigation", { name: "Pages" }).getByRole("button", { name: /Takes/ }).click();
  await expect(page.getByTestId("page-title")).toHaveText("Takes");
  await expect(page.getByTestId("take-grid").locator(".pxw-take-card")).toHaveCount(1, { timeout: 30_000 });
  /* Filed for review, not auto-approved (CLAUDE.md rule 4). */
  await expect(page.locator(".pxw-take-card .pxw-take-status").first()).not.toContainText(/Approved/i);
});

test("a mocked Grok Imagine Video clip is priced per second, runs on the xAI engine and files a take", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one desktop run");
  test.setTimeout(180_000);
  const { project, scope } = await seeded(page);
  const sent = watchPaid(page);
  await page.goto(url(project.id));
  await page.getByTestId("topbar-generate").click();
  await composer(page).getByRole("group", { name: "Output type" }).getByRole("button", { name: "Video" }).click();
  await composer(page).getByTestId("composer-model").selectOption("grok-imagine-video-1.5");
  await composer(page).getByTestId("composer-prompt").fill("A red fox crosses the frozen harbour at dusk.");
  await expect(generateButton(page)).toHaveText(priced, { timeout: 30_000 });
  await generateButton(page).click();
  await expect.poll(() => sent.map((s) => s.path)).toEqual(["/api/generate/quote", "/api/generate"]);
  expect(sent[1].body).toMatchObject({ model: "grok-imagine-video-1.5", prompt: "A red fox crosses the frozen harbour at dusk." });
  await expect(page.getByRole("status").filter({ hasText: /rendered\. Filed in Takes/ })).toBeVisible({ timeout: 90_000 });
  const library = await page.request.get(`/api/workbench/library?projectId=${project.id}&source=generations`, { headers: { "X-Workbench-Scope": scope } }).then((r) => r.json());
  expect((library.generations ?? []).filter((g: { status: string; model?: string }) => g.status === "succeeded")).toHaveLength(1);
});

test("a moved price blocks the send and spends nothing", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  const { project } = await seeded(page);
  const sent = watchPaid(page);
  /* The re-quote at submit answers with a different figure than the button showed. */
  await page.route("**/api/generate/quote", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    return route.fulfill({ response, json: { ...body, estimatedCredits: Number(body.estimatedCredits ?? 1) + 7 } });
  });
  await page.goto(url(project.id));
  await page.getByTestId("topbar-generate").click();
  await composer(page).getByTestId("composer-prompt").fill("A red lighthouse under a flat grey sky.");
  await expect(generateButton(page)).toHaveText(priced, { timeout: 30_000 });
  const before = Number((await generateButton(page).textContent())!.replace(/\D/g, ""));

  await generateButton(page).click();

  /* The new price is shown, the button carries it, and nothing was submitted. */
  await expect(composer(page).getByTestId("composer-notice")).toContainText(`The price is now ${(before + 7).toLocaleString("en-US")} cr`);
  await expect(generateButton(page)).toHaveText(`Generate · ${(before + 7).toLocaleString("en-US")} cr`);
  await expect(page.locator(".pxw-gen")).toHaveCount(0);
  expect(sent.filter((s) => s.path === "/api/generate")).toEqual([]);
  expect(sent.filter((s) => s.path === "/api/higgsfield/consumer/generation")).toEqual([]);
  /* Pressing it again approves the figure now on the button. */
  await generateButton(page).click();
  await expect.poll(() => sent.filter((s) => s.path === "/api/generate").length, { timeout: 30_000 }).toBe(1);
  expect(sent.find((s) => s.path === "/api/generate")!.body.maxCredits).toBe(before + 7);
});

test("the connected switch changes the model list and the credit wording", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  const { project } = await seeded(page);
  const posts = await mockConnected(page);
  const sent = watchPaid(page);
  await page.goto(url(project.id));
  await page.getByTestId("topbar-generate").click();
  await composer(page).getByTestId("composer-prompt").fill("A red lighthouse under a flat grey sky.");

  const models = composer(page).getByTestId("composer-model");
  await expect(models).toHaveValue(IMAGE_ENGINE);
  const workspaceOptions = await models.locator("option").allTextContents();
  const workspaceWording = await composer(page).getByTestId("composer-billing").textContent();
  await expect(generateButton(page)).toHaveText(priced, { timeout: 30_000 });

  await composer(page).getByRole("group", { name: "Credits used" }).getByRole("button", { name: "Connected account" }).click();

  /* A different catalogue, and a different price source. */
  await expect(models).toHaveValue("connected-still", { timeout: 30_000 });
  const connectedOptions = await models.locator("option").allTextContents();
  expect(connectedOptions).toEqual(["Still 1", "Still 1 Pro"]);
  expect(connectedOptions).not.toEqual(workspaceOptions);
  await expect(generateButton(page)).toHaveText("Generate · 9 connected cr", { timeout: 30_000 });
  const connectedWording = await composer(page).getByTestId("composer-billing").textContent();
  expect(connectedWording).not.toBe(workspaceWording);
  expect(connectedWording).toContain("connected account");
  expect(connectedWording).toContain("Studio wallet");
  /* Neutral throughout: the provider is never named. */
  await expect(composer(page)).not.toContainText(/Higgsfield/i);
  expect(posts.map((post) => post.action)).toContain("catalogue");
  /* Switching back restores the workspace list and its wording. */
  await composer(page).getByRole("group", { name: "Credits used" }).getByRole("button", { name: "This workspace’s credits" }).click();
  await expect(models).toHaveValue(IMAGE_ENGINE, { timeout: 30_000 });
  await expect(generateButton(page)).toHaveText(priced, { timeout: 30_000 });
  /* Looking at the other source spends nothing on this one. */
  expect(sent.filter((s) => s.path === "/api/generate")).toEqual([]);
});

test("with no project open the composer starts one called Untitled and says so", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  test.setTimeout(180_000);
  const { scope } = await account(page);
  const sent = watchPaid(page);
  await page.goto("/workspace");
  /* Home, no project of any kind. */
  await expect(page.getByTestId("home-generate")).toBeVisible();
  await expect(page.locator(".pxw-home-empty")).toBeVisible();
  await page.getByTestId("home-generate").click();
  await expect(composer(page)).toBeVisible();
  await composer(page).getByTestId("composer-prompt").fill("A red lighthouse under a flat grey sky.");
  await expect(generateButton(page)).toHaveText(priced, { timeout: 30_000 });
  await generateButton(page).click();

  await expect(composer(page).getByTestId("composer-project-notice")).toContainText("Untitled");
  await expect.poll(() => sent.some((s) => s.path === "/api/generate"), { timeout: 60_000 }).toBe(true);
  /* The project was created server-side, with an id the browser never invented. */
  const created = await expect.poll(async () => {
    const body = await page.request.get("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope } }).then((r) => r.json());
    return (body.projects ?? []).map((project: { name: string }) => project.name);
  }, { timeout: 30_000 });
  await created.toContain("Untitled");
  const dispatched = sent.find((s) => s.path === "/api/generate")!.body as { projectId: string; shotId: string };
  expect(dispatched.projectId).toMatch(/^[a-zA-Z0-9_-]{1,100}$/);
  expect(dispatched.shotId).toMatch(/^[a-zA-Z0-9_-]{1,100}$/);
  await expect(page.locator(".pxw-gen")).toBeVisible({ timeout: 30_000 });
});

test("no clipping at 1200, 1440 and 1920 with the composer open", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one desktop project resizes through all three");
  const { project } = await seeded(page);
  for (const size of [{ width: 1200, height: 800 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(size);
    await page.goto(url(project.id));
    await page.getByTestId("topbar-generate").click();
    await expect(composer(page)).toBeVisible();
    await composer(page).getByTestId("composer-prompt").fill("A red lighthouse under a flat grey sky.");
    await expect(generateButton(page)).toHaveText(priced, { timeout: 30_000 });
    await assertNoClipping(page);
  }
});
