import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import type { AdmissionActor, AdmissionReply, PreparedAdmission } from "../../lib/admissionTypes";
import type { TenantUser, TenantWorkspace } from "../../lib/tenant";
import type { RunSpend } from "../../lib/runLimit";
import { newProject, type CanvasNode, type Project } from "../../lib/workbench/studio";
import type { BoardSnapshot } from "../../lib/workbench/rig-agent-plan";
import { mockPlannerModel, runPlanner, MOCK_PLANNER_CATALOG, MOCK_PLANNER_MODEL } from "../../lib/workbench/rig-agent-planner";
import { LIFT_LINE, SAMPLE_LINE, SAMPLE_SETTING_KEY } from "../../lib/demo/sample";

/*
 * The one-run lift (owner, 7 Oct; lib/demo/lift.server.ts): "a sample mark stops ALL spending in its workspace. I
 * (admin only) can lift it for one approved run, and it comes back on automatically afterwards. Guests can never lift
 * it." Only an owner or admin, a signed-in person, lifts it; Atomik, a token, an MCP caller, a member or a guest never.
 * While it is lifted only the lifter's next ask of Atomik, and then that one run, pass the guard; everything else in
 * the workspace still answers 409 in the sample's words. The run's end, the lift's expiry or a person putting it back
 * closes it, a second run needs a new lift, and another workspace is untouched. The harness is the plan approval
 * spec's: the scripted mock planner and a stand-in for admission that makes the real reservation. Nothing reaches a
 * provider (ENGINE_MOCK=1, and every network call is refused).
 */

const dir = mkdtempSync(path.join(tmpdir(), "particl-sample-lift-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
delete process.env.LIVEBLOCKS_SECRET_KEY;

const OWNER = "ana", ADMIN = "bo", MEMBER = "cy";
const userOf = (id: string, extra: Partial<TenantUser> = {}): TenantUser => ({
  id, email: `${id}@example.invalid`, name: id, role: id === MEMBER ? "member" : "admin", owner: id === OWNER, disabled: false, createdAt: 0, lastSeen: null, ...extra,
});
const actorOf = (id: string): AdmissionActor => ({ user: userOf(id) });
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
let requests = 0;
const rid = () => `req-lift-${String(++requests).padStart(6, "0")}`;

/* ── A workspace, marked as the sample or not, with a production and its board ── */

async function workspace(name: string): Promise<TenantWorkspace> {
  const { platformReady, platformDb, rowToWorkspace, grantCredits } = await import("../../lib/platform");
  await platformReady();
  await platformDb().execute({
    sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,1,?,0,0,20,500)",
    args: [name, name, name, `file:${path.join(dir, name + ".db")}`, OWNER],
  });
  await grantCredits(name, 2000, "Test", OWNER, "manual");
  return rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [name] })).rows[0]);
}

const scene = (id: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({ id, title: id, type: "scene", x: 0, y: 0, width: 344, linked: [], mode: "Video", ...extra });

async function seed(sample: boolean) {
  const { db, ready } = await import("../../lib/db");
  const { patchTeamCanvas } = await import("../../lib/workbench/team-canvas");
  const project: Project = { ...newProject("Dunes"), id: "draft-1", productionProjectId: "prod-1" };
  await ready();
  await db().execute("INSERT INTO projects(id,name,created_at) VALUES('prod-1','Dunes',0)");
  for (const who of [OWNER, ADMIN])
    await db().execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,0)", args: [`${who}:draft-1`, who, "draft-1", "Dunes", JSON.stringify(project)] });
  await patchTeamCanvas("prod-1", { upsertNodes: [scene("theirs", { x: 100, y: 100, title: "Ana's shot" })], removeNodes: [], upsertAssets: [], order: ["theirs"] }, OWNER);
  if (sample) {
    const mark = { version: 1, projectId: "prod-1", name: "Dunes", draftOwner: OWNER, draftId: "draft-1", markedBy: OWNER, markedAt: 1 };
    await db().execute({ sql: "INSERT INTO settings(key,value,updated_by,updated_at) VALUES(?,?,?,?)", args: [SAMPLE_SETTING_KEY, JSON.stringify(mark), OWNER, 1] });
  }
}

/** Runs `fn` in a fresh workspace (the sample workspace unless `sample: false`), as `as` when given; the network is refused. */
async function inWorkspace<T>(name: string, fn: (ws: TenantWorkspace) => Promise<T>, opts: { sample?: boolean } = {}): Promise<T> {
  const { runInTenant } = await import("../../lib/tenant");
  const ws = await workspace(name);
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Network forbidden in the sample lift test"); };
  try { return await runInTenant(ws, async () => { await seed(opts.sample ?? true); return fn(ws); }); }
  finally { globalThis.fetch = original; }
}

/* ── A stand-in for admission: the real reservation, with the run's id ── */

function renders(ws: TenantWorkspace) {
  const calls: { run: RunSpend | undefined; status: number; error: string | null }[] = [];
  const prepare = async (body: Record<string, unknown>, actor: AdmissionActor) => {
    const { billCredits } = await import("../../lib/creditTerms");
    const usd = 0.3, credits = billCredits(usd, "mock");
    const compiled = { model: { provider: "byteplus" }, estUsd: usd, prompt: String(body.prompt ?? ""), draft: body.draft === true, resolution: body.resolution };
    const quote = { estimatedCredits: credits, price: credits, unit: "cr" as const };
    return { ok: true as const, value: { version: 1 as const, kind: "video" as const, workspaceId: ws.id, actorId: actor.user.id, request: { ...body, maxCredits: credits }, compiled, quote: { ...quote, fingerprint: sha({ compiled, quote }) } } satisfies PreparedAdmission };
  };
  const admit = async (prepared: PreparedAdmission, actor: AdmissionActor, options: { requestKey: string; run?: RunSpend }): Promise<AdmissionReply> => {
    const { db, id, now } = await import("../../lib/db");
    const { withGenerationRequestData, bindGenerationRequestStatement, reserveGenerationSpend, SpendReservationError } = await import("../../lib/generationRequests");
    const { preparedClaimFingerprint } = await import("../../lib/admissionSupport");
    const response = await withGenerationRequestData({ userId: actor.user.id, key: options.requestKey, fingerprint: preparedClaimFingerprint(prepared) }, async (claim) => {
      const genId = id("gen");
      await db().batch([
        { sql: "INSERT INTO generations(id,project_id,kind,model,prompt,params,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)", args: [genId, "prod-1", "video", "mock", String(prepared.request.prompt ?? ""), "{}", "queued", actor.user.id, now(), now()] },
        bindGenerationRequestStatement(claim, genId),
      ], "write");
      try {
        await reserveGenerationSpend({ id: genId, kind: "video", engine: "byteplus", model: "mock", status: "running", engineCostUsd: 0.3, projectId: "prod-1", createdBy: actor.user.id }, { run: options.run });
      } catch (error) {
        await db().execute({ sql: "UPDATE generations SET status='failed', error=?, updated_at=? WHERE id=?", args: [(error as Error).message, now(), genId] });
        return Response.json({ id: genId, status: "failed", error: (error as Error).message }, { status: error instanceof SpendReservationError ? error.status : 503 });
      }
      return Response.json({ id: genId, status: "queued" }, { status: 202 });
    }, { atomicBinding: true });
    const body = await response.json();
    calls.push({ run: options.run, status: response.status, error: typeof body.error === "string" ? body.error : null });
    return { status: response.status, body, headers: Object.fromEntries(response.headers) };
  };
  return { prepare, admit, calls };
}

async function depsFor(ws: TenantWorkspace, r: ReturnType<typeof renders>) {
  const { runInTenant } = await import("../../lib/tenant");
  return {
    access: async () => null, paceMs: 0,
    plan: async (snapshot: BoardSnapshot) => ({ ...(await runPlanner(snapshot, mockPlannerModel(snapshot))), model: MOCK_PLANNER_MODEL }),
    pricing: async () => ({ id: MOCK_PLANNER_MODEL, catalog: MOCK_PLANNER_CATALOG, direct: false }),
    asOwner: <T,>(owner: string, work: (actor: AdmissionActor) => Promise<T>) => runInTenant(ws, () => work(actorOf(owner)), { user: userOf(owner) }),
    prepare: r.prepare, admit: r.admit, defer: async () => {}, follow: async () => {},
  };
}

async function settleTake(jobId: string) {
  const { writeGenerationOutcome, deliverGenerationSettlement } = await import("../../lib/generationSettlement");
  await writeGenerationOutcome({ sql: "UPDATE generations SET status=?,cost_usd=?,updated_at=? WHERE id=?", args: ["succeeded", 0.3, Date.now(), jobId] },
    { id: jobId, kind: "video", engine: "byteplus", model: "mock", status: "succeeded", engineCostUsd: 0.3 });
  await deliverGenerationSettlement(jobId);
}

const ask = async (userId = OWNER, requestId = rid()) => (await import("../../lib/workbench/rig-agent")).askRigAgent({ productionId: "prod-1", draftId: "draft-1", userId, requestId, goal: "The dunes at dawn, two shots.", limit: 500 });
const refusal = async (scope: Parameters<typeof import("../../lib/demo/spend-guard.server").sampleWorkspaceRefusal>[0] = {}) =>
  (await import("../../lib/demo/spend-guard.server")).sampleWorkspaceRefusal(scope);
let jobs = 0;
/** A paid job reserved straight at the backstop, as part of `runId` or of no run. */
async function reserve(runId: string | null): Promise<number | "ok"> {
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  return reserveGenerationSpend({ id: `job-${++jobs}`, kind: "text", engine: "vercel", model: "m", status: "running", engineCostUsd: 0.01, createdBy: OWNER, projectId: "prod-1" },
    runId ? { run: { id: runId, limitCredits: 500, band: 1 } } : {}).then(() => "ok" as const, (e: { status?: number; message?: string }) => {
    expect(e.message).toBe(SAMPLE_LINE);
    return e.status ?? 0;
  });
}
const lifts = async () => (await (await import("../../lib/db")).db().execute("SELECT * FROM sample_lifts ORDER BY rowid").catch(() => ({ rows: [] }))).rows;

/* ── A route with its session and `after` replaced, the rest real ─────── */

const nodeRequire = createRequire(path.resolve("package.json"));
function resolveSource(from: string, name: string): string {
  const base = name.startsWith("@/") ? path.resolve(name.slice(2)) : path.resolve(path.dirname(from), name);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), base]) if (existsSync(candidate)) return candidate;
  return base;
}
function load<T>(file: string, overrides: Record<string, unknown> = {}): T {
  const source = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const target = { exports: {} };
  new Function("require", "module", "exports", source)(
    (name: string) => (name in overrides ? overrides[name] : name.startsWith("@/") || name.startsWith(".") ? nodeRequire(resolveSource(file, name)) : nodeRequire(name)),
    target, target.exports,
  );
  return target.exports as T;
}
type Handler = (req: Request, ctx?: unknown) => Promise<Response>;
/** A route as the browser reaches it, the session read from the tenant store as it really is (a token is refused). */
function route(dirName: string): { GET?: Handler; POST: Handler } {
  return load(`app/api/${dirName}/route.ts`, {
    "@/lib/auth": { ...nodeRequire(path.resolve("lib/auth.ts")), withTenant: (handler: unknown) => handler },
    "next/server": { NextResponse: Response, after: () => { throw new Error("Nothing may be continued after the response in this test"); } },
  });
}
async function as<T>(ws: TenantWorkspace, user: TenantUser | null, fn: () => Promise<T>, token = false): Promise<T> {
  const { runInTenant } = await import("../../lib/tenant");
  return runInTenant(ws, fn, { user, ...(token ? { token: { id: "tok_1", name: "CI", scope: "render" as const, capUsd: null } } : {}) });
}
async function call(ws: TenantWorkspace, dirName: string, method: "GET" | "POST", body: unknown, user: string | null): Promise<{ status: number; body: Record<string, unknown> }> {
  const handler = route(dirName)[method]!;
  const req = new Request(`http://localhost/api/${dirName}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Workbench-Scope": `particl-active-${ws.id}-${user ?? "nobody"}` },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
  const res = await handler(req);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/* ── Who may lift it ──────────────────────────────────────────────────── */

test("only an owner or an admin, a signed-in person, lifts the mark: never a member, Atomik, an MCP caller, a token or a guest", async () => {
  await inWorkspace("who", async (ws) => {
    const mark = await import("../../lib/demo/mark.server");
    for (const user of [userOf(MEMBER), userOf("agent:rar_1"), userOf("mcp:client"), userOf("token:pk_1"), userOf("auto"), userOf(ADMIN, { disabled: true })])
      await expect(mark.liftSampleMark(user), user.id).rejects.toMatchObject({ status: 403 });
    /* Through the route: a token is refused by the session check, a signed-out visitor (a guest) is not signed in, a member is refused. */
    expect(await as(ws, userOf(ADMIN), () => call(ws, "demo/sample/lift", "POST", { action: "lift" }, ADMIN), true)).toMatchObject({ status: 403 });
    expect(await as(ws, null, () => call(ws, "demo/sample/lift", "POST", { action: "lift" }, null))).toMatchObject({ status: 401 });
    expect(await as(ws, null, () => call(ws, "demo/sample/lift", "GET", null, null))).toMatchObject({ status: 401 });
    expect(await as(ws, userOf(MEMBER), () => call(ws, "demo/sample/lift", "POST", { action: "lift" }, MEMBER))).toMatchObject({ status: 403 });
    expect(await lifts()).toEqual([]);
    /* The table itself refuses a machine as the lifter. */
    const { db } = await import("../../lib/db");
    const { sampleLiftReady } = await import("../../lib/demo/lift.server");
    await sampleLiftReady();
    for (const machine of ["agent:rar_1", "MCP:x", "token:x", "auto", ""])
      await expect(db().execute({ sql: "INSERT INTO sample_lifts(id,workspace_id,lifted_by,lifted_at,expires_at) VALUES(?,?,?,?,?)", args: [`x-${machine}`, ws.id, machine, 1, 2] }), machine).rejects.toThrow();
    /* An admin lifts it through the route; the owner can too, once it is back. One lift at a time. */
    expect(await as(ws, userOf(ADMIN), () => call(ws, "demo/sample/lift", "POST", { action: "lift" }, ADMIN))).toMatchObject({ status: 200, body: { lifted: { runId: null } } });
    await expect(mark.liftSampleMark(userOf(OWNER))).rejects.toMatchObject({ status: 409, message: "The mark is already lifted for one run." });
    expect(await as(ws, userOf(MEMBER), () => call(ws, "demo/sample/lift", "POST", { action: "putBack" }, MEMBER))).toMatchObject({ status: 403 });
    expect(await mark.putSampleMarkBack(userOf(ADMIN))).toBe(true);
    expect((await mark.liftSampleMark(userOf(OWNER))).liftedBy).toBe(OWNER);
    /* What a member's board reads: lifted, not theirs, and no record. An admin reads who, when and which run. */
    const member = await as(ws, userOf(MEMBER), () => call(ws, "demo/sample/lift", "GET", null, MEMBER));
    expect(member).toEqual({ status: 200, body: { marked: true, status: { lifted: true, mine: false, productionId: null, runId: null, expiresAt: expect.any(Number) } } });
    const admin = await as(ws, userOf(ADMIN), () => call(ws, "demo/sample/lift", "GET", null, ADMIN));
    expect(admin.body).toMatchObject({ marked: true, canLift: false, status: { lifted: true, mine: false } });
    expect((admin.body.record as { why: string | null; backAt: number | null }[]).map((r) => [r.why, r.backAt != null])).toEqual([[null, false], ["put_back", true]]);
  });
  /* A workspace with no mark has nothing to lift. */
  await inWorkspace("who-unmarked", async () => {
    const mark = await import("../../lib/demo/mark.server");
    await expect(mark.liftSampleMark(userOf(OWNER))).rejects.toMatchObject({ status: 409 });
  }, { sample: false });
});

/* ── While it is lifted ───────────────────────────────────────────────── */

test("lifted: only the lifter's next ask and then that one run pass; every other request in the workspace still answers 409, and the run's end puts the mark back", async () => {
  await inWorkspace("one-run", async (ws) => {
    const mark = await import("../../lib/demo/mark.server");
    const agent = await import("../../lib/workbench/rig-agent");
    /* Before the lift, the lifter's own ask is refused like everything else. */
    await expect(ask()).rejects.toMatchObject({ status: 409, message: SAMPLE_LINE });
    await mark.liftSampleMark(userOf(OWNER));
    /* Lifted and waiting for its run: a request with no run, another person's ask, and a made-up run still refuse. */
    expect(await refusal()).toBe(SAMPLE_LINE);
    expect(await reserve(null)).toBe(409);
    expect(await reserve("rar_made_up")).toBe(409);
    expect(await refusal({ ask: { userId: ADMIN, requestId: "r" } })).toBe(SAMPLE_LINE);
    await expect(ask(ADMIN)).rejects.toMatchObject({ status: 409, message: SAMPLE_LINE });
    /* Every other paid door answers as before. */
    const generate = await as(ws, userOf(OWNER), () => call(ws, "generate", "POST", { model: "dreamina-seedance-2-0-260128", prompt: "Dunes", ratio: "16:9", resolution: "720p", duration: 5 }, OWNER));
    expect(generate).toEqual({ status: 409, body: { error: SAMPLE_LINE, charged: 0 } });
    /* The lifter's ask makes the one run, bound to the lift in the same write. */
    const requestId = rid();
    const asked = await ask(OWNER, requestId);
    expect((await lifts()).map((l) => [l.lifted_by, l.run_id, l.production_id])).toEqual([[OWNER, asked.id, "prod-1"]]);
    /* Its lost reply asked again answers the same run; a new ask is a second run, and needs a new lift. */
    expect((await ask(OWNER, requestId)).id).toBe(asked.id);
    expect(await refusal({ ask: { userId: OWNER, requestId: rid() } })).toBe(SAMPLE_LINE);
    /* Only that run passes: at the backstop, and on the board for the person who lifted it. */
    expect(await reserve(asked.id)).toBe("ok");
    expect(await reserve("rar_other")).toBe(409);
    expect(await reserve(null)).toBe(409);
    expect(await refusal({ runId: asked.id, userId: OWNER })).toBeNull();
    expect(await refusal({ runId: asked.id, userId: ADMIN })).toBe(SAMPLE_LINE);
    const board = (body: Record<string, unknown>) => as(ws, userOf(OWNER), () => call(ws, "workbench/team-canvas", "POST", { productionId: "prod-1", ...body }, OWNER));
    expect(await board({ action: "agent.approvePlan", runId: "rar_" + "0".repeat(24), fingerprint: "a".repeat(64) })).toEqual({ status: 409, body: { error: SAMPLE_LINE, charged: 0 } });
    expect((await board({ action: "agent.approvePlan", runId: asked.id, fingerprint: "a".repeat(64) })).body.error).not.toBe(SAMPLE_LINE);
    expect(await board({ action: "agent.plan", projectId: "draft-1", requestId: rid(), goal: "Another board", limit: 50 })).toEqual({ status: 409, body: { error: SAMPLE_LINE, charged: 0 } });

    /* The run itself: planned (its planning charge reserved under the run), built, approved once, rendered, settled. */
    const r = renders(ws);
    const deps = await depsFor(ws, r);
    expect(await agent.advanceRigAgentRun(asked.id, deps)).toEqual({ state: "awaiting_approval", more: false });
    const proposal = (await agent.rigAgentState("prod-1", OWNER)).run!.proposal!.fingerprint;
    await agent.approveRigAgent({ productionId: "prod-1", runId: asked.id, fingerprint: proposal, userId: OWNER });
    expect(await agent.advanceRigAgentRun(asked.id, deps)).toEqual({ state: "needs_you", more: false });
    const gate = (await agent.rigAgentState("prod-1", OWNER)).run!.plan!.quote!.fingerprint;
    await agent.approveRigAgentPlan({ productionId: "prod-1", runId: asked.id, fingerprint: gate, userId: OWNER });
    const { db } = await import("../../lib/db");
    for (let i = 0; i < 4; i++) {
      const tick = await agent.advanceRigAgentRun(asked.id, deps);
      if (tick.state === "done") break;
      const live = (await db().execute("SELECT id FROM generations WHERE status='queued' ORDER BY created_at")).rows;
      for (const row of live) await settleTake(String(row.id));
    }
    expect(r.calls.length).toBeGreaterThan(0);
    expect(r.calls.every((c) => c.status === 202 && c.run?.id === asked.id)).toBe(true);
    expect((await agent.rigAgentState("prod-1", OWNER)).run!.state).toBe("done");
    /* The run finished: the mark is fully back on, and the record says when and why. */
    expect(await reserve(asked.id)).toBe(409);
    expect(await refusal({ runId: asked.id, userId: OWNER })).toBe(SAMPLE_LINE);
    const [ended] = await lifts();
    expect(ended).toMatchObject({ run_id: asked.id, ended_reason: "finished" });
    expect(Number(ended.ended_at)).toBeGreaterThanOrEqual(Number(ended.lifted_at));
    /* A fix on the finished run is refused: the lift was for the run as approved, and it has ended. */
    expect(await board({ action: "agent.fix", runId: asked.id, seq: 1 })).toEqual({ status: 409, body: { error: SAMPLE_LINE, charged: 0 } });
    /* A second run needs a new lift. */
    await expect(ask()).rejects.toMatchObject({ status: 409, message: SAMPLE_LINE });
    await mark.liftSampleMark(userOf(OWNER));
    const second = await ask();
    expect(second.id).not.toBe(asked.id);
    expect(await reserve(second.id)).toBe("ok");
    expect(await reserve(asked.id)).toBe(409);
    /* The board's read: lifted, the lifter's, on the run's production. */
    expect(await mark.sampleLiftStatus(OWNER)).toMatchObject({ lifted: true, mine: true, runId: second.id, productionId: "prod-1" });
    expect(await mark.sampleLiftStatus(ADMIN)).toMatchObject({ lifted: true, mine: false });
  });
});

/* ── It comes back by itself ──────────────────────────────────────────── */

test("it comes back on by itself: a stopped, failed or undone run, its expiry mid-run (a crash leaves nothing lifted), put back by hand, or the mark undone", async () => {
  await inWorkspace("back-on", async () => {
    const mark = await import("../../lib/demo/mark.server");
    const agent = await import("../../lib/workbench/rig-agent");
    const { db } = await import("../../lib/db");
    const reasons: string[] = [];
    const lastReason = async () => String((await lifts()).at(-1)!.ended_reason);

    /* Stopped. */
    await mark.liftSampleMark(userOf(OWNER));
    const stopped = await ask();
    expect(await reserve(stopped.id)).toBe("ok");
    await agent.stopRigAgent({ productionId: "prod-1", runId: stopped.id, userId: OWNER });
    expect(await reserve(stopped.id)).toBe(409);
    reasons.push(await lastReason());

    /* Failed (a worker marks the run failed). */
    await mark.liftSampleMark(userOf(OWNER));
    const failed = await ask();
    await db().execute({ sql: "UPDATE rig_agent_runs SET state='failed',finished_at=? WHERE id=?", args: [Date.now(), failed.id] });
    expect(await reserve(failed.id)).toBe(409);
    reasons.push(await lastReason());

    /* A crash mid-run: the run still reads running, but the lift's time is up, and nothing has to run for it to end. */
    await mark.liftSampleMark(userOf(OWNER));
    const crashed = await ask();
    expect(await reserve(crashed.id)).toBe("ok");
    const { LIFT_MS } = await import("../../lib/demo/lift.server");
    await db().execute({ sql: "UPDATE sample_lifts SET lifted_at=lifted_at-?, expires_at=expires_at-?, bound_at=bound_at-? WHERE ended_at IS NULL", args: [LIFT_MS + 1, LIFT_MS + 1, LIFT_MS + 1] });
    expect(await reserve(crashed.id)).toBe(409);
    const expired = (await lifts()).at(-1)!;
    expect(expired).toMatchObject({ ended_reason: "expired", ended_at: expired.expires_at });
    reasons.push(String(expired.ended_reason));
    await agent.stopRigAgent({ productionId: "prod-1", runId: crashed.id, userId: OWNER });

    /* A run of one's own still going may be lifted for again (say after an expiry); someone else's, or an ended one, may not. */
    await mark.liftSampleMark(userOf(OWNER));
    const going = await ask();
    expect(await mark.putSampleMarkBack(userOf(ADMIN))).toBe(true);
    reasons.push(await lastReason());
    expect(await reserve(going.id)).toBe(409);
    await expect(mark.liftSampleMark(userOf(ADMIN), { runId: going.id })).rejects.toMatchObject({ status: 409 });
    await expect(mark.liftSampleMark(userOf(OWNER), { runId: stopped.id })).rejects.toMatchObject({ status: 409 });
    await mark.liftSampleMark(userOf(OWNER), { runId: going.id });
    expect(await reserve(going.id)).toBe("ok");
    /* Undone. */
    await db().execute({ sql: "UPDATE rig_agent_runs SET undone_at=? WHERE id=?", args: [Date.now(), going.id] });
    expect(await reserve(going.id)).toBe(409);
    reasons.push(await lastReason());

    /* The mark undone ends a lift still waiting; marking again finds none. */
    await mark.liftSampleMark(userOf(OWNER));
    expect(await mark.hideSampleMark(userOf(OWNER))).toBe(true);
    reasons.push(await lastReason());
    expect(await mark.sampleLiftStatus(OWNER)).toMatchObject({ lifted: false });

    expect(reasons).toEqual(["stopped", "failed", "expired", "put_back", "undone", "unmarked"]);
    /* Every lift is kept, and each says who lifted it and when it came back. */
    const rows = await lifts();
    expect(rows).toHaveLength(6);
    expect(rows.every((l) => l.lifted_by === OWNER && l.ended_at != null)).toBe(true);
    const record = await mark.sampleLiftRecord(userOf(OWNER));
    expect(record[0]).toMatchObject({ by: "You", why: "unmarked", run: null });
    expect(record.find((l) => l.why === "put_back")).toMatchObject({ backBy: expect.any(String), run: { id: going.id, goal: "The dunes at dawn, two shots." } });
    await expect(mark.sampleLiftRecord(userOf(MEMBER))).rejects.toMatchObject({ status: 403 });
  });
});

/* ── Another workspace ────────────────────────────────────────────────── */

test("another workspace is unaffected: a lift is its own workspace's, another sample workspace still refuses that run, and a workspace with no mark spends as before", async () => {
  let liftedRun = "";
  await inWorkspace("tenant-a", async () => {
    const mark = await import("../../lib/demo/mark.server");
    await mark.liftSampleMark(userOf(OWNER));
    liftedRun = (await ask()).id;
    expect(await reserve(liftedRun)).toBe("ok");
  });
  await inWorkspace("tenant-b", async () => {
    const { sampleLifts } = await import("../../lib/demo/lift.server");
    expect(await sampleLifts()).toEqual([]);
    expect(await reserve(liftedRun)).toBe(409);
    expect(await refusal({ runId: liftedRun, userId: OWNER })).toBe(SAMPLE_LINE);
    expect(await refusal({ ask: { userId: OWNER, requestId: "r" } })).toBe(SAMPLE_LINE);
    expect((await (await import("../../lib/demo/mark.server")).sampleLiftStatus(OWNER)).lifted).toBe(false);
  });
  await inWorkspace("tenant-c", async () => {
    expect(await reserve(null)).toBe("ok");
    expect(await refusal()).toBeNull();
    const asked = await ask();
    expect(await reserve(asked.id)).toBe("ok");
    expect(await lifts().catch(() => [])).toEqual([]);
  }, { sample: false });
});

test("the board's words: the lift line is short and plain", () => {
  expect(LIFT_LINE).toBe("Lifted for one run · comes back on when it ends");
});
