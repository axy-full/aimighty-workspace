import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";
const dir = mkdtempSync(path.join(tmpdir(), "particl-dispatch-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
function workspace(name: string): TenantWorkspace {
  return {
    id: `ws_${name}`,
    slug: name,
    name,
    legacy: true,
    dbUrl: `file:${path.join(dir, `${name}.db`)}`,
    dbToken: null,
    keys: {},
    usesPlatformKeys: false,
    allowanceUsd: null,
    gatewayKeyId: null,
    ownerId: "u_test",
    createdAt: 0,
    suspendedAt: null,
    suspendedReason: null,
    flaggedAt: null,
    flagNote: null,
    concurrency: 8,
    rendersPerHour: null,
    storageQuotaBytes: null,
    deletedAt: null,
  };
}
async function insert(id: string) {
  const { db, ready } = await import("../../lib/db");
  await ready();
  await db().execute({
    sql: "INSERT INTO generations(id,kind,provider,model,prompt,params,status,created_at,updated_at) VALUES(?,'image','google','gemini-3.1-flash-image','test','{}','running',?,?)",
    args: [id, Date.now(), Date.now()],
  });
}

test("concurrent event deliveries take one lease and share a workspace-scoped event ID", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { dispatchRender, renderDispatchReady } =
    await import("../../lib/renderDispatch");
  await runInTenant(workspace("lease"), async () => {
    await insert("gen_lease");
    await renderDispatchReady();
    let calls = 0,
      release!: () => void,
      entered!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = dispatchRender("gen_lease", "image", async (event) => {
      calls++;
      expect(event.id).toBe("render-ws_lease-gen_lease");
      entered();
      await wait;
    });
    await started;
    expect(
      await dispatchRender("gen_lease", "image", async () => {
        calls++;
      }),
    ).toBe(true);
    release();
    expect(await first).toBe(true);
    expect(calls).toBe(1);
  });
});

test("an ambiguous event acknowledgment retains intent and its late delivery cannot reclaim the paid step", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const { claimRender } = await import("../../lib/renderWork");
  const { dispatchRender } = await import("../../lib/renderDispatch");
  await runInTenant(workspace("timeout"), async () => {
    await insert("gen_timeout");
    let late!: () => void;
    const acknowledgment = new Promise<void>((resolve) => {
      late = resolve;
    });
    expect(
      await dispatchRender(
        "gen_timeout",
        "image",
        async () => acknowledgment,
        10,
      ),
    ).toBe(false);
    expect(
      (await db().execute("SELECT accepted_at FROM render_dispatches")).rows[0]
        .accepted_at,
    ).toBeNull();
    expect(await claimRender("gen_timeout")).toBe(true); // Inline fallback entered the paid step.
    late();
    expect(await claimRender("gen_timeout")).toBe(false); // A late worker sees the same permanent claim.
    let resent = 0;
    expect(
      await dispatchRender("gen_timeout", "image", async () => {
        resent++;
      }),
    ).toBe(true);
    expect(resent).toBe(0);
  });
});

test("a crash before event dispatch recovers only reserved, unclaimed jobs and respects its deadline", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const { reserveGenerationSpend } =
    await import("../../lib/generationRequests");
  const { recoverRenderDispatches } = await import("../../lib/renderDispatch");
  await runInTenant(workspace("recover"), async () => {
    await insert("gen_dispatch_recover");
    await insert("gen_no_reservation");
    await reserveGenerationSpend({
      id: "gen_dispatch_recover",
      kind: "image",
      engine: "google",
      model: "gemini-3.1-flash-image",
      status: "running",
      engineCostUsd: 0.1,
    });
    const events: string[] = [];
    const send = async (event: { id: string }) => {
      events.push(event.id);
    };
    const expired = await recoverRenderDispatches(send, {
      deadlineAt: Date.now() - 1,
    });
    expect(expired.attempted).toBe(0);
    expect(events).toEqual([]);
    expect(await recoverRenderDispatches(send)).toEqual({
      attempted: 1,
      failed: 0,
      deferred: 0,
    });
    expect(events).toEqual(["render-ws_recover-gen_dispatch_recover"]);
    expect(
      (
        await db().execute(
          "SELECT accepted_at FROM render_dispatches WHERE id='gen_dispatch_recover'",
        )
      ).rows[0].accepted_at,
    ).not.toBeNull();
    expect(await recoverRenderDispatches(send)).toEqual({
      attempted: 0,
      failed: 0,
      deferred: 0,
    });
  });
});

test("an expired delivery lease may resend its exact event, never an already claimed render", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const { dispatchRender } = await import("../../lib/renderDispatch");
  await runInTenant(workspace("expired"), async () => {
    await insert("gen_expired");
    const ids: string[] = [];
    await dispatchRender("gen_expired", "image", async (event) => {
      ids.push(event.id);
    });
    await db().execute(
      "UPDATE render_dispatches SET lease_token='lost-owner',lease_until=1,accepted_at=NULL",
    );
    await dispatchRender("gen_expired", "image", async (event) => {
      ids.push(event.id);
    });
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });
});

test("workspace suspension after reservation stops the worker before a paid provider call and releases its reservation", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { platformDb, platformReady } = await import("../../lib/platform");
  const { reserveGenerationSpend } =
    await import("../../lib/generationRequests");
  const { loadJob, produce } = await import("../../lib/renderWork");
  const { engineFor } = await import("../../lib/engines");
  const ws = workspace("suspended");
  await platformReady();
  await platformDb().execute({
    sql: "INSERT INTO workspaces(id,slug,name,db_url,owner_id,created_at,updated_at) VALUES(?,?,?,?,?,0,0)",
    args: [ws.id, ws.slug, ws.name, ws.dbUrl, ws.ownerId],
  });
  const engine = engineFor("google"),
    original = engine.render;
  let calls = 0;
  engine.render = async () => {
    calls++;
    throw new Error("provider must not be called");
  };
  try {
    await runInTenant(ws, async () => {
      await insert("gen_suspended");
      await reserveGenerationSpend({
        id: "gen_suspended",
        kind: "image",
        engine: "google",
        model: "gemini-3.1-flash-image",
        status: "running",
        engineCostUsd: 0.1,
      });
      await platformDb().execute({
        sql: "UPDATE workspaces SET suspended_at=? WHERE id=?",
        args: [Date.now(), ws.id],
      });
      await expect(produce((await loadJob("gen_suspended"))!)).rejects.toThrow(
        /paused or deleted/,
      );
      expect(calls).toBe(0);
      const meter = (
        await platformDb().execute(
          "SELECT status,engine_cost_usd FROM meter_events WHERE id='gen_suspended'",
        )
      ).rows[0];
      expect(meter.status).toBe("failed");
      expect(Number(meter.engine_cost_usd)).toBe(0);
    });
  } finally {
    engine.render = original;
  }
});

test("a lost video dispatch recovers a reserved row once; accepted handles and paid claims are never sent again", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const { meter } = await import("../../lib/meter");
  const { recoverRenderDispatches } = await import("../../lib/renderDispatch");
  const { submitVideoRow } = await import("../../lib/submitVideo");
  const { engineFor } = await import("../../lib/engines");
  const engine = engineFor("byteplus"), original = engine.render;
  let paid = 0;
  engine.render = async () => { paid++; return { handle: { provider: "byteplus", model: "mock", ref: "recovered-video" } }; };
  try { await runInTenant(workspace("video_recover"), async () => {
    for (const id of ["pending_video", "accepted_video", "claimed_video", "unreserved_video"]) {
      await insert(id);
      await db().execute({ sql: "UPDATE generations SET kind='video',provider='byteplus',model='dreamina-seedance-2-0-260128',status='queued',params=? WHERE id=?", args: [JSON.stringify({ ratio: "16:9", resolution: "720p", duration: 5, watermark: false }), id] });
      if (id !== "unreserved_video") await meter({ id, kind: "video", engine: "byteplus", model: "dreamina-seedance-2-0-260128", status: "running", engineCostUsd: 0.7 });
    }
    await db().execute("UPDATE generations SET ark_task_id='already-accepted' WHERE id='accepted_video'");
    await db().execute("UPDATE generations SET params=json_set(params,'$.paidClaim',1) WHERE id='claimed_video'");
    const delivered: string[] = [];
    expect(await recoverRenderDispatches(async event => {
      expect(event.data.kind).toBe("video"); delivered.push(event.data.genId);
      const outcomes = await Promise.all([submitVideoRow(event.data.genId), submitVideoRow(event.data.genId)]);
      expect(outcomes.some(out => out.ok)).toBe(true);
    })).toEqual({ attempted: 1, failed: 0, deferred: 0 });
    expect(delivered).toEqual(["pending_video"]); expect(paid).toBe(1);
    expect(await recoverRenderDispatches(async () => { throw new Error("Must not resend"); })).toEqual({ attempted: 0, failed: 0, deferred: 0 });
    expect(await submitVideoRow("pending_video")).toMatchObject({ ok: true, taskId: "recovered-video" }); expect(paid).toBe(1);
  }); } finally { engine.render = original; }
});

test("unreserved rows cannot permanently starve the bounded dispatch recovery page", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { meter } = await import("../../lib/meter");
  const { recoverRenderDispatches } = await import("../../lib/renderDispatch");
  await runInTenant(workspace("unreserved_fairness"), async () => {
    await insert("abandoned_first");
    await insert("reserved_second");
    await meter({ id: "reserved_second", kind: "image", engine: "google", model: "gemini-3.1-flash-image", status: "running", engineCostUsd: 0.1 });
    const sent: string[] = [];
    const send = async (event: { data: { genId: string } }) => { sent.push(event.data.genId); };
    expect((await recoverRenderDispatches(send, { limit: 1 })).attempted).toBe(0);
    expect((await recoverRenderDispatches(send, { limit: 1 })).attempted).toBe(1);
    expect(sent).toEqual(["reserved_second"]);
  });
});
