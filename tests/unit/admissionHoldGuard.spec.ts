import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";
import type { AdmissionActor, AdmissionReply, PreparedAdmission } from "../../lib/admissionTypes";
import { CINEMA_STUDIO_MODEL_ID } from "../../lib/cinemaStudioTypes";

/**
 * A take its reservation turned away ends honestly, and only once. When the
 * shared provider pool (lib/providerPool.ts) is full, Generate parks the take
 * in the line (lib/held.ts holdForPool); when it cannot (the hold could not be
 * written, or the take ended a moment before), the take fails unsent and
 * unreserved, and nothing is left running. A take cancelled a moment before is
 * never overwritten as failed, nor brought back as held, and the reply says
 * what it is. Local databases and the mock engine only; nothing is sent.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-admission-guard-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

const MARKETING = "higgsfield/marketing-studio-image";
/* Workspace ids of this run only: the platform database may be shared with other files in the worker. */
const RUN = randomBytes(3).toString("hex");
const actor: AdmissionActor = {
  user: { id: "owner", email: "owner@example.invalid", name: "Owner", role: "admin", owner: true, disabled: false, createdAt: 0, lastSeen: null },
};
/** The words a take cancelled by another path a moment before carries. */
const CANCELLED = "Cancelled before it started. Nothing was charged.";
const pool = (size: string | null, share: string | null = null) => {
  if (size == null) delete process.env.HF_POOL_SIZE; else process.env.HF_POOL_SIZE = size;
  if (share == null) delete process.env.HF_POOL_WORKSPACE_SHARE; else process.env.HF_POOL_WORKSPACE_SHARE = share;
};
const originalFetch = globalThis.fetch;

test.beforeEach(async () => {
  pool(null);
  process.env.ENGINE_MOCK = "1";
  globalThis.fetch = async () => { throw new Error("Network forbidden: nothing is sent"); };
  const { providerPoolReady } = await import("../../lib/providerPool");
  const { platformDb } = await import("../../lib/platform");
  await providerPoolReady();
  // Each test starts with an empty line and no slot taken (a fixture database, not anyone's data).
  await platformDb().execute("DELETE FROM provider_pool");
});
test.afterEach(() => { globalThis.fetch = originalFetch; });
test.afterAll(() => pool(null));

async function register(name: string): Promise<TenantWorkspace> {
  const { platformReady, platformDb, rowToWorkspace, grantCredits } = await import("../../lib/platform");
  await platformReady();
  const id = `ws_${name}_${RUN}`;
  await platformDb().execute({
    sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,1,'owner',0,0,8,500)",
    args: [id, `ag-${name}-${RUN}`, `Studio ${name}`, `file:${path.join(dir, `${name}.db`)}`],
  });
  await grantCredits(id, 10_000, "Test", "owner", "manual");
  return rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [id] })).rows[0]);
}
const inside = async <T>(ws: TenantWorkspace, fn: () => Promise<T>) => (await import("../../lib/tenant")).runInTenant(ws, fn, actor);
const still = (id: string) => ({ id, kind: "image" as const, engine: "higgsfield", model: MARKETING, status: "running" as const, engineCostUsd: 0.31 });
/** A take of another workspace holding a shared slot. */
async function occupy(ws: TenantWorkspace, id: string) {
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  await inside(ws, () => reserveGenerationSpend(still(id)));
}
async function release(ws: TenantWorkspace, id: string) {
  const { meter } = await import("../../lib/meter");
  await inside(ws, () => meter({ ...still(id), status: "succeeded" }));
}
async function metered(id: string) {
  const { platformDb } = await import("../../lib/platform");
  return (await platformDb().execute({ sql: "SELECT status,billed_credits FROM meter_events WHERE id=?", args: [id] })).rows[0];
}
async function line(id: string) {
  const { platformDb } = await import("../../lib/platform");
  return (await platformDb().execute({ sql: "SELECT admitted_at,left_at FROM provider_pool WHERE id=?", args: [id] })).rows[0];
}
async function take(ws: TenantWorkspace, id: string) {
  const { db } = await import("../../lib/db");
  return inside(ws, async () => (await db().execute({ sql: "SELECT kind,model,status,error FROM generations WHERE id=?", args: [id] })).rows[0]);
}
const kinds = { still: { kind: "image", model: MARKETING }, video: { kind: "video", model: CINEMA_STUDIO_MODEL_ID } } as const;
/** Takes still waiting or in flight: a take left queued, running or held here is stranded. */
async function live(ws: TenantWorkspace) {
  const { db } = await import("../../lib/db");
  return inside(ws, async () => Number((await db().execute("SELECT COUNT(*) AS n FROM generations WHERE status IN ('queued','running','held')")).rows[0].n));
}
async function balance(ws: TenantWorkspace) {
  const { creditState } = await import("../../lib/credits");
  return inside(ws, async () => (await creditState())!.balance);
}
/** Another path ends the take a moment before this request's own write (a person discarding it, say). */
async function cancelNow(id: string) {
  const { db } = await import("../../lib/db");
  await db().execute({ sql: "UPDATE generations SET status='cancelled', error=?, cost_usd=0, updated_at=? WHERE id=?", args: [CANCELLED, Date.now(), id] });
}
async function studio(ws: TenantWorkspace) {
  const { db, ready } = await import("../../lib/db");
  await inside(ws, async () => {
    await ready();
    await db().execute("INSERT INTO projects(id,name,created_at) VALUES('project','Project',0)");
    await db().execute("INSERT INTO settings(key,value,updated_at) VALUES('promptWriter','none',0) ON CONFLICT(key) DO UPDATE SET value='none'");
  });
}
/** What reaches console.error while `fn` runs. */
async function errorsDuring<T>(fn: () => Promise<T>): Promise<{ value: T; logged: string[] }> {
  const logged: string[] = [];
  const before = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  try {
    return { value: await fn(), logged };
  } finally {
    console.error = before;
  }
}

const nodeRequire = createRequire(path.resolve("package.json"));
function load<T>(file: string, overrides: Record<string, unknown> = {}): T {
  const source = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const target = { exports: {} };
  new Function("require", "module", "exports", source)((name: string) => {
    if (name in overrides) return overrides[name];
    return name.startsWith("@/") ? nodeRequire(path.resolve(name.slice(2) + ".ts"))
      : name.startsWith(".") ? nodeRequire(path.resolve(path.dirname(file), name + ".ts")) : nodeRequire(name);
  }, target, target.exports);
  return target.exports as T;
}

type Generation = typeof import("../../lib/generationAdmission");
const takes = {
  still: { model: MARKETING, prompt: "A bottle on a marble plinth", projectId: "project", ratio: "3:4", resolution: "2k" },
  video: { model: CINEMA_STUDIO_MODEL_ID, prompt: "A harbour at dawn", projectId: "project", ratio: "16:9", resolution: "720p", duration: 5, refine: false },
} as const;

/** Generate as a person does: priced, then sent at the approved quote. */
async function generate(gen: Generation, ws: TenantWorkspace, body: Record<string, unknown>): Promise<AdmissionReply> {
  return inside(ws, async () => {
    const prepared = await gen.prepareGeneration(body, actor);
    expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
    const quote = (prepared as { value: PreparedAdmission }).value.quote;
    return gen.executeGenerationAdmission({ ...body, maxCredits: quote.estimatedCredits }, actor, {
      checkpoint: (value) => (value.quote.fingerprint === quote.fingerprint ? undefined : { status: 409, body: { error: "changed" } }),
      defer: async () => {},
    });
  });
}

/**
 * Generate on a full pool, as two Generates racing for the last slot leave it: the read before the write saw a
 * free slot, and the reservation's own answer (the pool is full) decides. `hold` stands in for lib/held.ts
 * holdForPool.
 */
async function racedForTheLastSlot(kind: keyof typeof takes, name: string, hold: (id: string, info: never) => Promise<boolean>) {
  pool("1", "1");
  const dispatched: string[] = [];
  const realPool = await import("../../lib/providerPool");
  const realHeld = await import("../../lib/held");
  const gen = load<Generation>("lib/generationAdmission.ts", {
    "@/lib/inngest": { enqueueRender: async (genId: string) => { dispatched.push(genId); return true; } },
    "@/lib/providerPool": { ...realPool, poolAdmission: async () => ({ admit: true, free: 1 }) },
    "@/lib/held": { ...realHeld, holdForPool: hold },
  });
  const other = await register(`${name}_other`), ws = await register(name);
  await occupy(other, `${name}_other_running`);
  await studio(ws);
  const before = await balance(ws);
  const { value: reply, logged } = await errorsDuring(() => generate(gen, ws, takes[kind]));
  return { ws, reply, logged, dispatched, before, done: () => release(other, `${name}_other_running`) };
}

/* ── A hold that throws ────────────────────────────────────────────── */

for (const kind of ["still", "video"] as const)
  test(`a ${kind} whose hold for the full pool throws fails unsent and unreserved, in no line, with nothing left running`, async () => {
    const { POOL_BUSY_UNSENT } = await import("../../lib/sharedKeyTerms");
    const asked: string[] = [];
    /* Its hold's own write fails: the database refused it. */
    const raced = await racedForTheLastSlot(kind, `throws_${kind}`, async (id) => {
      asked.push(id);
      throw new Error("SQLITE_BUSY: database is locked");
    });
    const { ws, reply, logged } = raced;
    // The same failure reply as a take that could not be held: unsent, nothing charged, never "waits in line".
    expect(reply.status).toBe(409);
    expect(reply.body).toMatchObject({ status: "failed", error: POOL_BUSY_UNSENT });
    const id = String(reply.body.id);
    expect(asked).toEqual([id]);
    expect(await take(ws, id)).toMatchObject({ ...kinds[kind], status: "failed", error: POOL_BUSY_UNSENT });
    // Nothing reserved or charged, nothing sent, and it stands in no line.
    expect(await metered(id)).toBeUndefined();
    expect(await balance(ws)).toBe(raced.before);
    expect(await line(id)).toBeUndefined();
    expect(raced.dispatched).toEqual([]);
    // Nothing is left queued, running or held: no stranded take holds one of the workspace's slots.
    expect(await live(ws)).toBe(0);
    // Said on the server, with the take's id and the database's words, once.
    expect(logged.filter((entry) => entry.includes(id))).toEqual([`generate ${id}: not held for the shared pool — SQLITE_BUSY: database is locked`]);
    await raced.done();
  });

/* ── A take that ended a moment before ─────────────────────────────── */

for (const kind of ["still", "video"] as const)
  test(`a ${kind} cancelled a moment before its failure is written stays cancelled, and the reply says so`, async () => {
    const realHeld = await import("../../lib/held");
    const { POOL_BUSY_UNSENT } = await import("../../lib/sharedKeyTerms");
    /* Cancelled between its write and its hold: the real hold then finds it ended, and holds nothing. */
    const raced = await racedForTheLastSlot(kind, `cancelled_${kind}`, async (id, info) => {
      await cancelNow(id);
      return realHeld.holdForPool(id, info);
    });
    const { ws, reply } = raced;
    // The refusal's own status, as before; the take as it stands, never "failed".
    expect(reply.status).toBe(409);
    expect(reply.body).toEqual({ id: expect.any(String), status: "cancelled", error: CANCELLED });
    expect(JSON.stringify(reply.body)).not.toContain(POOL_BUSY_UNSENT);
    const id = String(reply.body.id);
    expect(await take(ws, id)).toMatchObject({ ...kinds[kind], status: "cancelled", error: CANCELLED });
    expect(await metered(id)).toBeUndefined();
    expect(await balance(ws)).toBe(raced.before);
    expect(await line(id)).toBeUndefined();
    expect(raced.dispatched).toEqual([]);
    expect(await live(ws)).toBe(0);
    await raced.done();
  });

/* ── A hold whose place in the line could not be written ───────────── */

test("a held take whose place in the shared line could not be written is said on the server, and the next release pass puts it in the line", async () => {
  pool("1", "1");
  const realPool = await import("../../lib/providerPool");
  const realHeld = await import("../../lib/held");
  /* The database refuses the line's write; the hold's own write goes through. */
  const held = load<typeof import("../../lib/held")>("lib/held.ts", {
    "./providerPool": { ...realPool, queueForPool: async () => { throw new Error("SQLITE_BUSY: database is locked"); } },
  });
  const other = await register("unqueued_other"), ws = await register("unqueued");
  await occupy(other, "unqueued_other_running");
  const id = `unqueued_${RUN}`;
  const { db, ready } = await import("../../lib/db");
  await inside(ws, async () => {
    await ready();
    await db().execute({
      sql: `INSERT INTO generations(id,kind,provider,model,prompt,params,status,created_by,created_at,updated_at,billed_to,task)
            VALUES(?,'image','higgsfield',?,'A bottle on a plinth',?,'running','owner',?,?,'higgsfield','generate')`,
      args: [id, MARKETING, JSON.stringify({ ratio: "3:4", resolution: "2k" }), Date.now(), Date.now()],
    });
  });
  const { value: parked, logged } = await errorsDuring(() => inside(ws, () => held.holdForPool(id, realHeld.heldInfo(0.31, "image", MARKETING, "slots"))));
  // Held all the same, nothing reserved or sent; out of the line for now, and said once, with the take's id.
  expect(parked).toBe(true);
  expect(await take(ws, id)).toMatchObject({ status: "held" });
  expect(await metered(id)).toBeUndefined();
  expect(await line(id)).toBeUndefined();
  expect(logged).toEqual([`held ${id}: not queued in the shared pool's line — SQLITE_BUSY: database is locked; the next release pass re-queues it`]);
  // Its workspace's next release pass (lib/held.ts releaseHeldJobs) puts it in the line; the pool is still full, so nothing starts.
  const sent: string[] = [];
  await inside(ws, () => realHeld.releaseHeldJobs({ defer: async () => { sent.push(id); } }));
  expect(sent).toEqual([]);
  expect(await line(id)).toMatchObject({ admitted_at: null, left_at: null });
  expect(await metered(id)).toBeUndefined();
  await release(other, "unqueued_other_running");
});

/* ── The trained-likeness still's reservation ──────────────────────── */

test("a trained-likeness still cancelled a moment before its reservation is refused stays cancelled, and the reply says so", async () => {
  const realIdentities = await import("../../lib/identities");
  const realRequests = await import("../../lib/generationRequests");
  const identity = { id: "idn_mara", name: "Mara", trigger: "mara_prtcl", loraUrl: "https://example.invalid/lora.safetensors", status: "ready" };
  const deferred: string[] = [];
  const gen = load<Generation>("lib/generationAdmission.ts", {
    "@/lib/identities": { ...realIdentities, identityForCast: async () => identity },
    "@/lib/generationRequests": {
      ...realRequests,
      /* Cancelled a moment before its reservation, which then refuses it (a cap, say). */
      reserveGenerationSpend: async (event: { id: string }) => {
        await cancelNow(event.id);
        throw new realRequests.SpendReservationError("This job exceeds the project's saved spending cap.", 409, true);
      },
    },
  });
  const ws = await register("trained");
  await studio(ws);
  const { db } = await import("../../lib/db");
  await inside(ws, () => db().execute("INSERT INTO cast_members(id,project_id,name,kind,created_at) VALUES('cast_mara',NULL,'Mara','character',0)"));
  const before = await balance(ws);
  const reply = await inside(ws, () => gen.executeGenerationAdmission(
    { model: "gemini-3-pro-image", prompt: "@Mara on a rooftop at dusk", projectId: "project", ratio: "16:9" },
    actor,
    { defer: async () => { deferred.push("render"); } },
  ));
  expect(reply.status).toBe(409);
  expect(reply.body).toEqual({ id: expect.any(String), status: "cancelled", error: CANCELLED });
  const id = String(reply.body.id);
  // The trained renderer's take (lib/identities.ts startIdentityStill), not an ordinary still.
  expect(await take(ws, id)).toMatchObject({ kind: "image", model: "fal-ai/flux-lora", status: "cancelled", error: CANCELLED });
  // Nothing charged, nothing started.
  expect(await balance(ws)).toBe(before);
  expect(deferred).toEqual([]);
  expect(await live(ws)).toBe(0);
});

/* ── A sound or a voice line (lib/audioAdmission.ts) ───────────────── */

type Audio = typeof import("../../lib/audioAdmission");
const voiceLine = { task: "speech", modelId: "grok-tts", voiceId: "eve", text: "The ferry will not wait for anyone tonight." };

/** A voice line sent at its quote, its reservation answering with `refuse` (which may end the take first). */
async function speak(name: string, refuse: (id: string) => Promise<never>, overrides: Record<string, unknown> = {}) {
  const realRequests = await import("../../lib/generationRequests");
  const dispatched: string[] = [];
  const audio = load<Audio>("lib/audioAdmission.ts", {
    "@/lib/inngest": { enqueueRender: async (genId: string) => { dispatched.push(genId); return true; } },
    "@/lib/generationRequests": { ...realRequests, reserveGenerationSpend: async (event: { id: string }) => refuse(event.id) },
    ...overrides,
  });
  const ws = await register(name);
  const before = await balance(ws);
  const { value: reply, logged } = await errorsDuring(() => inside(ws, async () => {
    const quote = await audio.executeAudioAdmission({ ...voiceLine, quoteOnly: true }, actor, { defer: async () => {} });
    expect(quote.status, JSON.stringify(quote.body)).toBe(200);
    return audio.executeAudioAdmission({ ...voiceLine, maxCredits: quote.body.estimatedCredits }, actor, { defer: async () => {} });
  }));
  const { db } = await import("../../lib/db");
  const rows = await inside(ws, async () => (await db().execute("SELECT id,status,error FROM generations")).rows);
  expect(rows).toHaveLength(1);
  return { ws, reply, logged, dispatched, before, id: String(rows[0].id) };
}

test("a voice line cancelled a moment before its reservation refuses it stays cancelled, and the reply says so", async () => {
  const { SpendReservationError } = await import("../../lib/generationRequests");
  const spoken = await speak("voice_refused", async (id) => {
    await cancelNow(id);
    throw new SpendReservationError("This job exceeds the project's saved spending cap.", 409, true);
  });
  expect(spoken.reply.status).toBe(409);
  expect(spoken.reply.body).toEqual({ id: spoken.id, status: "cancelled", error: CANCELLED });
  expect(await take(spoken.ws, spoken.id)).toMatchObject({ status: "cancelled", error: CANCELLED });
  expect(await balance(spoken.ws)).toBe(spoken.before);
  expect(spoken.dispatched).toEqual([]);
});

test("a voice line cancelled a moment before its reservation would hold it is never brought back as held", async () => {
  const { SpendReservationError } = await import("../../lib/generationRequests");
  const spoken = await speak("voice_unheld", async (id) => {
    await cancelNow(id);
    throw new SpendReservationError("Not enough credits for this job.", 402);
  });
  // Never held (it could start, and be charged, later by itself): the refusal's status, and the take as it stands.
  expect(spoken.reply.status).toBe(402);
  expect(spoken.reply.body).toEqual({ id: spoken.id, status: "cancelled", error: CANCELLED });
  expect(await take(spoken.ws, spoken.id)).toMatchObject({ status: "cancelled", error: CANCELLED });
  expect(await live(spoken.ws)).toBe(0);
  expect(await balance(spoken.ws)).toBe(spoken.before);
  expect(spoken.dispatched).toEqual([]);
});

test("a voice line whose hold cannot be written fails unsent, and nothing is left running", async () => {
  const { SpendReservationError } = await import("../../lib/generationRequests");
  const realDb = await import("../../lib/db");
  const said = "Not enough credits for this job.";
  /* The database refuses the hold's write; every other statement goes through. */
  const refusesHolds = () => new Proxy(realDb.db(), {
    get(client, key) {
      const value = Reflect.get(client, key, client);
      if (key !== "execute") return typeof value === "function" ? value.bind(client) : value;
      return (statement: { sql?: string }) => (/SET status='held'/.test(String(statement?.sql))
        ? Promise.reject(new Error("SQLITE_BUSY: database is locked"))
        : client.execute(statement as never));
    },
  });
  const spoken = await speak("voice_hold_throws", async () => { throw new SpendReservationError(said, 402); }, {
    "@/lib/db": { ...realDb, db: refusesHolds },
  });
  // The same reply as a line refused outright: its words and status, unsent, nothing charged.
  expect(spoken.reply.status).toBe(402);
  expect(spoken.reply.body).toEqual({ error: said });
  expect(await take(spoken.ws, spoken.id)).toMatchObject({ status: "failed", error: said });
  expect(await live(spoken.ws)).toBe(0);
  expect(await balance(spoken.ws)).toBe(spoken.before);
  expect(spoken.dispatched).toEqual([]);
  expect(spoken.logged.filter((entry) => entry.includes(spoken.id))).toEqual([`audio ${spoken.id}: not held — SQLITE_BUSY: database is locked`]);
});

/* ── The trained-likeness still's first meter (lib/identities.ts) ───── */

test("a trained-likeness still cancelled a moment before its meter fails stays cancelled", async () => {
  const realMeter = await import("../../lib/meter");
  const identities = load<typeof import("../../lib/identities")>("lib/identities.ts", {
    "./meter": {
      ...realMeter,
      meter: async (event: { id: string; status: string }) => {
        if (event.status !== "running") return realMeter.meter(event as never);
        await cancelNow(event.id);
        throw new Error("The meter could not be reached.");
      },
    },
  });
  const ws = await register("trained_meter");
  await studio(ws);
  const identity = { id: "idn_mara", name: "Mara", trigger: "mara_prtcl", loraUrl: "https://example.invalid/lora.safetensors" } as never;
  await expect(inside(ws, () => identities.startIdentityStill({
    identity, prompt: "@Mara on a rooftop", ratio: "16:9", projectId: "project", shotId: null, version: 1, createdBy: "owner", tokenId: null,
  }))).rejects.toThrow("The meter could not be reached.");
  const { db } = await import("../../lib/db");
  const rows = await inside(ws, async () => (await db().execute("SELECT model,status,error FROM generations")).rows);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ model: "fal-ai/flux-lora", status: "cancelled", error: CANCELLED });
});
