import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import type { AdmissionActor } from "../../lib/admissionTypes";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * Owner, 22 Oct 2026: "yes, record releasedBy on every person's Release, as a small follow-up."
 *
 *  - A signed-in person's own Release of a held take records `releasedBy` = that person on the take, whatever it was held for and
 *    whoever made it: a take held for credits with no token, a capped token's take, a no-ceiling token's take.
 *  - Nothing else about the release moves: a capped token's take is still reserved under its token with no `approved_by`; only the
 *    no-ceiling take's reservation names the person (#871).
 *  - The automatic release (credits arriving) names nobody; a token's or Atomik's press is refused as before and names nobody.
 *
 * No paid call: ENGINE_MOCK, a release whose paid submission is recorded and never run, and the network refused. Every figure is the
 * server's own price of a synthetic estimate, or a synthetic ceiling made up for the test.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-released-by-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.BLOB_READ_WRITE_TOKEN = "";
process.env.ENGINE_MOCK = "1";

const MODEL = "dreamina-seedance-2-0-260128";
/** Synthetic: the engine estimate a held row carries. Its credits are the server's own figure (heldPriceNow), never typed here. */
const HELD_EST_USD = 1;
/** Synthetic ceiling, far above one take. */
const ROOMY = 100_000;
const person: AdmissionActor = {
  user: { id: "owner", email: "owner@example.invalid", name: "Owner", role: "admin", owner: true, disabled: false, createdAt: 0, lastSeen: null },
};
const agent: AdmissionActor = { user: { ...person.user!, id: "agent:run_1", name: "Atomik" } };
const viaToken: AdmissionActor = { ...person, token: { id: "tok_agent", name: "Agent", scope: "render", capUsd: null, capCredits: null } };

const nodeRequire = createRequire(path.resolve("package.json"));
function load<T>(file: string, overrides: Record<string, unknown> = {}): T {
  const source = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const target = { exports: {} };
  new Function("require", "module", "exports", source)(
    (name: string) => {
      if (name in overrides) return overrides[name];
      return name.startsWith("@/")
        ? nodeRequire(path.resolve(name.slice(2)))
        : name.startsWith(".")
          ? nodeRequire(path.resolve(path.dirname(file), name))
          : nodeRequire(name);
    },
    target,
    target.exports,
  );
  return target.exports as T;
}

async function newWorkspace(name: string): Promise<TenantWorkspace> {
  const { platformReady, platformDb, rowToWorkspace, grantCredits } = await import("../../lib/platform");
  const { alignLedgerUnit } = await import("../helpers/ledgerUnit");
  await platformReady();
  await alignLedgerUnit();
  const id = `rbe-${name}-${randomUUID().slice(0, 8)}`;
  await platformDb().execute({
    sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,1,'owner',0,0,20,200)",
    args: [id, id, id, `file:${path.join(dir, id + ".db")}`],
  });
  await grantCredits(id, 10_000, "Test", "owner", "manual");
  return rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [id] })).rows[0]);
}

/** A take held for credits, made by the member: through a token (`capCredits` null is no ceiling), or in the browser (`token` left out). */
async function heldTake(o: { token?: string; capCredits?: number | null } = {}): Promise<{ id: string; needs: number }> {
  const { db, ready } = await import("../../lib/db");
  const { heldPriceNow } = await import("../../lib/creditTerms");
  await ready();
  const needs = heldPriceNow({ estUsd: HELD_EST_USD }, "video", MODEL);
  expect(needs, "the server prices the synthetic estimate").toBeGreaterThan(1);
  const id = `gen_held_${o.token ?? "browser"}_${randomUUID().slice(0, 8)}`;
  const at = Date.now() - 60_000;
  await db().batch([
    "INSERT INTO users(id,email,name,password_hash,created_at) VALUES('owner','owner@example.invalid','Owner','x',0) ON CONFLICT(id) DO NOTHING",
    "INSERT INTO users(id,email,name,password_hash,created_at) VALUES('member','member@example.invalid','Member','x',0) ON CONFLICT(id) DO NOTHING",
    ...(o.token ? [{ sql: "INSERT INTO api_tokens(id,token_hash,name,user_id,scope,cap_credits,created_at) VALUES(?,?,'assistant','member','render',?,0) ON CONFLICT(id) DO NOTHING",
      args: [o.token, `hash_${o.token}`, o.capCredits ?? null] }] : []),
    "DELETE FROM settings WHERE key='sampleProduction'",
    { sql: `INSERT INTO generations(id,kind,provider,model,prompt,params,status,created_by,created_at,updated_at,token_id,billed_to,task)
            VALUES(?,'video','byteplus',?,'test',?,'held','member',?,?,?,'byteplus','generate')`,
      args: [id, MODEL, JSON.stringify({ ratio: "16:9", resolution: "720p", duration: 5, watermark: false,
        held: { estUsd: HELD_EST_USD, needs, at: 1, why: "credits" } }), at, at, o.token ?? null] },
  ], "write");
  return { id, needs };
}
async function trace(id: string) {
  const { db } = await import("../../lib/db");
  const { platformDb } = await import("../../lib/platform");
  const row = (await db().execute({ sql: "SELECT status,created_by,token_id,json_extract(params,'$.releasedBy') AS released_by FROM generations WHERE id=?", args: [id] })).rows[0];
  const reservation = (await platformDb().execute({ sql: "SELECT token_id,approved_by FROM generation_reservations WHERE id=?", args: [id] })).rows;
  const meter = (await platformDb().execute({ sql: "SELECT billed_credits FROM meter_events WHERE id=?", args: [id] })).rows;
  return { row: { ...row }, reservation: reservation.map((r) => ({ ...r })), meter: meter.map((r) => ({ ...r })) };
}

type ReleaseRoute = { POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> };
/** The release route, signed in as `who`; its paid submission recorded, never run (no engine, mocked or not, is asked). */
async function releaseRoute(who: AdmissionActor, submitted: string[]): Promise<ReleaseRoute> {
  const held = await import("../../lib/held");
  return load<ReleaseRoute>("app/api/jobs/[id]/release/route.ts", {
    "@/lib/auth": { withTenant: (handler: unknown) => handler, requireUser: async () => who },
    "@/lib/held": { ...held, releaseHeldJobs: (o: Parameters<typeof held.releaseHeldJobs>[0]) =>
      held.releaseHeldJobs({ ...o, defer: async () => { submitted.push(o?.only ?? "line"); } }) },
    "next/server": { NextResponse: Response },
  });
}
const pressRelease = (route: ReleaseRoute, id: string, credits: number) => route.POST(
  new Request(`http://localhost/api/jobs/${id}/release`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ credits }) }),
  { params: Promise.resolve({ id }) },
);
async function offline<T>(fn: () => Promise<T>): Promise<T> {
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Network forbidden in the releasedBy test"); };
  try { return await fn(); } finally { globalThis.fetch = fetch; }
}

test("a person's Release records them as its releaser, whatever the take was held for and whoever made it; nothing else about it moves", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const ws = await newWorkspace("person");
  await offline(() => runInTenant(ws, async () => {
    const submitted: string[] = [];
    const route = await releaseRoute(person, submitted);
    const browser = await heldTake();
    const capped = await heldTake({ token: "tok_roomy", capCredits: ROOMY });
    const bare = await heldTake({ token: "tok_bare" });
    for (const take of [browser, capped, bare]) {
      const res = await pressRelease(route, take.id, take.needs);
      expect(res.status, take.id).toBe(200);
      expect(await res.json()).toEqual({ released: true, id: take.id });
    }
    expect(submitted).toEqual([browser.id, capped.id, bare.id]);
    /* Held for credits in the browser: the person released it; nothing was reserved under a token, and nobody's approval is recorded. */
    expect(await trace(browser.id)).toEqual({
      row: { status: "queued", created_by: "member", token_id: null, released_by: "owner" },
      reservation: [{ token_id: null, approved_by: null }], meter: [{ billed_credits: browser.needs }],
    });
    /* A capped token's take: released by the person, still reserved under its token (its ceiling counts it). */
    expect(await trace(capped.id)).toEqual({
      row: { status: "queued", created_by: "member", token_id: "tok_roomy", released_by: "owner" },
      reservation: [{ token_id: "tok_roomy", approved_by: null }], meter: [{ billed_credits: capped.needs }],
    });
    /* A no-ceiling token's take: the person's press is their approval (#871), as before. */
    expect(await trace(bare.id)).toEqual({
      row: { status: "queued", created_by: "member", token_id: "tok_bare", released_by: "owner" },
      reservation: [{ token_id: null, approved_by: "owner" }], meter: [{ billed_credits: bare.needs }],
    });
  }, { user: person.user }));
});

test("a press at another figure starts nothing and names nobody", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const ws = await newWorkspace("repriced");
  await offline(() => runInTenant(ws, async () => {
    const submitted: string[] = [];
    const take = await heldTake();
    const res = await pressRelease(await releaseRoute(person, submitted), take.id, take.needs - 1);
    expect(res.status).toBe(409);
    expect(submitted).toEqual([]);
    expect(await trace(take.id)).toEqual({ row: { status: "held", created_by: "member", token_id: null, released_by: null }, reservation: [], meter: [] });
  }, { user: person.user }));
});

test("the automatic release names nobody: credits arriving starts the takes it can, released by no one", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { releaseHeldJobs } = await import("../../lib/held");
  const ws = await newWorkspace("auto");
  await offline(() => runInTenant(ws, async () => {
    const browser = await heldTake();
    const capped = await heldTake({ token: "tok_roomy", capCredits: ROOMY });
    const out = await releaseHeldJobs({ defer: async () => {} });
    expect(out.released.sort()).toEqual([browser.id, capped.id].sort());
    for (const take of [browser, capped]) expect((await trace(take.id)).row).toMatchObject({ status: "queued", released_by: null });
  }, { user: person.user }));
});

test("a token's or Atomik's press is refused as before, and names nobody", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { releaseHeldJobs } = await import("../../lib/held");
  const { HELD_TAKE_NO_CEILING } = await import("../../lib/tokenSpend");
  const { PEOPLE_ONLY } = await import("../../lib/security/people-only");
  const ws = await newWorkspace("refused");
  const takes: { id: string; needs: number }[] = [];
  await offline(() => runInTenant(ws, async () => {
    takes.push(await heldTake(), await heldTake({ token: "tok_roomy", capCredits: ROOMY }), await heldTake({ token: "tok_bare" }));
    const submitted: string[] = [];
    const [byToken, byAgent] = [await releaseRoute(viaToken, submitted), await releaseRoute(agent, submitted)];
    for (const take of takes) {
      const t = await pressRelease(byToken, take.id, take.needs);
      expect(t.status, take.id).toBe(403);
      expect((await t.json()).error).toContain("API tokens cannot release it");
      const a = await pressRelease(byAgent, take.id, take.needs);
      expect(a.status, take.id).toBe(403);
      expect((await a.json()).error).toBe(PEOPLE_ONLY);
    }
    expect(submitted).toEqual([]);
  }, { user: person.user }));
  /* lib/held.ts asks again: called as Atomik, or under a token, with a figure, a no-ceiling token's take still meets the token's wall. */
  const bare = takes[2];
  for (const as of [{ user: agent.user }, { user: person.user, token: viaToken.token }]) {
    await offline(() => runInTenant(ws, async () => {
      expect((await releaseHeldJobs({ only: bare.id, approved: bare.needs, defer: async () => {} })).refused).toMatchObject({ status: 403, error: HELD_TAKE_NO_CEILING });
    }, as));
  }
  await runInTenant(ws, async () => {
    for (const take of takes) expect(await trace(take.id), take.id).toMatchObject({ row: { status: "held", released_by: null }, reservation: [], meter: [] });
  });
});
