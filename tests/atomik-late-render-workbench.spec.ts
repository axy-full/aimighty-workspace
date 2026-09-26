import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { legacyShell } from "./helpers/legacyShell";

/**
 * An Atomik step approved with Continue whose render request is only delayed:
 * it has not reached the server two minutes later, so reading the plan puts the
 * step back to proposed ("nothing was sent"). The render then arrives. Its key
 * was fenced before the step went back, so it is answered and admits nothing:
 * no job, no charge. Approving again renders under a key of its own, once.
 *
 * Real local routes against an ENGINE_MOCK server: the chat and its proposed
 * step are written straight into this login's tenant database, the network is
 * intercepted only to hold the render back, and the step's claim is aged in the
 * database rather than waited out. Nothing is billed for real.
 */

const ENGINE = "dreamina-seedance-2-0-260128";

async function seeded(page: Page) {
  const signed = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  let tenantUrl: string;
  try {
    await platform.execute({
      sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
      args: [randomUUID(), signed.workspace.id, 2000, "Local mock Atomik fixture", "admin", "test", Date.now()],
    });
    tenantUrl = String((await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id=?", args: [signed.workspace.id] })).rows[0].db_url);
  } finally {
    platform.close();
  }
  /* The workspace's tables exist once it has been read. */
  expect((await page.request.get("/api/atomik")).ok()).toBe(true);
  const chatId = `ach_late_${randomUUID().slice(0, 8)}`, stepId = `astp_late_${randomUUID().slice(0, 8)}`;
  const tenant = createClient({ url: tenantUrl, timeout: 10_000 });
  try {
    const at = Date.now();
    await tenant.execute({ sql: "INSERT INTO atomik_chats (id,project_id,title,model,agent_mode,status,text_cost_usd,created_by,created_at,updated_at,deleted) VALUES (?,NULL,'Bottle spot','auto','ask','waiting',0,?,?,?,0)", args: [chatId, me.id, at, at] });
    await tenant.execute({ sql: "INSERT INTO atomik_messages (id,chat_id,role,text,activity,created_at) VALUES (?,?,'user','A bottle spot.','[]',?)", args: [`${chatId}_u`, chatId, at] });
    await tenant.execute({ sql: "INSERT INTO atomik_messages (id,chat_id,role,text,activity,created_at) VALUES (?,?,'assistant','A slow push in.','[]',?)", args: [`${chatId}_a`, chatId, at + 1] });
    await tenant.execute({
      sql: `INSERT INTO atomik_steps (id,chat_id,message_id,position,kind,title,prompt,model,params,refs,status,est_cost_usd,created_at,updated_at)
            VALUES (?,?,?,0,'video','Push in','A slow push in on a bottle on a kitchen table.',?,?,'[]','proposed',NULL,?,?)`,
      args: [stepId, chatId, `${chatId}_a`, ENGINE, JSON.stringify({ ratio: "16:9", resolution: "720p", seconds: 5 }), at, at],
    });
  } finally {
    tenant.close();
  }
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { workspaceId: signed.workspace.id, tenantUrl, chatId, stepId, errors };
}

/** Every job the workspace made, and every charge on its meter. */
async function ledger(tenantUrl: string, workspaceId: string) {
  const tenant = createClient({ url: tenantUrl, timeout: 10_000 });
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    const jobs = (await tenant.execute("SELECT id FROM generations ORDER BY created_at")).rows.map((r) => String(r.id));
    const charges = (await platform.execute({ sql: "SELECT billed_credits FROM meter_events WHERE workspace_id=? ORDER BY created_at", args: [workspaceId] })).rows.map((r) => Number(r.billed_credits));
    return { jobs, charges };
  } finally {
    tenant.close();
    platform.close();
  }
}

const surfaceOf = (page: Page) =>
  page.viewportSize()!.width < 760
    ? page.getByRole("group", { name: "Checkpoint", exact: true })
    : page.getByRole("complementary", { name: "Atomik" }).or(page.getByLabel("Atomik", { exact: true })).filter({ visible: true }).first();

test("a Continue whose render was only delayed: the step goes back to proposed, the late render admits nothing, and approving again renders once under a key of its own", async ({ page }) => {
  test.setTimeout(240_000);
  const f = await seeded(page);
  await page.goto(await legacyShell(page, "/atomik?page=generate"));
  const cont = () => surfaceOf(page).getByRole("button", { name: /^Continue/ }).first();
  await expect(cont()).toContainText(/\d+ cr/, { timeout: 60_000 });
  await expect(cont()).toBeEnabled();
  const price = Number(/(\d[\d,]*) cr/.exec((await cont().textContent()) ?? "")![1].replace(/,/g, ""));

  /* The render leaves the browser and is held back: it has not reached the server. */
  let hold = true;
  let held: { headers: Record<string, string>; body: string } | null = null;
  const renders: { key: string | undefined; body: Record<string, unknown> }[] = [];
  await page.route("**/api/generate", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.fallback();
    renders.push({ key: request.headers()["idempotency-key"], body: request.postDataJSON() });
    if (!hold) return route.fallback();
    hold = false;
    held = { headers: { "Content-Type": "application/json", "Idempotency-Key": request.headers()["idempotency-key"]! }, body: request.postData() ?? "" };
    return route.abort("internetdisconnected");
  });
  await cont().click();
  await expect.poll(() => renders.length, { timeout: 60_000 }).toBe(1);
  expect(renders[0]).toMatchObject({ key: `atomik-step:${f.stepId}`, body: { maxCredits: price } });

  /* Two minutes on (aged in the database), reading the plan gives the step up: it is proposed again. */
  const tenant = createClient({ url: f.tenantUrl, timeout: 10_000 });
  try {
    await expect.poll(async () => String((await tenant.execute({ sql: "SELECT status FROM atomik_steps WHERE id=?", args: [f.stepId] })).rows[0].status)).toBe("running");
    await tenant.execute({ sql: "UPDATE atomik_steps SET updated_at = updated_at - 180000 WHERE id=?", args: [f.stepId] });
  } finally {
    tenant.close();
  }
  await page.reload();
  await expect(cont()).toContainText(/\d+ cr/, { timeout: 60_000 });
  const reread = createClient({ url: f.tenantUrl, timeout: 10_000 });
  try {
    expect((await reread.execute({ sql: "SELECT status,error FROM atomik_steps WHERE id=?", args: [f.stepId] })).rows[0])
      .toMatchObject({ status: "proposed", error: "The approval did not reach the renderer, so nothing was sent. Approve it again." });
  } finally {
    reread.close();
  }

  /* The held render arrives now: what the server makes of it, and what it made and billed. */
  const late = await page.request.post("/api/generate", { headers: held!.headers, data: held!.body });
  let books = await ledger(f.tenantUrl, f.workspaceId);
  expect({ late: late.status(), made: books.jobs.length, billed: books.charges }).toEqual({ late: 409, made: 0, billed: [] });
  expect(await late.json()).toMatchObject({ code: "set_aside" });

  /* Continue again: a key of its own, admitted once, at the price on the button. */
  await expect(cont()).toBeEnabled();
  const again = Number(/(\d[\d,]*) cr/.exec((await cont().textContent()) ?? "")![1].replace(/,/g, ""));
  await cont().click();
  await expect.poll(() => renders.length, { timeout: 60_000 }).toBe(2);
  expect(renders[1]).toMatchObject({ key: `atomik-step:${f.stepId}:2`, body: { maxCredits: again } });
  await expect.poll(async () => (await ledger(f.tenantUrl, f.workspaceId)).jobs.length, { timeout: 60_000 }).toBe(1);
  books = await ledger(f.tenantUrl, f.workspaceId);
  expect(books.charges).toEqual([again]);
  expect(f.errors).toEqual([]);
});
