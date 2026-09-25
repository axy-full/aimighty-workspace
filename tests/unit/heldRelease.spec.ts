import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * Held takes: discarding one is free, a finished take of any engine starts
 * what waited for its slot, and a take that cannot start for a reason of its
 * own does not hold up the takes behind it.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-held-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.CREDIT_USD = "0.10";
process.env.ENGINE_MOCK = "1";

function workspace(name: string, concurrency: number): TenantWorkspace {
  return {
    id: `ws_${name}`, slug: name, name, legacy: false,
    dbUrl: `file:${path.join(dir, `${name}.db`)}`, dbToken: null,
    keys: {}, usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null,
    ownerId: "u_test", createdAt: 0, suspendedAt: null, suspendedReason: null,
    flaggedAt: null, flagNote: null, concurrency, rendersPerHour: null,
    storageQuotaBytes: null, deletedAt: null,
  };
}
async function setup(name: string, concurrency = 1, credits = 1000) {
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  const ws = workspace(name, concurrency);
  await platformDb().execute({
    sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,created_at) VALUES(?,?,?,'test',?)",
    args: [`grant_${name}`, ws.id, credits, Date.now()],
  });
  return ws;
}
async function held(id: string, options: { why?: "credits" | "slots"; kind?: "video" | "image"; token?: string; at?: number; estUsd?: number; shot?: string; by?: string } = {}) {
  const { db, ready } = await import("../../lib/db");
  await ready();
  const kind = options.kind ?? "video";
  await db().execute({
    sql: `INSERT INTO generations(id,kind,provider,model,prompt,params,status,created_by,created_at,updated_at,token_id,billed_to,task,shot_id)
          VALUES(?,?,?,?,'test',?,'held',?,?,?,?,?,'generate',?)`,
    args: [id, kind, kind === "video" ? "byteplus" : "google", kind === "video" ? "dreamina-seedance-2-0-260128" : "gemini-3-pro-image",
      JSON.stringify({ ratio: "16:9", resolution: "720p", duration: 5, watermark: false, held: { estUsd: options.estUsd ?? 1, needs: 15, at: 1, why: options.why ?? "slots" } }),
      options.by ?? "u_test", options.at ?? Date.now(), options.at ?? Date.now(), options.token ?? null, kind === "video" ? "byteplus" : "google", options.shot ?? null],
  });
}
async function cappedToken() {
  const { db, ready } = await import("../../lib/db");
  await ready();
  await db().batch([
    "INSERT INTO users(id,email,name,password_hash,created_at) VALUES('u_test','member@example.invalid','Member','x',0)",
    "INSERT INTO api_tokens(id,token_hash,name,user_id,cap_usd,created_at) VALUES('tok_capped','hash','agent','u_test',0.01,0)",
  ], "write");
}
const status = async (id: string) => {
  const { db } = await import("../../lib/db");
  return (await db().execute({ sql: "SELECT status,error,cost_usd FROM generations WHERE id=?", args: [id] })).rows[0];
};
const metered = async (id: string) => {
  const { platformDb } = await import("../../lib/platform");
  return (await platformDb().execute({ sql: "SELECT status,engine_cost_usd,billed_credits FROM meter_events WHERE id=?", args: [id] })).rows[0];
};

test("discarding a held take is free, and a release that raced the discard gives its reservation back", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { discardHeldJob, releaseHeldJobs } = await import("../../lib/held");
  const { db } = await import("../../lib/db");
  await runInTenant(await setup("discard", 4), async () => {
    await held("gen_discard");
    expect(await discardHeldJob("gen_discard")).toBe(true);
    expect(await status("gen_discard")).toMatchObject({ status: "cancelled", cost_usd: 0 });
    expect(await metered("gen_discard")).toBeUndefined();
    // Only a held take can be discarded; it is not a way to cancel paid work.
    expect(await discardHeldJob("gen_discard")).toBe(false);

    await held("gen_race");
    const client = db(), execute = client.execute.bind(client);
    client.execute = (async (...args: Parameters<typeof client.execute>) => {
      const statement = args[0] as unknown as string | { sql: string };
      const sql = typeof statement === "string" ? statement : statement.sql;
      // The person discards it after the release reserved it, before the release flips it.
      if (sql.includes("'$.releasedAt'")) await discardHeldJob("gen_race");
      return execute(...args);
    }) as typeof client.execute;
    try {
      expect((await releaseHeldJobs({ defer: () => { throw new Error("a discarded take must never be sent"); } })).released).toEqual([]);
    } finally {
      client.execute = execute;
    }
    expect(await status("gen_race")).toMatchObject({ status: "cancelled" });
    expect(await metered("gen_race")).toMatchObject({ status: "failed", engine_cost_usd: 0, billed_credits: 0 });
  });
});

test("a finished still starts the take that waited for its slot, and the paid submit is never left floating", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  const { failJob } = await import("../../lib/renderWork");
  const { engineFor } = await import("../../lib/engines");
  const engine = engineFor("byteplus"), original = engine.render;
  let submits = 0;
  engine.render = async () => { submits++; return { handle: { provider: "byteplus", ref: "slot-freed", model: "mock" } }; };
  try {
    await runInTenant(await setup("slot", 1), async () => {
      await ready();
      await db().execute({
        sql: `INSERT INTO generations(id,kind,provider,model,prompt,params,status,created_by,created_at,updated_at,billed_to)
              VALUES('gen_still','image','google','gemini-3-pro-image','test',?,'running','u_test',?,?,'google')`,
        args: [JSON.stringify({ ratio: "16:9", resolution: "1K", paidClaim: 1 }), Date.now(), Date.now()],
      });
      await reserveGenerationSpend({ id: "gen_still", kind: "image", engine: "google", model: "gemini-3-pro-image", status: "running", engineCostUsd: 0.2 });
      await held("gen_waiting", { why: "slots" });
      // The still ends (any engine, any outcome): its settlement frees the one slot.
      await failJob("gen_still", "The engine refused it.", true);
      expect(await status("gen_still")).toMatchObject({ status: "failed" });
      const row = (await db().execute("SELECT status,ark_task_id FROM generations WHERE id='gen_waiting'")).rows[0];
      expect(row).toMatchObject({ status: "running", ark_task_id: "slot-freed" });
      expect(submits).toBe(1);
      expect(await metered("gen_waiting")).toMatchObject({ status: "running", engine_cost_usd: 1 });
    });
  } finally {
    engine.render = original;
  }
});

test("a take its own cap stops is marked with the reason and does not hold up the takes behind it", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { releaseHeldJobs } = await import("../../lib/held");
  await runInTenant(await setup("line", 4), async () => {
    await cappedToken();
    const t = Date.now() - 60_000;
    await held("gen_capped", { why: "credits", token: "tok_capped", at: t });
    await held("gen_behind_slot", { why: "slots", at: t + 1 });
    await held("gen_behind_credits", { why: "credits", at: t + 2 });
    const deferred: string[] = [];
    const out = await releaseHeldJobs({ defer: async () => { deferred.push("submit"); } });
    // The capped take spends nothing, so neither line waits behind it.
    expect(out.released).toEqual(["gen_behind_slot", "gen_behind_credits"]);
    expect(deferred).toHaveLength(2);
    expect(await status("gen_capped")).toMatchObject({ status: "held", error: expect.stringContaining("token's monthly spending ceiling") });
    expect(await status("gen_behind_credits")).toMatchObject({ status: "queued", error: null });
    expect(await metered("gen_capped")).toBeUndefined();
  });
});

test("a top-up releases the credits-held takes behind one its own cap refuses, measured without it", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { releaseHeldJobs } = await import("../../lib/held");
  // 30 credits cover two 15-credit takes, not three: the capped take's share goes to the ones behind it.
  await runInTenant(await setup("topup", 4, 30), async () => {
    await cappedToken();
    const t = Date.now() - 60_000;
    await held("gen_top_capped", { why: "credits", token: "tok_capped", at: t });
    await held("gen_top_b", { why: "credits", at: t + 1 });
    await held("gen_top_c", { why: "credits", at: t + 2 });
    const out = await releaseHeldJobs({ defer: async () => {} });
    expect(out.released).toEqual(["gen_top_b", "gen_top_c"]);
    expect(await status("gen_top_capped")).toMatchObject({ status: "held", error: expect.stringContaining("token's monthly spending ceiling") });
    expect(await metered("gen_top_b")).toMatchObject({ status: "running", billed_credits: 15 });
    expect(await metered("gen_top_c")).toMatchObject({ status: "running", billed_credits: 15 });
  });
});

test("the balance still stops the credits line in order, even for a smaller take behind", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { releaseHeldJobs } = await import("../../lib/held");
  await runInTenant(await setup("order", 4, 20), async () => {
    const t = Date.now() - 60_000;
    // The slot-held take spends 15 of the 20 first; the credits line's first take then does not fit.
    await held("gen_order_slot", { why: "slots", at: t });
    await held("gen_order_first", { why: "credits", at: t + 1 });
    await held("gen_order_small", { why: "credits", at: t + 2, estUsd: 0.1 });
    const out = await releaseHeldJobs({ defer: async () => {} });
    expect(out.released).toEqual(["gen_order_slot"]);
    expect(await status("gen_order_first")).toMatchObject({ status: "held", error: expect.any(String) });
    // The 2-credit take would fit the 5 left, but it does not jump the line.
    expect(await status("gen_order_small")).toMatchObject({ status: "held", error: null });
    expect(await metered("gen_order_small")).toBeUndefined();
  });
});

test("the shot cap follows the take's author, not whoever's request started the line", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { platformDb } = await import("../../lib/platform");
  const { setSetting } = await import("../../lib/settings");
  const { releaseHeldJobs } = await import("../../lib/held");
  const ws = await setup("shotcap", 4);
  await platformDb().batch([
    { sql: "INSERT INTO memberships(workspace_id,account_id,role,disabled,created_at) VALUES(?,'u_lead','admin',0,0)", args: [ws.id] },
    { sql: "INSERT INTO memberships(workspace_id,account_id,role,disabled,created_at) VALUES(?,'u_crew','member',0,0)", args: [ws.id] },
  ], "write");
  const person = (id: string, role: "admin" | "member") =>
    ({ id, email: `${id}@example.invalid`, name: id, role, owner: false, disabled: false, lastSeen: null, createdAt: 0 });
  await runInTenant(ws, async () => {
    await setSetting("approvalRule", "cap", "u_lead");
    await setSetting("shotCapCredits", "10", "u_lead");
    const t = Date.now() - 60_000;
    await held("gen_crew_take", { why: "slots", shot: "shot_a", by: "u_crew", at: t });
    await held("gen_lead_take", { why: "slots", shot: "shot_b", by: "u_lead", at: t + 1 });
  });
  // A member's poll settles something: the admin's take starts, the member's own is capped.
  await runInTenant(ws, async () => {
    expect((await releaseHeldJobs({ defer: async () => {} })).released).toEqual(["gen_lead_take"]);
  }, { user: person("u_crew", "member") });
  // An admin's poll does not lift the member's cap either.
  await runInTenant(ws, async () => {
    expect((await releaseHeldJobs({ defer: async () => {} })).released).toEqual([]);
    expect(await status("gen_crew_take")).toMatchObject({ status: "held", error: expect.stringContaining("shot's credit cap") });
    // An admin pressing Release on it is the approval the cap asks for.
    expect((await releaseHeldJobs({ only: "gen_crew_take", defer: async () => {} })).released).toEqual(["gen_crew_take"]);
  }, { user: person("u_lead", "admin") });
});

function loadRoute<T>(file: string, dependencies: Record<string, unknown>): T {
  const filename = path.resolve(file), require = createRequire(filename);
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)(
    (name: string) => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name),
    mod, mod.exports,
  );
  return mod.exports as T;
}

test("the jobs route discards a held take, or deletes it, and only its author or an admin may", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { workbenchScopeFor } = await import("../../lib/workbench/request-scope");
  let user = { id: "u_other", name: "Teammate", role: "member" };
  const route = loadRoute<typeof import("../../app/api/jobs/[id]/route")>("app/api/jobs/[id]/route.ts", {
    "@/lib/auth": { requireUser: async () => ({ user, token: null }), withTenant: (handler: unknown) => handler },
  });
  const ws = await setup("route", 4);
  const call = (method: "PATCH" | "DELETE", id: string, body?: unknown) =>
    (route[method] as unknown as (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>)(
      new Request(`http://unit.invalid/api/jobs/${id}`, {
        method, headers: { "Content-Type": "application/json", "X-Workbench-Scope": workbenchScopeFor(ws.id, user.id) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      { params: Promise.resolve({ id }) },
    );
  await runInTenant(ws, async () => {
    await ready();
    await held("gen_route_discard");
    await held("gen_route_delete");
    const refused = await call("PATCH", "gen_route_discard", { discard: true });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toContain("Only the person who made this take");
    expect(await status("gen_route_discard")).toMatchObject({ status: "held" });

    user = { id: "u_test", name: "Member", role: "member" };
    expect((await call("PATCH", "gen_route_discard", { discard: true })).status).toBe(200);
    expect(await status("gen_route_discard")).toMatchObject({ status: "cancelled", cost_usd: 0 });
    // A take that is no longer held cannot be discarded again.
    expect((await call("PATCH", "gen_route_discard", { discard: true })).status).toBe(409);

    expect((await call("DELETE", "gen_route_delete")).status).toBe(200);
    expect((await db().execute("SELECT status,deleted FROM generations WHERE id='gen_route_delete'")).rows[0]).toMatchObject({ status: "cancelled", deleted: 1 });
    expect(await metered("gen_route_delete")).toBeUndefined();

    // Paid work in flight still cannot be deleted.
    await db().execute("UPDATE generations SET status='running',deleted=0 WHERE id='gen_route_delete'");
    expect((await call("DELETE", "gen_route_delete")).status).toBe(409);
  });
});
