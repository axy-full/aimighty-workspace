import { test, expect, type Locator, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { newProject, type Project } from "../lib/workbench/studio";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { dimLabels, smallTargets } from "./phoneFloors";

/**
 * Production › Cast on the platform's key, in a managed workspace (credits),
 * against a local ENGINE_MOCK=1 server: every route is the real one and every
 * engine is the mock. A character renders with a Soul ID trained in this
 * workspace — Soul Standard here, the family it was trained for — 4 stills in one
 * request at the live estimate shown on the button ("about N cr"), sent once
 * with that figure as its ceiling, and every still is filed as Cast. Entries
 * built earlier on the connected account are shown read-only, a Soul ID
 * trained there asks to be trained again, and nothing of the account is read.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const SCRIPT = "EXT. FROZEN HARBOUR - DUSK\n\nA red fox crosses the ice.\n";
const CONSUMER = /\/api\/higgsfield\/consumer\//;
const OLD_BUILD = `gen_hfc_${createHash("sha1").update("an account build").digest("hex")}`;
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "ignoreErrors" }); });
const hydrated = (target: Locator) => expect.poll(() => target.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps"))), { timeout: 30_000 }).toBe(true);

type Identity = { id: string; name: string; status: string; renderModel: string | null; creditsBilled: number | null };

/** `scene`: the beat sheet's names in place of the fox and the lantern; `cast: false` starts with no cast list. */
async function setup(page: Page, options: { scene?: { characters?: string[]; props?: string[] }; cast?: boolean } = {}) {
  const account = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${account.workspace.id}-${me.id}` };
  /* A managed workspace pays in credits. The server writes the same local files: wait for its lock. */
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  let tenantUrl = "";
  try {
    await platform.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)", args: [randomUUID(), account.workspace.id, 5000, "Cast test", "admin", "test", Date.now()] });
    tenantUrl = String((await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id=?", args: [account.workspace.id] })).rows[0].db_url);
  } finally { platform.close(); }
  expect(tenantUrl).toMatch(/^file:/);
  /* The still an earlier build on the connected account left in this workspace, as its collector filed it. */
  const tenant = createClient({ url: tenantUrl, timeout: 10_000 });
  try { await tenant.execute({ sql: "INSERT OR IGNORE INTO generations(id,model,prompt,params,status,kind,stored_url,created_by,created_at,updated_at) VALUES(?,'soul_location','an earlier build','{}','succeeded','image',?,?,?,?)", args: [OLD_BUILD, `/api/media/${OLD_BUILD}`, me.id, Date.now(), Date.now()] }); }
  finally { tenant.close(); }
  const project = newProject(`Cast ${randomUUID().slice(0, 6)}`);
  project.script = SCRIPT;
  project.production = {
    beats: { scriptSha256: createHash("sha256").update(SCRIPT).digest("hex"), updatedAt: new Date().toISOString(), scenes: [
      { id: "scene-a", heading: "EXT. FROZEN HARBOUR - DUSK", summary: "The crossing", beats: [{ id: "beat-a", text: "The fox crosses" }], shots: [{ id: "shot-a", description: "The fox", framing: "", movement: "", lighting: "", sound: "" }], characters: ["Fox"], locations: ["Frozen harbour"], props: ["Lantern"], ...options.scene },
    ] },
    cast: { entries: options.cast === false ? [] : [
      { id: "cast-fox", kind: "character", name: "Fox", description: "A red fox", prompt: "A red fox on the ice at dusk, three-quarter view", takes: [] },
      /* Built earlier on the connected account with Soul Location, which the key has no family for. */
      { id: "cast-harbour", kind: "element", name: "Frozen harbour", description: "Where the fox crosses", prompt: "The harbour, wide", takes: [{ genId: OLD_BUILD, at: "2026-09-24T10:00:00.000Z" }], model: "soul_location", category: "environment" },
      /* A character whose Soul ID was trained on the account: it must be trained again here. */
      { id: "cast-nova", kind: "character", name: "Nova", description: "The harbour master", prompt: "Nova in a heavy coat", takes: [], soulId: "acct-soul-nova", model: "soul_cinematic" },
    ] },
  } as Project["production"];
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  /* Two stills of one person, uploaded and filed in this project's library. */
  const stills: { id: string; url: string }[] = [];
  for (const [i, background] of ["#8a6f5a", "#6f5a8a"].entries()) {
    const buffer = await sharp({ create: { width: 360, height: 480, channels: 3, background } }).png().toBuffer();
    const uploaded = await page.request.post("/api/uploads", { headers, multipart: { file: { name: `mira-${i + 1}.png`, mimeType: "image/png", buffer } } });
    expect(uploaded.ok(), await uploaded.text()).toBe(true);
    const still = await uploaded.json();
    const filed = await page.request.post("/api/workbench/library", { headers, data: { projectId: project.id, uploadId: still.id } });
    expect(filed.ok(), await filed.text()).toBe(true);
    stills.push(still);
  }
  const pixel = await readFile("public/fixtures/still.png");
  await page.route(`**/api/media/${OLD_BUILD}*`, (route) => route.fulfill({ body: pixel, contentType: "image/png" }));
  const consumer: string[] = [];
  const errors: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!CONSUMER.test(url.pathname)) return;
    /* No account route at all, not even a list of saved jobs: the shell's collector went with the sign-in. */
    consumer.push(`${request.method()} ${url.pathname}${url.search}`);
  });
  page.on("pageerror", (error) => errors.push(error.message));
  const read = async () => (await page.request.get(`/api/workbench/projects?id=${project.id}`, { headers }).then((r) => r.json())).project as Project;
  const identities = async () => (await page.request.get(`/api/soul/identities?projectId=${project.id}`, { headers }).then((r) => r.json())) as { identities: Identity[]; terms: { versions: { version: string; trainingCredits: number }[] } };
  /* Train a Soul ID through the real route (mock trainer) and wait until it is ready. */
  const train = async (name: string, version: "v1" | "v2" | "cinema") => {
    const { terms } = await identities();
    const credits = terms.versions.find((v) => v.version === version)!.trainingCredits;
    const reply = await page.request.post("/api/soul/identities", { headers: { ...headers, "Idempotency-Key": randomUUID() },
      data: { projectId: project.id, name, description: "", subjectType: "character", references: stills.map((s) => ({ uploadId: s.id })), consent: true, modelVersion: version, maxCredits: credits } });
    expect(reply.status(), await reply.text()).toBe(202);
    const { identity } = await reply.json() as { identity: Identity };
    await expect.poll(async () => (await identities()).identities.find((i) => i.id === identity.id)?.status, { timeout: 45_000 }).toBe("ready");
    return identity;
  };
  return { project, headers, stills, consumer, errors, read, identities, train };
}

async function noSideScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), "no horizontal page scroll").toBeLessThanOrEqual(1);
  for (const card of await page.locator('[data-testid="cast-entry"], [data-testid="soul-card"]').all())
    expect(await card.evaluate((el) => el.scrollWidth - el.clientWidth), "a card keeps its content inside").toBeLessThanOrEqual(1);
}

test("Render with identity: a character renders 4 stills with its Soul ID at the live estimate, sent once, every still filed as Cast", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "the five sizes");
  test.setTimeout(180_000);
  const f = await setup(page);
  const soul = await f.train("Mira", "v1");
  expect(soul.renderModel).toBe("hf-soul-standard");
  await page.goto(`/suites?suite=studio&page=cast&project=${f.project.id}`);
  await expect(page.getByTestId("cast-stage")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("page-title")).toHaveText("Cast & Elements");
  const fox = page.getByTestId("cast-entry").filter({ has: page.locator('input[value="Fox"]') });

  /* No Soul ID chosen: the reason, no price, nothing to press. */
  await expect(fox.getByTestId("cast-render-why")).toHaveText("Choose its Soul ID to render it.");
  await expect(fox.getByTestId("cast-render-run")).toBeDisabled();

  /* Its Soul ID (listed with the family it renders with), 4 stills, 1080p: the live estimate lands on the button. */
  await fox.getByTestId("cast-identity").selectOption({ label: "Mira · Soul Standard" });
  await fox.getByTestId("cast-batch-4").click();
  await fox.getByTestId("cast-size-1080p").click();
  const run = fox.getByTestId("cast-render-run");
  await expect(run).toHaveText(/^Render 4 stills · Soul Standard · about \d+ cr$/, { timeout: 30_000 });
  const credits = Number((await run.innerText()).match(/about (\d+) cr/)![1]);
  expect(credits).toBeGreaterThan(0);
  await expect(page.getByTestId("cast-render-why")).toHaveCount(1); // Nova's, not the fox's
  if (PHONES.includes(info.project.name)) {
    expect(await smallTargets(page, '[data-testid="cast-render"], [data-testid="cast-entries"] .gx-gen-enhance')).toEqual([]);
  }
  expect(await dimLabels(page, '[data-testid="cast-stage"]')).toEqual([]);
  await noSideScroll(page);
  await page.screenshot({ path: info.outputPath("cast-render-priced.png") });

  /* Sent once, at the price on the button as its ceiling, with the workspace's own Soul ID id — never the provider's. */
  const sent = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/generate" && request.method() === "POST");
  await run.click();
  const request = await sent;
  expect(request.headers()["idempotency-key"]).toBeTruthy();
  expect(request.postDataJSON()).toMatchObject({ model: "hf-soul-standard", soulIdentityId: soul.id, soulBatch: 4, soulStrength: 1, resolution: "1080p", ratio: "3:4",
    references: [], maxCredits: credits, quoteFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(request.postData()).not.toContain("custom_reference_id");
  await expect(run).toHaveText("Rendering…");

  /* The request's four stills are filed as Cast: four takes on the fox, four Character assets bound to the Soul ID. */
  await expect(fox.locator(".pd-takes [role=radio]")).toHaveCount(4, { timeout: 60_000 });
  /* The picture mounts once it is on screen (a short landscape phone scrolls to it). */
  await fox.locator(".pd-frame-image").scrollIntoViewIfNeeded();
  await expect(fox.locator(".pd-frame-image img")).toBeVisible();
  await expect.poll(async () => (await f.read()).assets.filter((a) => a.category === "Character" && a.soulIdentityId === soul.id).length, { timeout: 20_000 }).toBe(4);
  const entry = (await f.read()).production!.cast!.entries.find((e) => e.id === "cast-fox")!;
  expect(entry.pending ?? []).toEqual([]);
  expect(entry.takes).toHaveLength(4);
  /* One bill, on the request's own take, at the price shown; its batch's other stills carry none. */
  const [leader, ...rest] = entry.takes.map((t) => t.genId);
  expect(rest).toEqual([2, 3, 4].map((n) => `${leader}-${n}`));
  await expect.poll(async () => (await page.request.get(`/api/jobs/${leader}?sync=0`, { headers: f.headers }).then((r) => r.json())).generation.creditsBilled, { timeout: 20_000 }).toBe(credits);
  const first = (await page.request.get(`/api/jobs/${leader}?sync=0`, { headers: f.headers }).then((r) => r.json())).generation;
  expect(first.params.soulBatchIds).toEqual([leader, ...rest]);
  for (const id of rest) expect((await page.request.get(`/api/jobs/${id}?sync=0`, { headers: f.headers }).then((r) => r.json())).generation).toMatchObject({ status: "succeeded", creditsBilled: 0 });
  await expect(run).toHaveText(/^Render 4 stills · Soul Standard · about \d+ cr$/);

  /* Built earlier on the account: shown read-only; a Soul ID trained there asks to be trained again. */
  const harbour = page.getByTestId("cast-entry").filter({ has: page.locator('input[value="Frozen harbour"]') });
  await expect(harbour).toHaveAttribute("data-readonly", "");
  await expect(harbour.getByTestId("cast-retired")).toHaveText("Built earlier with Soul Location on the connected account, which isn’t available here. Read-only: its still stays in the Library.");
  await expect(harbour.getByRole("textbox", { name: "Name", exact: true })).toHaveAttribute("readonly", "");
  await expect(harbour.getByTestId("cast-render-run")).toHaveCount(0);
  const nova = page.getByTestId("cast-entry").filter({ has: page.locator('input[value="Nova"]') });
  await expect(nova.getByTestId("cast-soul-retrain")).toHaveText("Its Soul ID was trained on the connected account, which can’t be used here. Train it again below (Build identity) to render it.");
  await expect(nova.getByTestId("cast-render-why")).toHaveText("Choose its Soul ID to render it.");
  expect((await f.read()).production!.cast!.entries.find((e) => e.id === "cast-nova")).toMatchObject({ soulId: "acct-soul-nova", model: "soul_cinematic" });

  /* Filed in the Library as Cast (the desktop Library shows the filter). */
  if (!PHONES.includes(info.project.name)) {
    const library = page.getByTestId("library");
    await library.getByRole("tab", { name: /Assets/ }).click();
    await library.getByRole("button", { name: "Cast", exact: true }).click();
    await expect(library.locator("[data-ctx^='asset:']")).toHaveCount(4, { timeout: 20_000 });
  }
  await noSideScroll(page);
  await page.screenshot({ path: info.outputPath("cast-rendered.png") });
  expect(f.consumer, "nothing of the connected account is read or sent").toEqual([]);
  expect(f.errors).toEqual([]);
});

test("a render the estimate cannot price stays unsent: the reason, Try again, and no paid request", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  test.setTimeout(150_000);
  const f = await setup(page);
  const soul = await f.train("Mira", "v1");
  /* The quote route answers with no price, as it does when the provider's estimate has no number. */
  let quotes = 0;
  await page.route("**/api/generate/quote", (route) => { quotes++; return route.fulfill({ status: 503, json: { error: "The identity account returned no price for this Soul render. Nothing was submitted.", code: "price_unavailable" } }); });
  let paid = 0;
  await page.route("**/api/generate", (route) => { if (route.request().method() === "POST") paid++; return route.fallback(); });
  await page.goto(`/suites?suite=studio&page=cast&project=${f.project.id}`);
  const fox = page.getByTestId("cast-entry").filter({ has: page.locator('input[value="Fox"]') });
  await fox.getByTestId("cast-identity").selectOption(soul.id);
  const run = fox.getByTestId("cast-render-run");
  await expect(run).toHaveText("Price unavailable", { timeout: 30_000 });
  await expect(run).toBeDisabled();
  await expect(fox.getByRole("alert")).toHaveText("The identity account returned no price for this Soul render. Nothing was submitted.");
  const before = quotes;
  await fox.getByTestId("cast-render-retry").click();
  await expect.poll(() => quotes).toBeGreaterThan(before);
  expect(paid).toBe(0);
  await noSideScroll(page);
  expect(f.consumer).toEqual([]);
  expect(f.errors).toEqual([]);
});

/**
 * "Add N from the beat sheet" appended the list its render counted. When the
 * agent's cast landed between that render and the click, React ran the
 * handler from the render before, and a name both listed was added twice. The
 * click now decides on the list as it is when its update applies. This test
 * keeps the button's click handler from the render before the agent's names
 * landed and runs it after them: that order, every time.
 */
test("Add from the beat sheet clicked from a render before the agent's cast landed lists each name once", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one desktop width");
  test.setTimeout(150_000);
  /* The beat sheet names the agent's two (Mara, the mooring rope) and two it does not. */
  const { errors, read, project } = await setup(page, { cast: false, scene: { characters: ["Fox", "Mara"], props: ["Lantern", "Mooring rope"] } });
  await page.goto(`/suites?suite=studio&page=cast&project=${project.id}`);
  await expect(page.getByTestId("cast-stage")).toBeVisible({ timeout: 60_000 });
  const add = page.getByTestId("cast-from-beats");
  const status = page.getByTestId("cast-stage").locator(".pd-save");
  const names = async () => ((await read()).production?.cast?.entries ?? []).map((e: { name: string }) => e.name);
  await expect(add).toHaveText("Add 4 from the beat sheet");
  await hydrated(add);
  /* The button's click handler as rendered now, while the list is empty. */
  await add.evaluate((el) => {
    const props = (el as unknown as Record<string, { onClick: () => void }>)[Object.keys(el).find((k) => k.startsWith("__reactProps"))!];
    (window as unknown as { staleAdd: () => void }).staleAdd = props.onClick;
  });

  await page.getByTestId("cast-agent-estimate").click();
  await expect(page.getByTestId("cast-agent-quote")).toContainText("3 agent steps");
  await page.getByTestId("cast-agent-start").click();
  await expect.poll(names, { timeout: 60_000 }).toEqual(["Mara", "Mooring rope"]);
  /* The button counts only what is still missing. */
  await expect(add).toHaveText("Add 2 from the beat sheet");
  await expect(status).toHaveText(/^Saved/);

  /* The click lands now, with that earlier render's list of four: only the two still missing are added. */
  await page.evaluate(() => (window as unknown as { staleAdd: () => void }).staleAdd());
  await expect(page.getByTestId("cast-entry")).toHaveCount(4);
  await expect.poll(names).toEqual(["Mara", "Mooring rope", "Fox", "Lantern"]);
  await expect(add).toHaveText("Add 0 from the beat sheet");
  await expect(add).toBeDisabled();
  await expect(status).toHaveText(/^Saved/);

  /* Once more from that render: nothing is missing, so nothing changes — no edit, and the page still says Saved. */
  const after = await page.evaluate(async () => {
    (window as unknown as { staleAdd: () => void }).staleAdd();
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    return document.querySelector("[data-testid='cast-stage'] .pd-save")?.textContent ?? "";
  });
  expect(after).toMatch(/^Saved/);
  await expect(page.getByTestId("cast-entry")).toHaveCount(4);
  expect(await names()).toEqual(["Mara", "Mooring rope", "Fox", "Lantern"]);
  expect(errors).toEqual([]);
});

test("an entry's still is made in Gen with its own words, on this workspace's credits; Cast shows no card of the retired sign-in", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "the five sizes");
  test.setTimeout(120_000);
  const f = await setup(page);
  await page.goto(`/suites?suite=studio&page=cast&project=${f.project.id}`);
  await expect(page.getByTestId("cast-stage")).toBeVisible({ timeout: 60_000 });
  /* Cast builds on Particl's own key: nothing here is the card for what ran on the Higgsfield sign-in. */
  await expect(page.getByTestId("owner-run-cast")).toHaveCount(0);
  const fox = page.getByTestId("cast-entry").filter({ has: page.locator('input[value="Fox"]') });
  const still = fox.getByTestId("cast-still-gen");
  await still.scrollIntoViewIfNeeded();
  await hydrated(still);
  await still.click();
  await expect(page.getByTestId("gen-view")).toBeVisible();
  await expect(page.getByRole("tablist", { name: "Output" }).getByRole("tab", { name: "Images" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("gen-prompt")).toHaveValue("A red fox on the ice at dusk, three-quarter view");
  expect(f.consumer, "nothing of the connected account is read or sent").toEqual([]);
  expect(f.errors).toEqual([]);
});
