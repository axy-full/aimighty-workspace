import { test, expect, type Page, type Locator } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { legacyShell } from "./helpers/legacyShell";
import { newProject } from "../lib/workbench/studio";
import { GENJUTSU_MODELS } from "../lib/genjutsuTypes";
import { smallTargets } from "./phoneFloors";

/**
 * Atomik plans library steps: Motion Transfer and Marketing Studio Image on
 * the API key, from the project's own library.
 *
 * Real local routes on an ENGINE_MOCK=1 server. A fresh workspace uploads a
 * clip and a still, files them in its Studio project's library, and asks
 * Atomik in the rail (the sheet on a phone). The mocked planner proposes a
 * Motion Transfer and a Marketing Studio still from the library; each is
 * priced on its admission quote before it is shown. Continue approves the
 * transform at its quoted price, and the take lands in the project, billed
 * what the button said. A step nothing can price is named as not proposed and
 * never offered. No provider is called and nothing is billed for real.
 */
const MOTION = GENJUTSU_MODELS["motion-transfer"];

async function seeded(page: Page) {
  const signed = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${signed.workspace.id}-${me.id}` };
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  let tenantUrl: string;
  try {
    await platform.execute({
      sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
      args: [randomUUID(), signed.workspace.id, 2000, "Local mock Atomik library steps", "admin", "test", Date.now()],
    });
    tenantUrl = String((await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id=?", args: [signed.workspace.id] })).rows[0].db_url);
  } finally {
    platform.close();
  }
  const upload = async (name: string, mimeType: string, buffer: Buffer) => {
    const made = await page.request.post("/api/uploads", { headers, multipart: { file: { name, mimeType, buffer } } });
    expect(made.ok(), await made.text()).toBe(true);
    return (await made.json()) as { id: string };
  };
  /* The 10 s landscape fixture (640 × 360) and a square still. */
  const clip = await upload("Dance.mp4", "video/mp4", await readFile("public/fixtures/clip.mp4"));
  const still = await upload("Wardrobe.png", "image/png", await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#3a5a7a" } }).png().toBuffer());
  const project = newProject("Library steps film");
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const production = String((await saved.json()).productionProjectId);
  for (const uploadId of [clip.id, still.id]) {
    const filed = await page.request.post("/api/workbench/library", { headers, data: { projectId: project.id, uploadId } });
    expect(filed.ok(), await filed.text()).toBe(true);
  }
  /* This tab's production, and the rail open and expanded, as a returning person left them. */
  await page.addInitScript(([id, key]) => {
    localStorage.setItem("aw_project", id);
    localStorage.setItem(key, JSON.stringify({ state: "expanded", last: "expanded" }));
  }, [production, `particl:atomik:${me.email}`]);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { workspaceId: String(signed.workspace.id), tenantUrl, headers, draft: project.id, production, clip: clip.id, still: still.id, errors };
}

/** What the workspace made, and what its meter charged, read straight from the local databases. */
async function books(tenantUrl: string, workspaceId: string) {
  const tenant = createClient({ url: tenantUrl, timeout: 10_000 });
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    const jobs = (await tenant.execute("SELECT id, model, project_id, status FROM generations ORDER BY created_at")).rows.map((r) => ({ id: String(r.id), model: String(r.model), project: String(r.project_id), status: String(r.status) }));
    const charges = (await platform.execute({ sql: "SELECT id, kind, billed_credits FROM meter_events WHERE workspace_id=? ORDER BY created_at", args: [workspaceId] }))
      .rows.map((r) => ({ id: String(r.id), kind: String(r.kind), credits: r.billed_credits == null ? null : Number(r.billed_credits) }));
    return { jobs, charges };
  } finally {
    tenant.close();
    platform.close();
  }
}

const phone = (page: Page) => page.viewportSize()!.width < 760;
const surfaceOf = (page: Page) => (phone(page) ? page.getByRole("dialog", { name: "Atomik" }) : page.getByRole("complementary", { name: "Atomik" }));
const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const creditsIn = (text: string | null) => Number(/(\d[\d,]*) cr/.exec(text ?? "")?.[1].replace(/,/g, "") ?? NaN);

/** Ask Atomik in the open rail (or sheet): wait for the planning estimate for this production, then send at it. */
async function ask(page: Page, surface: Locator, brief: string, production: string) {
  const field = surface.getByRole("textbox", { name: "Ask Atomik" });
  /* The chat is filed under the production on screen: its estimate is asked for with it before Send. */
  const quoted = page.waitForResponse((r) => {
    const request = r.request();
    if (request.method() !== "POST" || new URL(r.url()).pathname !== "/api/atomik") return false;
    const body = request.postDataJSON() as { quoteOnly?: boolean; projectId?: string; text?: string } | null;
    return body?.quoteOnly === true && body.projectId === production && body.text === brief;
  }, { timeout: 60_000 });
  await field.fill(brief);
  expect((await quoted).status()).toBe(200);
  const send = surface.getByRole("button", { name: /^Send · \d+ cr estimated/ });
  await expect(send).toBeEnabled({ timeout: 60_000 });
  const turn = page.waitForResponse((r) => r.request().method() === "POST" && /\/api\/atomik\/ach_[^/]+$/.test(new URL(r.url()).pathname) && r.request().postDataJSON()?.quoteOnly !== true, { timeout: 120_000 });
  await send.click();
  const answered = await turn;
  expect(answered.status(), await answered.text()).toBe(200);
}

/** Where the checkpoint's Continue is: the rail's footer on a desktop, the checkpoint card on a phone. */
const checkpointOf = (page: Page) => (phone(page) ? page.getByRole("group", { name: "Checkpoint", exact: true }) : surfaceOf(page));

/** The plan's rows, listed on screen. A checkpoint arriving folds a phone's sheet to compact: it is opened again, as a person would. */
async function planRows(page: Page, surface: Locator) {
  if (phone(page)) {
    await expect(checkpointOf(page).getByRole("button", { name: /^Continue/ })).toBeVisible({ timeout: 60_000 });
    const expand = surface.getByRole("button", { name: /^Expand/ });
    if (await expand.isVisible()) await expand.click();
  }
  return page.locator("[data-library-step]").filter({ visible: true });
}

test("ask Atomik for a transform and a campaign still: both are proposed from the library at a price, and the approved transform lands", async ({ page }) => {
  test.setTimeout(300_000);
  const f = await seeded(page);
  await page.goto(await legacyShell(page, `/atomik?project=${encodeURIComponent(f.draft)}&page=generate`));
  const surface = surfaceOf(page);
  await expect(surface).toBeVisible({ timeout: 60_000 });
  await ask(page, surface, "Motion transfer the dance clip onto the wardrobe still, and a marketing campaign still of the product.", f.production);

  /* The plan: a Motion Transfer and a Marketing Studio still, each with a price and never "priced at checkpoint". */
  const rows = await planRows(page, surface);
  await expect(rows).toHaveCount(2, { timeout: 60_000 });
  const transform = rows.filter({ hasText: "Motion Transfer" });
  const still = rows.filter({ hasText: "Marketing Studio Image" });
  await expect(transform).toHaveAttribute("data-library-step", "transform");
  await expect(still).toHaveAttribute("data-library-step", "marketing");
  await expect(transform).toContainText(/\d+ cr/);
  /* Until its own checkpoint quote, the still reads as the estimate it is. */
  await expect(still).toContainText(/about \d+ cr/);
  await expect(page.getByText("priced at checkpoint", { exact: true }).filter({ visible: true })).toHaveCount(0);
  /* A price is never clipped: it keeps its own column whatever the title does. */
  for (const row of await rows.all())
    expect(await row.evaluate((el) => { const price = el.lastElementChild as HTMLElement; return price.scrollWidth - price.clientWidth; })).toBeLessThanOrEqual(1);
  expect(await noSideways(page)).toBeLessThanOrEqual(1);

  /* The checkpoint is the transform: priced by the route that will run it, and it says what it works from. */
  const card = checkpointOf(page);
  await expect(card.getByText(/Works on Dance\.mp4 and 1 still from the library\./).first()).toBeVisible();
  const cont = card.getByRole("button", { name: /^Continue/ }).first();
  await expect(cont).toContainText(/\d+ cr/, { timeout: 60_000 });
  await expect(cont).toBeEnabled();
  const price = creditsIn(await cont.textContent());
  expect(price).toBeGreaterThan(0);
  if (phone(page)) {
    /* A library step's engine goes with its inputs: there is nothing to change it to (the expanded desktop rail offers no switch at all). */
    await expect(card.getByRole("button", { name: "Change engine", exact: true })).toBeDisabled();
    expect(await smallTargets(page, '[role="group"][aria-label="Checkpoint"]')).toEqual([]);
  }
  /* Nothing has run: the planning turn is the only charge so far. */
  let ledger = await books(f.tenantUrl, f.workspaceId);
  expect(ledger.jobs).toEqual([]);
  expect(ledger.charges.length).toBeGreaterThan(0);
  expect(ledger.charges.filter((c) => c.kind !== "text")).toEqual([]);

  /* Continue: the transform goes to /api/generate as quoted, under the step's own key, filed in the Studio project. */
  const render = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/generate", { timeout: 60_000 });
  await cont.click();
  const sent = await render;
  const job = await sent.json();
  expect(sent.status(), JSON.stringify(job)).toBe(202);
  expect(sent.request().headers()["idempotency-key"]).toMatch(/^atomik-step:astp_/);
  expect(sent.request().postDataJSON()).toMatchObject({
    model: MOTION, task: "genjutsu", projectId: f.production, workbenchProjectId: f.draft, sourceUploadId: f.clip,
    references: [{ uploadId: f.still, role: "reference_image" }], maxCredits: price, quoteFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), refine: false,
  });

  /* The take lands in the project's library, charged what Continue showed. */
  await expect.poll(async () => (await page.request.get(`/api/jobs/${job.id}`, { headers: f.headers }).then((r) => r.json())).generation?.status, { timeout: 120_000, intervals: [1_000] }).toBe("succeeded");
  const library = await page.request.get(`/api/workbench/library?projectId=${encodeURIComponent(f.draft)}&source=generations`, { headers: f.headers }).then((r) => r.json());
  expect((library.generations as { id: string; model: string }[]).find((g) => g.id === job.id)).toMatchObject({ model: MOTION });
  await expect.poll(async () => (await books(f.tenantUrl, f.workspaceId)).charges.find((c) => c.id === job.id)?.credits ?? null, { timeout: 60_000 }).toBe(price);
  ledger = await books(f.tenantUrl, f.workspaceId);
  expect(ledger.jobs).toEqual([{ id: job.id, model: MOTION, project: f.production, status: "succeeded" }]);

  /* The plan moves on: the campaign still is the checkpoint now, at its own live price; nothing ran on its own. */
  const next = checkpointOf(page).getByRole("button", { name: /^Continue/ }).first();
  await expect(next).toContainText(/\d+ cr/, { timeout: 60_000 });
  await expect(next).toBeEnabled();
  await expect(checkpointOf(page).getByText(/Uses 1 still from the library\./).first()).toBeVisible();
  expect((await books(f.tenantUrl, f.workspaceId)).jobs).toHaveLength(1);
  expect(await noSideways(page)).toBeLessThanOrEqual(1);
  expect(f.errors).toEqual([]);
});

test("a library step nothing can price is not proposed: the reply says why, and nothing is offered or charged", async ({ page }) => {
  test.setTimeout(240_000);
  const f = await seeded(page);
  await page.goto(await legacyShell(page, `/atomik?project=${encodeURIComponent(f.draft)}&page=generate`));
  const surface = surfaceOf(page);
  await expect(surface).toBeVisible({ timeout: 60_000 });
  /* The fixture clip is 640 × 360: too small a frame for Object Swap, which admission measures before any estimate. */
  await ask(page, surface, "Object swap the bottle in the dance clip for the product in the wardrobe still.", f.production);
  const reply = surface.getByText(/Not proposed:/).first();
  await expect(reply).toBeVisible({ timeout: 60_000 });
  await expect(reply).toContainText("Mocked swap — no price: Object Swap needs a source video of at least 409,600 pixels per frame");
  await expect(page.locator("[data-library-step]").filter({ visible: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Continue/ }).filter({ visible: true })).toHaveCount(0);
  const ledger = await books(f.tenantUrl, f.workspaceId);
  expect(ledger.jobs).toEqual([]);
  expect(ledger.charges.filter((c) => c.kind !== "text")).toEqual([]);
  expect(await noSideways(page)).toBeLessThanOrEqual(1);
  expect(f.errors).toEqual([]);
});
