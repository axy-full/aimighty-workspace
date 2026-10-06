import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdmissionActor, AdmissionReply, PreparedAdmission } from "../../lib/admissionTypes";
import type { TenantWorkspace } from "../../lib/tenant";
import type { RunSpend } from "../../lib/runLimit";
import { newProject, type CanvasNode, type Project } from "../../lib/workbench/studio";
import type { BoardSnapshot } from "../../lib/workbench/rig-agent-plan";
import { mockPlannerModel, runPlanner, MOCK_PLANNER_CATALOG, MOCK_PLANNER_MODEL } from "../../lib/workbench/rig-agent-planner";
import { creditFigure } from "../../lib/runLimit";

/*
 * A plan is approved once (CLAUDE.md rule 14; lib/workbench/plan-approval.ts). Money: one person's approval covers
 * exactly the plan's listed renders at the server's prices and up to two fixes per shot, within twice the plan's
 * total; render N+1, a moved price and a third fix ask again; an agent, an MCP caller or a token cannot approve; the
 * balance, the production's cap and the plan's ceiling still refuse at the hold; the total the card shows is the
 * server's; a refund gives its room back. The harness is the rig runs spec's: the scripted mock planner, and a
 * stand-in for admission that makes the real durable claim and the real reservation. Nothing reaches a provider.
 */

const dir = mkdtempSync(path.join(tmpdir(), "particl-plan-approval-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
delete process.env.LIVEBLOCKS_SECRET_KEY;

const OWNER = "ana", TEAMMATE = "bo";
const userOf = (id: string) => ({ id, email: `${id}@example.invalid`, name: id === OWNER ? "Ana" : "Bo", role: "admin" as const, owner: id === OWNER, disabled: false, createdAt: 0, lastSeen: null });
const actorOf = (id: string): AdmissionActor => ({ user: userOf(id) });
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
let requests = 0;
const rid = () => `req-plan-${String(++requests).padStart(6, "0")}`;

/* ── A paid workspace, a production, a board ──────────────────────────── */

async function paidWorkspace(name: string, credits = 2000): Promise<TenantWorkspace> {
  const { platformReady, platformDb, rowToWorkspace, grantCredits } = await import("../../lib/platform");
  await platformReady();
  await platformDb().execute({
    sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,1,?,0,0,20,500)",
    args: [name, name, name, `file:${path.join(dir, name + ".db")}`, OWNER],
  });
  if (credits) await grantCredits(name, credits, "Test", OWNER, "manual");
  return rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [name] })).rows[0]);
}

const scene = (id: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({ id, title: id, type: "scene", x: 0, y: 0, width: 344, linked: [], mode: "Video", ...extra });

async function seedBoard() {
  const { db, ready } = await import("../../lib/db");
  const { patchTeamCanvas } = await import("../../lib/workbench/team-canvas");
  const project: Project = { ...newProject("Harbour"), id: "draft-1", productionProjectId: "prod-1" };
  await ready();
  await db().execute("INSERT INTO projects(id,name,created_at) VALUES('prod-1','Harbour',0)");
  await db().execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,0)", args: [`${OWNER}:draft-1`, OWNER, "draft-1", "Harbour", JSON.stringify(project)] });
  await db().execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,0)", args: [`${TEAMMATE}:draft-1`, TEAMMATE, "draft-1", "Harbour", JSON.stringify(project)] });
  await patchTeamCanvas("prod-1", { upsertNodes: [scene("theirs", { x: 100, y: 100, title: "Ana's shot" })], removeNodes: [], upsertAssets: [], order: ["theirs"] }, OWNER);
}

/** Runs `fn` in a fresh paid workspace with a production and its board. */
async function inRun<T>(name: string, fn: (ws: TenantWorkspace) => Promise<T>, credits?: number): Promise<T> {
  const { runInTenant } = await import("../../lib/tenant");
  const ws = await paidWorkspace(name, credits);
  return runInTenant(ws, async () => { await seedBoard(); return fn(ws); });
}

/* ── A stand-in for admission: the real durable claim and the real reservation ── */

type Behaviour = { throwBeforeClaim?: boolean; throwAfterReply?: boolean; pendingClaim?: boolean };

function renders(ws: TenantWorkspace, usdOf: (node: string) => number) {
  const calls: { key: string; savedKey: string | null; savedState: string | null; run: RunSpend | undefined }[] = [];
  const behaviour: Behaviour = {};
  /* The price the admission would compute now, per shot: a moved price refuses an old approval. */
  const priceNow = new Map<string, number>();
  const shotOf = (body: Record<string, unknown>) => String(body.prompt ?? "").match(/Shot (\d+) of/)?.[1] ?? "?";
  const prepare = async (body: Record<string, unknown>, actor: AdmissionActor) => {
    const { billCredits } = await import("../../lib/creditTerms");
    const shot = shotOf(body);
    const usd = priceNow.get(shot) ?? usdOf(shot);
    const credits = billCredits(usd, "mock");
    const compiled = { model: { provider: "byteplus" }, estUsd: usd, shot, draft: body.draft === true, resolution: body.resolution };
    const quote = { estimatedCredits: credits, price: credits, unit: "cr" as const };
    return { ok: true as const, value: { version: 1 as const, kind: "video" as const, workspaceId: ws.id, actorId: actor.user.id, request: { ...body, maxCredits: credits }, compiled, quote: { ...quote, fingerprint: sha({ compiled, quote }) } } satisfies PreparedAdmission };
  };
  const admit = async (prepared: PreparedAdmission, actor: AdmissionActor, options: { requestKey: string; run?: RunSpend }): Promise<AdmissionReply> => {
    const { db, id, now } = await import("../../lib/db");
    const { withGenerationRequestData, bindGenerationRequestStatement, reserveGenerationSpend, SpendReservationError } = await import("../../lib/generationRequests");
    const { preparedClaimFingerprint } = await import("../../lib/admissionSupport");
    const saved = (await db().execute({ sql: "SELECT state,request_key FROM rig_agent_steps WHERE request_key=?", args: [options.requestKey] })).rows[0];
    calls.push({ key: options.requestKey, savedKey: saved ? String(saved.request_key) : null, savedState: saved ? String(saved.state) : null, run: options.run });
    if (behaviour.throwBeforeClaim) { behaviour.throwBeforeClaim = false; throw new Error("the function died before the request left"); }
    if (behaviour.pendingClaim) {
      behaviour.pendingClaim = false;
      await db().execute({ sql: "INSERT INTO generation_requests(user_id,request_key,fingerprint,created_at,updated_at) VALUES(?,?,?,?,?)", args: [actor.user.id, options.requestKey, preparedClaimFingerprint(prepared), now(), now()] });
      throw new Error("the function died while the request was being accepted");
    }
    const compiled = prepared.compiled as { estUsd: number; shot: string };
    const response = await withGenerationRequestData({ userId: actor.user.id, key: options.requestKey, fingerprint: preparedClaimFingerprint(prepared) }, async (claim) => {
      /* The checkpoint: what this shot would cost now must be what was approved. */
      const current = priceNow.get(compiled.shot);
      if (current != null && current !== compiled.estUsd) return Response.json({ error: "The compiled generation or price changed. Review and approve a fresh quote.", quoteChanged: true }, { status: 409 });
      const genId = id("gen");
      await db().batch([
        { sql: "INSERT INTO generations(id,project_id,kind,model,prompt,params,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)", args: [genId, "prod-1", "video", "mock", String(prepared.request.prompt ?? ""), "{}", "queued", actor.user.id, now(), now()] },
        bindGenerationRequestStatement(claim, genId),
      ], "write");
      try {
        await reserveGenerationSpend({ id: genId, kind: "video", engine: "byteplus", model: "mock", status: "running", engineCostUsd: compiled.estUsd, projectId: "prod-1", createdBy: actor.user.id }, { run: options.run });
      } catch (error) {
        await db().execute({ sql: "UPDATE generations SET status='failed', error=?, updated_at=? WHERE id=?", args: [(error as Error).message, now(), genId] });
        return Response.json({ id: genId, status: "failed", error: (error as Error).message }, { status: error instanceof SpendReservationError ? error.status : 503 });
      }
      return Response.json({ id: genId, status: "queued" }, { status: 202 });
    }, { atomicBinding: true });
    const reply = { status: response.status, body: await response.json(), headers: Object.fromEntries(response.headers) };
    if (behaviour.throwAfterReply) { behaviour.throwAfterReply = false; throw new Error("the reply was lost on its way back"); }
    return reply;
  };
  return { prepare, admit, calls, behaviour, priceNow };
}

type Renders = ReturnType<typeof renders>;

async function depsFor(ws: TenantWorkspace, r: Renders, extra: Record<string, unknown> = {}) {
  const { runInTenant } = await import("../../lib/tenant");
  return {
    access: async () => null, paceMs: 0,
    plan: async (snapshot: BoardSnapshot) => ({ ...(await runPlanner(snapshot, mockPlannerModel(snapshot))), model: MOCK_PLANNER_MODEL }),
    pricing: async () => ({ id: MOCK_PLANNER_MODEL, catalog: MOCK_PLANNER_CATALOG, direct: false }),
    asOwner: <T,>(owner: string, work: (actor: AdmissionActor) => Promise<T>) => runInTenant(ws, () => work(actorOf(owner)), { user: userOf(owner) }),
    prepare: r.prepare, admit: r.admit, defer: async () => {}, follow: async () => {},
    ...extra,
  };
}

/** Ask, plan and approve a board of `shots` shots; the build is applied by the first tick after. */
async function approvedRun(deps: Awaited<ReturnType<typeof depsFor>>, input: { limit: number; mode?: "ask" | "auto"; shots?: number }) {
  const agent = await import("../../lib/workbench/rig-agent");
  const words = ["one", "two", "three", "four"][(input.shots ?? 2) - 1];
  const asked = await agent.askRigAgent({ productionId: "prod-1", draftId: "draft-1", userId: OWNER, requestId: rid(), goal: `The captain on the pier, ${words} shots.`, limit: input.limit, mode: input.mode });
  expect(await agent.advanceRigAgentRun(asked.id, deps)).toEqual({ state: "awaiting_approval", more: false });
  const fingerprint = (await agent.rigAgentState("prod-1", OWNER)).run!.proposal!.fingerprint;
  await agent.approveRigAgent({ productionId: "prod-1", runId: asked.id, fingerprint, userId: OWNER });
  return asked.id;
}

const view = async (viewer = OWNER) => (await (await import("../../lib/workbench/rig-agent")).rigAgentState("prod-1", viewer)).run!;
const renderRows = async () => {
  const { db } = await import("../../lib/db");
  return (await db().execute("SELECT id,status FROM generations ORDER BY created_at")).rows.map((r) => ({ id: String(r.id), status: String(r.status) }));
};
async function meterRow(id: string) {
  const { platformDb } = await import("../../lib/platform");
  const row = (await platformDb().execute({ sql: "SELECT status,billed_credits,engine_cost_usd FROM meter_events WHERE id=?", args: [id] })).rows[0];
  return row ? { status: String(row.status), credits: Number(row.billed_credits ?? 0), usd: Number(row.engine_cost_usd ?? 0) } : null;
}
async function balance(ws: TenantWorkspace) {
  const { creditStateFor } = await import("../../lib/credits");
  return (await creditStateFor(ws))!.balance;
}
/** The vendor finishes a take: its outcome and bill written together, then delivered to the ledger (the settlement). */
async function settleTake(jobId: string, status: "succeeded" | "failed", usd: number) {
  const { writeGenerationOutcome, deliverGenerationSettlement } = await import("../../lib/generationSettlement");
  await writeGenerationOutcome({ sql: "UPDATE generations SET status=?,cost_usd=?,updated_at=? WHERE id=?", args: [status, usd, Date.now(), jobId] },
    { id: jobId, kind: "video", engine: "byteplus", model: "mock", status, engineCostUsd: usd });
  await deliverGenerationSettlement(jobId);
}
const credits = async (usd: number) => (await import("../../lib/creditTerms")).billCredits(usd, "mock");


/* ── The plan's approval ──────────────────────────────────────────────── */

const ATOMIK = (runId: string) => `agent:${runId}`;

/** A run at its plan gate: built, every render priced by the server, waiting for the one approval. */
async function atGate(ws: TenantWorkspace, usdOf: (shot: string) => number, shots = 2) {
  const agent = await import("../../lib/workbench/rig-agent");
  const r = renders(ws, usdOf);
  const deps = await depsFor(ws, r);
  const runId = await approvedRun(deps, { limit: 500, shots });
  expect(await agent.advanceRigAgentRun(runId, deps)).toEqual({ state: "needs_you", more: false });
  return { agent, r, deps, runId, run: await view() };
}

const takeSteps = (run: Awaited<ReturnType<typeof view>>) => run.paid.filter((p) => p.tool === "render");

test("the pure rules: only a person approves; the quote is the server's prices summed, the ceiling twice that; one approval covers exactly its listed renders at their prices", async () => {
  const pa = await import("../../lib/workbench/plan-approval");
  for (const person of ["ana", "u_123", "user-7"]) expect(pa.isPersonApprover(person), person).toBe(true);
  for (const machine of ["agent:rar_1", "AGENT:rar_1", "mcp:client", "token:pk_x", "auto", "plan:rpa_1", "system:cron", "", " ana", null, undefined, 7])
    expect(pa.isPersonApprover(machine), String(machine)).toBe(false);
  const step = (seq: number, quote: number, extra: Partial<Parameters<typeof pa.planQuote>[0][number]> = {}) => ({
    seq, nodeId: `n${seq}`, title: `Shot ${seq}`, state: "waiting", fixOf: null, quote, worst: quote, fingerprint: `f${seq}`, pause: null, reason: null, ...extra,
  });
  /* 43 + 43 + 7 = 93; at most 186. */
  const q = pa.planQuote([step(1, 43), step(3, 43), step(5, 7)], 200);
  expect(q).toMatchObject({ ready: true, total: 93, ceiling: 186, totalTenths: 930, ceilingTenths: 1860, approximate: false, asks: [] });
  if (!q.ready) throw new Error("not ready");
  /* An approximate engine counts at its worst case, and says "up to". */
  expect(pa.planQuote([step(1, 10, { worst: 30 })], 200)).toMatchObject({ ready: true, total: 30, ceiling: 60, approximate: true });
  /* Above the per-job line: listed to ask on its own, not in the total. */
  expect(pa.planQuote([step(1, 43), step(3, 250)], 200)).toMatchObject({ ready: true, total: 43, asks: [{ seq: 3 }] });
  /* A render without the server's price: the plan cannot be approved yet. */
  expect(pa.planQuote([step(1, 43), step(3, 0, { state: "next", quote: null, worst: null, fingerprint: null })], 200)).toMatchObject({ ready: false, reason: "Shot 3 is not priced yet." });
  /* The fingerprint covers every price: a moved price is a different plan. */
  const moved = pa.planQuote([step(1, 43), step(3, 44), step(5, 7)], 200);
  expect(moved.ready && moved.fingerprint).not.toBe(q.fingerprint);
  const approval = {
    id: "rpa_x", runId: "rar_x", productionId: "p", approvedBy: "ana", approvedAt: 0, expiresAt: pa.PLAN_APPROVAL_MS, fingerprint: q.fingerprint,
    steps: q.steps, totalTenths: q.totalTenths, ceilingTenths: q.ceilingTenths, fixes: { "1": [9] }, limitCredits: 186, closedAt: null, closedReason: null,
  };
  const at = 1000;
  expect(pa.coverage(approval, { seq: 1, fixOf: null, quote: 43, worst: 43, fingerprint: "f1" }, at, 200)).toEqual({ ok: true });
  /* Render N+1: not listed. A moved price: asks. */
  expect(pa.coverage(approval, { seq: 7, fixOf: null, quote: 7, worst: 7, fingerprint: "f7" }, at, 200)).toEqual({ ok: false, reason: pa.NOT_IN_PLAN });
  expect(pa.coverage(approval, { seq: 1, fixOf: null, quote: 43, worst: 43, fingerprint: "other" }, at, 200)).toEqual({ ok: false, reason: pa.PRICE_MOVED });
  /* A fix drawn on its shot, priced no higher: covered. One priced above its shot, or never drawn: asks. */
  expect(pa.coverage(approval, { seq: 9, fixOf: 1, quote: 43, worst: 43, fingerprint: "g" }, at, 200)).toEqual({ ok: true });
  expect(pa.coverage(approval, { seq: 9, fixOf: 1, quote: 44, worst: 44, fingerprint: "g" }, at, 200).ok).toBe(false);
  expect(pa.coverage(approval, { seq: 11, fixOf: 1, quote: 43, worst: 43, fingerprint: "g" }, at, 200)).toEqual({ ok: false, reason: pa.NOT_IN_PLAN });
  /* Closed or expired: nothing more is drawn on it. */
  expect(pa.coverage({ ...approval, closedAt: 5, closedReason: "Stopped." }, { seq: 1, fixOf: null, quote: 43, worst: 43, fingerprint: "f1" }, at, 200)).toEqual({ ok: false, reason: "Stopped." });
  expect(pa.coverage(approval, { seq: 1, fixOf: null, quote: 43, worst: 43, fingerprint: "f1" }, pa.PLAN_APPROVAL_MS, 200).ok).toBe(false);
  expect(pa.fixRoom(approval, 1)).toEqual({ used: 1, left: 1, listed: true });
  expect(pa.fixRoom({ ...approval, fixes: { "1": [9, 11] } }, 1)).toEqual({ used: 2, left: 0, listed: true });
});

test("one approval covers exactly the plan: the gate shows the server's total (the card's figures are its figures), the person approves once, and every listed render goes with no further tap", async () => {
  await inRun("once", async (ws) => {
    const { agent, r, deps, runId, run } = await atGate(ws, (shot) => (shot === "1" ? 0.3 : 0.45));
    const a = await credits(0.3), b = await credits(0.45);
    /* Both renders priced by the server before anything is sent; nothing reserved. */
    expect(takeSteps(run).map((p) => [p.state, p.quote])).toEqual([["waiting", a], ["waiting", b]]);
    expect(r.calls).toEqual([]);
    expect(run.plan?.quote).toMatchObject({ total: a + b, ceiling: 2 * (a + b), covered: takeSteps(run).map((p) => p.seq), asks: [] });
    /* The card says what the server says: the title, the total and the button are the server's T and 2T. */
    const { planModel } = await import("../../components/graphite/board/cards/plan/model");
    const model = planModel({ run, enabled: true, balance: await balance(ws), rule: null, readOnly: null })!;
    expect(model.phase).toBe("proposal");
    expect(model.total).toEqual({ kind: "exact", credits: a + b });
    expect(model.ceiling).toBe(2 * (a + b));
    expect(model.title).toBe(`Make 2 shots · ${creditFigure(a + b)} cr · at most ${creditFigure(2 * (a + b))} cr`);
    expect(model.primary).toMatchObject({ kind: "plan", label: `Approve · ${creditFigure(a + b)} cr`, fingerprint: run.plan!.quote!.fingerprint, blocked: null });
    const fingerprint = run.plan!.quote!.fingerprint;
    /* The one queue lists the plan once, at the server's total, to approve once (never a row per render). */
    const { readApprovals } = await import("../../lib/control-room/approvals.server");
    const queue = await readApprovals({ id: OWNER, role: "admin", owner: true });
    const boardItems = queue.items.filter((i) => i.source === "board-plan" || i.source === "board-render");
    expect(boardItems.map((i) => [i.source, i.price, i.approve])).toEqual([
      ["board-plan", { kind: "exact", credits: a + b }, { kind: "board-approve", productionId: "prod-1", runId, fingerprint, plan: true }],
    ]);
    expect(boardItems[0].note).toBe(`At most ${creditFigure(2 * (a + b))} cr with fixes`);
    /* Not the right plan: refused. */
    await expect(agent.approveRigAgentPlan({ productionId: "prod-1", runId, fingerprint: "0".repeat(64), userId: OWNER })).rejects.toMatchObject({ status: 409 });
    const planned = (await meterRow(agent.planEventId(runId)))!.credits;
    const approved = await agent.approveRigAgentPlan({ productionId: "prod-1", runId, fingerprint, userId: OWNER });
    /* The run's limit is what it used plus the plan's ceiling: the reservation holds the plan to it. */
    expect(approved.state).toBe("running");
    expect(approved.money!.limit).toBeCloseTo(planned + 2 * (a + b), 5);
    expect(approved.plan?.approval).toMatchObject({ mine: true, total: a + b, ceiling: 2 * (a + b), used: 0, open: true, maxFixes: 2 });
    /* The lost reply to the approval: the same answer, approved once. */
    expect((await agent.approveRigAgentPlan({ productionId: "prod-1", runId, fingerprint, userId: OWNER })).state).toBe("running");
    const { db } = await import("../../lib/db");
    const rows = (await db().execute({ sql: "SELECT approved_by,total_tenths,ceiling_tenths,steps FROM rig_plan_approvals WHERE run_id=?", args: [runId] })).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ approved_by: OWNER, total_tenths: Math.round((a + b) * 10), ceiling_tenths: Math.round(2 * (a + b) * 10) });
    expect((JSON.parse(String(rows[0].steps)) as { seq: number }[]).map((s) => s.seq)).toEqual(takeSteps(run).map((p) => p.seq));
    /* First render: sent with no tap, under its durable key and the run's limit, approved by the person's plan approval. */
    await agent.advanceRigAgentRun(runId, deps);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].run).toMatchObject({ id: runId });
    expect(r.calls[0].run!.limitCredits).toBeCloseTo(planned + 2 * (a + b), 5);
    const stepRows = async () => (await db().execute({ sql: "SELECT seq,state,approved_by,approval_id FROM rig_agent_steps WHERE run_id=? AND purpose='take' ORDER BY seq", args: [runId] })).rows;
    expect((await stepRows())[0]).toMatchObject({ state: "rendering", approved_by: OWNER });
    expect(String((await stepRows())[0].approval_id)).toMatch(/^rpa_/);
    await settleTake((await renderRows())[0].id, "succeeded", 0.3);
    /* Second render: no tap either. */
    await agent.advanceRigAgentRun(runId, deps);
    expect(r.calls).toHaveLength(2);
    await settleTake((await renderRows())[1].id, "succeeded", 0.45);
    expect(await agent.advanceRigAgentRun(runId, deps)).toEqual({ state: "done", more: false });
    const done = await view();
    expect(done.plan?.approval).toMatchObject({ used: a + b, ceiling: 2 * (a + b) });
    expect(takeSteps(done).every((p) => p.inPlan)).toBe(true);
    /* A plan is approved once: another approval of this run is refused. */
    await expect(agent.approveRigAgentPlan({ productionId: "prod-1", runId, fingerprint: "1".repeat(64), userId: OWNER })).rejects.toMatchObject({ status: 409 });
  });
});

test("an agent, an MCP caller, a token or a teammate cannot approve a plan or draw a fix; the route takes a signed-in person's session only", async () => {
  await inRun("people", async (ws) => {
    const { agent, r, runId, run } = await atGate(ws, () => 0.3);
    const fingerprint = run.plan!.quote!.fingerprint;
    for (const userId of [ATOMIK(runId), `mcp:outside`, `token:pk_${ws.id}_x`, "auto", TEAMMATE]) {
      await expect(agent.approveRigAgentPlan({ productionId: "prod-1", runId, fingerprint, userId }), userId).rejects.toMatchObject({ status: 403 });
      await expect(agent.fixRigAgentShot({ productionId: "prod-1", runId, seq: takeSteps(run)[0].seq, userId }), userId).rejects.toMatchObject({ status: 403 });
    }
    /* Nothing was approved or sent. */
    const { db } = await import("../../lib/db");
    expect((await db().execute({ sql: "SELECT COUNT(*) AS n FROM rig_plan_approvals WHERE run_id=?", args: [runId] })).rows[0].n).toBe(0);
    expect(r.calls).toEqual([]);
    /* The table itself refuses a machine as the approver. */
    await expect(db().execute({ sql: "INSERT INTO rig_plan_approvals(id,run_id,production_id,approved_by,approved_at,expires_at,fingerprint,steps,total_tenths,ceiling_tenths,limit_credits,created_at) VALUES('rpa_m','rar_m','prod-1',?,0,1,'f','[]',1,2,1,0)", args: [ATOMIK(runId)] })).rejects.toThrow(/CHECK/i);
    /* The route: a session only (tokens are refused by requireSession), and both actions only through it. */
    const { readFileSync } = await import("node:fs");
    const route = readFileSync(path.join(process.cwd(), "app/api/workbench/team-canvas/route.ts"), "utf8");
    expect(route).toMatch(/const auth = await requireSession\(\);/);
    expect(route).not.toMatch(/requireUser|requireRender/);
    expect(route).toContain('runAction("agent.approvePlan")');
    expect(route).toContain('runAction("agent.fix")');
  });
});

test("render N+1 asks: a render the approval does not list, or one whose price moved, waits for its own tap; a third fix is refused", async () => {
  await inRun("outside", async (ws) => {
    const { agent, r, deps, runId, run } = await atGate(ws, () => 0.3);
    await agent.approveRigAgentPlan({ productionId: "prod-1", runId, fingerprint: run.plan!.quote!.fingerprint, userId: OWNER });
    const { db } = await import("../../lib/db");
    /* A render added to the run after the approval (render N+1): it is priced, and it asks. */
    const [first, second] = takeSteps(run);
    const node = String((await db().execute({ sql: "SELECT node_id FROM rig_agent_steps WHERE run_id=? AND seq=?", args: [runId, second.seq] })).rows[0].node_id);
    await db().execute({ sql: "INSERT INTO rig_agent_steps(id,run_id,seq,tool,label,purpose,node_id,attempt,prepared,state,created_at,updated_at) VALUES(?,?,?,'render','Render extra','take',?,0,'[]','next',0,0)", args: [`${runId}:50`, runId, 50, node] });
    await agent.advanceRigAgentRun(runId, deps);
    await settleTake((await renderRows())[0].id, "succeeded", 0.3);
    await agent.advanceRigAgentRun(runId, deps);
    await settleTake((await renderRows())[1].id, "succeeded", 0.3);
    expect(await agent.advanceRigAgentRun(runId, deps)).toEqual({ state: "needs_you", more: false });
    let shown = await view();
    expect(r.calls).toHaveLength(2);
    expect(shown.paid.find((p) => p.seq === 50)).toMatchObject({ state: "waiting", canRender: true, inPlan: false });
    expect(shown.reason).toContain("Not in the approved plan, so it asks at its own price.");
    await agent.skipRigAgentStep({ productionId: "prod-1", runId, seq: 50, userId: OWNER });
    expect(await agent.advanceRigAgentRun(runId, deps)).toEqual({ state: "done", more: false });
    /* Fixes: two on a shot go with no tap, at no more than the shot's price; a third is refused. */
    for (let i = 0; i < 2; i++) {
      const fixed = await agent.fixRigAgentShot({ productionId: "prod-1", runId, seq: first.seq, userId: OWNER });
      expect(fixed.state).toBe("running");
      /* A second press while that fix is on its way answers the same and draws nothing more. */
      await agent.fixRigAgentShot({ productionId: "prod-1", runId, seq: first.seq, userId: OWNER });
      await agent.advanceRigAgentRun(runId, deps);
      expect(r.calls).toHaveLength(3 + i);
      await settleTake((await renderRows())[2 + i].id, "succeeded", 0.3);
      await agent.advanceRigAgentRun(runId, deps);
    }
    shown = await view();
    expect(shown.plan?.approval?.fixes).toEqual({ [String(first.seq)]: 2 });
    expect(shown.paid.filter((p) => p.fixOf === first.seq).map((p) => [p.title, p.state, p.inPlan])).toEqual([
      [`Fix · ${first.title}`, "done", true], [`Fix · ${first.title}`, "done", true],
    ]);
    const { THIRD_FIX } = await import("../../lib/workbench/plan-approval");
    await expect(agent.fixRigAgentShot({ productionId: "prod-1", runId, seq: first.seq, userId: OWNER })).rejects.toMatchObject({ status: 409, message: THIRD_FIX });
    expect(r.calls).toHaveLength(4);
  });
});

test("a moved price asks again: the render is priced afresh and waits for a tap at its new price, never adopted under the plan", async () => {
  await inRun("moved", async (ws) => {
    const { agent, r, deps, runId, run } = await atGate(ws, () => 0.3);
    await agent.approveRigAgentPlan({ productionId: "prod-1", runId, fingerprint: run.plan!.quote!.fingerprint, userId: OWNER });
    /* The shot changes before it is sent (cheaper, even): admission says the quote changed; it is priced again and asks. */
    r.priceNow.set("1", 0.2);
    expect(await agent.advanceRigAgentRun(runId, deps)).toEqual({ state: "needs_you", more: false });
    const shown = await view();
    const first = takeSteps(shown)[0];
    expect(first).toMatchObject({ state: "waiting", quote: await credits(0.2), inPlan: false });
    expect(shown.reason).toContain("price changed since the plan was approved");
    expect(await renderRows()).toEqual([]);
    /* One tap at the new price sends it. */
    await agent.renderRigAgentStep({ productionId: "prod-1", runId, seq: first.seq, fingerprint: first.fingerprint, userId: OWNER });
    await agent.advanceRigAgentRun(runId, deps);
    expect(await renderRows()).toHaveLength(1);
  });
});

test("the balance and the caps still bite: approval waits while the balance is short of the total; the plan's ceiling and the production's cap refuse at the hold", async () => {
  await inRun("bite", async (ws) => {
    const { agent, r, deps, runId, run } = await atGate(ws, (shot) => (shot === "1" ? 0.3 : 0.45));
    const a = await credits(0.3), b = await credits(0.45);
    const fingerprint = run.plan!.quote!.fingerprint;
    /* Spend the balance down outside the run, to less than the plan's total. */
    const { reserveGenerationSpend } = await import("../../lib/generationRequests");
    const { creditUsd, marginFor } = await import("../../lib/creditTerms");
    const { meter } = await import("../../lib/meter");
    const drain = Math.floor((await balance(ws)) - (a + b) + 1);
    const usd = (drain * creditUsd()) / marginFor("mock");
    const outside = { id: "gen_outside_drain", kind: "video" as const, engine: "byteplus", model: "mock", status: "running" as const, engineCostUsd: usd, createdBy: OWNER };
    await reserveGenerationSpend(outside);
    expect(await balance(ws)).toBeLessThan(a + b);
    await expect(agent.approveRigAgentPlan({ productionId: "prod-1", runId, fingerprint, userId: OWNER })).rejects.toMatchObject({ status: 402, message: expect.stringMatching(/^Short by [\d.,]+ cr\. Top up, then approve\./) });
    /* The card says so too, and its Approve waits. */
    const { planModel, SHORT_LINE } = await import("../../components/graphite/board/cards/plan/model");
    expect(planModel({ run: await view(), enabled: true, balance: await balance(ws), rule: null, readOnly: null })!.primary).toMatchObject({ kind: "plan", blocked: SHORT_LINE });
    /* Topped up (here: that job refunded), the approval goes. */
    await meter({ ...outside, status: "failed", engineCostUsd: 0 });
    await agent.approveRigAgentPlan({ productionId: "prod-1", runId, fingerprint, userId: OWNER });
    /* The production's cap, checked at the hold as for every render: the first fits, the second does not. */
    const { db } = await import("../../lib/db");
    const { projectCapSpent } = await import("../../lib/caps");
    const spentSoFar = (await projectCapSpent("prod-1"))!.spent;
    await db().execute({ sql: "UPDATE projects SET cap_credits=? WHERE id='prod-1'", args: [spentSoFar + a] });
    await db().execute("INSERT INTO settings(key,value,updated_at) VALUES('atCap','stop',0) ON CONFLICT(key) DO UPDATE SET value='stop'");
    await agent.advanceRigAgentRun(runId, deps);
    await settleTake((await renderRows())[0].id, "succeeded", 0.3);
    expect(await agent.advanceRigAgentRun(runId, deps)).toEqual({ state: "needs_you", more: false });
    let shown = await view();
    expect(takeSteps(shown)[1]).toMatchObject({ state: "paused", pause: "refused" });
    expect(shown.reason).toMatch(/cap/i);
    expect(await meterRow((await renderRows())[1].id)).toBeNull();
    /* Without the cap, the plan's own ceiling still bites: two fixes of the dearer shot would pass 2 × the total. */
    await db().execute("UPDATE projects SET cap_credits=NULL WHERE id='prod-1'");
    await agent.renderRigAgentStep({ productionId: "prod-1", runId, seq: takeSteps(shown)[1].seq, fingerprint: takeSteps(shown)[1].fingerprint, userId: OWNER });
    await agent.advanceRigAgentRun(runId, deps);
    await settleTake((await renderRows()).at(-1)!.id, "succeeded", 0.45);
    expect(await agent.advanceRigAgentRun(runId, deps)).toEqual({ state: "done", more: false });
    const dear = takeSteps(await view())[1].seq;
    await agent.fixRigAgentShot({ productionId: "prod-1", runId, seq: dear, userId: OWNER });
    await agent.advanceRigAgentRun(runId, deps);
    await settleTake((await renderRows()).at(-1)!.id, "succeeded", 0.45);
    await agent.advanceRigAgentRun(runId, deps);
    /* a + b + b so far; one more b passes 2(a + b) because b > a: refused at the reservation, nothing charged. */
    expect(b).toBeGreaterThan(a);
    await agent.fixRigAgentShot({ productionId: "prod-1", runId, seq: dear, userId: OWNER });
    const sent = r.calls.length;
    expect(await agent.advanceRigAgentRun(runId, deps)).toEqual({ state: "needs_you", more: false });
    shown = await view();
    expect(shown.paid.at(-1)).toMatchObject({ state: "paused", pause: "limit" });
    expect(r.calls.length).toBe(sent);
    expect(shown.plan!.approval!.used).toBeLessThanOrEqual(shown.plan!.approval!.ceiling);
  });
});

test("refunds return to the approval: a failed render the provider refunded uses none of the plan's room, and a stop closes the approval", async () => {
  await inRun("refund", async (ws) => {
    const { agent, deps, runId, run } = await atGate(ws, () => 0.3);
    const a = await credits(0.3);
    await agent.approveRigAgentPlan({ productionId: "prod-1", runId, fingerprint: run.plan!.quote!.fingerprint, userId: OWNER });
    const before = await balance(ws);
    await agent.advanceRigAgentRun(runId, deps);
    expect((await view()).plan!.approval!.used).toBe(a);
    /* The provider failed it and charged nothing: its credits come back to the balance and to the plan's room. */
    await settleTake((await renderRows())[0].id, "failed", 0);
    expect((await view()).plan!.approval!.used).toBe(0);
    await agent.advanceRigAgentRun(runId, deps);
    let shown = await view();
    expect(takeSteps(shown)[0]).toMatchObject({ state: "failed", outcome: "not_billed" });
    /* The second render now holds its price: the only use of the plan's room. */
    expect(shown.plan!.approval!.used).toBe(a);
    await settleTake((await renderRows())[1].id, "succeeded", 0.3);
    await agent.advanceRigAgentRun(runId, deps);
    shown = await view();
    /* Only the second render counts: the refund gave its room back. */
    expect(shown.plan!.approval!.used).toBe(a);
    expect(await balance(ws)).toBe(before - a);
    /* A re-render of the failed shot is a fix, inside the plan. */
    await agent.fixRigAgentShot({ productionId: "prod-1", runId, seq: takeSteps(shown)[0].seq, userId: OWNER });
    /* Stop: what is not sent is let go, and the approval closes; nothing more is drawn on it. */
    await agent.stopRigAgent({ productionId: "prod-1", runId, userId: OWNER });
    shown = await view();
    expect(shown.plan!.approval).toMatchObject({ open: false });
    expect(shown.paid.at(-1)).toMatchObject({ state: "skipped" });
    await expect(agent.fixRigAgentShot({ productionId: "prod-1", runId, seq: takeSteps(shown)[1].seq, userId: OWNER })).rejects.toMatchObject({ status: 409 });
  });
});
