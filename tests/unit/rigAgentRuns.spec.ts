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
import {
  STATED_CHARGE_BAND, ceilTenths, creditFigure, fromTenths, isRunLimitAmount, jobBand, runLimitVerdict, runTally, toTenths,
} from "../../lib/runLimit";

/*
 * Atomik renders drafts inside a limit a person approved (plan PR 10). Money:
 * the limit arithmetic in tenths, the reservation that enforces it under its
 * write lock with the run's id on every job, the per-job line from the
 * workspace's approval rule, the planning turn metered into the limit, Ask and
 * Auto, the durable request key saved before anything is sent, the lost reply
 * asked about and never replayed, release on stop, decline and failure, and no
 * charge without an approval that covers it.
 *
 * Every model is the scripted mock planner through the real SDK loop; renders
 * go through a stand-in for admission that makes the real durable claim and the
 * real reservation (and, in one test, the real admission under ENGINE_MOCK=1).
 * Nothing reaches a provider.
 */

const dir = mkdtempSync(path.join(tmpdir(), "particl-rig-runs-"));
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
const rid = () => `req-runs-${String(++requests).padStart(6, "0")}`;

/* ── The arithmetic (lib/runLimit.ts) ─────────────────────────────────── */

test("the run limit is counted in whole tenths: exactly at the limit passes, a tenth over does not; work in flight counts at its worst case", () => {
  expect(toTenths(0.1) + toTenths(0.2)).toBe(toTenths(0.3));
  expect(fromTenths(toTenths(0.1) + toTenths(0.2))).toBe(0.3);
  expect(toTenths(12)).toBe(120);
  expect(ceilTenths(1.01)).toBe(11);
  expect(ceilTenths(1.1)).toBe(11);
  const empty = runTally([]);
  expect(empty).toEqual({ settledTenths: 0, heldTenths: 0, worstTenths: 0 });
  /* Settled work at its final charge; work in flight at its estimate, and at its worst for the limit. */
  const tally = runTally([
    { running: false, credits: 1.3 }, { running: false, credits: 0 }, { running: true, credits: 4, band: 1 }, { running: true, credits: 2.5, band: STATED_CHARGE_BAND },
  ]);
  expect(tally).toEqual({ settledTenths: 13, heldTenths: 65, worstTenths: 40 + 75 });
  /* 1.3 + 4 + 7.5 = 12.8 stands; a 2.2 job makes 15 exactly: it fits a 15 limit, not a 14.9 one. */
  expect(runLimitVerdict({ limitTenths: 150, tally, jobTenths: 22 })).toMatchObject({ ok: true, afterTenths: 150, leftTenths: 22, needTenths: 22 });
  expect(runLimitVerdict({ limitTenths: 149, tally, jobTenths: 22 })).toMatchObject({ ok: false, afterTenths: 150, leftTenths: 21 });
  /* A job whose charge follows the provider's stated amount needs room for its worst case. */
  expect(runLimitVerdict({ limitTenths: 150, tally, jobTenths: 8, band: 3 })).toMatchObject({ ok: false, needTenths: 24 });
  expect(runLimitVerdict({ limitTenths: 152, tally, jobTenths: 8, band: 3 })).toMatchObject({ ok: true, afterTenths: 152 });
  expect(jobBand({})).toBe(1);
  expect(jobBand({ approximate: true })).toBe(STATED_CHARGE_BAND);
  expect(jobBand({ statesCharge: true })).toBe(STATED_CHARGE_BAND);
  /* A sum of hundreds of tenths never drifts. */
  const many = runTally(Array.from({ length: 300 }, () => ({ running: false, credits: 0.1 })));
  expect(many.settledTenths).toBe(300);
  expect(runLimitVerdict({ limitTenths: toTenths(30), tally: many, jobTenths: 0 }).ok).toBe(true);
  expect(runLimitVerdict({ limitTenths: toTenths(30), tally: many, jobTenths: 1 }).ok).toBe(false);
});

test("a limit a person approves is a positive amount in tenths; credit figures show one decimal only when there is one, never cut short", () => {
  for (const ok of [0.1, 1, 12.5, 50, 999_999.9]) expect(isRunLimitAmount(ok), String(ok)).toBe(true);
  for (const bad of [0, -1, 0.05, 12.34, Number.NaN, Infinity, "12", null, 1_000_000.1]) expect(isRunLimitAmount(bad), String(bad)).toBe(false);
  expect(creditFigure(12)).toBe("12");
  expect(creditFigure(12.5)).toBe("12.5");
  expect(creditFigure(1234.5)).toBe("1,234.5");
  expect(creditFigure(0.1 + 0.2)).toBe("0.3");
});

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
/** A balance less some charges, in whole tenths as the ledger counts them (0.4 + 0.3 never drifts to 0.7000000000000001). */
const minus = (from: number, ...charges: number[]) => (Math.round(from * 10) - charges.reduce((t, c) => t + Math.round(c * 10), 0)) / 10;

/* ── The reservation enforces the limit, under its write lock ─────────── */

test("the reservation enforces a run's limit: over it nothing is reserved and the balance is untouched; every job carries the run's id; a stopped run reserves nothing", async () => {
  await inRun("reserve", async (ws) => {
    const { reserveGenerationSpend, runCharges, RUN_LIMIT_REACHED } = await import("../../lib/generationRequests");
    const { platformDb } = await import("../../lib/platform");
    const { meter } = await import("../../lib/meter");
    const { billCredits } = await import("../../lib/creditTerms");
    const job = (id: string, usd: number) => ({ id, kind: "video" as const, engine: "byteplus", model: "mock", status: "running" as const, engineCostUsd: usd, createdBy: OWNER });
    const a = billCredits(0.9, "mock"), b = billCredits(0.6, "mock");
    const limit = a + b;
    const run = (band = 1, live?: () => Promise<string | null>): RunSpend => ({ id: "rar_aaaaaaaaaaaaaaaaaaaaaaaa", limitCredits: limit, band, live });
    const before = await balance(ws);
    await reserveGenerationSpend(job("gen_limit_a", 0.9), { run: run() });
    /* A second job that would pass the limit: refused, nothing written for it. */
    await expect(reserveGenerationSpend(job("gen_limit_over", 0.61 + 0.2), { run: run() })).rejects.toMatchObject({ message: RUN_LIMIT_REACHED, status: 409 });
    expect(await meterRow("gen_limit_over")).toBeNull();
    /* One that meets it exactly lands. */
    await reserveGenerationSpend(job("gen_limit_b", 0.6), { run: run() });
    expect(await balance(ws)).toBe(minus(before, a, b));
    const rows = (await platformDb().execute({ sql: "SELECT id,run_id,run_band FROM generation_reservations WHERE workspace_id=? ORDER BY id", args: [ws.id] })).rows.map((r) => [String(r.id), r.run_id, Number(r.run_band)]);
    expect(rows).toEqual([["gen_limit_a", "rar_aaaaaaaaaaaaaaaaaaaaaaaa", 1], ["gen_limit_b", "rar_aaaaaaaaaaaaaaaaaaaaaaaa", 1]]);
    expect((await runCharges("rar_aaaaaaaaaaaaaaaaaaaaaaaa")).map((c) => [c.id, c.running, c.credits]).sort()).toEqual([["gen_limit_a", true, a], ["gen_limit_b", true, b]]);
    /* A job that settles lower (here refunded) gives its room back. */
    await meter({ ...job("gen_limit_a", 0), status: "failed", engineCostUsd: 0 });
    await reserveGenerationSpend(job("gen_limit_c", 0.9), { run: run() });
    /* In flight at its worst case: a job that may settle at three times its quote needs room for that. */
    await meter({ ...job("gen_limit_b", 0), status: "failed", engineCostUsd: 0 });
    await meter({ ...job("gen_limit_c", 0), status: "failed", engineCostUsd: 0 });
    await reserveGenerationSpend(job("gen_limit_d", 0.3), { run: run(STATED_CHARGE_BAND) });
    const worstOfD = billCredits(0.3, "mock") * STATED_CHARGE_BAND;
    const room = limit - worstOfD;
    const tooMuch = [0.9, 0.6, 0.3].find((usd) => billCredits(usd, "mock") > room);
    if (tooMuch) await expect(reserveGenerationSpend(job("gen_limit_e", tooMuch), { run: run() })).rejects.toMatchObject({ message: RUN_LIMIT_REACHED });
    /* A run that was stopped (or switched off) reserves nothing, whatever room is left. */
    await expect(reserveGenerationSpend(job("gen_limit_stopped", 0.1), { run: run(1, async () => "This run was stopped.") })).rejects.toMatchObject({ message: "This run was stopped.", status: 409 });
    expect(await meterRow("gen_limit_stopped")).toBeNull();
    /* Work outside any run is not counted toward it, and is never refused by it. */
    await reserveGenerationSpend(job("gen_outside", 5));
    expect((await runCharges("rar_aaaaaaaaaaaaaaaaaaaaaaaa")).some((c) => c.id === "gen_outside")).toBe(false);
  });
});

test("two reservations of one run that each fit but not together: exactly one lands", async () => {
  await inRun("race", async () => {
    const { reserveGenerationSpend, RUN_LIMIT_REACHED } = await import("../../lib/generationRequests");
    const { billCredits } = await import("../../lib/creditTerms");
    const each = billCredits(0.9, "mock");
    const run: RunSpend = { id: "rar_bbbbbbbbbbbbbbbbbbbbbbbb", limitCredits: each + each - 0.1, band: 1 };
    const results = await Promise.allSettled(["gen_race_a", "gen_race_b"].map((id) =>
      reserveGenerationSpend({ id, kind: "video", engine: "byteplus", model: "mock", status: "running", engineCostUsd: 0.9, createdBy: OWNER }, { run })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason.message).toBe(RUN_LIMIT_REACHED);
  });
});

/* ── The per-job line: the workspace's own approval line ──────────────── */

test("the per-job line is the platform's approval line (SOW guardrail 4) at the price of a credit — the owner's seam unset, a workspace's own shot cap does not move it — and the card suggests the same limit", async () => {
  const limits = await import("../../lib/workbench/rig-agent-limits");
  const { jobApprovalLineCredits, JOB_APPROVAL_LINE_USD } = await import("../../lib/approvalRule");
  const { creditUsd } = await import("../../lib/creditTerms");
  expect(limits.RIG_AGENT_JOB_CEILING_CREDITS).toBeNull();
  /* One line, a job's price, counted in credits at whatever a credit costs, in whole tenths rounded down. */
  for (const perCredit of [0.1, 0.8, 0.125, 0.3]) {
    const line = jobApprovalLineCredits(perCredit);
    expect(line * perCredit).toBeLessThanOrEqual(JOB_APPROVAL_LINE_USD + 1e-9);
    expect((line + 0.1) * perCredit).toBeGreaterThan(JOB_APPROVAL_LINE_USD);
    expect(Math.round(line * 10)).toBe(line * 10);
  }
  /* Where the line divides evenly into credits, it is exactly that many: read from the one source, never a figure of its own. */
  expect(jobApprovalLineCredits(0.125)).toBe(JOB_APPROVAL_LINE_USD / 0.125);
  expect(jobApprovalLineCredits(0.1)).toBe(JOB_APPROVAL_LINE_USD / 0.1);
  expect(jobApprovalLineCredits(0)).toBe(0);
  expect(limits.effectiveJobCeiling(null, 17)).toBe(17);
  expect(limits.effectiveJobCeiling(30, 17)).toBe(17);
  expect(limits.effectiveJobCeiling(12, 17)).toBe(12);
  await inRun("line", async () => {
    const { setSetting } = await import("../../lib/settings");
    const agent = await import("../../lib/workbench/rig-agent");
    const line = jobApprovalLineCredits(creditUsd());
    expect(await limits.rigJobCeiling()).toBe(line);
    expect(await limits.suggestedRunLimit()).toBe(line);
    /* A workspace's per-shot cap is its own rule (enforced at admission): it does not move Atomik's line. */
    await setSetting("shotCapCredits", "17", OWNER);
    expect(await limits.rigJobCeiling()).toBe(line);
    const state = await agent.rigAgentState("prod-1", OWNER, "draft-1");
    expect(state.ask).toMatchObject({ limit: line, jobCeiling: line });
    /* Planning's price is shown before asking, in credits. */
    expect(state.ask!.planning).toBeGreaterThan(0);
    /* The run records the line in force when its limit was approved. */
    const asked = await agent.askRigAgent({ productionId: "prod-1", draftId: "draft-1", userId: OWNER, requestId: rid(), goal: "Two shots.", limit: 500, mode: "auto" });
    expect(asked.money).toMatchObject({ mode: "auto", jobCeiling: line });
  });
});

/* ── Planning, metered into the limit ─────────────────────────────────── */

test("planning is metered into the run's limit: reserved at its ceiling while it runs, settled at what it used; a limit below its ceiling plans nothing", async () => {
  await inRun("planning", async (ws) => {
    const agent = await import("../../lib/workbench/rig-agent");
    const { quotedCredits } = await import("../../lib/credits");
    const { plannerCeilingUsd } = await import("../../lib/workbench/rig-agent-planner");
    const { runCharges } = await import("../../lib/generationRequests");
    const r = renders(ws, () => 0.3);
    let during: Awaited<ReturnType<typeof meterRow>> = null;
    let ceilingCredits = 0;
    const deps = await depsFor(ws, r, {
      plan: async (snapshot: BoardSnapshot) => {
        ceilingCredits = quotedCredits(plannerCeilingUsd(MOCK_PLANNER_CATALOG, snapshot)!, "text");
        during = await meterRow(agent.planEventId(runId));
        return { ...(await runPlanner(snapshot, mockPlannerModel(snapshot))), model: MOCK_PLANNER_MODEL };
      },
    });
    const start = await balance(ws);
    /* No limit, no ask: nothing is planned (or paid) without one. */
    await expect(agent.askRigAgent({ productionId: "prod-1", draftId: "draft-1", userId: OWNER, requestId: rid(), goal: "Two shots.", limit: 0 })).rejects.toMatchObject({ status: 400 });
    const asked = await agent.askRigAgent({ productionId: "prod-1", draftId: "draft-1", userId: OWNER, requestId: rid(), goal: "The captain on the pier, two shots.", limit: 500 });
    const runId = asked.id;
    expect(asked.money).toMatchObject({ limit: 500, mode: "ask", spent: 0, planning: null });
    expect(await agent.advanceRigAgentRun(runId, deps)).toEqual({ state: "awaiting_approval", more: false });
    /* While it planned: reserved at its ceiling, under the run's id. */
    expect(during).toMatchObject({ status: "running", credits: ceilingCredits });
    const after = await meterRow(agent.planEventId(runId));
    expect(after!.status).toBe("succeeded");
    expect(after!.credits).toBeGreaterThan(0);
    expect(after!.credits).toBeLessThanOrEqual(ceilingCredits);
    expect(after!.usd).toBeGreaterThan(0);
    expect(await balance(ws)).toBe(minus(start, after!.credits));
    expect((await runCharges(runId)).map((c) => c.id)).toEqual([agent.planEventId(runId)]);
    const { platformDb } = await import("../../lib/platform");
    expect((await platformDb().execute({ sql: "SELECT state FROM recovery_intents WHERE id=?", args: [agent.planEventId(runId)] })).rows[0]?.state).toBe("resolved");
    const shown = await view();
    expect(shown.money).toMatchObject({ spent: after!.credits, inFlight: 0, planning: { state: "settled", credits: after!.credits } });
    expect(shown.credits).toBe(after!.credits);
    /* A limit below what planning may cost: the run stops before anything is sent or charged. */
    await agent.declineRigAgent({ productionId: "prod-1", runId, userId: OWNER });
    const tight = await agent.askRigAgent({ productionId: "prod-1", draftId: "draft-1", userId: OWNER, requestId: rid(), goal: "Two shots.", limit: 0.1 });
    expect(await agent.advanceRigAgentRun(tight.id, deps)).toEqual({ state: "failed", more: false });
    expect((await view()).reason).toMatch(/Planning this board may cost up to about .* cr, more than this run's limit of 0\.1 cr/);
    expect(await meterRow(agent.planEventId(tight.id))).toBeNull();
    expect(await balance(ws)).toBe(minus(start, after!.credits));
  });
});

test("a planning turn that fails is released unbilled; a planning charge a dead worker left behind is released when the run stops, and by the cron", async () => {
  await inRun("planfail", async (ws) => {
    const agent = await import("../../lib/workbench/rig-agent");
    const { PlannerError } = await import("../../lib/workbench/rig-agent-planner");
    const { reserveGenerationSpend } = await import("../../lib/generationRequests");
    const { db } = await import("../../lib/db");
    const r = renders(ws, () => 0.3);
    const start = await balance(ws);
    const failing = await depsFor(ws, r, { plan: async () => { throw new PlannerError("Atomik did not finish its proposal. Ask again."); } });
    const asked = await agent.askRigAgent({ productionId: "prod-1", draftId: "draft-1", userId: OWNER, requestId: rid(), goal: "Two shots.", limit: 500 });
    expect(await agent.advanceRigAgentRun(asked.id, failing)).toEqual({ state: "failed", more: false });
    expect(await meterRow(agent.planEventId(asked.id))).toMatchObject({ status: "failed", credits: 0 });
    expect((await view()).money!.planning).toMatchObject({ state: "released", credits: 0 });
    expect(await balance(ws)).toBe(start);
    /* Its outcome is settled: nothing is left for the platform's recovery to reconcile. */
    const intent = async (id: string) => {
      const { platformDb } = await import("../../lib/platform");
      return (await platformDb().execute({ sql: "SELECT state FROM recovery_intents WHERE id=?", args: [id] })).rows[0]?.state;
    };
    expect(await intent(agent.planEventId(asked.id))).toBe("resolved");
    /* A worker that died after reserving: the stop (nobody holding the run) releases it, unbilled. */
    const orphan = await agent.askRigAgent({ productionId: "prod-1", draftId: "draft-1", userId: OWNER, requestId: rid(), goal: "Two shots.", limit: 500 });
    await reserveGenerationSpend({ id: agent.planEventId(orphan.id), kind: "text", engine: "vercel", model: MOCK_PLANNER_MODEL, status: "running", engineCostUsd: 0.2, createdBy: OWNER },
      { run: { id: orphan.id, limitCredits: 500, band: 1 } });
    await db().execute({ sql: "UPDATE rig_agent_runs SET plan_charge='reserved',planning_started_at=? WHERE id=?", args: [Date.now(), orphan.id] });
    expect(await balance(ws)).toBeLessThan(start);
    expect(await intent(agent.planEventId(orphan.id))).toBe("accepted");
    await agent.stopRigAgent({ productionId: "prod-1", runId: orphan.id, userId: TEAMMATE });
    expect(await meterRow(agent.planEventId(orphan.id))).toMatchObject({ status: "failed", credits: 0 });
    expect(await intent(agent.planEventId(orphan.id))).toBe("resolved");
    expect(await balance(ws)).toBe(start);
    /* The cron finds one whose release did not happen (the run already ended, nobody holds it). */
    const late = await agent.askRigAgent({ productionId: "prod-1", draftId: "draft-1", userId: OWNER, requestId: rid(), goal: "Two shots.", limit: 500 });
    await reserveGenerationSpend({ id: agent.planEventId(late.id), kind: "text", engine: "vercel", model: MOCK_PLANNER_MODEL, status: "running", engineCostUsd: 0.2, createdBy: OWNER },
      { run: { id: late.id, limitCredits: 500, band: 1 } });
    await db().execute({ sql: "UPDATE rig_agent_runs SET plan_charge='reserved',state='stopped',updated_at=0 WHERE id=?", args: [late.id] });
    expect(await agent.drainRigAgentWakeups()).toMatchObject({ released: 1 });
    expect(await meterRow(agent.planEventId(late.id))).toMatchObject({ status: "failed", credits: 0 });
    expect(await intent(agent.planEventId(late.id))).toBe("resolved");
    expect(await balance(ws)).toBe(start);
  });
});

/* ── Ask: each render waits for one tap ───────────────────────────────── */

test("Ask: after the build each render is priced and waits for one tap by the person who asked; nothing is reserved or sent before it; takes land and the balance moves by what they settled at", async () => {
  await inRun("ask", async (ws) => {
    const agent = await import("../../lib/workbench/rig-agent");
    const { requestKeyFor } = await import("../../lib/workbench/rig-agent-runs");
    const { agentNodeId } = await import("../../lib/workbench/rig-agent-plan");
    const r = renders(ws, (shot) => (shot === "1" ? 0.3 : 0.45));
    const deps = await depsFor(ws, r);
    const runId = await approvedRun(deps, { limit: 500 });
    const afterPlan = await balance(ws);
    /* The build lands, then the first render is priced and waits. */
    expect(await agent.advanceRigAgentRun(runId, deps)).toEqual({ state: "needs_you", more: false });
    let run = await view();
    expect(run.built).toEqual({ cards: 4, wires: 4 });
    expect(run.paid.map((p) => [p.tool, p.title, p.state])).toEqual([
      ["render", "01 — Opening", "waiting"], ["verify", "01 — Opening", "next"], ["render", "02 — The turn", "next"], ["verify", "02 — The turn", "next"],
    ]);
    const first = run.paid[0];
    expect(first).toMatchObject({ quote: await credits(0.3), canRender: true, pause: null });
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(run.reason).toBe(`01 — Opening is ready to render · about ${creditFigure(await credits(0.3))} cr.`);
    /* The check of a take is shown and never charged until verify lands. */
    expect(run.paid[1]).toMatchObject({ reason: "Verify arrives in the next update.", charged: null, canRender: false });
    /* A teammate sees it waiting, and may not tap it. */
    expect((await view(TEAMMATE)).paid[0].canRender).toBe(false);
    await expect(agent.renderRigAgentStep({ productionId: "prod-1", runId, seq: first.seq, fingerprint: first.fingerprint, userId: TEAMMATE })).rejects.toMatchObject({ status: 403 });
    /* Nothing was sent or reserved: no take, no admission, the balance as planning left it. */
    expect(r.calls).toEqual([]);
    expect(await renderRows()).toEqual([]);
    expect(await balance(ws)).toBe(afterPlan);
    /* A tap at a price the card no longer shows is refused. */
    await expect(agent.renderRigAgentStep({ productionId: "prod-1", runId, seq: first.seq, fingerprint: "0".repeat(64), userId: OWNER })).rejects.toMatchObject({ status: 409 });
    /* One tap: approved, sent under its durable key, with the run's limit on the reservation. */
    const tapped = await agent.renderRigAgentStep({ productionId: "prod-1", runId, seq: first.seq, fingerprint: first.fingerprint, userId: OWNER });
    expect(tapped.state).toBe("running");
    /* The lost reply to that tap: the same answer, approved once. */
    expect((await agent.renderRigAgentStep({ productionId: "prod-1", runId, seq: first.seq, fingerprint: first.fingerprint, userId: OWNER })).state).toBe("running");
    const tick = await agent.advanceRigAgentRun(runId, deps);
    const [job1] = await renderRows();
    expect(tick).toEqual({ state: "running", more: false, waitFor: { genId: job1.id } });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].key).toBe(requestKeyFor(runId, agentNodeId(runId, "shot-1"), 1));
    expect(r.calls[0].run).toMatchObject({ id: runId, limitCredits: 500, band: 1 });
    run = await view();
    expect(run.paid[0]).toMatchObject({ state: "rendering", canRender: false });
    expect(run.money).toMatchObject({ inFlight: await credits(0.3) });
    /* The take lands: the step records what the ledger settled, and the next render waits for its own tap. */
    await settleTake(job1.id, "succeeded", 0.3);
    expect(await agent.advanceRigAgentRun(runId, deps)).toEqual({ state: "needs_you", more: false });
    run = await view();
    expect(run.paid[0]).toMatchObject({ state: "done", charged: await credits(0.3) });
    expect(run.paid[2]).toMatchObject({ state: "waiting", quote: await credits(0.45), canRender: true });
    expect(await balance(ws)).toBe(minus(afterPlan, await credits(0.3)));
    await agent.renderRigAgentStep({ productionId: "prod-1", runId, seq: run.paid[2].seq, fingerprint: run.paid[2].fingerprint, userId: OWNER });
    await agent.advanceRigAgentRun(runId, deps);
    const job2 = (await renderRows())[1];
    await settleTake(job2.id, "succeeded", 0.45);
    expect(await agent.advanceRigAgentRun(runId, deps)).toEqual({ state: "done", more: false });
    run = await view();
    expect(run.state).toBe("done");
    expect(run.paid.filter((p) => p.tool === "render").map((p) => [p.state, p.charged])).toEqual([["done", await credits(0.3)], ["done", await credits(0.45)]]);
    const spent = (await meterRow(agent.planEventId(runId)))!.credits + (await credits(0.3)) + (await credits(0.45));
    expect(run.money).toMatchObject({ spent, inFlight: 0 });
    expect(await balance(ws)).toBe(minus(afterPlan, await credits(0.3), await credits(0.45)));
    /* Every paid action carries the run's id: the planning turn and both takes. */
    const { runCharges } = await import("../../lib/generationRequests");
    expect((await runCharges(runId)).map((c) => c.id).sort()).toEqual([agent.planEventId(runId), job1.id, job2.id].sort());
  });
});

test("the durable request key is saved on the step before anything is sent, and a draft is asked for where the engine has one", async () => {
  await inRun("keys", async (ws) => {
    const agent = await import("../../lib/workbench/rig-agent");
    const r = renders(ws, () => 0.3);
    const deps = await depsFor(ws, r);
    const runId = await approvedRun(deps, { limit: 500, mode: "auto", shots: 1 });
    await agent.advanceRigAgentRun(runId, deps);
    expect(r.calls).toHaveLength(1);
    /* When admission was asked, the step already held the key it was asked under, and said so. */
    expect(r.calls[0]).toMatchObject({ savedKey: r.calls[0].key, savedState: "sending" });
    const { db } = await import("../../lib/db");
    const step = (await db().execute({ sql: "SELECT admission FROM rig_agent_steps WHERE run_id=? AND purpose='take'", args: [runId] })).rows[0];
    const admission = JSON.parse(String(step.admission)) as PreparedAdmission;
    expect(admission.compiled).toMatchObject({ draft: true, resolution: "480p" });
    /* The priced request never reaches the card: only its price and fingerprint do. */
    const shown = JSON.stringify(await view());
    expect(shown).not.toContain("compiled");
    expect(shown).not.toContain("estUsd");
  });
});

/* ── Auto: under the per-job line it runs; over it, it asks ───────────── */

test("Auto: a render at or under the per-job line runs without a tap; one over it asks; a line lowered mid-run makes the next render ask", async () => {
  await inRun("auto", async (ws) => {
    const agent = await import("../../lib/workbench/rig-agent");
    const { rigJobCeiling } = await import("../../lib/workbench/rig-agent-limits");
    const { creditUsd, marginFor } = await import("../../lib/creditTerms");
    const line = await rigJobCeiling();
    /* Shot 1 costs exactly the line; shot 2 half as much again; shot 3 the line once more. */
    const atLine = (line * creditUsd()) / marginFor("mock"), over = atLine * 1.5;
    expect(await credits(atLine)).toBe(line);
    expect(await credits(over)).toBeGreaterThan(line);
    const r = renders(ws, (shot) => (shot === "2" ? over : atLine));
    let today = line;
    const deps = await depsFor(ws, r, { ceiling: async () => today });
    const runId = await approvedRun(deps, { limit: 5000, mode: "auto", shots: 3 });
    expect((await view()).money).toMatchObject({ mode: "auto", jobCeiling: line });
    /* Shot 1 costs exactly the line: it goes on its own. */
    const tick = await agent.advanceRigAgentRun(runId, deps);
    expect(tick.state).toBe("running");
    expect(r.calls).toHaveLength(1);
    await settleTake((await renderRows())[0].id, "succeeded", atLine);
    /* Shot 2 costs more than the line: it asks, and nothing is sent. */
    expect(await agent.advanceRigAgentRun(runId, deps)).toEqual({ state: "needs_you", more: false });
    let run = await view();
    expect(run.reason).toBe(`02 — The turn is about ${creditFigure(await credits(over))} cr, over the ${creditFigure(line)} cr a draft may cost without asking. Render it, skip it, or stop.`);
    expect(run.paid[2]).toMatchObject({ state: "waiting", canRender: true });
    expect(r.calls).toHaveLength(1);
    await agent.renderRigAgentStep({ productionId: "prod-1", runId, seq: run.paid[2].seq, fingerprint: run.paid[2].fingerprint, userId: OWNER });
    await agent.advanceRigAgentRun(runId, deps);
    expect(r.calls).toHaveLength(2);
    await settleTake((await renderRows())[1].id, "succeeded", over);
    /* The line is lower today than when the limit was approved: shot 3, at the old line, now asks too. */
    today = line - 0.1;
    expect(await agent.advanceRigAgentRun(runId, deps)).toEqual({ state: "needs_you", more: false });
    run = await view();
    expect(run.paid[4]).toMatchObject({ state: "waiting", canRender: true });
    expect(run.money!.jobCeiling).toBe(line);
    expect(r.calls).toHaveLength(2);
    /* Skipped: nothing is charged, and the run finishes. */
    await agent.skipRigAgentStep({ productionId: "prod-1", runId, seq: run.paid[4].seq, userId: OWNER });
    expect(await agent.advanceRigAgentRun(runId, deps)).toEqual({ state: "done", more: false });
    expect((await view()).paid[4]).toMatchObject({ state: "skipped", charged: null });
  }, 20_000);
});

test("Auto spends without a tap only on drafts: a shot moved to an engine with no draft renders in full, so it asks first, however cheap", async () => {
  await inRun("auto-full", async (ws) => {
    const agent = await import("../../lib/workbench/rig-agent");
    const { agentNodeId } = await import("../../lib/workbench/rig-agent-plan");
    const { readTeamCanvas, patchTeamCanvas } = await import("../../lib/workbench/team-canvas");
    const { db } = await import("../../lib/db");
    const r = renders(ws, () => 0.3);
    const deps = await depsFor(ws, r);
    const runId = await approvedRun(deps, { limit: 500, mode: "auto", shots: 2 });
    /* Shot 1 is a draft on the board's default engine: it goes on its own. */
    await agent.advanceRigAgentRun(runId, deps);
    expect(r.calls).toHaveLength(1);
    /* A teammate moves shot 2 to an engine with no draft before Atomik reaches it. */
    const shot2 = agentNodeId(runId, "shot-2");
    const saved = (await readTeamCanvas("prod-1"))!;
    await patchTeamCanvas("prod-1", { upsertNodes: [{ ...saved.canvas.nodes[shot2], engine: "dreamina-seedance-2-0-260128" }], fields: { [shot2]: ["engine"] }, removeNodes: [], upsertAssets: [], order: null }, TEAMMATE);
    await settleTake((await renderRows())[0].id, "succeeded", 0.3);
    expect(await agent.advanceRigAgentRun(runId, deps)).toEqual({ state: "needs_you", more: false });
    const run = await view();
    const full = run.paid.find((p) => p.tool === "render" && p.state === "waiting")!;
    expect(full.quote!).toBeLessThanOrEqual(run.money!.jobCeiling);
    expect(run.reason).toBe(`${full.title} has no draft on its engine, so Atomik asks before rendering it in full · about ${creditFigure(full.quote!)} cr. Render it, skip it, or stop.`);
    expect(r.calls).toHaveLength(1);
    const step = (await db().execute({ sql: "SELECT admission FROM rig_agent_steps WHERE run_id=? AND node_id=? AND purpose='take'", args: [runId, shot2] })).rows[0];
    expect((JSON.parse(String(step.admission)) as PreparedAdmission).request.draft).toBeUndefined();
    /* One tap from the person who asked sends it, at the price shown. */
    await agent.renderRigAgentStep({ productionId: "prod-1", runId, seq: full.seq, fingerprint: full.fingerprint, userId: OWNER });
    await agent.advanceRigAgentRun(runId, deps);
    expect(r.calls).toHaveLength(2);
  });
});

/* ── The limit: a render that would pass it pauses the run ────────────── */

test("a render that would pass the limit pauses the run (needs you) with nothing reserved; raising the limit carries on", async () => {
  await inRun("limit", async (ws) => {
    const agent = await import("../../lib/workbench/rig-agent");
    const { quotedCredits } = await import("../../lib/credits");
    const { plannerCeilingUsd } = await import("../../lib/workbench/rig-agent-planner");
    const { creditUsd, marginFor } = await import("../../lib/creditTerms");
    let renderUsd = 0.3, ceiling = 0;
    const r = renders(ws, () => renderUsd);
    const deps = await depsFor(ws, r, {
      plan: async (snapshot: BoardSnapshot) => {
        ceiling = quotedCredits(plannerCeilingUsd(MOCK_PLANNER_CATALOG, snapshot)!, "text");
        return { ...(await runPlanner(snapshot, mockPlannerModel(snapshot))), model: MOCK_PLANNER_MODEL };
      },
    });
    /* A probe plan of the same request says what planning this board costs; set aside, it builds nothing. */
    const goal = "The captain on the pier, two shots.";
    const probe = await agent.askRigAgent({ productionId: "prod-1", draftId: "draft-1", userId: OWNER, requestId: rid(), goal, limit: 5000 });
    await agent.advanceRigAgentRun(probe.id, deps);
    const planned = (await meterRow(agent.planEventId(probe.id)))!.credits;
    await agent.declineRigAgent({ productionId: "prod-1", runId: probe.id, userId: OWNER });
    /* The limit just covers planning's ceiling; each render is priced so one fits after planning and two do not. */
    const limit = ceiling;
    const each = Math.floor(limit - planned);
    expect(each).toBeGreaterThanOrEqual(1);
    renderUsd = (each * creditUsd()) / marginFor("mock");
    expect(await credits(renderUsd)).toBe(each);
    expect(planned + each).toBeLessThanOrEqual(limit);
    expect(planned + 2 * each).toBeGreaterThan(limit);
    const runId = await approvedRun(deps, { limit, mode: "auto", shots: 2 });
    expect((await meterRow(agent.planEventId(runId)))!.credits).toBe(planned);
    await agent.advanceRigAgentRun(runId, deps);
    expect(r.calls).toHaveLength(1);
    await settleTake((await renderRows())[0].id, "succeeded", renderUsd);
    /* The second would pass the limit: the run waits for a person, and nothing is reserved or sent for it. */
    expect(await agent.advanceRigAgentRun(runId, deps)).toEqual({ state: "needs_you", more: false });
    const run = await view();
    const paused = run.paid.find((p) => p.state === "paused")!;
    expect(paused).toMatchObject({ pause: "limit", canRender: true, quote: each });
    expect(run.reason).toBe(`The next render is about ${creditFigure(each)} cr; this run's limit of ${creditFigure(limit)} cr leaves about ${creditFigure(limit - planned - each)} cr. Raise the limit, skip this render, or stop.`);
    expect(r.calls).toHaveLength(1);
    expect(await renderRows()).toHaveLength(1);
    expect(run.money).toMatchObject({ spent: planned + each, inFlight: 0 });
    expect(run.money!.spent).toBeLessThanOrEqual(limit);
    /* Only the person who asked raises it, and only upward. */
    await expect(agent.raiseRigAgentLimit({ productionId: "prod-1", runId, limit: limit + 50, userId: TEAMMATE })).rejects.toMatchObject({ status: 403 });
    await expect(agent.raiseRigAgentLimit({ productionId: "prod-1", runId, limit: limit - 0.1, userId: OWNER })).rejects.toMatchObject({ status: 409 });
    const raised = await agent.raiseRigAgentLimit({ productionId: "prod-1", runId, limit: limit + 50, userId: OWNER });
    expect(raised).toMatchObject({ state: "running", money: { limit: limit + 50 } });
    const { getRun } = await import("../../lib/workbench/rig-agent-store");
    const { db } = await import("../../lib/db");
    expect((await getRun(db(), runId))!.limits.map((l) => [l.credits, l.by])).toEqual([[limit, OWNER], [limit + 50, OWNER]]);
    /* The raise is its own approval: the render goes, inside the new limit. */
    await agent.advanceRigAgentRun(runId, deps);
    expect(r.calls).toHaveLength(2);
    expect(r.calls[1].run).toMatchObject({ limitCredits: limit + 50 });
  });
});

/* ── A lost reply is asked about by its key and never replayed ────────── */

test("a lost reply is asked about by its key and never sent again: one that landed is followed; one that never arrived is fenced, and a new attempt uses a new key", async () => {
  await inRun("lost", async (ws) => {
    const agent = await import("../../lib/workbench/rig-agent");
    const { requestKeyFor } = await import("../../lib/workbench/rig-agent-runs");
    const { agentNodeId } = await import("../../lib/workbench/rig-agent-plan");
    const { withGenerationRequestData } = await import("../../lib/generationRequests");
    const { preparedClaimFingerprint } = await import("../../lib/admissionSupport");
    const { db } = await import("../../lib/db");
    const r = renders(ws, () => 0.3);
    const deps = await depsFor(ws, r);
    const runId = await approvedRun(deps, { limit: 500, mode: "auto", shots: 2 });
    const node1 = agentNodeId(runId, "shot-1"), node2 = agentNodeId(runId, "shot-2");
    /* The job was made and reserved, and the reply was lost: the step keeps its key, and nothing is sent again. */
    r.behaviour.throwAfterReply = true;
    expect(await agent.advanceRigAgentRun(runId, deps)).toEqual({ state: "running", more: false });
    expect((await view()).paid[0].state).toBe("sending");
    const [landed] = await renderRows();
    expect(await agent.advanceRigAgentRun(runId, deps)).toEqual({ state: "running", more: false, waitFor: { genId: landed.id } });
    expect(r.calls.map((c) => c.key)).toEqual([requestKeyFor(runId, node1, 1)]);
    expect((await renderRows())).toHaveLength(1);
    await settleTake(landed.id, "succeeded", 0.3);
    /* The next request never arrived (the worker died before it left): its key is fenced, and attempt 2 goes under a new key. */
    r.behaviour.throwBeforeClaim = true;
    await agent.advanceRigAgentRun(runId, deps);
    expect((await view()).paid[2].state).toBe("sending");
    await agent.advanceRigAgentRun(runId, deps);
    expect(r.calls.map((c) => c.key)).toEqual([requestKeyFor(runId, node1, 1), requestKeyFor(runId, node2, 1), requestKeyFor(runId, node2, 2)]);
    /* The fenced key answers any late arrival with its refusal, and admits nothing. */
    const step = (await db().execute({ sql: "SELECT admission FROM rig_agent_steps WHERE run_id=? AND node_id=? AND purpose='take'", args: [runId, node2] })).rows[0];
    const admission = JSON.parse(String(step.admission)) as PreparedAdmission;
    let ran = false;
    const late = await withGenerationRequestData({ userId: OWNER, key: requestKeyFor(runId, node2, 1), fingerprint: preparedClaimFingerprint(admission) }, async () => { ran = true; return Response.json({}); });
    expect(late.status).toBe(409);
    expect(ran).toBe(false);
    expect(await renderRows()).toHaveLength(2);
    /* A request still being accepted is waited for, never sent again. */
    await settleTake((await renderRows())[1].id, "succeeded", 0.3);
    expect(await agent.advanceRigAgentRun(runId, deps)).toEqual({ state: "done", more: false });
  });
});

test("a request whose claim is still being accepted is waited for, never sent again", async () => {
  await inRun("pending", async (ws) => {
    const agent = await import("../../lib/workbench/rig-agent");
    const r = renders(ws, () => 0.3);
    const deps = await depsFor(ws, r);
    const runId = await approvedRun(deps, { limit: 500, mode: "auto", shots: 1 });
    const { generationRequestsReady } = await import("../../lib/generationRequests");
    await generationRequestsReady();
    r.behaviour.pendingClaim = true;
    await agent.advanceRigAgentRun(runId, deps);
    for (let i = 0; i < 3; i++) expect(await agent.advanceRigAgentRun(runId, deps)).toEqual({ state: "running", more: false });
    expect(r.calls).toHaveLength(1);
    expect((await view()).paid[0].state).toBe("sending");
    expect(await renderRows()).toEqual([]);
  });
});

test("what a stop cannot close at once is closed later, never re-sent: a request still being accepted is closed by the cron once it is answered; a take that settled before its step knew its job is recorded at the stop", async () => {
  await inRun("closing", async (ws) => {
    const agent = await import("../../lib/workbench/rig-agent");
    const { STOPPED_UNSENT } = await import("../../lib/workbench/rig-agent-runs");
    const { STALE_CLAIM_MS, generationRequestsReady, runCharges } = await import("../../lib/generationRequests");
    const { db } = await import("../../lib/db");
    const r = renders(ws, () => 0.3);
    const deps = await depsFor(ws, r);
    await generationRequestsReady();
    /* The worker died while its request was being accepted; the run is stopped before anyone could say what became of it. */
    const pending = await approvedRun(deps, { limit: 500, mode: "auto", shots: 1 });
    r.behaviour.pendingClaim = true;
    await agent.advanceRigAgentRun(pending, deps);
    const before = await balance(ws);
    let stopped = await agent.stopRigAgent({ productionId: "prod-1", runId: pending, userId: OWNER });
    expect(stopped.state).toBe("stopped");
    expect(stopped.paid[0].state).toBe("sending");
    /* While the claim may still be answered, the cron leaves it be. */
    expect(await agent.drainRigAgentWakeups()).toMatchObject({ swept: 1 });
    expect((await view()).paid[0].state).toBe("sending");
    /* Once no request can still be running it, the cron closes it: nothing was made, sent again or charged. */
    await db().execute({ sql: "UPDATE generation_requests SET created_at=? WHERE request_key=?", args: [Date.now() - STALE_CLAIM_MS - 1000, r.calls[0].key] });
    expect(await agent.drainRigAgentWakeups()).toMatchObject({ swept: 1 });
    stopped = await view();
    expect(stopped.paid[0]).toMatchObject({ state: "skipped", reason: STOPPED_UNSENT, charged: null });
    expect(await agent.drainRigAgentWakeups()).toMatchObject({ swept: 0 });
    expect(r.calls).toHaveLength(1);
    expect(await renderRows()).toEqual([]);
    expect(await balance(ws)).toBe(before);
    expect(await runCharges(pending)).toHaveLength(1);
    /* The take landed and settled, but its reply was lost: the stop asks by the key, follows it, and records what it settled at. */
    const settledFirst = await approvedRun(deps, { limit: 500, mode: "auto", shots: 1 });
    r.behaviour.throwAfterReply = true;
    await agent.advanceRigAgentRun(settledFirst, deps);
    expect((await view()).paid[0].state).toBe("sending");
    const [take] = await renderRows();
    await settleTake(take.id, "succeeded", 0.3);
    expect((await view()).paid[0].state).toBe("sending");
    const halted = await agent.stopRigAgent({ productionId: "prod-1", runId: settledFirst, userId: OWNER });
    expect(halted.paid[0]).toMatchObject({ state: "done", charged: await credits(0.3) });
    expect(r.calls).toHaveLength(2);
    expect(await renderRows()).toHaveLength(1);
    expect(await agent.drainRigAgentWakeups()).toMatchObject({ swept: 0 });
  });
});

/* ── Failed takes record what the provider did ────────────────────────── */

test("a failed take records what the provider did with the charge — not billed, or charged — and the run carries on; the refund reaches the balance", async () => {
  await inRun("failed", async (ws) => {
    const agent = await import("../../lib/workbench/rig-agent");
    const r = renders(ws, () => 0.3);
    const deps = await depsFor(ws, r);
    const runId = await approvedRun(deps, { limit: 500, mode: "auto", shots: 2 });
    const afterPlan = await balance(ws);
    await agent.advanceRigAgentRun(runId, deps);
    const [a] = await renderRows();
    expect(await balance(ws)).toBe(minus(afterPlan, await credits(0.3)));
    /* The provider refused it and charged nothing: the reservation comes back. */
    await settleTake(a.id, "failed", 0);
    expect(await balance(ws)).toBe(afterPlan);
    await agent.advanceRigAgentRun(runId, deps);
    let run = await view();
    expect(run.paid[0]).toMatchObject({ state: "failed", outcome: "not_billed", charged: 0, charge: { credits: 0, settled: true } });
    /* The provider kept its charge for the second: the ledger shows it, and says so. */
    const b = (await renderRows())[1];
    await settleTake(b.id, "failed", 0.2);
    expect(await agent.advanceRigAgentRun(runId, deps)).toEqual({ state: "done", more: false });
    run = await view();
    expect(run.paid[2]).toMatchObject({ state: "failed", outcome: "charged", charged: await credits(0.2), charge: { credits: await credits(0.2), settled: true } });
    expect(await balance(ws)).toBe(minus(afterPlan, await credits(0.2)));
  });
});

/* ── Stop, decline: everything not sent is let go ─────────────────────── */

test("stop lets go of everything not sent: waiting renders are skipped, a key that never arrived is fenced, a render on its way settles; decline leaves only the planning charge", async () => {
  await inRun("stop", async (ws) => {
    const agent = await import("../../lib/workbench/rig-agent");
    const { runCharges } = await import("../../lib/generationRequests");
    const r = renders(ws, () => 0.3);
    const deps = await depsFor(ws, r);
    /* Ask: a render waits for its tap. Stop: nothing is sent, nothing held. */
    const waiting = await approvedRun(deps, { limit: 500, shots: 2 });
    await agent.advanceRigAgentRun(waiting, deps);
    const beforeStop = await balance(ws);
    const stopped = await agent.stopRigAgent({ productionId: "prod-1", runId: waiting, userId: TEAMMATE });
    expect(stopped.state).toBe("stopped");
    expect(stopped.paid.filter((p) => p.tool === "render").map((p) => [p.state, p.charged])).toEqual([["skipped", null], ["skipped", null]]);
    expect(stopped.money).toMatchObject({ inFlight: 0 });
    expect(r.calls).toEqual([]);
    expect(await balance(ws)).toBe(beforeStop);
    await expect(agent.renderRigAgentStep({ productionId: "prod-1", runId: waiting, seq: stopped.paid[0].seq, fingerprint: "a".repeat(64), userId: OWNER })).rejects.toMatchObject({ status: 409 });
    /* Auto: one render on its way, the next one's request lost before it left. */
    const moving = await approvedRun(deps, { limit: 500, mode: "auto", shots: 2 });
    await agent.advanceRigAgentRun(moving, deps);
    const [onItsWay] = await renderRows();
    await settleTake(onItsWay.id, "succeeded", 0.3);
    r.behaviour.throwBeforeClaim = true;
    await agent.advanceRigAgentRun(moving, deps);
    expect((await view()).paid[2].state).toBe("sending");
    const halted = await agent.stopRigAgent({ productionId: "prod-1", runId: moving, userId: OWNER });
    /* Asked about by its key at the stop: it never arrived, so it is fenced and skipped. Nothing more is sent, ever. */
    expect(halted.paid[2]).toMatchObject({ state: "skipped", charged: null });
    expect(await agent.advanceRigAgentRun(moving, deps)).toEqual({ state: "stopped", more: false });
    expect(r.calls).toHaveLength(2);
    expect((await runCharges(moving)).every((c) => !c.running)).toBe(true);
    /* A render in flight at the stop settles at what it cost, and its step records it. */
    const third = await approvedRun(deps, { limit: 500, mode: "auto", shots: 1 });
    await agent.advanceRigAgentRun(third, deps);
    const inFlight = (await renderRows()).at(-1)!;
    await agent.stopRigAgent({ productionId: "prod-1", runId: third, userId: OWNER });
    expect((await view()).paid[0].state).toBe("rendering");
    await settleTake(inFlight.id, "succeeded", 0.3);
    expect((await view()).paid[0]).toMatchObject({ state: "done", charged: await credits(0.3) });
    /* Declined: only the planning turn was charged, and nothing is reserved. */
    const asked = await agent.askRigAgent({ productionId: "prod-1", draftId: "draft-1", userId: OWNER, requestId: rid(), goal: "Two shots.", limit: 500 });
    await agent.advanceRigAgentRun(asked.id, deps);
    const declined = await agent.declineRigAgent({ productionId: "prod-1", runId: asked.id, userId: OWNER });
    expect(declined.state).toBe("stopped");
    expect((await runCharges(asked.id)).map((c) => [c.id, c.running])).toEqual([[agent.planEventId(asked.id), false]]);
  });
});

/* ── No charge without an approval that covers it ─────────────────────── */

test("no charge without an approval: a price that moved after the tap is priced again and waits for a new tap; the switch off refuses taps and pauses before the next paid step", async () => {
  await inRun("approval", async (ws) => {
    const agent = await import("../../lib/workbench/rig-agent");
    const r = renders(ws, () => 0.3);
    const deps = await depsFor(ws, r);
    const runId = await approvedRun(deps, { limit: 500, shots: 1 });
    await agent.advanceRigAgentRun(runId, deps);
    const first = (await view()).paid[0];
    await agent.renderRigAgentStep({ productionId: "prod-1", runId, seq: first.seq, fingerprint: first.fingerprint, userId: OWNER });
    /* The shot changed after the tap: admission refuses the old approval, and nothing is reserved. */
    r.priceNow.set("1", 0.9);
    expect(await agent.advanceRigAgentRun(runId, deps)).toEqual({ state: "needs_you", more: false });
    let run = await view();
    expect(run.paid[0]).toMatchObject({ state: "waiting", quote: await credits(0.9) });
    expect(run.paid[0].fingerprint).not.toBe(first.fingerprint);
    expect(await renderRows()).toEqual([]);
    expect(r.calls).toHaveLength(1);
    /* The switch off: no tap is taken, and the run pauses before its next paid step; on again, the tap sends it. */
    const previous = process.env.RIG_AGENT_ENABLED;
    process.env.RIG_AGENT_ENABLED = "0";
    try {
      await expect(agent.renderRigAgentStep({ productionId: "prod-1", runId, seq: first.seq, fingerprint: run.paid[0].fingerprint, userId: OWNER })).rejects.toMatchObject({ status: 403 });
    } finally {
      if (previous === undefined) delete process.env.RIG_AGENT_ENABLED; else process.env.RIG_AGENT_ENABLED = previous;
    }
    await agent.renderRigAgentStep({ productionId: "prod-1", runId, seq: first.seq, fingerprint: run.paid[0].fingerprint, userId: OWNER });
    process.env.RIG_AGENT_ENABLED = "0";
    try {
      expect(await agent.advanceRigAgentRun(runId, deps)).toEqual({ state: "paused", more: false });
      expect(r.calls).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env.RIG_AGENT_ENABLED; else process.env.RIG_AGENT_ENABLED = previous;
    }
    await agent.advanceRigAgentRun(runId, deps);
    expect(r.calls).toHaveLength(2);
    run = await view();
    expect(run.paid[0].state).toBe("rendering");
  });
});

/* ── Real admission (ENGINE_MOCK=1): no held take for a run, and the run's limit ── */

test("admission refuses to hold a run's take (no credits, no slot) and enforces the run's limit at the reservation; within it the reservation carries the run", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { MODELS } = await import("../../lib/models");
  const video = MODELS.find((m) => !m.hidden && m.kind === "video" && (m.supportsTasks ?? ["generate"]).includes("generate"))!;
  const body = { prompt: "A slow push in on a bottle.", model: video.id, projectId: "project", ratio: video.ratios.includes("16:9") ? "16:9" : video.ratios[0], resolution: video.resolutions[0], duration: video.durations[0], refine: false, references: [] };
  const admitIn = async (ws: TenantWorkspace, run: RunSpend, key: string) => runInTenant(ws, async () => {
    const { ready, db } = await import("../../lib/db");
    await ready();
    await db().execute("INSERT OR IGNORE INTO projects(id,name,created_at) VALUES('project','Project',0)");
    await db().execute("INSERT INTO settings(key,value,updated_at) VALUES('promptWriter','none',0) ON CONFLICT(key) DO UPDATE SET value='none'");
    const { prepareGeneration, admitGeneration } = await import("../../lib/generationAdmission");
    const prepared = await prepareGeneration(body, actorOf(OWNER));
    expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
    if (!prepared.ok) throw new Error("unpriced");
    const reply = await admitGeneration(prepared.value, actorOf(OWNER), { requestKey: key, defer: async () => {}, run });
    const rows = (await db().execute("SELECT id,status FROM generations")).rows.map((r) => ({ id: String(r.id), status: String(r.status) }));
    return { reply, rows, quote: prepared.value.quote.estimatedCredits };
  }, { user: userOf(OWNER) });
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Network forbidden in the rig runs test"); };
  try {
    /* No credits: a take the run would have left held is refused instead, and nothing is made. */
    const broke = await paidWorkspace("realbroke", 0);
    const refused = await admitIn(broke, { id: "rar_cccccccccccccccccccccccc", limitCredits: 500, band: 1 }, "rig-agent:real:broke:take:1");
    expect(refused.reply.status).toBe(402);
    expect(refused.reply.body).toMatchObject({ runHold: "credits" });
    expect(refused.rows).toEqual([]);
    /* Credits, but a run limit below the job: the reservation refuses it; the take fails unreserved and uncharged. */
    const funded = await paidWorkspace("realfunded", 5000);
    const over = await admitIn(funded, { id: "rar_dddddddddddddddddddddddd", limitCredits: 0.1, band: 1 }, "rig-agent:real:over:take:1");
    const { RUN_LIMIT_REACHED } = await import("../../lib/generationRequests");
    expect(over.reply.body).toMatchObject({ status: "failed", error: RUN_LIMIT_REACHED });
    expect(await meterRow(String(over.reply.body.id))).toBeNull();
    /* Inside the limit: admitted, and its reservation names the run. */
    const within = await admitIn(funded, { id: "rar_eeeeeeeeeeeeeeeeeeeeeeee", limitCredits: 5000, band: 1 }, "rig-agent:real:within:take:1");
    expect(within.reply.status).toBe(202);
    const { platformDb } = await import("../../lib/platform");
    const reservation = (await platformDb().execute({ sql: "SELECT run_id,run_band FROM generation_reservations WHERE id=?", args: [String(within.reply.body.id)] })).rows[0];
    expect(reservation).toMatchObject({ run_id: "rar_eeeeeeeeeeeeeeeeeeeeeeee", run_band: 1 });
    expect(await meterRow(String(within.reply.body.id))).toMatchObject({ status: "running", credits: within.quote });
  } finally {
    globalThis.fetch = fetch;
  }
});

/* ── The settlement wakes the run; Inngest waits for it ───────────────── */

test("a take's settlement records its step and wakes the run; while a render is in flight the tick asks Inngest to wait for rig/render.settled", async () => {
  const { SETTLE_MATCH } = await import("../../lib/workers");
  const { RIG_RENDER_SETTLED } = await import("../../lib/dispatch");
  expect(RIG_RENDER_SETTLED).toBe("rig/render.settled");
  expect(SETTLE_MATCH.test("gen_abc123")).toBe(true);
  expect(SETTLE_MATCH.test('gen" || true || "')).toBe(false);
  await inRun("settled", async (ws) => {
    const agent = await import("../../lib/workbench/rig-agent");
    const { db } = await import("../../lib/db");
    const r = renders(ws, () => 0.3);
    const deps = await depsFor(ws, r);
    const runId = await approvedRun(deps, { limit: 500, mode: "auto", shots: 1 });
    const tick = await agent.advanceRigAgentRun(runId, deps);
    const [job] = await renderRows();
    expect(tick.waitFor).toEqual({ genId: job.id });
    await db().execute({ sql: "UPDATE rig_agent_runs SET wake_at=? WHERE id=?", args: [Date.now() + 3_600_000, runId] });
    await settleTake(job.id, "succeeded", 0.3);
    /* The settlement brought the run's wake forward and recorded the step. */
    const wake = Number((await db().execute({ sql: "SELECT wake_at FROM rig_agent_runs WHERE id=?", args: [runId] })).rows[0].wake_at);
    expect(wake).toBeLessThanOrEqual(Date.now());
    expect((await view()).paid[0]).toMatchObject({ state: "done", charged: await credits(0.3) });
    /* The card's read, finding the wake due and nobody holding the run, claims it and nudges the run on. */
    const nudged = Number((await db().execute({ sql: "SELECT wake_at FROM rig_agent_runs WHERE id=?", args: [runId] })).rows[0].wake_at);
    expect(nudged).toBeGreaterThan(Date.now());
  });
});
