import { test, expect, type Locator, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { newProject, type Project } from "../lib/workbench/studio";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { dimLabels, smallTargets } from "./phoneFloors";

/**
 * Production › Cast, in a managed workspace (credits), against a local
 * ENGINE_MOCK=1 server: every route is the real one and every engine is the
 * mock. Since D0.2 Cast starts no render: the stills engines it rendered with
 * are no longer offered, so a character's card has its Identity select, Build
 * identity at the trainer's own price, and Make a still in Gen. Entries built
 * earlier are still read (one read-only), an identity trained earlier is
 * listed read-only, the server refuses a new request for a retired engine,
 * and nothing of the connected account is read.
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
    /* The shell's collector (lib/shell/connected-collector.ts) lists the open project's earlier connected jobs on every page,
       so paid work already on the account still lands. That listing is not Cast's; anything else would be. */
    if (request.method() === "GET" && url.pathname === "/api/higgsfield/consumer/generation" && url.searchParams.has("draftId")) return;
    consumer.push(`${request.method()} ${url.pathname}${url.search}`);
  });
  page.on("pageerror", (error) => errors.push(error.message));
  const read = async () => (await page.request.get(`/api/workbench/projects?id=${project.id}`, { headers }).then((r) => r.json())).project as Project;
  const identities = async () => (await page.request.get(`/api/soul/identities?projectId=${project.id}`, { headers }).then((r) => r.json())) as { identities: Identity[]; terms: { versions: { version: string; trainingCredits: number }[] } };
  /* An identity as an earlier build left it: trained through the earlier route (mock trainer) until it is ready. */
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

test("Cast starts no render on the retired stills engines: Identity, Build identity at the trainer's price, earlier builds read-only, and the server refuses a new request", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "the five sizes");
  test.setTimeout(180_000);
  const f = await setup(page);
  const earlier = await f.train("Mira", "v1");
  expect(earlier.renderModel).toBe("hf-soul-standard");
  await page.goto(`/suites?suite=studio&page=cast&project=${f.project.id}`);
  await expect(page.getByTestId("cast-stage")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("page-title")).toHaveText("Cast & Elements");
  const fox = page.getByTestId("cast-entry").filter({ has: page.locator('input[value="Fox"]') });

  /* The select is Identity; with none built here it offers None alone, and nothing renders from the card. */
  const select = fox.getByTestId("cast-identity");
  await expect(select).toHaveAttribute("aria-label", "Fox identity");
  await expect(select.locator("option")).toHaveText(["None"]);
  for (const gone of ["cast-render-run", "cast-render-why", "cast-render-retry", "cast-batch-4", "cast-size-1080p", "cast-likeness", "cast-element", "cast-soul-retrain"])
    await expect(page.getByTestId(gone), gone).toHaveCount(0);
  /* Its primary is Build identity, at the price the trainer's own terms state (never one written in the page). */
  const terms = (await page.request.get("/api/identities", { headers: f.headers }).then((r) => r.json())).terms as { trainCredits: number | null };
  expect(terms.trainCredits).toBeGreaterThan(0);
  const build = fox.getByTestId("cast-build-identity");
  await expect(build).toHaveText(`Build identity · ${terms.trainCredits!.toLocaleString("en-US")} cr`, { timeout: 30_000 });
  /* No customer reads the old family word or the vendor anywhere on the page. */
  await expect(page.getByTestId("cast-stage")).not.toContainText(/Soul|Higgsfield/i);
  if (PHONES.includes(info.project.name)) {
    expect(await smallTargets(page, '[data-testid="cast-render"], [data-testid="cast-entries"] .gx-gen-enhance')).toEqual([]);
  }
  expect(await dimLabels(page, '[data-testid="cast-stage"]')).toEqual([]);
  await noSideScroll(page);
  await page.screenshot({ path: info.outputPath("cast-identity.png") });

  /* Build identity on the card opens the section below with the character's name; nothing is sent by the press. */
  let paid = 0;
  await page.route("**/api/identities/**", (route) => { if (route.request().method() === "POST") paid++; return route.fallback(); });
  await hydrated(build);
  await build.click();
  const card = page.getByTestId("soul-card");
  await expect(card.getByTestId("soul-name")).toHaveValue("Fox");
  await expect(card.getByTestId("soul-build")).toHaveText(`Build identity · ${terms.trainCredits!.toLocaleString("en-US")} cr`);
  await expect(card.getByTestId("soul-build")).toBeDisabled();
  await expect(card.getByTestId("soul-blocked")).toHaveText(/^Pick \d+–\d+ uploaded photos of the same person \(0 picked\)\.$/);
  /* The identity trained earlier stays listed, read-only. */
  await expect(card.getByTestId(`soul-row-${earlier.id}`)).toContainText("Mira");
  await expect(card.getByTestId(`soul-row-${earlier.id}`)).toContainText("Earlier identity · read-only");
  expect(paid).toBe(0);

  /* The server refuses a new request for a retired engine, quote and submit alike, in one plain sentence. */
  const body = { model: "hf-soul-standard", prompt: "A red fox on the ice", projectId: (await f.read()).productionProjectId, shotId: "", ratio: "3:4", resolution: "720p", duration: 5,
    refine: false, references: [], soulIdentityId: earlier.id, soulStrength: 1, workbenchProjectId: f.project.id, soulBatch: 1 };
  for (const path of ["/api/generate/quote", "/api/generate"]) {
    const refused = await page.request.post(path, { headers: { ...f.headers, "Idempotency-Key": randomUUID() }, data: { ...body, ...(path === "/api/generate" ? { maxCredits: 999 } : {}) } });
    expect(refused.status(), path).toBe(410);
    expect(await refused.json(), path).toMatchObject({ error: "This engine is no longer offered for new renders. Past results stay in the Library.", code: "engine_retired" });
  }

  /* Built earlier with a stills model that made a place: shown read-only, its still kept. */
  const harbour = page.getByTestId("cast-entry").filter({ has: page.locator('input[value="Frozen harbour"]') });
  await expect(harbour).toHaveAttribute("data-readonly", "");
  await expect(harbour.getByTestId("cast-retired")).toHaveText("Built earlier on an engine that is no longer offered. Read-only: its still stays in the Library.");
  await expect(harbour.getByRole("textbox", { name: "Name", exact: true })).toHaveAttribute("readonly", "");
  await harbour.locator(".pd-frame-image").scrollIntoViewIfNeeded();
  await expect(harbour.locator(".pd-frame-image img")).toBeVisible();
  /* A character whose identity was trained on the earlier account keeps every saved field; its card offers Build identity. */
  const nova = page.getByTestId("cast-entry").filter({ has: page.locator('input[value="Nova"]') });
  await expect(nova.getByTestId("cast-build-identity")).toBeVisible();
  expect((await f.read()).production!.cast!.entries.find((e) => e.id === "cast-nova")).toMatchObject({ soulId: "acct-soul-nova", model: "soul_cinematic" });

  await noSideScroll(page);
  await page.screenshot({ path: info.outputPath("cast-build-identity.png") });
  expect(f.consumer, "nothing of the connected account is read or sent").toEqual([]);
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
  /* Cast builds on Particl's own key: nothing here is the card for what ran on the retired sign-in. */
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
