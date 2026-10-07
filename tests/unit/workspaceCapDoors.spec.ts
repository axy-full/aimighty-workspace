import { test, expect } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import type { AdmissionActor } from "../../lib/admissionTypes";
import { PAID_ROUTES } from "../helpers/paidRoutes";

/**
 * The workspace's monthly engine cap (`workspaces.allowance_usd`, set on /admin by the platform owner only:
 * tests/unit/adminWorkspaceCap.spec.ts) is a ceiling on that one workspace, enforced on the server at the hold.
 *
 * Every paid door ends in the one reservation (lib/generationRequests.ts reserveGenerationSpend), which compares
 * what the workspace's jobs have settled AND what they hold right now (a running job at its estimate, a Cinema
 * Studio take at its 3N hold: tests/unit/demo-13a-cinema-hold-caps.spec.ts) plus the new job against the cap, under
 * the billing write lock. Admission asks the same question earlier (lib/allowance.ts allowanceCheck) so a press is
 * refused before a row is written; the reservation is the wall that counts.
 *
 * Here: every paid route the browser reaches, at an own $0 cap, spends nothing though the balance covers it; the
 * hold counts what is reserved, not only what settled; the ceiling is per workspace and admits exactly one of two
 * holds raced at it; a take parked before the cap fell starts nothing; and no new door can start a job outside the
 * reservation without this file saying so.
 */
/* Every test has its own workspaces, and each worker its own databases: they run side by side. */
test.describe.configure({ mode: "parallel" });
const dir = mkdtempSync(path.join(tmpdir(), "workspace-cap-doors-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET = "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
delete process.env.PLATFORM_ALLOWANCE_USD;

const person = (id: string): AdmissionActor["user"] =>
  ({ id, email: `${id}@example.invalid`, name: id, role: "admin", owner: true, disabled: false, createdAt: 0, lastSeen: null });
const OWNER: AdmissionActor = { user: person("owner") };

/** What a press hears at the cap: admission's early wall, or the reservation's. Neither carries a figure. */
const CAP_REFUSAL = /monthly cap on the platform's engines|monthly spending cap/;

const nodeRequire = createRequire(path.resolve("package.json"));
function resolveSource(from: string, name: string): string {
  const base = name.startsWith("@/") ? path.resolve(name.slice(2)) : path.resolve(path.dirname(from), name);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), base]) if (existsSync(candidate)) return candidate;
  return base;
}
/** A route module with its session and `after` replaced, everything else real. */
function load<T>(file: string, overrides: Record<string, unknown> = {}): T {
  const source = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const target = { exports: {} };
  new Function("require", "module", "exports", source)(
    (name: string) => {
      if (name in overrides) return overrides[name];
      return name.startsWith("@/") || name.startsWith(".") ? nodeRequire(resolveSource(file, name)) : nodeRequire(name);
    },
    target, target.exports,
  );
  return target.exports as T;
}
/* Work continued after the response is dropped: this file only reads what the press itself reserved. */
const dropAfter = () => {};

type Handler = (req: Request, ctx?: unknown) => Promise<Response>;
function door(dirName: string, actor: AdmissionActor = OWNER): Handler {
  const passthrough = (handler: unknown) => handler;
  const signedIn = async () => actor;
  const crew = nodeRequire(path.resolve("lib/crew/http.ts"));
  return load<{ POST: Handler }>(`app/api/${dirName}/route.ts`, {
    "@/lib/auth": { ...nodeRequire(path.resolve("lib/auth.ts")), withTenant: passthrough, requireRender: signedIn, requireUser: signedIn, requireSession: signedIn },
    "@/lib/crew/http": { ...crew, crewCaller: async () => ({ userId: actor.user.id }) },
    "next/server": { NextResponse: Response, after: dropAfter },
  }).POST;
}

/** One request per paid door, a body each would accept far enough to spend (as tests/unit/demo-s12-sample-workspace-off.spec.ts). */
const DIGEST = "a".repeat(64);
const DOORS: { dir: string; body: Record<string, unknown>; id?: string }[] = [
  { dir: "generate", body: { model: "dreamina-seedance-2-0-260128", prompt: "A tree in rain", ratio: "16:9", resolution: "720p", duration: 5, projectId: "film" } },
  { dir: "audio", body: { task: "sound", text: "Soft rain", durationSeconds: 5, projectId: "film" } },
  { dir: "audio/dub", body: { sourceUploadId: "up_line", targetLanguage: "es" } },
  { dir: "audio/transcribe", body: { sourceUploadId: "up_line", diarize: true, maxCredits: 100000 } },
  { dir: "jobs/[id]/release", body: { credits: 10 }, id: "gen_held" },
  { dir: "atomik/steps/[id]/claim", body: {}, id: "step_1" },
  { dir: "atomik", body: { model: "auto" } },
  { dir: "atomik/[id]", body: { text: "Plan a short film", maxCredits: 100 }, id: "chat_1" },
  { dir: "atomik/ideas/draft", body: { brief: "car ad at dawn", maxCredits: 100 } },
  { dir: "atomik/shots/draft", body: { projectId: "film", scene: 1, maxCredits: 100 } },
  { dir: "atomik/treatment/scene", body: { projectId: "film", n: 1, maxCredits: 100 } },
  { dir: "atomik/memory/read", body: { text: "Our tone is warm and quiet.", model: "auto", maxCredits: 100 } },
  { dir: "identities/[id]/train", body: { consent: true, maxCredits: 1000 }, id: "id_1" },
  { dir: "identities/[id]/render", body: { prompt: "A portrait", count: 1 }, id: "id_1" },
  { dir: "soul/identities", body: { name: "Lead", maxCredits: 1000 } },
  { dir: "workbench/astra-blender/render", body: { projectId: "film", requestId: "request-astra-1", source: "scene", sourceDigest: DIGEST, maxCredits: 100 } },
  { dir: "workbench/atomik", body: { projectId: "film", requestId: "request-atomik-1", request: "Block the opening shot" } },
  { dir: "workbench/development", body: { projectId: "film", requestId: "request-dev-1", kind: "idea", model: "auto", maxCredits: 100 } },
  { dir: "pipelines/[id]", body: { action: "approve", revision: 1, quoteId: "q1", fingerprint: DIGEST }, id: "pipe_1" },
  { dir: "prompt/enhance", body: { prompt: "a tree in rain", mode: "video", maxCredits: 5 } },
  { dir: "crew/sessions", body: { projectId: "film", goal: "Review the cut" } },
  { dir: "crew/sessions/[id]/rounds", body: { round: 1, maxCredits: 100 }, id: "crew_1" },
  /* The board's agent: its plan, and the renders a person's plan approval sends (lib/workbench/rig-agent-runs.ts). */
  { dir: "workbench/team-canvas", body: { action: "agent.plan", productionId: "film", projectId: "draft-1", requestId: "request-board-1", goal: "Build the plan", limit: 50 } },
];
/* Doors whose request reaches the hold in this harness with no fixtures beyond two productions (the rest stop
   earlier, at a missing row, an unconnected engine or a text model with no price while the catalogue is offline, and
   are covered by the reservation itself, below: every one of them reserves through it). Listed so
   the harness cannot quietly stop reaching them: each must hold uncapped, and be refused at the cap. */
const REACHES_THE_HOLD = ["generate", "audio"];

let n = 0;
const name = (what: string) => `cap-${what}-${++n}`.replace(/[^a-z0-9-]/gi, "-");
let providerCalls = 0;

/** A workspace of its own database with 10,000 credits, an own cap (null: none) and two productions; every network call refused, and
 *  every one counted but the engine catalogue's free read (`/models`). */
async function scope(ws: string, capUsd: number | null, fn: () => Promise<void>, actor: AdmissionActor = OWNER) {
  const { platformReady, platformDb, rowToWorkspace, grantCredits } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { ready, db } = await import("../../lib/db");
  await platformReady();
  await platformDb().execute({
    sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour,allowance_usd) VALUES(?,?,?,?,1,'owner',0,0,20,200,?)",
    args: [ws, ws, ws, `file:${path.join(dir, ws + ".db")}`, capUsd],
  });
  await grantCredits(ws, 10000, "Test", "owner", "manual");
  const row = rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [ws] })).rows[0]);
  expect(row.allowanceUsd).toBe(capUsd);
  const original = globalThis.fetch;
  providerCalls = 0;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!/\/models(?:[?#]|$)/.test(url)) providerCalls++;
    throw new Error("Network forbidden in the workspace cap test");
  };
  try {
    await runInTenant(row, async () => {
      await ready();
      for (const [id, title] of [["film", "Film"], ["other", "Other"]]) await db().execute({ sql: "INSERT INTO projects(id,name,created_at) VALUES(?,?,0)", args: [id, title] });
      await db().execute("INSERT INTO settings(key,value,updated_at) VALUES('promptWriter','none',0) ON CONFLICT(key) DO UPDATE SET value='none'");
      await fn();
    }, actor);
  } finally { globalThis.fetch = original; }
}

async function meterRows() {
  const { platformDb } = await import("../../lib/platform");
  const { requireTenant } = await import("../../lib/tenant");
  return (await platformDb().execute({ sql: "SELECT id,status,engine_cost_usd,billed_credits FROM meter_events WHERE workspace_id=?", args: [requireTenant().id] })).rows;
}
async function reservations(): Promise<number> {
  const { platformDb } = await import("../../lib/platform");
  const { requireTenant } = await import("../../lib/tenant");
  try { return (await platformDb().execute({ sql: "SELECT * FROM generation_reservations WHERE workspace_id=?", args: [requireTenant().id] })).rows.length; }
  catch (error) { if (/no such table/i.test(String(error))) return 0; throw error; }
}
async function balance(): Promise<number> {
  const { creditState } = await import("../../lib/credits");
  return (await creditState())?.balance ?? NaN;
}
/** What a press could have spent: a hold (a running or billed meter row), a reservation, a call out, a credit. */
async function spent() {
  const rows = await meterRows();
  return {
    holds: rows.filter((r) => r.status === "running" || Number(r.billed_credits ?? 0) > 0).length,
    reservations: await reservations(),
    provider: providerCalls,
    balance: await balance(),
  };
}
const NOTHING = { holds: 0, reservations: 0, provider: 0, balance: 10000 };

async function press(entry: (typeof DOORS)[number], key: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const { requireTenant } = await import("../../lib/tenant");
  const req = new Request(`http://localhost/api/${entry.dir.replace("[id]", entry.id ?? "x")}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key.replace(/[^A-Za-z0-9.:_-]/g, "-"), "X-Workbench-Scope": `particl-active-${requireTenant().id}-owner` },
    body: JSON.stringify(entry.body),
  });
  const res = await door(entry.dir)(req, { params: Promise.resolve({ id: entry.id ?? "x" }) });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 200) }; }
  return { status: res.status, body };
}

test("every paid route the browser can reach is pressed here", () => {
  const covered = new Set(DOORS.map((d) => d.dir));
  expect(PAID_ROUTES.map((r) => r.dir).filter((d) => !covered.has(d))).toEqual([]);
});

for (const entry of DOORS)
  test(`${entry.dir}: at an own $0 cap nothing is held, reserved, sent or charged, though the balance covers it`, async () => {
    let held = false;
    await scope(name(`open-${entry.dir}`), null, async () => {
      await press(entry, `request-${entry.dir}-open`);
      held = (await spent()).holds > 0;
    });
    expect(held, `${entry.dir}: reaches the hold uncapped`).toBe(REACHES_THE_HOLD.includes(entry.dir));
    await scope(name(`wall-${entry.dir}`), 0, async () => {
      const out = await press(entry, `request-${entry.dir}-wall`);
      expect(await spent(), entry.dir).toEqual(NOTHING);
      /* A door that would have held is refused at the cap, in words with no figure in them. */
      if (held) {
        expect(out.status, JSON.stringify(out.body)).toBe(429);
        expect(String(out.body.error)).toMatch(CAP_REFUSAL);
        expect(String(out.body.error)).not.toMatch(/\$|\d/);
      }
    });
  });

test("Make's render, still and sound: the hold counts a job still running at its estimate, and the next press past the cap is refused", async () => {
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  const presses = [
    DOORS.find((d) => d.dir === "generate")!,
    { dir: "generate", body: { model: "gemini-3.1-flash-image", prompt: "raw: A tree", ratio: "16:9", resolution: "1K", projectId: "film" } },
    DOORS.find((d) => d.dir === "audio")!,
  ];
  let k = 0;
  for (const entry of presses)
    await scope(name("running"), 1, async () => {
      /* A job reserved and not settled: $0.99 of the $1 cap, held. */
      await reserveGenerationSpend({ id: `running-${k}`, kind: "text", engine: "vercel", model: "m", status: "running", engineCostUsd: 0.99, createdBy: "owner" });
      const before = await spent();
      expect(before.holds).toBe(1);
      const out = await press(entry, `request-running-${k++}`);
      expect(out.status, JSON.stringify(out.body)).toBe(429);
      expect(String(out.body.error)).toMatch(CAP_REFUSAL);
      expect(await spent()).toEqual(before);
    });
});

test("Atomik's paid text (a planning turn, ideas, Enhance, a memory read): reserved uncapped, refused at an own $0 cap before any call out", async () => {
  /* A priced model handed in, as tests/unit/paidEntryPoints.spec.ts does: the catalogue is offline here. */
  const model = { id: "test/text", name: "Test", owner: "test", type: "language", description: "", contextWindow: 100000, maxTokens: 5000, pricing: { input: "0.000001", output: "0.000002" } } as never;
  const request = { model: "test/text", messages: [{ role: "user", content: "A film idea" }], maxTokens: 600, kind: "enhance" };
  let sent = 0;
  const holdsSeen: number[] = [];
  /* The vendor boundary, counted: what it sees on the meter when it is called. */
  const submit = async () => { sent++; holdsSeen.push((await meterRows()).filter((r) => r.status === "running").length); return { ok: true, status: 200, text: JSON.stringify({ choices: [{ message: { content: "An idea." } }], usage: { cost: 0.01 } }) }; };
  await scope(name("text-open"), null, async () => {
    const { runPaidText } = await import("../../lib/paidText");
    await runPaidText({ ...request, id: "text_open" }, { model, submit } as never);
    expect((await meterRows()).map((r) => String(r.id))).toEqual(["text_open"]);
    expect(sent).toBe(1);
    /* Reserved before it was sent: the call saw its own running hold. */
    expect(holdsSeen).toEqual([1]);
  });
  await scope(name("text-wall"), 0, async () => {
    const { runPaidText } = await import("../../lib/paidText");
    const refused = await runPaidText({ ...request, id: "text_wall" }, { model, submit } as never).then(() => null, (e) => e);
    expect(refused).toMatchObject({ status: 429 });
    expect(String((refused as Error).message)).toMatch(CAP_REFUSAL);
    expect(sent).toBe(1);
    expect(await spent()).toEqual(NOTHING);
  });
});

test("the reservation counts holds, not only settled spend: room comes back when a held job fails at no cost or settles below its hold", async () => {
  const { reserveGenerationSpend, SpendReservationError } = await import("../../lib/generationRequests");
  const { meter } = await import("../../lib/meter");
  await scope(name("holds"), 1, async () => {
    const job = (id: string, usd: number) => ({ id, kind: "text" as const, engine: "vercel", model: "m", status: "running" as const, engineCostUsd: usd, createdBy: "owner" });
    await reserveGenerationSpend(job("a", 0.6));
    /* Nothing has settled; the hold alone leaves $0.40. */
    const refused = await reserveGenerationSpend(job("b", 0.5)).then(() => null, (e) => e);
    expect(refused).toBeInstanceOf(SpendReservationError);
    expect(refused).toMatchObject({ status: 429, message: "This job and the reserved jobs would exceed the workspace's monthly spending cap." });
    await reserveGenerationSpend(job("c", 0.4));
    /* At the cap exactly: nothing more, however small. */
    expect(await reserveGenerationSpend(job("d", 0.01)).then(() => null, (e) => e)).toMatchObject({ status: 429 });
    /* The first fails at no cost: its hold is released and its room returns. */
    await meter({ id: "a", kind: "text", engine: "vercel", model: "m", status: "failed", engineCostUsd: 0 });
    await reserveGenerationSpend(job("b", 0.5));
    /* One settles below its hold: what it settled at counts from now on. */
    await meter({ id: "c", kind: "text", engine: "vercel", model: "m", status: "succeeded", engineCostUsd: 0.1 });
    await reserveGenerationSpend(job("e", 0.4));
    expect(await reserveGenerationSpend(job("f", 0.01)).then(() => null, (e) => e)).toMatchObject({ status: 429 });
    const held = (await meterRows()).filter((r) => r.status === "running").map((r) => String(r.id)).sort();
    expect(held).toEqual(["b", "e"]);
  });
});

test("the cap is the workspace's own: another workspace's spend never counts against it, and of two holds raced at room for one, exactly one is admitted", async () => {
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  const job = (id: string, usd: number) => ({ id, kind: "text" as const, engine: "vercel", model: "m", status: "running" as const, engineCostUsd: usd, createdBy: "owner" });
  /* A workspace with no cap spends past the other's figure. */
  await scope(name("open-neighbour"), null, async () => {
    await reserveGenerationSpend(job("n1", 0.9));
    await reserveGenerationSpend(job("n2", 0.9));
    expect((await meterRows()).length).toBe(2);
  });
  await scope(name("raced"), 1, async () => {
    const outcomes = await Promise.allSettled([reserveGenerationSpend(job("r1", 0.7)), reserveGenerationSpend(job("r2", 0.7))]);
    expect(outcomes.map((o) => o.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ status: 429 });
    expect((await meterRows()).length).toBe(1);
  });
});

test("a cap lowered on /admin while a request is on its way applies to it: the reservation reads the cap inside its own write", async () => {
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  const { platformDb } = await import("../../lib/platform");
  const { requireTenant } = await import("../../lib/tenant");
  /* The request's workspace was read with no cap; the platform owner sets $0 before it reserves. */
  await scope(name("lowered"), null, async () => {
    await platformDb().execute({ sql: "UPDATE workspaces SET allowance_usd=0 WHERE id=?", args: [requireTenant().id] });
    expect(requireTenant().allowanceUsd).toBeNull();
    const refused = await reserveGenerationSpend({ id: "late", kind: "text", engine: "vercel", model: "m", status: "running", engineCostUsd: 0.01, createdBy: "owner" }).then(() => null, (e) => e);
    expect(refused).toMatchObject({ status: 429 });
    expect(await spent()).toEqual(NOTHING);
    /* Lifted again (null: no cap, the deployment sets none), the same job reserves. */
    await platformDb().execute({ sql: "UPDATE workspaces SET allowance_usd=NULL WHERE id=?", args: [requireTenant().id] });
    await reserveGenerationSpend({ id: "late", kind: "text", engine: "vercel", model: "m", status: "running", engineCostUsd: 0.01, createdBy: "owner" });
    expect((await meterRows()).map((r) => String(r.status))).toEqual(["running"]);
  });
});

test("a take parked before the cap fell starts nothing: neither a person's release nor the server's own pass reserves or sends it", async () => {
  const { releaseHeldJobs } = await import("../../lib/held");
  await scope(name("held"), 0, async () => {
    const { db } = await import("../../lib/db");
    await db().execute({
      sql: `INSERT INTO generations(id,kind,provider,model,prompt,params,status,created_by,created_at,updated_at,billed_to,task)
            VALUES('gen_parked','video','byteplus','dreamina-seedance-2-0-260128','test',?,'held','owner',?,?,'byteplus','generate')`,
      args: [JSON.stringify({ ratio: "16:9", resolution: "720p", duration: 5, watermark: false, held: { estUsd: 1, needs: 15, at: 1, why: "slots" } }), Date.now(), Date.now()],
    });
    const own = await releaseHeldJobs({ only: "gen_parked" });
    expect(own.released).toEqual([]);
    expect(own.refused).toMatchObject({ status: 429 });
    expect(String(own.refused?.error)).toMatch(CAP_REFUSAL);
    expect((await releaseHeldJobs()).released).toEqual([]);
    expect(String((await db().execute("SELECT status FROM generations WHERE id='gen_parked'")).rows[0].status)).toBe("held");
    expect(await spent()).toEqual(NOTHING);
  });
});

/* ── The guard: every paid door reserves before its vendor is called ──────────────────────────────────────────────
 * meter() checks no cap: a row it creates (a start, or a job first metered at completion) is charged without one. So
 * the cap holds only if every paid door reserves (reserveGenerationSpend) before it calls a vendor. The browser matrix
 * above cannot show that (most doors stop earlier in its harness), so this reads it from the code, as closed lists:
 *  - RESERVERS: each module that reserves, how many reservations it makes, and its vendor calls. Every vendor call
 *    must come after a reservation, and the count is pinned, so removing or moving one fails here.
 *  - SETTLE_ONLY: a module that meters but never reserves settles rows a RESERVERS module wrote. Any other module
 *    that calls meter() fails: a new one must be shown to reserve first.
 *  - DOOR_MODULE: each paid route the browser reaches names the module that reserves for it, and its imports reach it.
 * Proven at run time for the Crew round and paid text below (the vendor sees a running hold; at $0 it is never called). */
type Reserver = { reserve: string; count: number; vendor: string[]; bound?: string };
const RESERVERS: Record<string, Reserver> = {
  "lib/generationAdmission.ts": { reserve: "await reserveGenerationSpend(", count: 3, vendor: ["runIdentityRender(started.genId", 'enqueueRender(genId, "image")', "runInline(genId)", 'enqueueRender(genId, "video")', "submitVideoRow(genId)"] },
  "lib/audioAdmission.ts": { reserve: "await reserveGenerationSpend(", count: 1, vendor: ['enqueueRender(genId, "audio")', "runInline(genId)"] },
  "lib/dubbing.ts": { reserve: "await reserveGenerationSpend(", count: 1, vendor: ["?? submitDubbing)("] },
  "lib/transcription.ts": { reserve: "?? reserveGenerationSpend)(", count: 1, vendor: ["?? grokTranscribe)("] },
  "lib/held.ts": { reserve: "await reserveGenerationSpend(", count: 1, vendor: ["submitVideoRow(r.id)", "runInline(r.id)"] },
  "lib/paidText.ts": { reserve: "await reserveGenerationSpend(", count: 1, vendor: ["await submit("] },
  "lib/identities.ts": { reserve: "await reserveGenerationSpend(", count: 1, vendor: ["?? falSubmit)("] },
  "app/api/identities/[id]/render/route.ts": { reserve: "await reserveGenerationSpend(", count: 1, vendor: ["await runIdentityRender("] },
  "lib/soulIdentities.ts": { reserve: "await reserveGenerationSpend(", count: 1, vendor: ["?? createSoulReference)("] },
  "lib/astra-blender/render-jobs.ts": { reserve: "?? reserveGenerationSpend)(", count: 1, vendor: ["await renderAstraNative(", "await renderAstraScene("] },
  "lib/workbench/atomik-server.ts": { reserve: "await deps.reserve(", count: 1, vendor: ["await deps.runAstra(", "await deps.runSuite(", "await deps.run("], bound: "reserve: reserveGenerationSpend" },
  "lib/workbench/development-server.ts": { reserve: "await deps.reserve(", count: 1, vendor: ["await deps.call("], bound: "reserve: reserveGenerationSpend" },
  "lib/workbench/rig-agent.ts": { reserve: "await reserveGenerationSpend(", count: 1, vendor: ["?? defaultPlan)("] },
  "lib/crew/round.ts": { reserve: "await reserveGenerationSpend(", count: 1, vendor: ["await askGrok("] },
  /* An Atomik turn is paid text: its reservation is runPaidText's (lib/paidText.ts); the meter() after it re-settles that row. */
  "lib/atomik.ts": { reserve: "await runPaidText(", count: 1, vendor: ["await meter({ id: messageId"] },
};
const SETTLE_ONLY: Record<string, string> = {
  "lib/generationSettlement.ts": "settles a take's row, reserved at admission (generationAdmission, audioAdmission, dubbing, held, the identity render route)",
  "lib/jobs.ts": "syncs a running take's reserved row with its provider's figure",
  "lib/submitVideo.ts": "records a video that failed to submit, at nothing or an unknown cost, on its reserved row",
};
const DOOR_MODULE: Record<string, string> = {
  "generate": "lib/generationAdmission.ts",
  "audio": "lib/audioAdmission.ts",
  "audio/dub": "lib/dubbing.ts",
  "audio/transcribe": "lib/transcription.ts",
  "jobs/[id]/release": "lib/held.ts",
  /* Taking a step claims it; the step's render is paid through admission. */
  "atomik/steps/[id]/claim": "lib/generationAdmission.ts",
  "atomik": "lib/paidText.ts",
  "atomik/[id]": "lib/paidText.ts",
  "atomik/ideas/draft": "lib/paidText.ts",
  "atomik/shots/draft": "lib/paidText.ts",
  "atomik/treatment/scene": "lib/paidText.ts",
  "atomik/memory/read": "lib/paidText.ts",
  "identities/[id]/train": "lib/identities.ts",
  "identities/[id]/render": "app/api/identities/[id]/render/route.ts",
  "soul/identities": "lib/soulIdentities.ts",
  "workbench/astra-blender/render": "lib/astra-blender/render-jobs.ts",
  "workbench/atomik": "lib/workbench/atomik-server.ts",
  "workbench/development": "lib/workbench/development-server.ts",
  "pipelines/[id]": "lib/generationAdmission.ts",
  "prompt/enhance": "lib/paidText.ts",
  "crew/sessions": "lib/crew/round.ts",
  "crew/sessions/[id]/rounds": "lib/crew/round.ts",
};

function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(f.name)) files.push(p.split(path.sep).join("/"));
    }
  };
  for (const d of ["lib", "app", "components"]) walk(d);
  return files;
}
/** The source without comment lines, so a sentence about meter() is not a call. */
const code = (file: string) => readFileSync(file, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const occurrences = (text: string, needle: string) => { const at: number[] = []; for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) at.push(i); return at; };
const METER_CALL = /(?<![\w.])(?:meter|deps\.meter|\(deps\.meter \?\? meter\))\(\s*(?=[{a-zA-Z.(])/;
const RESERVE_CALL = /(?<![\w.])reserveGenerationSpend\(|\?\? reserveGenerationSpend\)\(|reserve: reserveGenerationSpend\b/;

/** What a module's imports reach (static and dynamic), within the repository. */
function reach(file: string): Set<string> {
  const seen = new Set<string>();
  const stack = [file];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const m of readFileSync(f, "utf8").matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g)) {
      const spec = m[1];
      if (!spec.startsWith("@/") && !spec.startsWith(".")) continue;
      const resolved = resolveSource(f, spec);
      const rel = path.relative(process.cwd(), resolved).split(path.sep).join("/");
      if (/\.tsx?$/.test(rel) && existsSync(rel)) stack.push(rel);
    }
  }
  return seen;
}

test("every module that reserves does so before each of its vendor calls, at a pinned count", () => {
  for (const [file, r] of Object.entries(RESERVERS)) {
    const text = code(file);
    const reserves = occurrences(text, r.reserve);
    expect(reserves.length, `${file}: reservations (${r.reserve})`).toBe(r.count);
    for (const v of r.vendor) {
      const calls = occurrences(text, v);
      expect(calls.length, `${file}: ${v} is still called`).toBeGreaterThan(0);
      for (const at of calls) expect(reserves.some((x) => x < at), `${file}: ${v} comes after a reservation`).toBe(true);
    }
    /* A module that takes its reservation as a dependency is bound to the real one by default. */
    if (r.bound) expect(text, `${file}: ${r.bound}`).toContain(r.bound);
  }
});

test("no module meters a charge or reserves outside the closed lists: a new one is shown to reserve first", () => {
  const metering: string[] = [];
  const reserving: string[] = [];
  for (const file of sourceFiles()) {
    if (file === "lib/meter.ts" || file === "lib/generationRequests.ts") continue;
    const text = code(file);
    if (METER_CALL.test(text)) metering.push(file);
    if (RESERVE_CALL.test(text)) reserving.push(file);
  }
  const known = new Set([...Object.keys(RESERVERS), ...Object.keys(SETTLE_ONLY)]);
  expect(metering.filter((f) => !known.has(f)), "meters without a listed reservation").toEqual([]);
  expect(reserving.filter((f) => !(f in RESERVERS)).sort(), "reserves but is not listed").toEqual([]);
  /* A settle-only module that starts reserving belongs in RESERVERS, with its vendor calls. */
  for (const f of Object.keys(SETTLE_ONLY)) expect(RESERVE_CALL.test(code(f)), f).toBe(false);
  /* The reservation itself still reads the cap for every platform-paid job and counts running holds. */
  const reservation = readFileSync("lib/generationRequests.ts", "utf8");
  expect(reservation).toContain("const capNow = !paid ? null : standing.rows[0] ? allowanceUsdOfStored(standing.rows[0].allowance_usd) : monthlyCap;");
  expect(reservation).toContain("monthly.set(String(r.id), Math.max(monthly.get(String(r.id)) ?? 0, allowanceUsdOf(r)));");
});

test("every paid route names the module that reserves for it, and its imports reach that module", () => {
  expect(PAID_ROUTES.map((r) => r.dir).filter((d) => !(d in DOOR_MODULE))).toEqual([]);
  for (const [dirName, module] of Object.entries(DOOR_MODULE)) {
    expect(module in RESERVERS, `${dirName}: ${module} reserves`).toBe(true);
    expect(reach(`app/api/${dirName}/route.ts`).has(module), `${dirName} reaches ${module}`).toBe(true);
  }
});

/** A Crew room of its own, in a workspace with `capUsd` (null: none) and 10,000 credits, its owner a member. */
async function crewRoom(capUsd: number | null) {
  const { platformReady, platformDb, getWorkspace, grantCredits } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { createSession, claimRound, listMembers } = await import("../../lib/crew/store");
  const { DEFAULT_CONTEXT } = await import("../../lib/crew/room");
  await platformReady();
  const id = name("crew"), owner = `owner_${id}`;
  await platformDb().batch([
    { sql: "INSERT INTO accounts(id,email,name,password_hash,created_at) VALUES(?,?,?,'unused',0)", args: [owner, `${owner}@example.test`, "Crew"] },
    { sql: "INSERT INTO workspaces(id,slug,name,db_url,owner_id,created_at,updated_at,uses_platform_keys,allowance_usd) VALUES(?,?,?,?,?,0,0,1,?)", args: [id, id, id, `file:${path.join(dir, id + ".db")}`, owner, capUsd] },
    { sql: "INSERT INTO memberships(workspace_id,account_id,role,created_at) VALUES(?,?,'owner',0)", args: [id, owner] },
  ], "write");
  await grantCredits(id, 10000, "Test", null, "manual");
  const workspace = (await getWorkspace(id))!;
  expect(workspace.allowanceUsd).toBe(capUsd);
  const session = await runInTenant(workspace as never, async () => {
    await listMembers(owner, "crew-project");
    const made = await createSession(owner, { projectId: "crew-project", goal: "Find the ending", context: DEFAULT_CONTEXT, model: "grok-4.6" });
    expect(await claimRound(owner, made.id, 1)).toBe(true);
    return made;
  });
  return { workspace, owner, session };
}

test("a Crew round reserves before it asks the engine: the engine sees the round's running hold, and at an own $0 cap it is never asked", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { listMembers } = await import("../../lib/crew/store");
  const { newProject } = await import("../../lib/workbench/studio");
  const { SpendReservationError } = await import("../../lib/generationRequests");
  const xai = nodeRequire(path.resolve("lib/crew/xai.ts"));
  let asked = 0;
  const holdsSeen: number[] = [];
  /* The engine boundary (lib/crew/xai.ts askGrok), counted: what it sees on the meter when it is asked. */
  const askGrok = async (input: { phase: string }) => {
    asked++;
    holdsSeen.push((await meterRows()).filter((r) => r.status === "running").length);
    return { ok: true, text: input.phase === "converge" ? "1. Opening — Hold the wide shot.\n2. Detail — Show the bottle.\n3. Close — End on a glance." : "Start wide.", promptTokens: 10, completionTokens: 20, providerCostUsd: 0.001 };
  };
  const { runRound, quoteRound } = load<typeof import("../../lib/crew/round")>("lib/crew/round.ts", { "./xai": { ...xai, askGrok } });
  const rate = { inputUsdPerToken: 0.000001, outputUsdPerToken: 0.000003 };
  for (const capUsd of [null, 0]) {
    const { workspace, owner, session } = await crewRoom(capUsd);
    asked = 0; holdsSeen.length = 0; providerCalls = 0;
    await runInTenant(workspace as never, async () => {
      const active = (await listMembers(owner, session.projectId)).slice(0, 1).map((m) => ({ ...m, isChair: true }));
      const project = newProject("A project");
      const quote = quoteRound({ session, project, active, rate, transcriptChars: 0 });
      const run = () => runRound({ session, project, active, rate, ceilingUsd: quote.ceilingUsd, userId: owner, emit: () => {} });
      if (capUsd == null) {
        const out = await run();
        expect(out.billed).toBe(true);
        expect(asked).toBeGreaterThan(0);
        expect(holdsSeen.every((n) => n === 1), JSON.stringify(holdsSeen)).toBe(true);
      } else {
        const refused = await run().then(() => null, (e) => e);
        expect(refused).toBeInstanceOf(SpendReservationError);
        expect(refused).toMatchObject({ status: 429 });
        expect(String((refused as Error).message)).toMatch(CAP_REFUSAL);
        expect(asked).toBe(0);
        expect(await spent()).toEqual(NOTHING);
      }
    }, { user: person(owner) } as never);
  }
});
