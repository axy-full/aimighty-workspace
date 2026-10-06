import { test, expect, type Locator, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { password, signupInvite } from "./helpers/identityAdmin";

/**
 * The paid sends that still went with no Idempotency-Key and no ceiling, after
 * #401: the Shots grid's Render, the platform desk's preview renders, and the
 * MCP render_shot tool. Each now carries the price it showed (or, for MCP, the
 * price it was just quoted) as maxCredits, under a key claimed before it is
 * sent; a second press after a lost reply asks the server what became of the
 * first (POST /api/generate/check) and follows it, never sending it twice.
 *
 * And the one route that was only suspected: PATCH /api/atomik/steps/:id
 * records a step's state; it cannot start, approve or bill anything.
 *
 * Real local routes against an ENGINE_MOCK server: the network is intercepted
 * only to lose a reply, and to narrow the preview plan the desk asks for to one
 * clip. Jobs and charges are the server's own. Nothing is billed for real.
 */

const DESKS = ["workbench-1440x900", "workbench-1920x1080"];
type Sent = { path: string; key: string | undefined; body: Record<string, unknown> };

function watch(page: Page) {
  const sent: Sent[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && /^\/api\/generate(\/check)?$/.test(path))
      sent.push({ path, key: request.headers()["idempotency-key"], body: request.postDataJSON() });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { sent, errors };
}

async function grant(workspaceId: string, credits = 2000) {
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    await platform.execute({
      sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
      args: [randomUUID(), workspaceId, credits, "Local mock lost-reply fixture", "admin", "test", Date.now()],
    });
    return String((await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id=?", args: [workspaceId] })).rows[0].db_url);
  } finally {
    platform.close();
  }
}

/** Jobs matching `where` in the tenant, and the workspace's charges on the meter, since `since`. */
async function ledger(tenantUrl: string, workspaceId: string, where: { sql: string; args: (string | number)[] }, since = 0) {
  const tenant = createClient({ url: tenantUrl, timeout: 10_000 });
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    const jobs = (await tenant.execute({ sql: `SELECT id FROM generations WHERE ${where.sql} AND created_at >= ? ORDER BY created_at`, args: [...where.args, since] })).rows.map((r) => String(r.id));
    const charges = (await platform.execute({ sql: "SELECT billed_credits FROM meter_events WHERE workspace_id=? AND created_at >= ? ORDER BY created_at", args: [workspaceId, since] })).rows.map((r) => Number(r.billed_credits));
    return { jobs, charges };
  } finally {
    tenant.close();
    platform.close();
  }
}

/** The next paid POST /api/generate reaches the server and makes its job; only its reply is lost. */
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

/** The figure in a button's own cost slot (its mono price), in credits. */
const creditsOn = async (button: Locator) => Number(/(\d[\d,]*) cr/.exec((await button.locator(".ui-mono-cost").first().textContent()) ?? "")?.[1]?.replace(/,/g, "") ?? NaN);

test("the Shots grid's Render sends the price on its button as the ceiling, and a second press after a lost reply follows the take instead of rendering it twice", async ({ page }) => {
  test.setTimeout(240_000);
  const signed = await signInLocally(page.request);
  const tenantUrl = await grant(signed.workspace.id);
  const { sent, errors } = watch(page);
  const made = await page.request.post("/api/projects", { data: { name: `Lost reply shots ${randomUUID().slice(0, 6)}` } });
  expect(made.ok(), await made.text()).toBe(true);
  const projectId = (await made.json()).id as string;
  const shot = await page.request.post("/api/shots", { data: { projectId, code: "SH01", title: "Wide", kind: "shot", description: "Iver crosses the ice at dawn" } });
  expect(shot.ok(), await shot.text()).toBe(true);
  const shotId = String((await shot.json()).id ?? (await shot.json()).shot?.id);
  const list = await page.request.get("/api/productions").then((r) => r.json()) as { productions: { id: string; projects: { id: string }[] }[] };
  const prod = list.productions.find((p) => p.projects.some((j) => j.id === projectId))!;
  await page.goto(`/productions/${prod.id}/${projectId}/shots`);

  /* The one primary: the header button on a desktop, the pinned one on a phone. */
  const render = page.getByRole("button", { name: /^Render/ }).filter({ visible: true }).first();
  await expect(render).toContainText(/Render SH01[\s\S]*\d+ cr/, { timeout: 60_000 });
  await expect(render).toBeEnabled();
  const price = await creditsOn(render);
  const landedId = await loseNextReply(page);
  await render.click();
  await expect.poll(() => sent.filter((s) => s.path === "/api/generate").length, { timeout: 60_000 }).toBe(1);
  await expect.poll(landedId, { timeout: 60_000 }).toBeTruthy();
  const first = sent.find((s) => s.path === "/api/generate")!;

  /* The shot, chosen again, and Render pressed again: what left the browser, and what the server made and billed. */
  /* (The header button keeps its busy label in the DOM, hidden, and says busy with aria-busy; the pinned one swaps its label.) */
  await expect(render).not.toHaveAttribute("aria-busy", "true", { timeout: 30_000 });
  if (page.viewportSize()!.width < 768) await expect(render).not.toContainText("Rendering", { timeout: 30_000 });
  await page.locator(`[data-shot="${shotId}"]`).click();
  await expect(render).toContainText(/Render SH01[\s\S]*\d+ cr/, { timeout: 30_000 });
  await expect(render).toBeEnabled();
  const mark = sent.length;
  await render.click();
  await expect.poll(() => sent.length - mark, { timeout: 60_000 }).toBeGreaterThan(0);
  await expect(page.getByText(/1 take rendering/).first()).toBeVisible({ timeout: 60_000 });
  const books = await ledger(tenantUrl, signed.workspace.id, { sql: "shot_id=?", args: [shotId] });
  expect({ ceiling: first.body.maxCredits ?? null, sent: sent.slice(mark).map((s) => s.path), made: books.jobs.length, billed: books.charges })
    .toEqual({ ceiling: price, sent: ["/api/generate/check"], made: 1, billed: [price] });
  expect(books.jobs).toEqual([landedId()]);
  expect(first.key).toBeTruthy();
  expect(sent[mark].body.key).toBe(first.key);
  expect(errors).toEqual([]);
});

test("the platform desk's preview renders carry the per-clip price as their ceiling, and a second press after a lost reply follows the clip instead of rendering it twice", async ({ page }, info) => {
  test.skip(!DESKS.includes(info.project.name), "the platform desk is a desktop console");
  test.setTimeout(240_000);
  const ownerEmail = "platform-owner@example.test";
  const login = await page.request.post("/api/auth/login", { data: { email: ownerEmail, password } });
  if (!login.ok()) {
    const code = await signupInvite(ownerEmail);
    const signup = await page.request.post("/api/auth/signup", { data: { code, name: "Platform owner", email: ownerEmail, workspace: "Platform desk", password, accept: true } });
    expect(signup.ok(), await signup.text()).toBe(true);
  }
  const me = await page.request.get("/api/me").then((r) => r.json());
  expect(me.superAdmin, "start the server with SUPER_ADMIN_EMAIL=platform-owner@example.test").toBe(true);
  /* A test workspace of its own, so one run's renders never hold the next run's at the concurrency cap; hidden again after. */
  const name = `Preview lost reply ${randomUUID().slice(0, 6)}`;
  const created = await page.request.post("/api/workspaces", { headers: { "X-Workbench-Scope": `particl-active-${me.workspace.id}-${me.id}` }, data: { name } });
  expect(created.ok(), await created.text()).toBe(true);
  const ws = (await created.json()).workspace as { id: string };
  try {
    const tenantUrl = await grant(ws.id);
    const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
    try {
      await platform.execute({ sql: "UPDATE workspaces SET internal_test=1 WHERE id=?", args: [ws.id] });
    } finally {
      platform.close();
    }
    /* The plan, read first (it also has the route compiled before the page asks for it). */
    const plan = await page.request.get("/api/admin/previews", { timeout: 60_000 }).then((r) => r.json()) as { plan: { perClipCredits: number; items: { key: string }[] } };
    const clip = plan.plan.items[0].key;
    const since = Date.now();
    const { sent, errors } = watch(page);
    /* One clip, not the bank's whole batch: the plan the desk is handed is narrowed; what it renders is real. */
    await page.route(/\/api\/admin\/previews\?/, async (route) => {
      const real = await (await route.fetch()).json();
      const items = real.plan.items.slice(0, 1);
      return route.fulfill({ json: { ...real, plan: { ...real.plan, items, count: 1, totalUsd: real.plan.perClipUsd, totalCredits: real.plan.perClipCredits } } });
    });
    await page.goto("/admin");
    const press = async () => {
      const render = page.getByRole("button", { name: /^Render 1 previews · [\d,]+ cr$/ });
      await expect(render).toBeEnabled({ timeout: 60_000 });
      await render.click();
      await page.getByRole("dialog").getByRole("button", { name: /^Spend \$/ }).click();
      await expect(page.getByRole("button", { name: /^Render 1 previews · [\d,]+ cr$/ })).toBeEnabled({ timeout: 60_000 });
    };

    const landedId = await loseNextReply(page);
    await press();
    await expect.poll(landedId, { timeout: 60_000 }).toBeTruthy();
    const first = sent.find((s) => s.path === "/api/generate")!;
    const mark = sent.length;
    await press();
    const books = await ledger(tenantUrl, ws.id, { sql: "json_extract(params,'$.previewFor')=?", args: [clip] }, since);
    expect({ ceiling: first.body.maxCredits ?? null, sent: sent.slice(mark).map((s) => s.path), made: books.jobs.length, billed: books.charges })
      .toEqual({ ceiling: plan.plan.perClipCredits, sent: ["/api/generate/check"], made: 1, billed: [plan.plan.perClipCredits] });
    expect(books.jobs).toEqual([landedId()]);
    expect(sent[mark].body.key).toBe(first.key);
    expect(errors).toEqual([]);
  } finally {
    await page.request.delete("/api/workspaces", { headers: { "X-Workbench-Scope": `particl-active-${ws.id}-${me.id}` }, data: { name } });
  }
});

test("MCP render_shot called again with the same request_id after its reply was lost returns the render it started, billed once", async ({ page }) => {
  test.setTimeout(120_000);
  const signed = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const tenantUrl = await grant(signed.workspace.id);
  const minted = await page.request.post("/api/tokens", {
    headers: { "X-Workbench-Scope": `particl-active-${signed.workspace.id}-${me.id}` },
    data: { name: "Lost reply MCP fixture", scope: "render" },
  });
  expect(minted.ok(), await minted.text()).toBe(true);
  const token = (await minted.json()).token as string;
  const since = Date.now();
  const requestId = `lost-reply-${randomUUID()}`;
  const render = async (id: number) => {
    const reply = await page.request.post("/api/mcp", {
      headers: { Authorization: `Bearer ${token}` },
      data: { jsonrpc: "2.0", id, method: "tools/call", params: { name: "render_shot", arguments: { prompt: "A slow dolly through monsoon rain.", duration: 5, resolution: "720p", request_id: requestId } } },
    });
    expect(reply.ok(), await reply.text()).toBe(true);
    const text = String((await reply.json()).result?.content?.[0]?.text ?? "");
    return /id: (\S+)/.exec(text)?.[1] ?? text;
  };
  /* The client never saw the first reply, so it calls again with the same request_id. */
  const firstId = await render(1);
  const againId = await render(2);
  const books = await ledger(tenantUrl, signed.workspace.id, { sql: "1=1", args: [] }, since);
  expect({ same: againId === firstId, made: books.jobs.length, billed: books.charges.length }).toEqual({ same: true, made: 1, billed: 1 });
  expect(books.jobs).toEqual([firstId]);
});

test("PATCH /api/atomik/steps/:id records a step's state and nothing else: it cannot start, approve or bill a render", async ({ page }) => {
  test.setTimeout(120_000);
  const signed = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const tenantUrl = await grant(signed.workspace.id);
  expect((await page.request.get("/api/atomik")).ok()).toBe(true);
  const chatId = `ach_patch_${randomUUID().slice(0, 8)}`, stepId = `astp_patch_${randomUUID().slice(0, 8)}`;
  const tenant = createClient({ url: tenantUrl, timeout: 10_000 });
  try {
    const at = Date.now();
    await tenant.execute({ sql: "INSERT INTO atomik_chats (id,project_id,title,model,agent_mode,status,text_cost_usd,created_by,created_at,updated_at,deleted) VALUES (?,NULL,'Patch check','auto','ask','waiting',0,?,?,?,0)", args: [chatId, me.id, at, at] });
    await tenant.execute({
      sql: `INSERT INTO atomik_steps (id,chat_id,message_id,position,kind,title,prompt,model,params,refs,status,est_cost_usd,created_at,updated_at)
            VALUES (?,?,'m',0,'video','Push in','A slow push in on a bottle.','dreamina-seedance-2-0-260128',?,'[]','proposed',NULL,?,?)`,
      args: [stepId, chatId, JSON.stringify({ ratio: "16:9", resolution: "720p", seconds: 5 }), at, at],
    });
  } finally {
    tenant.close();
  }
  const since = Date.now();
  /* Every state a client can write, in every order a client could try; then the plan is read (which settles steps). */
  for (const status of ["running", "done", "proposed", "running", "failed", "proposed", "rejected", "running"]) {
    const patched = await page.request.patch(`/api/atomik/steps/${stepId}`, { data: { status } });
    expect(patched.ok(), await patched.text()).toBe(true);
    expect((await patched.json()).status).toBe(status);
  }
  expect((await page.request.get(`/api/atomik/${chatId}`)).ok()).toBe(true);
  const books = await ledger(tenantUrl, signed.workspace.id, { sql: "1=1", args: [] }, since);
  expect({ made: books.jobs.length, billed: books.charges.length }).toEqual({ made: 0, billed: 0 });
});
