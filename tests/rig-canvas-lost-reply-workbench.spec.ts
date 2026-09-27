import { test, expect, type Locator, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";

/**
 * The rate-table Rig (/rig/canvas) sent paid takes with no Idempotency-Key from
 * two places: a node's Run (the desktop inspector, the phone's pinned button)
 * and the phone board's Apply vN. A lost reply followed by a second press was a
 * second paid job. Each take now goes under a stored key, and the next press
 * asks the server what became of it first (POST /api/generate/check): landed,
 * it is followed and nothing is sent again.
 *
 * Real local routes against an ENGINE_MOCK server: the network is intercepted
 * only to lose a reply, and (for Apply) to serve the element and shot fixtures
 * the slot sheet reads. Jobs and charges are the server's own. Nothing is billed
 * for real.
 */

const ENGINE = "dreamina-seedance-2-0-260128";
const PHONES = ["workbench-360x640", "workbench-390x844"];
type Sent = { path: string; key: string | undefined; scope: string | undefined; body: Record<string, unknown> };

async function account(page: Page) {
  const signed = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  let tenantUrl: string;
  try {
    await platform.execute({
      sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
      args: [randomUUID(), signed.workspace.id, 2000, "Local mock Rig canvas fixture", "admin", "test", Date.now()],
    });
    tenantUrl = String((await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id=?", args: [signed.workspace.id] })).rows[0].db_url);
  } finally {
    platform.close();
  }
  const made = await page.request.post("/api/projects", { data: { name: `Lost reply canvas ${randomUUID().slice(0, 6)}` } });
  expect(made.ok(), await made.text()).toBe(true);
  const projectId = (await made.json()).id as string;
  const shot = await page.request.post("/api/shots", { data: { projectId, code: "SH01", title: "Wide", kind: "shot", description: "Iver crosses the ice" } });
  expect(shot.ok(), await shot.text()).toBe(true);
  const shotJson = await shot.json();
  const sent: Sent[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== "POST" || !/^\/api\/generate(\/check)?$/.test(path)) return;
    const headers = request.headers();
    sent.push({ path, key: headers["idempotency-key"], scope: headers["x-workbench-scope"], body: request.postDataJSON() });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { workspaceId: signed.workspace.id, scope: `particl-active-${me.workspace.id}-${me.id}`, tenantUrl, projectId, shotId: (shotJson.id ?? shotJson.shot?.id) as string, sent, errors };
}

/** Every job this project has on the server, and every charge the workspace has on the meter. */
async function ledger(tenantUrl: string, workspaceId: string, projectId: string) {
  const tenant = createClient({ url: tenantUrl, timeout: 10_000 });
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    const jobs = (await tenant.execute({ sql: "SELECT id,shot_id,status FROM generations WHERE project_id=? ORDER BY created_at", args: [projectId] })).rows.map((r) => String(r.id));
    const charges = (await platform.execute({ sql: "SELECT billed_credits FROM meter_events WHERE workspace_id=? ORDER BY created_at", args: [workspaceId] })).rows.map((r) => Number(r.billed_credits));
    return { jobs, charges };
  } finally {
    tenant.close();
    platform.close();
  }
}

/** The ledger once `jobs` jobs exist and each is on the meter: admission writes a job's row, then reserves its charge. */
async function settledLedger(tenantUrl: string, workspaceId: string, projectId: string, jobs: number) {
  await expect.poll(async () => {
    const books = await ledger(tenantUrl, workspaceId, projectId);
    return [books.jobs.length, books.charges.length];
  }, { timeout: 60_000 }).toEqual([jobs, jobs]);
  return ledger(tenantUrl, workspaceId, projectId);
}

/** The next paid POST reaches the server and makes its job; only its reply is lost. */
async function loseNextReply(page: Page) {
  const landed: string[] = [];
  let armed = true;
  await page.route("**/api/generate", async (route) => {
    if (!armed || route.request().method() !== "POST") return route.fallback();
    armed = false;
    landed.push(String((await (await route.fetch()).json()).id ?? ""));
    return route.abort("connectionreset");
  });
  return () => landed[0] ?? "";
}

const creditsOn = async (button: Locator) => Number(/(\d[\d,]*) cr/.exec((await button.textContent()) ?? "")?.[1]?.replace(/,/g, "") ?? NaN);

test("a canvas node whose run reply was lost is followed by the next Run, never run twice", async ({ page }, info) => {
  test.setTimeout(240_000);
  const phone = PHONES.includes(info.project.name);
  const f = await account(page);
  const made = await page.request.post("/api/rig/boards", { data: { projectId: f.projectId, name: "Lost reply board" } });
  expect(made.ok(), await made.text()).toBe(true);
  const board = (await made.json()).board as { id: string };
  const node = { id: "n_video", kind: "video", label: "Kite", x: 160, y: 140, ref: { engine: ENGINE }, ports: [], inputs: [], output: null,
    settings: { prompt: "A red kite over the salt flats at noon", resolution: "720p", seconds: 5 }, state: "idle", credits: 0, staleSince: null };
  expect((await page.request.put(`/api/rig/boards/${board.id}`, { data: { nodes: [node], wires: [] } })).ok()).toBe(true);
  await page.goto(`/rig/canvas/${board.id}`);

  /* The phone's pinned Run, or the desktop inspector's once the node is selected. */
  let run: Locator;
  if (phone) run = page.locator("[data-render]");
  else {
    await page.getByRole("article", { name: "Video Kite" }).click({ timeout: 60_000 });
    run = page.getByRole("button", { name: /^Run node/ });
  }
  /* (The desktop button keeps its busy label in the DOM, hidden, and says busy with aria-busy.) */
  await expect(run).toContainText(/\d+ cr/, { timeout: 60_000 });
  await expect(run).toBeEnabled();
  const price = await creditsOn(run);

  const landedId = await loseNextReply(page);
  await run.click();
  await expect.poll(() => f.sent.filter((s) => s.path === "/api/generate").length, { timeout: 60_000 }).toBe(1);
  await expect(run).toBeEnabled({ timeout: 30_000 });
  await expect(run).not.toHaveAttribute("aria-busy", "true");
  if (phone) await expect(run).not.toContainText("Running");
  expect(landedId()).toBeTruthy();

  /* The second press: what left the browser, and what the server made and billed. */
  const mark = f.sent.length;
  await run.click();
  await expect(run).toContainText("Run node again", { timeout: 120_000 });
  const books = await settledLedger(f.tenantUrl, f.workspaceId, f.projectId, 1);
  expect({ sent: f.sent.slice(mark).map((s) => s.path), made: books.jobs.length, billed: books.charges })
    .toEqual({ sent: ["/api/generate/check"], made: 1, billed: [price] });
  expect(books.jobs).toEqual([landedId()]);
  /* The lost take went under its own key, in this workspace, at the price on the button. */
  const first = f.sent[mark - 1];
  expect(first).toMatchObject({ path: "/api/generate", scope: f.scope, body: { maxCredits: price } });
  expect(f.sent[mark].body.key).toBe(first.key);
  expect(f.errors).toEqual([]);
});

test("the phone board's Apply follows a take whose reply was lost, and never sends it twice", async ({ page }, info) => {
  test.skip(!PHONES.includes(info.project.name), "the phone board is the Rig below 768");
  test.setTimeout(240_000);
  const f = await account(page);
  const at = Date.now();
  const version = (id: string, i: number) => ({ id, attributeId: "att_face", elementId: "el_iver", label: `v${i}`, uploadId: null, genId: null, identityId: null, status: "ready", createdAt: at + i });
  const element = { id: "el_iver", projectId: f.projectId, castId: null, kind: "character", name: "Iver", description: "", locked: false, lockedBy: null, lockedAt: null, fromShotId: null, fromGenId: null, createdAt: at,
    attributes: [{ id: "att_face", elementId: "el_iver", kind: "face", label: "Face", currentId: "ver_1", locked: false, position: 0, versions: [version("ver_1", 1), version("ver_2", 2)] }] };
  const node = (id: string, kind: string, label: string, extra: Record<string, unknown> = {}) => ({ id, kind, label, x: 0, y: 0, ref: null, ports: [], inputs: [], output: null, settings: {}, state: "idle", credits: 0, staleSince: null, ...extra });
  const made = await page.request.post("/api/rig/boards", { data: { projectId: f.projectId, name: "Apply board" } });
  const board = (await made.json()).board as { id: string };
  expect((await page.request.put(`/api/rig/boards/${board.id}`, { data: {
    nodes: [
      node("n_asset", "asset", "@Iver", { ref: { elementId: "el_iver" }, ports: [{ id: "face", label: "FACE", attributeId: "att_face", versionId: "ver_1", version: "v1" }] }),
      node("n_shot", "shot", "SH01", { ref: { shotId: f.shotId }, inputs: [{ id: "cast", label: "CAST" }], settings: { title: "Wide" } }),
      node("n_video", "video", "Seedance", { ref: { engine: ENGINE }, settings: { resolution: "1080p", seconds: 5 } }),
    ],
    wires: [{ id: "w1", from: { nodeId: "n_asset", portId: "face" }, to: { nodeId: "n_shot", slotId: "cast" }, kind: "inherited" }],
  } })).ok()).toBe(true);
  /* The slot sheet's reads: the element's versions, and the shot citing it (the shot itself is the server's). */
  await page.route((url) => url.pathname === "/api/rig/elements", (route) => route.fulfill({ json: { elements: [element] } }));
  await page.route((url) => url.pathname === "/api/shots" && url.searchParams.get("projectId") === f.projectId, (route) => route.fulfill({ json: { shots: [
    { id: f.shotId, projectId: f.projectId, code: "SH01", title: "Wide", description: "Iver crosses the ice", cast: ["@Iver"], planned: 5, setup: {}, state: "draft", takes: 0, spend: 0 },
  ] } }));

  await page.goto(`/rig/canvas/${board.id}`);
  await page.getByRole("button", { name: "CAST slot" }).click({ timeout: 60_000 });
  const sheet = page.getByRole("dialog", { name: "CAST · SH01" });
  await sheet.getByRole("option").nth(1).click();
  await sheet.getByRole("radio", { name: /^Apply to draft · 1/ }).click();
  const apply = page.locator("[data-apply]");
  await expect(apply).toContainText(/Apply v2 to draft\s*\d+ cr/);
  const price = await creditsOn(apply);

  const landedId = await loseNextReply(page);
  await apply.click();
  await expect(page.getByRole("status").filter({ hasText: "Nothing started" })).toContainText("SH01 may not have started: the connection dropped", { timeout: 60_000 });
  expect(landedId()).toBeTruthy();

  /* The same Apply again: what left the browser, and what the server made and billed. */
  const mark = f.sent.length;
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(page.getByRole("status").filter({ hasText: "rendering" })).toContainText(`Iver → v2 · 1 take rendering · ${price} cr`, { timeout: 60_000 });
  const books = await settledLedger(f.tenantUrl, f.workspaceId, f.projectId, 1);
  expect({ sent: f.sent.slice(mark).map((s) => s.path), made: books.jobs.length, billed: books.charges })
    .toEqual({ sent: ["/api/generate/check"], made: 1, billed: [price] });
  expect(books.jobs).toEqual([landedId()]);
  const first = f.sent[mark - 1];
  expect(first).toMatchObject({ path: "/api/generate", scope: f.scope, body: { shotId: f.shotId, maxCredits: price } });
  expect(f.sent[mark].body.key).toBe(first.key);
  expect(f.errors).toEqual([]);
});
