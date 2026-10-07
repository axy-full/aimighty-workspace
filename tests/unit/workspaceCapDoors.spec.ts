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
  const submit = async () => { sent++; return { ok: true, status: 200, text: JSON.stringify({ choices: [{ message: { content: "An idea." } }], usage: { cost: 0.01 } }) }; };
  await scope(name("text-open"), null, async () => {
    const { runPaidText } = await import("../../lib/paidText");
    await runPaidText({ ...request, id: "text_open" }, { model, submit } as never);
    expect((await meterRows()).map((r) => String(r.id))).toEqual(["text_open"]);
    expect(sent).toBe(1);
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

/**
 * meter() writes a running row with no cap of its own, so a job may start only through the reservation. These are
 * the only places a running row is written outside it, each beside a reservation of the same job: an identity's
 * training (after its reservation, only once reserved) and a still with a trained identity (generationAdmission
 * reserves it before the render is deferred). A new one fails here until it is shown to reserve.
 */
test("no paid job starts outside the reservation, where the cap is", () => {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(f.name)) files.push(p);
    }
  };
  walk("lib");
  walk("app");
  const running = /(?<![\w.])meter\((?:(?![;]\s*\n)[\s\S]){0,700}?["']running["']/g;
  const found: string[] = [];
  for (const file of files) {
    if (file === path.join("lib", "meter.ts")) continue;
    const source = readFileSync(file, "utf8");
    for (const m of source.matchAll(running)) found.push(`${file}: ${m[0].replace(/\s+/g, " ").slice(0, 50)}`);
  }
  expect(found.sort()).toEqual([
    'lib/identities.ts: meter({ ...event, status: handle ? "running"',
    'lib/identities.ts: meter({ id: genId, kind: "image", engine: "fal", m',
  ]);
  const identities = readFileSync("lib/identities.ts", "utf8");
  expect(identities).toContain('if (reserved) await meter({ ...event, status: handle ? "running"');
  const admission = readFileSync("lib/generationAdmission.ts", "utf8");
  const still = admission.slice(admission.indexOf("const started = await startIdentityStill("));
  expect(still.indexOf("await reserveGenerationSpend(")).toBeGreaterThan(0);
  expect(still.indexOf("await reserveGenerationSpend(")).toBeLessThan(still.indexOf("runIdentityRender("));
  /* The reservation reads the cap for every job the platform pays for, and compares holds against it. */
  const reservation = readFileSync("lib/generationRequests.ts", "utf8");
  expect(reservation).toContain("const monthlyCap = paid ? allowanceUsd() : null;");
  expect(reservation).toContain("else if (Number(r.created_at) >= since) monthly.set(String(r.id), Math.max(monthly.get(String(r.id)) ?? 0, allowanceUsdOf(r)));");
});
