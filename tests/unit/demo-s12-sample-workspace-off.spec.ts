import { test, expect } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import type { AdmissionActor } from "../../lib/admissionTypes";
import { SAMPLE_LINE, SAMPLE_SETTING_KEY } from "../../lib/demo/sample";
import { PAID_ROUTES } from "../helpers/paidRoutes";

/**
 * The owner's switch (6 Oct): the sample workspace spends nothing. A workspace that holds the sample mark (the
 * "Particl sample" workspace Guest Home reads from) refuses every paid door, whatever project the request names or
 * leaves out: Make's Enhance, Atomik's ideas, a chat turn, a memory read, an identity, a transcription, the board's
 * agent, a Crew round, a render filed under another production or under none. Each answers 409 in the sample's words
 * with nothing charged, and nothing is claimed, reserved, metered or sent first. Another workspace is unchanged: the
 * same request passes the check and is answered by the door as before.
 */
const dir = mkdtempSync(path.join(tmpdir(), "demo-s12-sample-off-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET = "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

const person = (id: string): AdmissionActor["user"] =>
  ({ id, email: `${id}@example.invalid`, name: id, role: "admin", owner: true, disabled: false, createdAt: 0, lastSeen: null });
const OWNER: AdmissionActor = { user: person("owner") };

const nodeRequire = createRequire(path.resolve("package.json"));
function resolveSource(from: string, name: string): string {
  const base = name.startsWith("@/") ? path.resolve(name.slice(2)) : path.resolve(path.dirname(from), name);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), base]) if (existsSync(candidate)) return candidate;
  return base;
}
/** A route module with some of its imports replaced (the session, `after`), everything else real. */
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
const noInline = () => { throw new Error("Nothing may be continued after the response in this test"); };

type Handler = (req: Request, ctx?: unknown) => Promise<Response>;
function door(dirName: string, actor: AdmissionActor = OWNER): Handler {
  const file = `app/api/${dirName}/route.ts`;
  const passthrough = (handler: unknown) => handler;
  const signedIn = async () => actor;
  const crew = nodeRequire(path.resolve("lib/crew/http.ts"));
  const mod = load<{ POST: Handler }>(file, {
    "@/lib/auth": { ...nodeRequire(path.resolve("lib/auth.ts")), withTenant: passthrough, requireRender: signedIn, requireUser: signedIn, requireSession: signedIn },
    "@/lib/crew/http": { ...crew, crewCaller: async () => ({ userId: actor.user.id }) },
    "next/server": { NextResponse: Response, after: noInline },
  });
  return mod.POST;
}

/** One request per paid door: a body each door would accept far enough to spend, with the id its path needs. */
const RUN = "rar_0123456789abcdef01234567";
const DIGEST = "a".repeat(64);
const DOORS: { dir: string; body: Record<string, unknown>; id?: string }[] = [
  { dir: "generate", body: { model: "dreamina-seedance-2-0-260128", prompt: "A tree in rain", ratio: "16:9", resolution: "720p", duration: 5 } },
  { dir: "audio", body: { task: "sound", text: "Soft rain", durationSeconds: 5 } },
  { dir: "audio/dub", body: { sourceUploadId: "up_line", targetLanguage: "es" } },
  { dir: "audio/transcribe", body: { sourceUploadId: "up_line", diarize: true, maxCredits: 100000 } },
  { dir: "jobs/[id]/release", body: { credits: 10 }, id: "gen_held" },
  { dir: "atomik/steps/[id]/claim", body: {}, id: "step_1" },
  { dir: "atomik", body: { model: "auto" } },
  { dir: "atomik/[id]", body: { text: "Plan a short film", maxCredits: 100 }, id: "chat_1" },
  { dir: "atomik/ideas/draft", body: { brief: "car ad at dawn", maxCredits: 100 } },
  { dir: "atomik/shots/draft", body: { projectId: "other", scene: 1, maxCredits: 100 } },
  { dir: "atomik/treatment/scene", body: { projectId: "other", n: 1, maxCredits: 100 } },
  { dir: "atomik/memory/read", body: { text: "Our tone is warm and quiet.", model: "auto", maxCredits: 100 } },
  { dir: "identities/[id]/train", body: { consent: true, maxCredits: 1000 }, id: "id_1" },
  { dir: "identities/[id]/render", body: { prompt: "A portrait", count: 1 }, id: "id_1" },
  { dir: "soul/identities", body: { name: "Lead", maxCredits: 1000 } },
  { dir: "workbench/astra-blender/render", body: { projectId: "other", requestId: "request-astra-1", source: "scene", sourceDigest: DIGEST, maxCredits: 100 } },
  { dir: "workbench/atomik", body: { projectId: "other", requestId: "request-atomik-1", request: "Block the opening shot" } },
  { dir: "workbench/development", body: { projectId: "other", requestId: "request-dev-1", kind: "idea", model: "auto", maxCredits: 100 } },
  { dir: "pipelines/[id]", body: { action: "approve", revision: 1, quoteId: "q1", fingerprint: DIGEST }, id: "pipe_1" },
  { dir: "prompt/enhance", body: { prompt: "a tree in rain", mode: "video", maxCredits: 5 } },
  { dir: "crew/sessions", body: { projectId: "other", goal: "Review the cut" } },
  { dir: "crew/sessions/[id]/rounds", body: { round: 1, maxCredits: 100 }, id: "crew_1" },
  { dir: "workbench/team-canvas", body: { action: "agent.plan", productionId: "other", projectId: "draft-1", requestId: "request-board-1", goal: "Build the plan", limit: 50 } },
];

let n = 0;
const name = (what: string) => `sample-off-${what}-${++n}`.replace(/[^a-z0-9-]/gi, "-");
let providerCalls = 0;

/** A workspace of its own database, marked as the sample or not, with two productions and every network call counted and refused. */
async function scope(ws: string, opts: { sample?: boolean | "hidden"; rawMark?: string }, fn: () => Promise<void>, actor: AdmissionActor = OWNER) {
  const { platformReady, platformDb, rowToWorkspace, grantCredits } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { ready, db } = await import("../../lib/db");
  await platformReady();
  await platformDb().execute({
    sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,1,'owner',0,0,20,200)",
    args: [ws, ws, ws, `file:${path.join(dir, ws + ".db")}`],
  });
  await grantCredits(ws, 10000, "Test", "owner", "manual");
  const row = rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [ws] })).rows[0]);
  const original = globalThis.fetch;
  providerCalls = 0;
  globalThis.fetch = async () => { providerCalls++; throw new Error("Network forbidden in the sample-off test"); };
  try {
    await runInTenant(row, async () => {
      await ready();
      for (const [id, title] of [["film", "Film"], ["other", "Other"]]) await db().execute({ sql: "INSERT INTO projects(id,name,created_at) VALUES(?,?,0)", args: [id, title] });
      await db().execute("INSERT INTO settings(key,value,updated_at) VALUES('promptWriter','none',0) ON CONFLICT(key) DO UPDATE SET value='none'");
      if (opts.sample) {
        const mark = { version: 1, projectId: "film", name: "Film", draftOwner: "owner", draftId: "d1", markedBy: "owner", markedAt: 1, ...(opts.sample === "hidden" ? { hiddenAt: 2 } : {}) };
        await db().execute({ sql: "INSERT INTO settings(key,value,updated_by,updated_at) VALUES(?,?,?,?)", args: [SAMPLE_SETTING_KEY, JSON.stringify(mark), "owner", 1] });
      }
      if (opts.rawMark !== undefined)
        await db().execute({ sql: "INSERT INTO settings(key,value,updated_by,updated_at) VALUES(?,?,?,?)", args: [SAMPLE_SETTING_KEY, opts.rawMark, "owner", 1] });
      await fn();
    }, actor);
  } finally { globalThis.fetch = original; }
}

async function count(table: string): Promise<number> {
  const { db } = await import("../../lib/db");
  try { return Number((await db().execute(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n); }
  catch (error) { if (/no such table/i.test(String(error))) return 0; throw error; }
}
async function meters(): Promise<number> {
  const { platformDb } = await import("../../lib/platform");
  const { requireTenant } = await import("../../lib/tenant");
  return (await platformDb().execute({ sql: "SELECT * FROM meter_events WHERE workspace_id=?", args: [requireTenant().id] })).rows.length;
}
async function reservations(): Promise<number> {
  const { platformDb } = await import("../../lib/platform");
  const { requireTenant } = await import("../../lib/tenant");
  try { return (await platformDb().execute({ sql: "SELECT * FROM generation_reservations WHERE workspace_id=?", args: [requireTenant().id] })).rows.length; }
  catch (error) { if (/no such table/i.test(String(error))) return 0; throw error; }
}
/** Everything a paid door could leave behind: its request claim, a job, a text job, a meter row, a reservation, a call out. */
async function traces() {
  return {
    claims: await count("generation_requests"), generations: await count("generations"), textJobs: await count("paid_text_jobs"),
    chats: await count("atomik_chats"), meters: await meters(), reservations: await reservations(), provider: providerCalls,
  };
}
const NONE = { claims: 0, generations: 0, textJobs: 0, chats: 0, meters: 0, reservations: 0, provider: 0 };

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

test("every paid route the browser can reach is one of the doors this switch covers", () => {
  const covered = new Set(DOORS.map((d) => d.dir));
  expect(PAID_ROUTES.map((r) => r.dir).filter((d) => !covered.has(d))).toEqual([]);
});

for (const entry of DOORS)
  test(`${entry.dir}: the sample workspace refuses it in the sample's words, with nothing claimed, reserved, metered or sent; another workspace is unchanged`, async () => {
    await scope(name(`on-${entry.dir}`), { sample: true }, async () => {
      const refused = await press(entry, `request-${entry.dir}-sample`);
      expect(refused, entry.dir).toEqual({ status: 409, body: { error: SAMPLE_LINE, charged: 0 } });
      expect(await traces(), entry.dir).toEqual(NONE);
    });
    await scope(name(`off-${entry.dir}`), {}, async () => {
      const answered = await press(entry, `request-${entry.dir}-other`);
      /* Past the check: the door answers as it always did (a missing row, an unconnected engine, a quote to review, or the job). */
      const error = String(answered.body.error ?? "");
      expect(error, `${entry.dir} ${answered.status} ${JSON.stringify(answered.body)}`).not.toBe(SAMPLE_LINE);
      expect(error).not.toMatch(/could not be checked/);
    });
  });

test("a request that names no project, another production or the sample's own is refused alike in the sample workspace", async () => {
  await scope(name("projects"), { sample: true }, async () => {
    const enhance = DOORS.find((d) => d.dir === "prompt/enhance")!;
    const generate = DOORS.find((d) => d.dir === "generate")!;
    for (const projectId of [undefined, "film", "other", "not-a-project"]) {
      for (const entry of [enhance, generate]) {
        const out = await press({ ...entry, body: { ...entry.body, ...(projectId ? { projectId } : {}) } }, `request-${entry.dir}-${projectId ?? "unfiled"}`);
        expect(out, `${entry.dir} ${projectId}`).toEqual({ status: 409, body: { error: SAMPLE_LINE, charged: 0 } });
      }
    }
    expect(await traces()).toEqual(NONE);
  });
});

test("a quote still answers in the sample workspace: only the press that spends is refused", async () => {
  await scope(name("quotes"), { sample: true }, async () => {
    for (const dirName of ["prompt/enhance", "atomik/ideas/draft", "audio/transcribe", "crew/sessions"]) {
      const entry = DOORS.find((d) => d.dir === dirName)!;
      const out = await press({ ...entry, body: { ...entry.body, quoteOnly: true } }, `request-quote-${dirName}`);
      expect(out.body.error, `${dirName} ${out.status} ${JSON.stringify(out.body)}`).not.toBe(SAMPLE_LINE);
    }
    /* A quote reads the engine catalogue (free); nothing is claimed, held or metered. */
    expect(await traces()).toMatchObject({ claims: 0, textJobs: 0, meters: 0, reservations: 0 });
  });
});

test("the backstops: paid text and the reservation refuse in the sample workspace with no project, before a job row or a hold", async () => {
  await scope(name("backstop"), { sample: true }, async () => {
    const { runPaidText, PaidTextError } = await import("../../lib/paidText");
    const text = await runPaidText({ model: "openai/gpt-5-mini", messages: [{ role: "user", content: "hi" }], maxTokens: 50, kind: "enhance", mock: "prompt" })
      .then(() => null, (e) => e);
    expect(text).toBeInstanceOf(PaidTextError);
    expect(text).toMatchObject({ status: 409, message: SAMPLE_LINE });
    const { reserveGenerationSpend, SpendReservationError } = await import("../../lib/generationRequests");
    for (const projectId of [null, "other", "film"]) {
      const error = await reserveGenerationSpend({ id: `res-${projectId}`, kind: "text", engine: "vercel", model: "m", status: "running", engineCostUsd: 0.01, createdBy: "owner", projectId })
        .then(() => null, (e) => e);
      expect(error, String(projectId)).toBeInstanceOf(SpendReservationError);
      expect(error).toMatchObject({ status: 409, message: SAMPLE_LINE });
    }
    expect(await traces()).toEqual(NONE);
  });
  /* Another workspace reserves an unfiled job as before. */
  await scope(name("backstop-other"), {}, async () => {
    const { reserveGenerationSpend } = await import("../../lib/generationRequests");
    await reserveGenerationSpend({ id: "res-unfiled", kind: "text", engine: "vercel", model: "m", status: "running", engineCostUsd: 0.01, createdBy: "owner", projectId: null });
    expect(await meters()).toBe(1);
  });
});

test("the switch follows the mark: an undone mark spends as before, and a mark that cannot be read keeps the workspace closed", async () => {
  const enhance = DOORS.find((d) => d.dir === "prompt/enhance")!;
  await scope(name("hidden"), { sample: "hidden" }, async () => {
    const out = await press(enhance, "request-hidden");
    expect(out.body.error).not.toBe(SAMPLE_LINE);
  });
  for (const raw of ["{not json", "[]", JSON.stringify({ version: 2, projectId: "film" })])
    await scope(name("unreadable"), { rawMark: raw }, async () => {
      const out = await press(enhance, "request-unreadable");
      expect(out, raw).toEqual({ status: 409, body: { error: SAMPLE_LINE, charged: 0 } });
      expect(await traces()).toEqual(NONE);
    });
});

test("a workspace whose settings cannot be read spends nothing on that request (fails closed)", async () => {
  const { sampleWorkspaceOff } = await import("../../lib/demo/spend-guard.server");
  await scope(name("broken"), {}, async () => {
    const { db } = await import("../../lib/db");
    await db().execute("ALTER TABLE settings RENAME TO settings_away");
    try {
      const off = await sampleWorkspaceOff();
      expect(off?.status).toBe(503);
      expect(await off?.json()).toMatchObject({ charged: 0 });
    } finally { await db().execute("ALTER TABLE settings_away RENAME TO settings"); }
  });
});
