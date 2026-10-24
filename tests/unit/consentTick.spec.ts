import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantUser, TenantWorkspace } from "../../lib/tenant";

/*
 * A tick, not a gate (owner, 23 Oct 2026, 13:15 IST): "Identity training (and anything else that refuses for want of
 * consent) records the tick — who ticked, when, an optional file — and refuses nothing." This is the identity trainer
 * (lib/identities.ts › startTraining), under ENGINE_MOCK with the trainer's submission mocked: nothing real is called.
 *
 *  - With no tick the training is claimed, reserved and sent, and records no tick.
 *  - A person's tick records who ticked and when.
 *  - A cited tick keeps its own ticker and time; a new tick replaces both, no tick keeps both.
 *  - Rule 11: training is a person's press. An agent identity, an API or MCP token, or no person at all is refused
 *    before anything is claimed, reserved or sent, ticked or not; a tick never reads as a machine's.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-consent-tick-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "tenant.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.CREDIT_USD = "0.10";
process.env.ENGINE_MOCK = "1";

const person: TenantUser = { id: "person", email: "person@example.test", name: "A Person", role: "member", owner: false, disabled: false, lastSeen: null, createdAt: 0 };

function workspace(name: string): TenantWorkspace {
  return {
    id: `ws_${name}`, slug: name, name, legacy: false, dbUrl: `file:${path.join(dir, `${name}.db`)}`, dbToken: null, keys: {},
    usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null, ownerId: "person", createdAt: 0, suspendedAt: null,
    suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: 10, rendersPerHour: 100, storageQuotaBytes: null, deletedAt: null,
  };
}

async function scope<T>(name: string, fn: (ws: TenantWorkspace) => Promise<T>): Promise<T> {
  const { platformReady, platformDb } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { ready } = await import("../../lib/db");
  const ws = workspace(name);
  await platformReady();
  await platformDb().execute({ sql: `INSERT INTO credit_grants(id,workspace_id,credits,kind,created_at) VALUES(?,?,?,'manual',0)`, args: [`grant_${name}`, ws.id, 500] });
  return runInTenant(ws, async () => { await ready(); return fn(ws); }, { user: person });
}

async function metered(name: string) {
  const { platformDb } = await import("../../lib/platform");
  return (await platformDb().execute({ sql: `SELECT * FROM meter_events WHERE workspace_id=?`, args: [`ws_${name}`] })).rows;
}

async function identity(id: string) {
  const { db, now } = await import("../../lib/db");
  const { MIN_PHOTOS } = await import("../../lib/identities");
  await db().execute({
    sql: `INSERT INTO identities(id,name,photos,status,created_by,created_at,updated_at) VALUES(?,?,?,'draft','person',?,?)`,
    args: [id, "A face", JSON.stringify(Array.from({ length: MIN_PHOTOS }, (_, i) => `photo_${i}`)), now(), now()],
  });
}

const tickOf = async (id: string) => {
  const { db } = await import("../../lib/db");
  const row = (await db().execute({ sql: `SELECT consent_by, consent_at FROM identities WHERE id=?`, args: [id] })).rows[0];
  return { by: row.consent_by ?? null, at: row.consent_at == null ? null : Number(row.consent_at) };
};

test("training with no tick is sent and records no tick; a person's tick records who and when", async () =>
  scope("tick_none", async () => {
    const { startTraining } = await import("../../lib/identities");
    let calls = 0;
    const deps = { archive: async () => "https://example.invalid/photos.zip", submit: async () => { calls++; return { request_id: `mock-${calls}` }; } };
    await identity("idn_none");
    const trained = await startTraining("idn_none", undefined, deps);
    expect(trained.status).toBe("training");
    expect(calls).toBe(1);
    expect(await tickOf("idn_none")).toEqual({ by: null, at: null });
    expect(trained.consentAt).toBeNull();
    expect(await metered("tick_none")).toHaveLength(1);

    await identity("idn_ticked");
    const before = Date.now();
    await startTraining("idn_ticked", { by: "person" }, deps);
    expect(calls).toBe(2);
    const tick = await tickOf("idn_ticked");
    expect(tick.by).toBe("person");
    expect(tick.at).toBeGreaterThanOrEqual(before);
    expect(tick.at).toBeLessThanOrEqual(Date.now());

    /* A cited tick keeps its own ticker and time (A ticked; the person here pressed). On a re-train, who and when
       travel together: a new tick replaces both, no tick keeps both. */
    const { db } = await import("../../lib/db");
    await identity("idn_cited");
    await startTraining("idn_cited", { by: "member_a", at: 1_234 }, deps);
    expect(await tickOf("idn_cited")).toEqual({ by: "member_a", at: 1_234 });
    await db().execute("UPDATE identities SET status='failed' WHERE id='idn_cited'");
    await startTraining("idn_cited", undefined, deps);
    expect(await tickOf("idn_cited")).toEqual({ by: "member_a", at: 1_234 });
    await db().execute("UPDATE identities SET status='failed' WHERE id='idn_cited'");
    await startTraining("idn_cited", { by: "member_b", at: 5_678 }, deps);
    expect(await tickOf("idn_cited")).toEqual({ by: "member_b", at: 5_678 });
    /* The press is billed to the person who pressed, never to the ticker. */
    expect([...new Set((await metered("tick_none")).map((r) => r.created_by))]).toEqual(["person"]);
  }));

test("rule 11: training by an agent identity, under an API or MCP token, or with no person is refused before anything is claimed, reserved or sent, ticked or not", async () =>
  scope("tick_agent", async (ws) => {
    const { startTraining } = await import("../../lib/identities");
    const { PeopleOnlyError } = await import("../../lib/security/people-only");
    const { runInTenant } = await import("../../lib/tenant");
    let calls = 0;
    const deps = { archive: async () => "https://example.invalid/photos.zip", submit: async () => { calls++; return { request_id: `mock-${calls}` }; } };
    await identity("idn_agent");
    await expect(startTraining("idn_agent", { by: "agent:run_1" }, deps)).rejects.toBeInstanceOf(PeopleOnlyError);
    await expect(runInTenant(ws, () => startTraining("idn_agent", { by: "person" }, deps), { user: person, token: { id: "tok", name: "Agent", scope: "render", capUsd: null } }))
      .rejects.toBeInstanceOf(PeopleOnlyError);
    /* Unticked, too: the press itself is a person's (defence in depth behind the people-only routes). */
    await expect(runInTenant(ws, () => startTraining("idn_agent", undefined, deps), { user: person, token: { id: "tok", name: "Agent", scope: "render", capUsd: null } }))
      .rejects.toBeInstanceOf(PeopleOnlyError);
    await expect(runInTenant(ws, () => startTraining("idn_agent", undefined, deps), { user: { ...person, id: "agent:run_1" } })).rejects.toBeInstanceOf(PeopleOnlyError);
    await expect(runInTenant(ws, () => startTraining("idn_agent", undefined, deps), { user: { ...person, disabled: true } })).rejects.toBeInstanceOf(PeopleOnlyError);
    await expect(runInTenant(ws, () => startTraining("idn_agent", undefined, deps))).rejects.toBeInstanceOf(PeopleOnlyError);
    expect(calls).toBe(0);
    expect(await metered("tick_agent")).toHaveLength(0);
    expect(await tickOf("idn_agent")).toEqual({ by: null, at: null });
    const { getIdentity } = await import("../../lib/identities");
    expect((await getIdentity("idn_agent"))?.status).toBe("draft");
  }));
