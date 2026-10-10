import { test, expect, type APIRequestContext } from "@playwright/test";
import { createClient } from "@libsql/client";
import { signInLocally, localPlatformDbUrl } from "./helpers/workbenchLocal";

/**
 * Cancel for a queued Seedance (BytePlus) or Kling and Topaz (fal) take, on the real routes and the real ledger, against the
 * mocked vendors (ENGINE_MOCK=1: lib/mock.ts mockQueueKind; no provider is ever called). The owner's rule: a cancel bills nothing
 * only while the provider still has the job queued, and the hold is released only when the provider confirms.
 * Seeded rows: a take at the provider, and the meter's reservation for it (what admission writes).
 */
const KLING = "fal-ai/kling-video/v3/standard";
const SEEDANCE = "dreamina-seedance-2-5-260628";
const HELD = 7;

type World = { api: APIRequestContext; workspaceId: string; userId: string; headers: Record<string, string> };
async function world(api: APIRequestContext, name: string): Promise<World> {
  const signed = await signInLocally(api, name);
  const me = (await (await api.get("/api/me")).json()) as { id: string };
  return { api, workspaceId: signed.workspace.id, userId: me.id, headers: { "X-Workbench-Scope": `particl-active-${signed.workspace.id}-${me.id}` } };
}
async function tenantDb(workspaceId: string) {
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    const url = String((await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id = ?", args: [workspaceId] })).rows[0].db_url);
    return createClient({ url, timeout: 10_000 });
  } finally { platform.close(); }
}
const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** A video take waiting at its provider (`tag` says how the mocked vendor behaves) with the meter's reservation for it. */
async function seed(w: World, provider: "byteplus" | "fal", tag: "queued" | "running" | "cancelerror") {
  const at = Date.now() - 20_000;
  const id = `gq${unique()}`;
  const handle = `mock_${provider === "fal" ? "fal" : "ark"}_${unique()}-${tag}_${Date.now()}`;
  const model = provider === "fal" ? KLING : SEEDANCE;
  const params = provider === "fal" ? { ratio: "16:9", resolution: "720p", duration: 5, falRequestId: handle, falModel: "fal-ai/kling-video/v3" } : { ratio: "16:9", resolution: "720p", duration: 5 };
  const db = await tenantDb(w.workspaceId);
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    await db.execute({
      sql: `INSERT INTO generations (id,project_id,shot_id,kind,model,prompt,params,status,stored_url,cost_usd,created_by,created_at,updated_at,version,provider,task,review_state,review_by,reviewed_at,deleted,error,ark_task_id)
            VALUES (?,NULL,NULL,'video',?,?,?,'queued',NULL,0,?,?,?,1,?,'generate','',NULL,NULL,0,NULL,?)`,
      args: [id, model, "A boat leaves the quay.", JSON.stringify(params), w.userId, at, at, provider, provider === "byteplus" ? handle : null],
    });
    await platform.execute({
      sql: `INSERT INTO meter_events(id,workspace_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_by,created_at,updated_at) VALUES(?,?,'video',?,?,'running',?,?,1,?,?,?)`,
      args: [id, w.workspaceId, provider === "fal" ? "fal" : "byteplus", model, HELD / 20, HELD, w.userId, at, at],
    });
  } finally { db.close(); platform.close(); }
  return id;
}
async function state(w: World, id: string) {
  const db = await tenantDb(w.workspaceId);
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    const gen = (await db.execute({ sql: "SELECT status FROM generations WHERE id=?", args: [id] })).rows[0];
    const meter = (await platform.execute({ sql: "SELECT status,billed_credits,engine_cost_usd,updated_at FROM meter_events WHERE id=? AND workspace_id=?", args: [id, w.workspaceId] })).rows[0];
    return { row: String(gen?.status), meter: String(meter?.status), credits: Number(meter?.billed_credits), updated: Number(meter?.updated_at) };
  } finally { db.close(); platform.close(); }
}
const cancel = (w: World, id: string) => w.api.post(`/api/generations/${encodeURIComponent(id)}/cancel`, { headers: w.headers });

test.describe("queued cancel", () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== "workbench-1440x900", "an API spec: one size"));

  for (const provider of ["byteplus", "fal"] as const) {
    test(`${provider}: queued at the provider, cancelled by it: nothing billed, the hold released once, a second press changes nothing`, async ({ request }) => {
      const w = await world(request, `Cancel ${provider}`);
      const id = await seed(w, provider, "queued");
      expect(await state(w, id)).toMatchObject({ row: "queued", meter: "running", credits: HELD });
      const first = await cancel(w, id);
      expect(first.status(), await first.text()).toBe(200);
      expect(await first.json()).toEqual({ status: "cancelled" });
      const after = await state(w, id);
      expect(after).toMatchObject({ row: "cancelled", meter: "failed", credits: 0 });
      /* A second press: still cancelled, the ledger untouched (released once). */
      const again = await cancel(w, id);
      expect(again.status()).toBe(200);
      expect(await again.json()).toEqual({ status: "cancelled" });
      expect(await state(w, id)).toEqual(after);
    });

    test(`${provider}: the provider says it is running: refused in its words, billed as today`, async ({ request }) => {
      const w = await world(request, `Running ${provider}`);
      const id = await seed(w, provider, "running");
      const reply = await cancel(w, id);
      expect(reply.status(), await reply.text()).toBe(200);
      expect(await reply.json()).toEqual({ status: "running" });
      expect(await state(w, id)).toMatchObject({ row: "queued", meter: "running", credits: HELD });
    });

    test(`${provider}: the provider errors: refused, the hold is kept`, async ({ request }) => {
      const w = await world(request, `Error ${provider}`);
      const id = await seed(w, provider, "cancelerror");
      const reply = await cancel(w, id);
      expect(reply.status()).toBe(503);
      const body = (await reply.json()) as { error: string };
      expect(body.error).toMatch(/could not be confirmed/i);
      expect(body.error).not.toMatch(/nothing (was )?billed/i);
      expect(await state(w, id)).toMatchObject({ row: "queued", meter: "running", credits: HELD });
    });
  }

  test("another workspace's take is not found, and nothing about it changes", async ({ request, playwright }) => {
    const mine = await world(request, "Cancel owner");
    const id = await seed(mine, "byteplus", "queued");
    const other = await playwright.request.newContext({ baseURL: process.env.PW_BASE_URL });
    try {
      const stranger = await world(other, "Cancel stranger");
      const reply = await cancel(stranger, id);
      expect(reply.status()).toBe(404);
      expect(await state(mine, id)).toMatchObject({ row: "queued", meter: "running", credits: HELD });
    } finally { await other.dispose(); }
  });
});
