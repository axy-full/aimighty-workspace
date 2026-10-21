import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import type { AdmissionActor } from "../../lib/admissionTypes";
import type { TenantToken, TenantWorkspace } from "../../lib/tenant";
import { PAID_ROUTES } from "../helpers/paidRoutes";

/**
 * Owner, 20 Oct 2026, Q1 "B": "An admin sets a ceiling per token in credits per month; every paid request from a token or an MCP
 * client carries its approved quote; a token with no ceiling can only prepare and price." (lib/tokenSpend.ts)
 *
 *  - A token with no ceiling prices (its quote answers) and is refused every paid request: before its key is claimed, and before
 *    any row, reservation or vendor call. The spend gate refuses it again at reservation, whichever path asked.
 *  - A token with a ceiling must carry its approved quote (maxCredits, and the fingerprint where the route issues one); a missing
 *    or stale quote is refused before anything is reserved. With both it runs, under its token; past its ceiling it is refused.
 *  - A person in the browser is not asked for any of it.
 *
 * No paid call: ENGINE_MOCK, a queue that only records, and the network refused. Every figure here is the server's own quote or a
 * synthetic ceiling made up for the test.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-token-ceiling-required-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.BLOB_READ_WRITE_TOKEN = "";
process.env.ENGINE_MOCK = "1";

const SEEDANCE = "dreamina-seedance-2-5-260628";
const take = { model: SEEDANCE, prompt: "raw: A lighthouse at dusk", ratio: "16:9", resolution: "720p", duration: 5, projectId: "project", refine: false };
const person: AdmissionActor = {
  user: { id: "owner", email: "owner@example.invalid", name: "Owner", role: "admin", owner: true, disabled: false, createdAt: 0, lastSeen: null },
};
const tokenActor = (token: Partial<TenantToken>): AdmissionActor => ({ ...person, token: { id: "tok_agent", name: "Agent", scope: "render", capUsd: null, capCredits: null, ...token } });
/** Synthetic ceilings: far above one take, and far below it. */
const ROOMY = 100_000, TIGHT = 1;

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

let dispatched: { genId: string; kind: string }[] = [];
const queue = { enqueueRender: async (genId: string, kind: string) => { dispatched.push({ genId, kind }); return true; } };
const noInline = () => { throw new Error("Durable dispatch acknowledged; inline work must not run"); };
type Handler = { POST(req: Request, ctx?: unknown): Promise<Response> };
type Scope = { generate: Handler; quote: Handler; ws: TenantWorkspace };

async function newWorkspace(name: string, platformKeys = true): Promise<TenantWorkspace> {
  const { platformReady, platformDb, rowToWorkspace, grantCredits } = await import("../../lib/platform");
  const { alignLedgerUnit } = await import("../helpers/ledgerUnit");
  await platformReady();
  await alignLedgerUnit();
  const id = `tcr-${name}-${randomUUID().slice(0, 8)}`;
  await platformDb().execute({
    sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,?,'owner',0,0,20,200)",
    args: [id, id, id, `file:${path.join(dir, id + ".db")}`, platformKeys ? 1 : 0],
  });
  await grantCredits(id, 10_000, "Test", "owner", "manual");
  return rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [id] })).rows[0]);
}

async function scope(name: string, who: AdmissionActor, fn: (s: Scope) => Promise<void>) {
  const { runInTenant } = await import("../../lib/tenant");
  const { ready, db } = await import("../../lib/db");
  const ws = await newWorkspace(name);
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Network forbidden in the token ceiling test"); };
  dispatched = [];
  try {
    await runInTenant(ws, async () => {
      await ready();
      await db().execute("INSERT INTO projects(id,name,created_at) VALUES('project','Project',0)");
      await db().execute("INSERT INTO settings(key,value,updated_at) VALUES('promptWriter','none',0) ON CONFLICT(key) DO UPDATE SET value='none'");
      await db().execute("DELETE FROM settings WHERE key='sampleProduction'");
      if (who.token) await db().execute({ sql: "INSERT INTO users(id,email,name,password_hash,created_at) VALUES('owner','owner@example.invalid','Owner','x',0) ON CONFLICT(id) DO NOTHING", args: [] });
      const gen = load<typeof import("../../lib/generationAdmission")>("lib/generationAdmission.ts", { "@/lib/inngest": queue });
      const auth = { withTenant: (handler: unknown) => handler, requireRender: async () => who };
      await fn({
        ws,
        generate: load<Handler>("app/api/generate/route.ts", { "@/lib/auth": auth, "@/lib/generationAdmission": gen, "next/server": { NextResponse: Response, after: noInline } }),
        quote: load<Handler>("app/api/generate/quote/route.ts", { "@/lib/auth": auth, "@/lib/generationAdmission": gen }),
      });
    }, { user: who.user, ...(who.token ? { token: who.token } : {}) });
  } finally {
    globalThis.fetch = fetch;
  }
}

const post = (body: unknown, key: string) => new Request("http://localhost/api/generate", {
  method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body),
});
const quoteOf = async (s: Scope, body: unknown) => {
  const res = await s.quote.POST(new Request("http://localhost/api/generate/quote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  expect(res.status, "the quote answers").toBe(200);
  return (await res.json()) as { estimatedCredits: number; fingerprint: string };
};
/** Everything a paid request could leave behind: its claim, its row, its meter row and reservation, a dispatch. */
async function traces() {
  const { db } = await import("../../lib/db");
  const { platformDb } = await import("../../lib/platform");
  const { requireTenant } = await import("../../lib/tenant");
  const count = async (sql: string, args: unknown[] = []) => Number((await db().execute({ sql, args: args as never })).rows[0]?.n ?? 0);
  const rows = async (table: string) => (await count("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?", [table])) ? count(`SELECT COUNT(*) AS n FROM ${table}`) : 0;
  const claims = await rows("generation_requests");
  /* The workbench doors' own job rows: the 3D blocking agent, development steps, the 3D render. */
  const jobs = (await rows("workbench_atomik_jobs")) + (await rows("workbench_development_jobs")) + (await rows("astra_render_jobs"));
  return {
    claims, jobs,
    generations: await count("SELECT COUNT(*) AS n FROM generations"),
    meters: Number((await platformDb().execute({ sql: "SELECT COUNT(*) AS n FROM meter_events WHERE workspace_id=?", args: [requireTenant().id] })).rows[0].n),
    dispatched: dispatched.length,
  };
}
const NOTHING = { claims: 0, jobs: 0, generations: 0, meters: 0, dispatched: 0 };

test("the rule in one place: a token spends only with a ceiling in its workspace's unit and the quote it was approved at; a person is never asked", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { tokenSpendProblem, tokenMaySpend, TOKEN_NO_CEILING, TOKEN_QUOTE_REQUIRED } = await import("../../lib/tokenSpend");
  const { hasSpendingCeiling } = await import("../../lib/tokenCeiling");
  const credits = await newWorkspace("rule");
  const FP = "c".repeat(64);
  await runInTenant(credits, async () => {
    /* A person in the browser: nothing to ask. */
    expect(tokenSpendProblem(undefined, { maxCredits: undefined })).toBeNull();
    /* No ceiling (none, or a figure that bounds nothing): prepares and prices only. */
    for (const t of [{ name: "A" }, { name: "A", capCredits: null, capUsd: null }, { name: "A", capCredits: 0 }, { name: "A", capUsd: 0 }]) {
      expect(tokenMaySpend(t), JSON.stringify(t)).toBe(false);
      expect(tokenSpendProblem(t, { maxCredits: 18 }), JSON.stringify(t)).toMatchObject({ status: 403, body: { code: TOKEN_NO_CEILING, charged: 0, error: expect.stringMatching(/The token "A" has no monthly ceiling, so it can only prepare and price jobs\. An admin can set its ceiling in credits/) } });
    }
    const capped = { name: "A", capCredits: 500 };
    expect(tokenMaySpend(capped)).toBe(true);
    /* A dollar ceiling left from before credits is still a ceiling: the spend gate holds it as credits at the public price of a credit. */
    expect(tokenMaySpend({ name: "A", capCredits: null, capUsd: 20 })).toBe(true);
    /* With a ceiling: the quote is required, as a whole number of credits, and the fingerprint where the route issues one. */
    for (const maxCredits of [undefined, null, "18", 1.5, -1])
      expect(tokenSpendProblem(capped, { maxCredits }), String(maxCredits)).toMatchObject({ status: 400, body: { code: TOKEN_QUOTE_REQUIRED } });
    expect(tokenSpendProblem(capped, { maxCredits: 18, needsFingerprint: true })).toMatchObject({ status: 400, body: { code: TOKEN_QUOTE_REQUIRED, error: expect.stringContaining("quoteFingerprint") } });
    expect(tokenSpendProblem(capped, { maxCredits: 18, fingerprint: "nope", needsFingerprint: true })).toMatchObject({ status: 400 });
    expect(tokenSpendProblem(capped, { maxCredits: 18, fingerprint: FP, needsFingerprint: true })).toBeNull();
    expect(tokenSpendProblem(capped, { maxCredits: 0 })).toBeNull();
  }, { user: person.user });
  /* The unit is the workspace's: credits where it is billed in credits, dollars in the house, never billed in credits. */
  expect(hasSpendingCeiling({ capCredits: 500, capUsd: null }, true)).toBe(true);
  expect(hasSpendingCeiling({ capCredits: null, capUsd: 20 }, true)).toBe(true);
  expect(hasSpendingCeiling({ capCredits: null, capUsd: null }, true)).toBe(false);
  expect(hasSpendingCeiling({ capCredits: null, capUsd: 20 }, false)).toBe(true);
  expect(hasSpendingCeiling({ capCredits: 500, capUsd: null }, false)).toBe(false);
  expect(hasSpendingCeiling({}, false)).toBe(false);
});

test("a token with no ceiling prices, and its paid request is refused before its key is claimed: nothing written, reserved or sent", async () =>
  scope("none", tokenActor({}), async (s) => {
    const quote = await quoteOf(s, take);
    expect(quote.estimatedCredits).toBeGreaterThan(0);
    const refused = await s.generate.POST(post({ ...take, maxCredits: quote.estimatedCredits, quoteFingerprint: quote.fingerprint }, "none-press"));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "token_no_ceiling", charged: 0, error: expect.stringContaining("can only prepare and price") });
    expect(await traces()).toEqual(NOTHING);
  }));

/* A dollar ceiling left on a credits workspace from before credits is converted at read: held as credits at the public price of a credit. */
test("a dollar ceiling left from before credits still bounds the token, as credits at the public price of a credit: a take past it is refused at the reservation", async () => {
  const { creditUsd } = await import("../../lib/creditTerms");
  let below = 0;
  await scope("legacy-probe", tokenActor({ capCredits: ROOMY }), async (s) => { below = ((await quoteOf(s, take)).estimatedCredits - 1) * creditUsd(); });
  await scope("legacy", tokenActor({ capUsd: below }), async (s) => {
    const quote = await quoteOf(s, take);
    const refused = await s.generate.POST(post({ ...take, maxCredits: quote.estimatedCredits, quoteFingerprint: quote.fingerprint }, "legacy-press"));
    expect(refused.status).toBe(429);
    expect(String((await refused.json()).error)).toMatch(/monthly spending ceiling/);
    const left = await traces();
    expect({ meters: left.meters, dispatched: left.dispatched }).toEqual({ meters: 0, dispatched: 0 });
  });
});

test("a token with a ceiling and no quote, or half of one, is refused before its key is claimed", async () =>
  scope("noquote", tokenActor({ capCredits: ROOMY }), async (s) => {
    const quote = await quoteOf(s, take);
    for (const [label, body] of [
      ["no maxCredits", { ...take, quoteFingerprint: quote.fingerprint }],
      ["no fingerprint", { ...take, maxCredits: quote.estimatedCredits }],
      ["a maxCredits that is not whole credits", { ...take, maxCredits: "lots", quoteFingerprint: quote.fingerprint }],
      ["neither", take],
    ] as const) {
      const refused = await s.generate.POST(post(body, `noquote-${label.replace(/\W+/g, "-")}`));
      expect(refused.status, label).toBe(400);
      expect(await refused.json(), label).toMatchObject({ code: "quote_required", charged: 0 });
    }
    expect(await traces()).toEqual(NOTHING);
  }));

test("a stale quote is refused before anything is reserved: a price above the approval, or a fingerprint for other settings", async () =>
  scope("stale", tokenActor({ capCredits: ROOMY }), async (s) => {
    const quote = await quoteOf(s, take);
    const under = await s.generate.POST(post({ ...take, maxCredits: quote.estimatedCredits - 1, quoteFingerprint: quote.fingerprint }, "stale-price"));
    expect(under.status).toBeGreaterThanOrEqual(400);
    expect(String((await under.json()).error)).toMatch(/estimate changed|price changed|fresh quote/i);
    const other = await quoteOf(s, { ...take, duration: 10 });
    const moved = await s.generate.POST(post({ ...take, maxCredits: other.estimatedCredits, quoteFingerprint: other.fingerprint }, "stale-fingerprint"));
    expect(moved.status).toBe(409);
    const left = await traces();
    expect({ generations: left.generations, meters: left.meters, dispatched: left.dispatched }).toEqual({ generations: 0, meters: 0, dispatched: 0 });
  }));

test("with a ceiling and its approved quote the take runs, under its token", async () =>
  scope("runs", tokenActor({ capCredits: ROOMY }), async (s) => {
    const quote = await quoteOf(s, take);
    const accepted = await s.generate.POST(post({ ...take, maxCredits: quote.estimatedCredits, quoteFingerprint: quote.fingerprint }, "runs-press"));
    expect(accepted.status, JSON.stringify(await accepted.clone().json())).toBe(202);
    const { id } = await accepted.json();
    const { db } = await import("../../lib/db");
    expect((await db().execute({ sql: "SELECT token_id FROM generations WHERE id=?", args: [id] })).rows[0]?.token_id).toBe("tok_agent");
    expect(dispatched).toEqual([{ genId: id, kind: "video" }]);
    expect((await traces()).meters).toBe(1);
  }));

test("a take past the token's ceiling is refused at the reservation, atomically, and nothing is reserved or sent", async () =>
  scope("ceiling", tokenActor({ capCredits: TIGHT }), async (s) => {
    const quote = await quoteOf(s, take);
    expect(quote.estimatedCredits).toBeGreaterThan(TIGHT);
    const refused = await s.generate.POST(post({ ...take, maxCredits: quote.estimatedCredits, quoteFingerprint: quote.fingerprint }, "ceiling-press"));
    expect(refused.status).toBe(429);
    expect(String((await refused.json()).error)).toMatch(/1 cr monthly ceiling/);
    const left = await traces();
    expect({ meters: left.meters, dispatched: left.dispatched }).toEqual({ meters: 0, dispatched: 0 });
  }));

test("a person in the browser is not asked for a quote: a take without maxCredits is admitted as before", async () =>
  scope("person", person, async (s) => {
    const accepted = await s.generate.POST(post(take, "person-press"));
    expect(accepted.status, JSON.stringify(await accepted.clone().json())).toBe(202);
    expect(dispatched).toHaveLength(1);
  }));

test("the spend gate refuses a token with no ceiling whichever path asked it, before anything is reserved", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  const { platformDb } = await import("../../lib/platform");
  const ws = await newWorkspace("gate");
  await runInTenant(ws, async () => {
    const event = (id: string) => ({ id: `${id}_${ws.id}`, kind: "video" as const, engine: "byteplus", model: "dreamina-seedance-2-0-260128", status: "running" as const, engineCostUsd: 1, createdBy: "owner" });
    for (const token of [{ id: "tok_none", capUsd: null, capCredits: null }, { id: "tok_zero", capUsd: null, capCredits: 0 }]) {
      await expect(reserveGenerationSpend(event(token.id), { token }), token.id).rejects.toMatchObject({ status: 403, message: expect.stringContaining("can only prepare and price") });
    }
    await reserveGenerationSpend(event("tok_capped"), { token: { id: "tok_capped", capUsd: null, capCredits: ROOMY } });
    await reserveGenerationSpend(event("tok_old"), { token: { id: "tok_old", capUsd: ROOMY, capCredits: null } });
    await reserveGenerationSpend(event("person"), {});
    const rows = await platformDb().execute({ sql: "SELECT id FROM meter_events WHERE workspace_id=? ORDER BY id", args: [ws.id] });
    expect(rows.rows.map((r) => String(r.id)).sort()).toEqual([`person_${ws.id}`, `tok_capped_${ws.id}`, `tok_old_${ws.id}`].sort());
  }, { user: person.user });
});

/* The other paid doors a render token reaches, each refusing a token with no ceiling before its key is claimed or a row is written. */
function loadRoute<T>(file: string, who: AdmissionActor): T {
  return load<T>(file, {
    "@/lib/auth": { withTenant: (handler: unknown) => handler, requireRender: async () => who, requireUser: async () => who, requireSession: async () => ({ response: Response.json({ error: "session only" }, { status: 403 }) }) },
    "@/lib/workbench/request-scope": { workbenchScopeProblem: () => null, workbenchScopeFor: () => "" },
  });
}
const DOORS: { file: string; body: Record<string, unknown>; ctx?: unknown }[] = [
  { file: "app/api/audio/route.ts", body: { task: "tts", text: "Hello", maxCredits: 50 } },
  { file: "app/api/audio/dub/route.ts", body: { sourceUploadId: "upl_x", targetLang: "es", maxCredits: 50 } },
  { file: "app/api/lipsync/route.ts", body: { maxCredits: 50 } },
  /* Recraft (#852): refused at the gate whether or not its engine is on for the workspace (the switch is never set here). */
  { file: "app/api/recraft/route.ts", body: { tool: "image", prompt: "A lighthouse", maxCredits: 50 } },
  { file: "app/api/audio/transcribe/route.ts", body: { sourceUploadId: "upl_x", maxCredits: 50 } },
  { file: "app/api/prompt/enhance/route.ts", body: { prompt: "a tree", mode: "video", maxCredits: 5 } },
  { file: "app/api/atomik/ideas/draft/route.ts", body: { brief: "a tree", maxCredits: 5 } },
  { file: "app/api/atomik/shots/draft/route.ts", body: { brief: "a tree", maxCredits: 5 } },
  { file: "app/api/atomik/treatment/scene/route.ts", body: { brief: "a tree", maxCredits: 5 } },
  { file: "app/api/atomik/[id]/route.ts", body: { text: "plan it", maxCredits: 5 }, ctx: { params: Promise.resolve({ id: "ach_x" }) } },
  { file: "app/api/identities/[id]/render/route.ts", body: { prompt: "a portrait", maxCredits: 50 }, ctx: { params: Promise.resolve({ id: "id_x" }) } },
  /* The workbench doors and Crew: each body is one their schema accepts, so it is the token gate that answers, before any job is written. */
  { file: "app/api/workbench/atomik/route.ts", body: { projectId: "p1", requestId: "req_tokengate1", request: "Plan the shoot", maxCredits: 5 } },
  { file: "app/api/workbench/development/route.ts", body: { projectId: "p1", requestId: "req_tokengate2", kind: "idea", model: "auto", maxCredits: 5 } },
  { file: "app/api/workbench/astra-blender/render/route.ts", body: { projectId: "p1", requestId: "req_tokengate3", source: "scene", sourceDigest: "a".repeat(64), quoteDigest: "b".repeat(64), maxCredits: 5 } },
  { file: "app/api/crew/sessions/[id]/rounds/route.ts", body: { maxCredits: 5, round: 1 }, ctx: { params: Promise.resolve({ id: "crew_x" }) } },
];
test("every other paid door a render token reaches refuses one with no ceiling before its key is claimed; with a ceiling and no quote, the same", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { ready, db } = await import("../../lib/db");
  const ws = await newWorkspace("doors");
  dispatched = [];
  for (const [label, token, code, status] of [["no ceiling", {}, "token_no_ceiling", 403], ["no quote", { capCredits: ROOMY }, "quote_required", 400]] as const) {
    const who = tokenActor(token);
    await runInTenant(ws, async () => {
      await ready();
      await db().execute("DELETE FROM settings WHERE key='sampleProduction'");
      for (const door of DOORS) {
        const route = loadRoute<Handler>(door.file, who);
        const body = label === "no quote" ? { ...door.body, maxCredits: undefined } : door.body;
        /* The workspace scope the browser and a token's client send (Crew's own check is the real one: lib/crew/http.ts). */
        const headers = { "Content-Type": "application/json", "Idempotency-Key": `door-${randomUUID()}`, "X-Workbench-Scope": `particl-active-${ws.id}-${who.user.id}` };
        const res = await route.POST(new Request(`http://localhost/api/${door.file}`, { method: "POST", headers, body: JSON.stringify(body) }), door.ctx);
        expect(res.status, `${door.file} (${label})`).toBe(status);
        expect(await res.json(), `${door.file} (${label})`).toMatchObject({ code, charged: 0 });
      }
      expect(await traces(), label).toEqual(NOTHING);
    }, { user: who.user, token: who.token });
  }
});

/**
 * A closed list, so a paid route cannot be added without deciding how a token is held at it: each route in tests/helpers/paidRoutes.ts
 * either asks lib/tokenSpend.ts (a ceiling and the approved quote) in its own source or its admission's, or refuses every token outright
 * (people only, or a signed-in session). A new paid route fails here until it says which.
 */
const TOKEN_DOORS: Record<string, { gate: RegExp; file?: string }> = {
  "generate": { gate: /tokenSpendRefusal\(\{ maxCredits: asked\?\.maxCredits, fingerprint: asked\?\.quoteFingerprint, needsFingerprint: true \}, got\.token\)/ },
  "generate/batch": { gate: /got\.token != null[^\n]*PEOPLE_ONLY/, file: "lib/batchPress.ts" },
  "audio": { gate: /tokenSpendRefusal\(\{ maxCredits: body\.maxCredits \}, got\.token\)/ },
  "audio/dub": { gate: /tokenSpendRefusal\(\{ maxCredits: body\.maxCredits \}, got\.token\)/ },
  "lipsync": { gate: /tokenSpendRefusal\(\{ maxCredits: body\.maxCredits \}, got\.token\)/ },
  "recraft": { gate: /tokenSpendRefusal\(\{ maxCredits: body\.maxCredits \}, got\.token\)/ },
  "audio/transcribe": { gate: /tokenSpendRefusal\(\{ maxCredits: body\?\.maxCredits \}, got\.token\)/ },
  "jobs/[id]/release": { gate: /if \(got\.token\) return NextResponse\.json\(\{ error: "A held take is released by a person/ },
  "atomik/steps/[id]/claim": { gate: /if \(!isPerson\(\{ user: got\.user, token: got\.token \}\)\) return/ },
  /* Its POST only makes a chat (free) or quotes; the turn that spends is atomik/[id]'s. */
  "atomik": { gate: /quoteOnly === true\)[\s\S]*const id = await createChat\([\s\S]*return NextResponse\.json\(\{ id \}\);/ },
  "atomik/[id]": { gate: /tokenSpendRefusal\(\{ maxCredits: b\?\.maxCredits \}, got\.token\)/ },
  "atomik/ideas/draft": { gate: /tokenSpendRefusal\(\{ maxCredits: body\?\.maxCredits \}, got\.token\)/ },
  "atomik/shots/draft": { gate: /tokenSpendRefusal\(\{ maxCredits: body\?\.maxCredits \}, got\.token\)/ },
  "atomik/treatment/scene": { gate: /tokenSpendRefusal\(\{ maxCredits: body\?\.maxCredits \}, got\.token\)/ },
  "atomik/memory/read": { gate: /if \(got\.token\) return Response\.json\(\{ error: "Memory is for signed-in people/ },
  "identities/[id]/train": { gate: /if \(!isPerson\(\{ user: got\.user, token: got\.token \}\)\) return/ },
  "identities/[id]/render": { gate: /tokenSpendRefusal\(\{ maxCredits: [^\n]*\}, got\.token\)/ },
  "soul/identities": { gate: /if \(!isPerson\(\{ user: got\.user, token: got\.token \}\)\)/ },
  "workbench/astra-blender/render": { gate: /tokenSpendRefusal\(\{ maxCredits: input\.maxCredits, fingerprint: input\.quoteDigest, needsFingerprint: true \}, auth\.token\)/ },
  "workbench/atomik": { gate: /tokenSpendRefusal\(\{ maxCredits: input\.maxCredits \}, auth\.token\)/ },
  "workbench/development": { gate: /tokenSpendRefusal\(\{ maxCredits: input\.maxCredits \}, auth\.token\)/ },
  "pipelines/[id]": { gate: /requireSession\(\)/ },
  "prompt/enhance": { gate: /tokenSpendRefusal\(\{ maxCredits: [^\n]*\}, got\.token\)/ },
  /* Its POST makes a room (free) or quotes, for a signed-in session only (crewCaller without `paid`: requireSession). */
  "crew/sessions": { gate: /export const POST = withTenant\(async \(req: Request\) => \{\s*const caller = await crewCaller\(req\);/ },
  "crew/sessions/[id]/rounds": { gate: /tokenSpendRefusal\(\{ maxCredits: asked\?\.maxCredits \}\)/ },
};
test("every paid route says how a token is held at it: its ceiling and its approved quote, or no token at all", () => {
  expect(Object.keys(TOKEN_DOORS).sort()).toEqual(PAID_ROUTES.map((r) => r.dir).sort());
  for (const [dir, door] of Object.entries(TOKEN_DOORS)) {
    const source = readFileSync(door.file ?? `app/api/${dir}/route.ts`, "utf8");
    expect(source, dir).toMatch(door.gate);
  }
  /* Generation admission asks again, for every path that reaches it with a claim (a prepared approval, a pipeline stage, the route). */
  expect(readFileSync("lib/generationAdmission.ts", "utf8")).toMatch(/if \(options\.requestClaim\) \{\s*const problem = tokenSpendProblem\(got\.token, \{ maxCredits: body\.maxCredits \}\);/);
  /* And the spend gate, under its lock, for every reservation that names a token. */
  expect(readFileSync("lib/generationRequests.ts", "utf8")).toContain("if (options.token && !hasSpendingCeiling(options.token, creditsApply(ws))) throw new TokenNoCeilingError();");
  /* Recraft (#852): its reservation names the request's token, so the spend gate holds it to its ceiling. */
  expect(readFileSync("lib/recraftImage.ts", "utf8")).toMatch(/reserveGenerationSpend\([\s\S]{0,400}\{ token: got\.token \}/);
});

/* A take a token made and parked (held for credits or a slot) is started by the spend gate when released. Made by a token with no ceiling:
   Owner, 20 Oct 2026, answer A: "A person's Release of a held take made by a no-ceiling token IS that person's approval and starts it,
   recorded under the person. Who may release is unchanged."
   This replaces the test that pinned the earlier refusal ("a person releasing ... is told who acts, and the take stays held"). Now:
    - a person's own Release, at the figure they were shown, starts it at its held price, judged as that person (no token on the
      reservation), with `releasedBy` the person and `created_by` still its author;
    - a price that rose since it was held stays held, nothing reserved;
    - the automatic release (credits arriving) still leaves it held, saying who acts (HELD_TAKE_NO_CEILING);
    - a token's press and an Atomik (agent:*) press are still refused at the route, and in lib/held.ts too;
    - a take a capped token made is still reserved under its token, and its ceiling still stops it. */
const NO_CEILING_MODEL = "dreamina-seedance-2-0-260128";
/** Synthetic: the engine estimate a held row carries. Its credits are the server's own figure (heldPriceNow), never typed here. */
const HELD_EST_USD = 1;
type ReleaseRoute = { POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> };

/** `rose`: credits the price rose by while it was held (it was held at that much less than it costs now). */
async function heldTokenTake(o: { token: string; capCredits?: number | null; rose?: number }): Promise<{ id: string; needs: number }> {
  const { db, ready } = await import("../../lib/db");
  const { heldPriceNow } = await import("../../lib/creditTerms");
  await ready();
  const needs = heldPriceNow({ estUsd: HELD_EST_USD }, "video", NO_CEILING_MODEL);
  expect(needs, "the server prices the synthetic estimate").toBeGreaterThan(1);
  const id = `gen_held_${o.token}_${randomUUID().slice(0, 8)}`;
  const at = Date.now() - 60_000;
  await db().batch([
    "INSERT INTO users(id,email,name,password_hash,created_at) VALUES('owner','owner@example.invalid','Owner','x',0) ON CONFLICT(id) DO NOTHING",
    "INSERT INTO users(id,email,name,password_hash,created_at) VALUES('member','member@example.invalid','Member','x',0) ON CONFLICT(id) DO NOTHING",
    { sql: "INSERT INTO api_tokens(id,token_hash,name,user_id,scope,cap_credits,created_at) VALUES(?,?,'assistant','member','render',?,0) ON CONFLICT(id) DO NOTHING",
      args: [o.token, `hash_${o.token}`, o.capCredits ?? null] },
    "DELETE FROM settings WHERE key='sampleProduction'",
    /* Made by the member's token: `created_by` is its author, the member, whoever releases it. */
    { sql: `INSERT INTO generations(id,kind,provider,model,prompt,params,status,created_by,created_at,updated_at,token_id,billed_to,task)
            VALUES(?,'video','byteplus',?,'test',?,'held','member',?,?,?,'byteplus','generate')`,
      args: [id, NO_CEILING_MODEL, JSON.stringify({ ratio: "16:9", resolution: "720p", duration: 5, watermark: false,
        held: { estUsd: HELD_EST_USD, needs: needs - (o.rose ?? 0), at: 1, why: "credits" } }), at, at, o.token] },
  ], "write");
  return { id, needs };
}
async function heldTrace(id: string) {
  const { db } = await import("../../lib/db");
  const { platformDb } = await import("../../lib/platform");
  const row = (await db().execute({ sql: "SELECT status,error,created_by,token_id,json_extract(params,'$.releasedBy') AS released_by FROM generations WHERE id=?", args: [id] })).rows[0];
  const meter = (await platformDb().execute({ sql: "SELECT billed_credits,created_by FROM meter_events WHERE id=?", args: [id] })).rows;
  const reservation = (await platformDb().execute({ sql: "SELECT token_id,approved_by FROM generation_reservations WHERE id=?", args: [id] })).rows;
  return { row: { ...row }, meter: meter.map((r) => ({ ...r })), reservation: reservation.map((r) => ({ ...r })) };
}
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

test("a person's Release of a held take a token with no ceiling made is their approval: it starts at its held price, recorded under them", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const ws = await newWorkspace("held-person");
  await runInTenant(ws, async () => {
    const { id, needs } = await heldTokenTake({ token: "tok_bare" });
    const submitted: string[] = [];
    const res = await pressRelease(await releaseRoute(person, submitted), id, needs);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ released: true, id });
    expect(submitted).toEqual([id]);
    /* At its held price, one meter row; judged as the person, so no token on the reservation; the person approved it, the member made it. */
    expect(await heldTrace(id)).toEqual({
      row: { status: "queued", error: null, created_by: "member", token_id: "tok_bare", released_by: "owner" },
      meter: [{ billed_credits: needs, created_by: "member" }],
      reservation: [{ token_id: null, approved_by: "owner" }],
    });
    /* A second press charges nothing more. */
    const again = await pressRelease(await releaseRoute(person, submitted), id, needs);
    expect(await again.json()).toEqual({ released: true, id, already: true });
    expect((await heldTrace(id)).meter).toHaveLength(1);
  }, { user: person.user });
});

test("a person's Release never starts a no-ceiling token's take above the price it was held at, nor at a figure they were not shown", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { movedPrice, repriced } = await import("../../lib/held");
  const ws = await newWorkspace("held-rose");
  await runInTenant(ws, async () => {
    /* Held at one credit less than it costs now: the price rose while it waited. */
    const { id, needs } = await heldTokenTake({ token: "tok_bare", rose: 1 });
    const submitted: string[] = [];
    const route = await releaseRoute(person, submitted);
    /* Pressed at today's figure, the one the card shows: above what it was held at, so it stays held. */
    const rose = await pressRelease(route, id, needs);
    expect(rose.status).toBe(409);
    expect(await rose.json()).toEqual({ error: movedPrice(needs), credits: needs });
    /* Pressed at the figure it was held at: not today's price, so not that either. */
    const old = await pressRelease(route, id, needs - 1);
    expect(old.status).toBe(409);
    expect(await old.json()).toEqual({ error: repriced(needs), credits: needs });
    expect(submitted).toEqual([]);
    expect(await heldTrace(id)).toEqual({
      row: { status: "held", error: null, created_by: "member", token_id: "tok_bare", released_by: null },
      meter: [], reservation: [],
    });
  }, { user: person.user });
});

test("the automatic release still leaves a no-ceiling token's take held, saying who acts; a token or Atomik press is refused", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { releaseHeldJobs } = await import("../../lib/held");
  const { HELD_TAKE_NO_CEILING } = await import("../../lib/tokenSpend");
  const { PEOPLE_ONLY } = await import("../../lib/security/people-only");
  const ws = await newWorkspace("held-auto");
  const agent: AdmissionActor = { user: { ...person.user!, id: "agent:run_1", name: "Atomik" } };
  const viaToken = tokenActor({ capUsd: null, capCredits: null });
  let take = { id: "", needs: 0 };
  await runInTenant(ws, async () => {
    take = await heldTokenTake({ token: "tok_bare" });
    /* Credits arriving (a top-up, the sync): nobody pressed, so nobody approved it. */
    const out = await releaseHeldJobs({ defer: async () => {} });
    expect(out.released).toEqual([]);
    expect(HELD_TAKE_NO_CEILING).toBe("This take was made by an API token with no monthly ceiling. An admin sets the ceiling in Settings › Connections, then release it.");
    expect((await heldTrace(take.id)).row).toMatchObject({ status: "held", error: HELD_TAKE_NO_CEILING, released_by: null });
    /* A press with no stated figure is not a person's approval either. */
    expect((await releaseHeldJobs({ only: take.id, defer: async () => {} })).refused).toMatchObject({ status: 403, error: HELD_TAKE_NO_CEILING });
    /* A token's press and an Atomik press are refused at the route, before anything is read or reserved. */
    const submitted: string[] = [];
    const byToken = await pressRelease(await releaseRoute(viaToken, submitted), take.id, take.needs);
    expect(byToken.status).toBe(403);
    expect((await byToken.json()).error).toContain("API tokens cannot release it");
    const byAgent = await pressRelease(await releaseRoute(agent, submitted), take.id, take.needs);
    expect(byAgent.status).toBe(403);
    expect((await byAgent.json()).error).toBe(PEOPLE_ONLY);
    expect(submitted).toEqual([]);
  }, { user: person.user });
  /* And lib/held.ts asks again: called as Atomik, or under a token, with a figure, it is still the token's wall. */
  await runInTenant(ws, async () => {
    expect((await releaseHeldJobs({ only: take.id, approved: take.needs, defer: async () => {} })).refused).toMatchObject({ status: 403, error: HELD_TAKE_NO_CEILING });
  }, { user: agent.user });
  await runInTenant(ws, async () => {
    expect((await releaseHeldJobs({ only: take.id, approved: take.needs, defer: async () => {} })).refused).toMatchObject({ status: 403, error: HELD_TAKE_NO_CEILING });
  }, { user: person.user, token: viaToken.token });
  await runInTenant(ws, async () => {
    expect(await heldTrace(take.id)).toMatchObject({ row: { status: "held", released_by: null }, meter: [], reservation: [] });
  });
});

test("a person's Release of a capped token's take is still reserved under its token, and its ceiling still stops it", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const ws = await newWorkspace("held-capped");
  await runInTenant(ws, async () => {
    const submitted: string[] = [];
    const route = await releaseRoute(person, submitted);
    const roomy = await heldTokenTake({ token: "tok_roomy", capCredits: ROOMY });
    const ok = await pressRelease(route, roomy.id, roomy.needs);
    expect(ok.status).toBe(200);
    expect(await heldTrace(roomy.id)).toEqual({
      row: { status: "queued", error: null, created_by: "member", token_id: "tok_roomy", released_by: null },
      meter: [{ billed_credits: roomy.needs, created_by: "member" }],
      reservation: [{ token_id: "tok_roomy", approved_by: null }],
    });
    const tight = await heldTokenTake({ token: "tok_tight", capCredits: TIGHT });
    const stopped = await pressRelease(route, tight.id, tight.needs);
    expect(stopped.status).toBe(429);
    expect((await stopped.json()).error).toContain("this token's 1 cr monthly ceiling");
    expect(submitted).toEqual([roomy.id]);
    expect(await heldTrace(tight.id)).toMatchObject({ row: { status: "held", released_by: null }, meter: [], reservation: [] });
  }, { user: person.user });
});

/* Recraft's MCP tools (#852) follow the direct-engine registry (lib/directEngineMcp.ts): none is declared a draft, so a call is priced and prepared
   for a person, never started, and never carries a maxCredits of the caller's or the tool's own. */
test("Recraft's MCP tools never start a job or carry an approval: priced and prepared for a person", async () => {
  const { RECRAFT_DIRECT_TOOLS } = await import("../../lib/recraftMcp");
  expect(RECRAFT_DIRECT_TOOLS.length).toBeGreaterThan(0);
  for (const tool of RECRAFT_DIRECT_TOOLS) expect("draft" in tool, tool.def.name).toBe(false);
  /* The body each tool sends is built from its arguments alone: it never names an approval, whatever the caller passed. */
  const args = { prompt: "A lighthouse", source_upload_id: "upl_x", project_id: "p1", maxCredits: 999, max_credits: 999 };
  for (const tool of RECRAFT_DIRECT_TOOLS) {
    const { body } = tool.request(args as never);
    expect(Object.keys(body), tool.def.name).not.toContain("maxCredits");
    expect(Object.keys(body), tool.def.name).not.toContain("max_credits");
  }
});
