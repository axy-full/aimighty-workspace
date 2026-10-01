import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdmissionActor, AdmissionReply, PreparedAdmission } from "../../lib/admissionTypes";
import type { TenantWorkspace } from "../../lib/tenant";
import type { RunSpend } from "../../lib/runLimit";
import { getTask, hasTrigger } from "../../lib/tasks";
import { newProject, type CanvasNode, type Project } from "../../lib/workbench/studio";
import type { BoardSnapshot } from "../../lib/workbench/rig-agent-plan";
import { mockPlannerModel, runPlanner, MOCK_PLANNER_CATALOG, MOCK_PLANNER_MODEL } from "../../lib/workbench/rig-agent-planner";
import type { RigVerify } from "../../lib/workbench/rig-agent-runs";
import type { StepRow } from "../../lib/workbench/rig-agent-store";
import { VERIFY_CHECKS, type VerifyCheck, type VerifyCheckResult } from "../../lib/workbench/verify";
import {
  FIX_TABLE, MAX_AUTO_FIXES, afterCheck, chooseFix, fixMoveFor, fixSteps, fixesOf, noFixReason,
} from "../../lib/workbench/rig-agent-fixes";

/*
 * Atomik fixes a failed check, at most twice, then hands over (plan PR 11) —
 * the part that does not wait on the owner's answers: the pure fix table, the
 * fix steps' identity and keys, the per-shot waiting state (a shot whose check
 * needs a person is flagged and the run carries on with the others), and stop,
 * release and the cron's sweep for checks, fixes and a step's own paid text,
 * modelled on the planning charge.
 *
 * Every model is the scripted mock planner; renders go through a stand-in for
 * admission that makes the real durable claim and the real reservation; the
 * check of a take is a scripted seam. Nothing reaches a provider.
 */

const dir = mkdtempSync(path.join(tmpdir(), "particl-rig-fix-"));
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
const rid = () => `req-fix-${String(++requests).padStart(6, "0")}`;

const result = (check: VerifyCheck, verdict: VerifyCheckResult["verdict"], reasons: string[] = [`What the judge saw for ${check}.`]): VerifyCheckResult =>
  ({ check, verdict, score: verdict === "pass" ? 0.95 : verdict === "fail" ? 0.1 : 0.6, reasons, frame: 0 });

/* ── The fix table (pure) ─────────────────────────────────────────────── */

test("every failed check maps to an edit of the failed take, never a fresh generation: each move's words register as an edit, with the master that anchors the check", () => {
  const edit = getTask("edit");
  for (const check of VERIFY_CHECKS) for (const kind of ["image", "video"] as const) {
    const move = fixMoveFor(result(check, "fail", ["The face is a different person."]), { kind });
    expect(move, `${check}/${kind}`).not.toBeNull();
    expect(move!.source).toBe("failed-take");
    expect(move!.task).toBe(kind === "video" ? "video-edit" : "still-edit");
    expect(move!.task).not.toMatch(/generate/);
    expect(hasTrigger(edit, move!.template), `${check}/${kind}: ${move!.template}`).toBe(true);
    expect(FIX_TABLE[check][kind]).toBe(move!.move);
  }
  expect(fixMoveFor(result("identity", "fail"), { kind: "video" })).toMatchObject({ move: "replace", master: "cast" });
  expect(fixMoveFor(result("wardrobe", "fail"), { kind: "video" })).toMatchObject({ move: "wardrobe", master: "cast", template: "Change the {}'s outfit to " });
  expect(fixMoveFor(result("environment", "fail"), { kind: "image" })).toMatchObject({ move: "background", master: "environment" });
  expect(fixMoveFor(result("props", "fail", ["The lamp is brass, not green glass."]), { kind: "video" })).toMatchObject({ move: "replace", master: "element" });
  expect(fixMoveFor(result("artifacts", "fail", ["An extra finger on the left hand."]), { kind: "video" })).toMatchObject({ move: "remove", master: null });
  /* A prop the take does not show at all is added, not replaced. */
  expect(fixMoveFor(result("props", "fail", ["The lantern is missing from the table."]), { kind: "image" })!.move).toBe("add");
  expect(fixMoveFor(result("props", "fail", ["The lantern is not in the shot."]), { kind: "video" })!.move).toBe("add");
});

test("no targeted fix: flicker or morphing over time, a failed check that says nothing, and a clip the engine cannot take as an edit's source", () => {
  expect(noFixReason(result("artifacts", "fail", ["The background flickers between frames."]), { kind: "video" })).toBe("Flicker or morphing over time has no targeted fix.");
  expect(noFixReason(result("artifacts", "fail", ["The cup morphs into a bowl."]), { kind: "video" })).toBe("Flicker or morphing over time has no targeted fix.");
  /* The same words on a still are a spatial artifact: removed. */
  expect(fixMoveFor(result("artifacts", "fail", ["The cup morphs into a bowl."]), { kind: "image" })!.move).toBe("remove");
  expect(noFixReason(result("identity", "fail", []), { kind: "image" })).toMatch(/failed without saying what it saw/);
  expect(noFixReason(result("identity", "fail", ["  "]), { kind: "video" })).toMatch(/failed without saying what it saw/);
  /* The engine edits a 480p or 720p clip of 4 to 30 seconds only. */
  expect(noFixReason(result("identity", "fail"), { kind: "video", source: { resolution: "480p", duration: 5 } })).toBeNull();
  expect(noFixReason(result("identity", "fail"), { kind: "video", source: { resolution: "1080p", duration: 5 } })).toMatch(/^This take cannot be edited: The video engine only accepts 480p or 720p/);
  expect(noFixReason(result("identity", "fail"), { kind: "video", source: { resolution: "480p", duration: 3 } })).toMatch(/at least 4 seconds/);
});

test("Atomik fixes on its own only a clean fail with a targeted fix: unsure or unfixable goes to a person; one move per fix, the most important failed check first", () => {
  const video = { kind: "video" as const };
  expect(chooseFix([result("identity", "pass"), result("artifacts", "pass")], video)).toEqual({ kind: "pass" });
  expect(chooseFix([], video)).toMatchObject({ kind: "person", why: "unsure" });
  /* Unsure anywhere: strict, a person decides (even with a fixable fail beside it). */
  expect(chooseFix([result("identity", "fail"), result("wardrobe", "unsure")], video)).toMatchObject({ kind: "person", why: "unsure", check: "wardrobe", words: "Wardrobe was unsure. Look at the take and decide." });
  /* Any failed check with no targeted fix: a person, rather than a fix that cannot pass. */
  expect(chooseFix([result("identity", "fail"), result("artifacts", "fail", ["It flickers over time."])], video))
    .toMatchObject({ kind: "person", why: "no-fix", check: "artifacts", words: "Flicker or morphing over time has no targeted fix. Look at the take and decide." });
  /* Several clean fails: the most important first, with its reasons (at most three, trimmed). */
  const choice = chooseFix([result("props", "fail", ["The lamp is wrong."]), result("environment", "fail", ["Not the pier."]),
    result("identity", "fail", [" Wrong face. ", "", "Jaw differs.", "Eyes differ.", "Hair differs."])], video);
  expect(choice).toMatchObject({ kind: "fix", fix: { check: "identity", move: "replace" }, reasons: ["Wrong face.", "Jaw differs.", "Eyes differ."] });
});

test("what follows a check: a pass is done; a clean fail is fixed, at most twice on one shot; then, or when this build does not fix, a person decides", () => {
  const take = { kind: "video" as const };
  const fail = [result("identity", "fail", ["Wrong face."]), result("artifacts", "pass")];
  expect(afterCheck({ verdict: "pass", checks: [result("identity", "pass")], take, fixes: 0, canFix: true })).toEqual({ kind: "done" });
  /* The verdict is the code's; a pass whose scorecard does not agree goes to a person. */
  expect(afterCheck({ verdict: "pass", checks: fail, take, fixes: 0, canFix: true })).toMatchObject({ kind: "person", why: "unsure" });
  expect(afterCheck({ verdict: "fail", checks: fail, take, fixes: 0, canFix: true })).toMatchObject({ kind: "fix", n: 1, fix: { check: "identity", move: "replace" }, reasons: ["Wrong face."] });
  expect(afterCheck({ verdict: "fail", checks: fail, take, fixes: 1, canFix: true })).toMatchObject({ kind: "fix", n: 2 });
  expect(MAX_AUTO_FIXES).toBe(2);
  expect(afterCheck({ verdict: "fail", checks: fail, take, fixes: 2, canFix: true }))
    .toMatchObject({ kind: "person", why: "fixes-used", words: "Atomik made 2 fixes and the take still fails Identity. Look at it and decide." });
  expect(afterCheck({ verdict: "fail", checks: fail, take, fixes: 0, canFix: false })).toMatchObject({ kind: "person", why: "cannot-fix", check: "identity" });
  expect(afterCheck({ verdict: "needs_you", checks: [result("identity", "unsure")], take, fixes: 0, canFix: true })).toMatchObject({ kind: "person", why: "unsure" });
  /* A fix's steps: the fix, then the check of the fixed take; a shot's fixes are counted from its fix steps. */
  expect(fixSteps("node-a", "01 — Opening", 2)).toEqual([
    { tool: "fix", purpose: "fix", label: "Fix 2 · 01 — Opening", nodeId: "node-a", fix: 2 },
    { tool: "verify", purpose: "verify", label: "Check fix 2 · 01 — Opening", nodeId: "node-a", fix: 2 },
  ]);
  expect(() => fixSteps("node-a", "x", 0)).toThrow();
  expect(fixesOf([{ purpose: "fix", nodeId: "a", fix: 1 }, { purpose: "verify", nodeId: "a", fix: 2 }, { purpose: "fix", nodeId: "a", fix: 2 }, { purpose: "fix", nodeId: "b", fix: 1 }], "a")).toBe(2);
  expect(fixesOf([], "a")).toBe(0);
});

/* ── Keys (pure) ──────────────────────────────────────────────────────── */

test("each paid attempt has its own durable key: a render's is unchanged; a fix's names its number and its send attempt; a check's is a development request id; a fix writer's turn has its own meter event", async () => {
  const { requestKeyFor, fixRequestKey, stepRequestKey, checkRequestId } = await import("../../lib/workbench/rig-agent-runs");
  const { stepChargeEventId } = await import("../../lib/workbench/rig-agent-charges");
  const run = "rar_0123456789abcdef01234567", node = "node-0123456789abcdef";
  expect(requestKeyFor(run, node, 1)).toBe(`rig-agent:${run}:${node}:take:1`);
  expect(fixRequestKey(run, node, 1, 1)).toBe(`rig-agent:${run}:${node}:fix:1:1`);
  expect(fixRequestKey(run, node, 2, 3)).toBe(`rig-agent:${run}:${node}:fix:2:3`);
  expect(stepRequestKey(run, { purpose: "take", nodeId: node, fix: null }, 4)).toBe(requestKeyFor(run, node, 4));
  expect(stepRequestKey(run, { purpose: "fix", nodeId: node, fix: 2 }, 1)).toBe(fixRequestKey(run, node, 2, 1));
  expect(() => stepRequestKey(run, { purpose: "fix", nodeId: node, fix: null }, 1)).toThrow("A fix step carries its number.");
  expect(() => stepRequestKey(run, { purpose: "take", nodeId: null, fix: null }, 1)).toThrow();
  /* Every key is distinct, and each is one a browser could recover by too. */
  const keys = [requestKeyFor(run, node, 1), requestKeyFor(run, node, 2), fixRequestKey(run, node, 1, 1), fixRequestKey(run, node, 1, 2), fixRequestKey(run, node, 2, 1), fixRequestKey(run, "x".repeat(200), 8, 8)];
  expect(new Set(keys).size).toBe(keys.length);
  for (const key of keys) expect(key, key).toMatch(/^[A-Za-z0-9._:-]{8,160}$/);
  /* A check's job is a development job: its request id takes letters, digits, _ and - only. */
  const checks = [checkRequestId(run, node, 0, 1), checkRequestId(run, node, 0, 2), checkRequestId(run, node, 1, 1), checkRequestId(run, "node-other", 0, 1)];
  expect(new Set(checks).size).toBe(checks.length);
  for (const id of checks) expect(id, id).toMatch(/^[a-zA-Z0-9_-]{8,100}$/);
  expect(stepChargeEventId(run, 12, 1)).toBe("rigfix_0123456789abcdef01234567_12_1");
  expect(stepChargeEventId(run, 12, 2)).not.toBe(stepChargeEventId(run, 12, 1));
});

/* ── Which step moves next (pure) ─────────────────────────────────────── */

let seqs = 0;
function row(over: Partial<StepRow> & Pick<StepRow, "purpose">): StepRow {
  const seq = over.seq ?? ++seqs;
  return {
    id: `r:${seq}`, runId: "r", seq, tool: over.purpose === "take" ? "render" : over.purpose === "fix" ? "fix" : over.purpose === "verify" ? "verify" : "create",
    label: "", nodeId: null, attempt: 0, ops: [], opId: null, state: "next", result: null, requestKey: null, jobId: null, creditsReserved: null, creditsSettled: null,
    admission: null, quoteCredits: null, band: null, approvedAt: null, approvedBy: null, approvedFingerprint: null, reason: null, pause: null, settledAt: null,
    outcome: null, fix: null, chargeId: null, charge: null, updatedAt: 0, ...over,
  };
}

test("a shot whose check needs a person is passed over and the others move; the run waits only when nothing else can; every other wait still holds the whole run", async () => {
  const { nextPaidMove, waitScope } = await import("../../lib/workbench/rig-agent-runs");
  const on = { verify: true, lock: false }, off = { verify: false, lock: false };
  for (const kind of ["limit", "credits", "admin", "refused", "unpriced", "record"] as const) expect(waitScope(kind), kind).toBe("run");
  expect(waitScope("check")).toBe("shot");
  const build = row({ purpose: "build", state: "done", seq: 1 });
  const take1 = row({ purpose: "take", nodeId: "a", state: "done", seq: 2, jobId: "gen_a" });
  const check1 = row({ purpose: "verify", nodeId: "a", seq: 3, state: "paused", pause: "check", reason: "Identity failed." });
  const take2 = row({ purpose: "take", nodeId: "b", seq: 4 });
  const check2 = row({ purpose: "verify", nodeId: "b", seq: 5 });
  /* Shot a waits for a person; shot b's render moves. */
  expect(nextPaidMove([build, take1, check1, take2, check2], on)).toEqual({ kind: "step", step: take2 });
  /* Once b is done, only a's wait is left: the run waits for a person, with its reason. */
  const done2 = { ...take2, state: "done" as const, jobId: "gen_b" }, passed2 = { ...check2, state: "done" as const };
  expect(nextPaidMove([build, take1, check1, done2, passed2], on)).toEqual({ kind: "wait", step: check1 });
  /* A wait for the whole run (here the limit) is the move: the run waits for it, whatever else could go. */
  const limited = { ...take2, state: "paused" as const, pause: "limit" as const };
  expect(nextPaidMove([build, take1, check1, limited, check2], on)).toEqual({ kind: "step", step: limited });
  /* A render waiting for its tap holds the run too (Ask). */
  const tapping = { ...take2, state: "waiting" as const, reason: "02 is ready to render · about 4 cr." };
  expect(nextPaidMove([build, take1, check1, tapping, check2], on)).toEqual({ kind: "step", step: tapping });
  /* Work in flight is followed first, wherever it is in the order: one paid step in flight at a time. */
  const fixA = row({ purpose: "fix", nodeId: "a", fix: 1, seq: 6, state: "rendering", jobId: "gen_fix" });
  const checkFixA = row({ purpose: "verify", nodeId: "a", fix: 1, seq: 7 });
  const resolved1 = { ...check1, state: "done" as const };
  expect(nextPaidMove([build, take1, resolved1, take2, check2, fixA, checkFixA], on)).toEqual({ kind: "step", step: fixA });
  /* A check reads its shot's latest take: the fix, once it lands; the render's check never runs on a take that did not land. */
  const landedFix = { ...fixA, state: "done" as const };
  expect(nextPaidMove([build, take1, resolved1, done2, passed2, landedFix, checkFixA], on)).toEqual({ kind: "step", step: checkFixA });
  const failedTake = { ...take2, state: "failed" as const };
  expect(nextPaidMove([build, take1, resolved1, failedTake, check2], on)).toEqual({ kind: "done" });
  /* Without the check's seam, checks are shown and never run (as before): the run is done once its renders are. */
  expect(nextPaidMove([build, take1, row({ purpose: "verify", nodeId: "a", seq: 3 }), done2, row({ purpose: "verify", nodeId: "b", seq: 5 })], off)).toEqual({ kind: "done" });
  /* A shot's later steps wait behind its own wait; another shot's do not. */
  const fixHeld = row({ purpose: "fix", nodeId: "a", fix: 1, seq: 6, state: "approved" });
  expect(nextPaidMove([build, take1, check1, done2, passed2, fixHeld], on)).toEqual({ kind: "wait", step: check1 });
});

/* ── A paid workspace, a production, a board (as tests/unit/rigAgentRuns.spec.ts) ── */

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

async function inRun<T>(name: string, fn: (ws: TenantWorkspace) => Promise<T>, credits?: number): Promise<T> {
  const { runInTenant } = await import("../../lib/tenant");
  const ws = await paidWorkspace(name, credits);
  return runInTenant(ws, async () => { await seedBoard(); return fn(ws); });
}

/* A stand-in for admission: the real durable claim and the real reservation. */
type Behaviour = { throwBeforeClaim?: boolean; throwAfterReply?: boolean };

function renders(ws: TenantWorkspace, usdOf: (shot: string) => number) {
  const calls: { key: string; run: RunSpend | undefined; prompt: string }[] = [];
  const prepared: string[] = [];
  const behaviour: Behaviour = {};
  const shotOf = (body: Record<string, unknown>) => String(body.prompt ?? "").match(/Shot (\d+) of/)?.[1] ?? "?";
  const prepare = async (body: Record<string, unknown>, actor: AdmissionActor) => {
    const { billCredits } = await import("../../lib/creditTerms");
    const shot = shotOf(body);
    prepared.push(String(body.prompt ?? ""));
    const usd = usdOf(shot);
    const credits = billCredits(usd, "mock");
    const compiled = { model: { provider: "byteplus" }, estUsd: usd, shot, draft: body.draft === true, task: body.task ?? "generate" };
    const quote = { estimatedCredits: credits, price: credits, unit: "cr" as const };
    return { ok: true as const, value: { version: 1 as const, kind: "video" as const, workspaceId: ws.id, actorId: actor.user.id, request: { ...body, maxCredits: credits }, compiled, quote: { ...quote, fingerprint: sha({ compiled, quote }) } } satisfies PreparedAdmission };
  };
  const admit = async (admission: PreparedAdmission, actor: AdmissionActor, options: { requestKey: string; run?: RunSpend }): Promise<AdmissionReply> => {
    const { db, id, now } = await import("../../lib/db");
    const { withGenerationRequestData, bindGenerationRequestStatement, reserveGenerationSpend, SpendReservationError } = await import("../../lib/generationRequests");
    const { preparedClaimFingerprint } = await import("../../lib/admissionSupport");
    calls.push({ key: options.requestKey, run: options.run, prompt: String(admission.request.prompt ?? "") });
    if (behaviour.throwBeforeClaim) { behaviour.throwBeforeClaim = false; throw new Error("the function died before the request left"); }
    const compiled = admission.compiled as { estUsd: number };
    const response = await withGenerationRequestData({ userId: actor.user.id, key: options.requestKey, fingerprint: preparedClaimFingerprint(admission) }, async (claim) => {
      const genId = id("gen");
      await db().batch([
        { sql: "INSERT INTO generations(id,project_id,kind,model,prompt,params,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)", args: [genId, "prod-1", "video", "mock", String(admission.request.prompt ?? ""), "{}", "queued", actor.user.id, now(), now()] },
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
  return { prepare, admit, calls, prepared, behaviour };
}
type Renders = ReturnType<typeof renders>;

/** A scripted check of each take: its answers per shot, in order (the last repeats). */
function checks(answers: Record<string, Awaited<ReturnType<RigVerify>>[]>) {
  const seen: { nodeId: string; takeId: string; run: RunSpend }[] = [];
  const verify: RigVerify = async (input) => {
    seen.push({ nodeId: input.nodeId, takeId: input.takeId, run: input.run });
    const list = answers[input.nodeId] ?? [{ state: "pass", credits: 1, reason: null }];
    return list.length > 1 ? list.shift()! : list[0];
  };
  return { verify, seen };
}

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
  return (await db().execute("SELECT id,status,prompt FROM generations ORDER BY created_at, rowid")).rows.map((r) => ({ id: String(r.id), status: String(r.status), prompt: String(r.prompt) }));
};
async function meterRow(id: string) {
  const { platformDb } = await import("../../lib/platform");
  const row = (await platformDb().execute({ sql: "SELECT status,billed_credits,engine_cost_usd FROM meter_events WHERE id=?", args: [id] })).rows[0];
  return row ? { status: String(row.status), credits: Number(row.billed_credits ?? 0), usd: Number(row.engine_cost_usd ?? 0) } : null;
}
async function intent(id: string) {
  const { platformDb } = await import("../../lib/platform");
  return (await platformDb().execute({ sql: "SELECT state FROM recovery_intents WHERE id=?", args: [id] })).rows[0]?.state;
}
async function balance(ws: TenantWorkspace) {
  const { creditStateFor } = await import("../../lib/credits");
  return (await creditStateFor(ws))!.balance;
}
async function settleTake(jobId: string, status: "succeeded" | "failed", usd: number) {
  const { writeGenerationOutcome, deliverGenerationSettlement } = await import("../../lib/generationSettlement");
  await writeGenerationOutcome({ sql: "UPDATE generations SET status=?,cost_usd=?,updated_at=? WHERE id=?", args: [status, usd, Date.now(), jobId] },
    { id: jobId, kind: "video", engine: "byteplus", model: "mock", status, engineCostUsd: usd });
  await deliverGenerationSettlement(jobId);
}
const credits = async (usd: number) => (await import("../../lib/creditTerms")).billCredits(usd, "mock");
const stepsOf = async (runId: string) => {
  const store = await import("../../lib/workbench/rig-agent-store");
  const { db } = await import("../../lib/db");
  return store.stepsOf(db(), runId);
};
const stepOfNode = async (runId: string, purpose: string, nodeId: string, fix: number | null = null) =>
  (await stepsOf(runId)).find((s) => s.purpose === purpose && s.nodeId === nodeId && s.fix === fix)!;

/** The fix path is the owner's to settle (who writes the fix, at what quality): a test adds a shot's fix n as that path will, priced by the stand-in and approved. */
async function addFix(r: Renders, runId: string, nodeId: string, n: number, approve = true) {
  const { workbenchTransaction } = await import("../../lib/workbench/records");
  const { insertLiveSteps, patchStep } = await import("../../lib/workbench/rig-agent-store");
  const { db, now } = await import("../../lib/db");
  const added = await workbenchTransaction((tx) => insertLiveSteps(tx, runId, fixSteps(nodeId, "01 — Opening", n), now()));
  const priced = await r.prepare({ prompt: `Replace the face with the cast master's. Shot 1 of 1, fix ${n}.`, task: "edit", draft: true }, actorOf(OWNER));
  await patchStep(db(), added[0].id, {
    state: approve ? "approved" : "waiting", admission: priced.value, quote_credits: priced.value.quote.estimatedCredits, band: 1,
    ...(approve ? { approved_at: now(), approved_by: OWNER, approved_fingerprint: priced.value.quote.fingerprint } : {}),
  }, ["next"]);
  return added;
}

/* ── Per-shot waiting, end to end ─────────────────────────────────────── */

test("Auto: a take whose check fails flags its shot and the run carries on with the other shots; the run says it needs you once nothing else can move, never done", async () => {
  await inRun("carry-on", async (ws) => {
    const agent = await import("../../lib/workbench/rig-agent");
    const { agentNodeId } = await import("../../lib/workbench/rig-agent-plan");
    const r = renders(ws, () => 0.3);
    const box: Record<string, Awaited<ReturnType<RigVerify>>[]> = {};
    const check = checks(box);
    const d = await depsFor(ws, r, { verify: check.verify });
    const runId = await approvedRun(d, { limit: 500, mode: "auto", shots: 2 });
    const shot1 = agentNodeId(runId, "shot-1"), shot2 = agentNodeId(runId, "shot-2");
    const identity = "Identity failed: the face is not the captain's.";
    box[shot1] = [{ state: "fail", credits: 1, reason: identity, checks: [result("identity", "fail", ["Not the captain."])] }];
    box[shot2] = [{ state: "pass", credits: 1, reason: "All checks passed." }];
    /* Shot 1 renders and lands. */
    const first = await agent.advanceRigAgentRun(runId, d);
    const [job1] = await renderRows();
    expect(first).toEqual({ state: "running", more: false, waitFor: { genId: job1.id } });
    await settleTake(job1.id, "succeeded", 0.3);
    /* Its check fails: the shot is flagged for a person, and the run goes straight on to shot 2. */
    const second = await agent.advanceRigAgentRun(runId, d);
    const job2 = (await renderRows())[1];
    expect(second).toEqual({ state: "running", more: false, waitFor: { genId: job2.id } });
    let run = await view();
    expect(run.state).toBe("running");
    expect(run.paid.map((p) => [p.tool, p.state, p.pause])).toEqual([["render", "done", null], ["verify", "paused", "check"], ["render", "rendering", null], ["verify", "next", null]]);
    expect(run.paid[1]).toMatchObject({ reason: identity, charged: 1, canRender: false });
    expect(check.seen.map((c) => [c.nodeId, c.takeId])).toEqual([[shot1, job1.id]]);
    expect(check.seen[0].run).toMatchObject({ id: runId, limitCredits: 500, band: 1 });
    /* Shot 2 lands and passes: nothing else can move, so the run waits for a person — with shot 1's reason, never done. */
    await settleTake(job2.id, "succeeded", 0.3);
    expect(await agent.advanceRigAgentRun(runId, d)).toEqual({ state: "needs_you", more: false });
    run = await view();
    expect(run).toMatchObject({ state: "needs_you", reason: identity });
    expect(run.paid.map((p) => [p.tool, p.state])).toEqual([["render", "done"], ["verify", "paused"], ["render", "done"], ["verify", "done"]]);
    expect(run.paid[3]).toMatchObject({ charged: 1 });
    expect(check.seen.map((c) => c.nodeId)).toEqual([shot1, shot2]);
    /* A run that waits for a person is not ticked on by itself, and nothing more is sent. */
    expect(await agent.advanceRigAgentRun(runId, d)).toEqual({ state: "needs_you", more: false });
    expect(r.calls).toHaveLength(2);
    /* A teammate sees the flagged shot too. */
    expect((await view(TEAMMATE)).paid[1]).toMatchObject({ state: "paused", pause: "check" });
    /* Stop: the flagged check is let go, keeping what it was charged — never "nothing was charged" for a check that ran. */
    const stopped = await agent.stopRigAgent({ productionId: "prod-1", runId, userId: TEAMMATE });
    expect(stopped.paid[1]).toMatchObject({ state: "skipped", charged: 1, reason: agent.STOPPED_AFTER_SPEND });
    expect(r.calls).toHaveLength(2);
  });
});

test("Ask: a shot waiting on its check does not hold the others, but a render waiting for its tap still holds the run, as before", async () => {
  await inRun("ask-carry", async (ws) => {
    const agent = await import("../../lib/workbench/rig-agent");
    const { agentNodeId } = await import("../../lib/workbench/rig-agent-plan");
    const r = renders(ws, (shot) => (shot === "1" ? 0.3 : 0.45));
    const box: Record<string, Awaited<ReturnType<RigVerify>>[]> = {};
    const check = checks(box);
    const deps = await depsFor(ws, r, { verify: check.verify });
    const runId = await approvedRun(deps, { limit: 500, mode: "ask", shots: 2 });
    const unsure = "Wardrobe was unsure. Look at the take and decide.";
    box[agentNodeId(runId, "shot-1")] = [{ state: "needs_you", credits: 1, reason: unsure }];
    /* As before: the first render waits for its tap, and nothing else is priced meanwhile. */
    expect(await agent.advanceRigAgentRun(runId, deps)).toEqual({ state: "needs_you", more: false });
    let run = await view();
    expect(run.paid.map((p) => p.state)).toEqual(["waiting", "next", "next", "next"]);
    await agent.renderRigAgentStep({ productionId: "prod-1", runId, seq: run.paid[0].seq, fingerprint: run.paid[0].fingerprint, userId: OWNER });
    await agent.advanceRigAgentRun(runId, deps);
    await settleTake((await renderRows())[0].id, "succeeded", 0.3);
    /* Shot 1's check needs a person; shot 2 is priced and waits for its own tap — that tap is what the run waits for now. */
    expect(await agent.advanceRigAgentRun(runId, deps)).toEqual({ state: "needs_you", more: false });
    run = await view();
    expect(run.paid.map((p) => [p.state, p.pause])).toEqual([["done", null], ["paused", "check"], ["waiting", null], ["next", null]]);
    expect(run.reason).toBe(`02 — The turn is ready to render · about ${(await import("../../lib/runLimit")).creditFigure(await credits(0.45))} cr.`);
    expect(run.paid[2]).toMatchObject({ canRender: true });
    await agent.renderRigAgentStep({ productionId: "prod-1", runId, seq: run.paid[2].seq, fingerprint: run.paid[2].fingerprint, userId: OWNER });
    await agent.advanceRigAgentRun(runId, deps);
    await settleTake((await renderRows())[1].id, "succeeded", 0.45);
    /* Shot 2 passes; only shot 1's check is left, and the run waits on it. */
    expect(await agent.advanceRigAgentRun(runId, deps)).toEqual({ state: "needs_you", more: false });
    run = await view();
    expect(run).toMatchObject({ state: "needs_you", reason: unsure });
    expect(run.paid.map((p) => p.state)).toEqual(["done", "paused", "done", "done"]);
  });
});

test("a run-wide wait still holds the run while a shot is flagged: the next render over the limit pauses everything, and raising the limit carries on", async () => {
  await inRun("limit-held", async (ws) => {
    const agent = await import("../../lib/workbench/rig-agent");
    const { agentNodeId } = await import("../../lib/workbench/rig-agent-plan");
    const r = renders(ws, (shot) => (shot === "1" ? 0.3 : 100));
    const box: Record<string, Awaited<ReturnType<RigVerify>>[]> = {};
    const check = checks(box);
    const deps = await depsFor(ws, r, { verify: check.verify });
    const runId = await approvedRun(deps, { limit: 500, mode: "ask", shots: 2 });
    box[agentNodeId(runId, "shot-1")] = [{ state: "fail", credits: 0, reason: "Environment failed: not the pier." }];
    await agent.advanceRigAgentRun(runId, deps);
    let run = await view();
    await agent.renderRigAgentStep({ productionId: "prod-1", runId, seq: run.paid[0].seq, fingerprint: run.paid[0].fingerprint, userId: OWNER });
    await agent.advanceRigAgentRun(runId, deps);
    await settleTake((await renderRows())[0].id, "succeeded", 0.3);
    /* Shot 1 is flagged; shot 2 would pass the run's limit: the run waits on the limit, with nothing reserved for shot 2. */
    expect(await agent.advanceRigAgentRun(runId, deps)).toEqual({ state: "needs_you", more: false });
    run = await view();
    expect(run.paid.map((p) => [p.state, p.pause])).toEqual([["done", null], ["paused", "check"], ["paused", "limit"], ["next", null]]);
    expect(run.reason).toMatch(/^The next render is about .* cr; this run's limit of 500 cr leaves about/);
    expect(r.calls).toHaveLength(1);
    /* Raised: shot 2 is priced within it and waits for its tap (Ask); the flagged shot still waits beside it. */
    await agent.raiseRigAgentLimit({ productionId: "prod-1", runId, limit: 500 + (await credits(100)) + 10, userId: OWNER });
    expect(await agent.advanceRigAgentRun(runId, deps)).toEqual({ state: "needs_you", more: false });
    run = await view();
    expect(run.paid.map((p) => [p.state, p.pause])).toEqual([["done", null], ["paused", "check"], ["waiting", null], ["next", null]]);
    await agent.renderRigAgentStep({ productionId: "prod-1", runId, seq: run.paid[2].seq, fingerprint: run.paid[2].fingerprint, userId: OWNER });
    await agent.advanceRigAgentRun(runId, deps);
    expect(r.calls).toHaveLength(2);
    expect((await view()).paid.map((p) => p.state)).toEqual(["done", "paused", "rendering", "next"]);
  }, 100_000);
});

/* ── Fix steps: identity, keys, sends ─────────────────────────────────── */

test("a shot's fix and the check of it are added once, after every step the run has, whatever asks twice", async () => {
  await inRun("live-steps", async (ws) => {
    const { agentNodeId } = await import("../../lib/workbench/rig-agent-plan");
    const { workbenchTransaction } = await import("../../lib/workbench/records");
    const { insertLiveSteps } = await import("../../lib/workbench/rig-agent-store");
    const { db, now } = await import("../../lib/db");
    const r = renders(ws, () => 0.3);
    const runId = await approvedRun(await depsFor(ws, r), { limit: 500, mode: "ask", shots: 2 });
    const before = await stepsOf(runId);
    const top = Math.max(...before.map((s) => s.seq));
    const shot1 = agentNodeId(runId, "shot-1");
    const first = await workbenchTransaction((tx) => insertLiveSteps(tx, runId, fixSteps(shot1, "01 — Opening", 1), now()));
    expect(first.map((s) => [s.seq, s.purpose, s.tool, s.fix, s.state, s.label])).toEqual([
      [top + 1, "fix", "fix", 1, "next", "Fix 1 · 01 — Opening"], [top + 2, "verify", "verify", 1, "next", "Check fix 1 · 01 — Opening"],
    ]);
    /* Asked again (a retried tick): the same steps, nothing added. */
    const again = await workbenchTransaction((tx) => insertLiveSteps(tx, runId, fixSteps(shot1, "01 — Opening", 1), now()));
    expect(again.map((s) => s.id)).toEqual(first.map((s) => s.id));
    expect(await stepsOf(runId)).toHaveLength(before.length + 2);
    /* The second fix comes after. */
    const second = await workbenchTransaction((tx) => insertLiveSteps(tx, runId, fixSteps(shot1, "01 — Opening", 2), now()));
    expect(second.map((s) => [s.seq, s.fix])).toEqual([[top + 3, 2], [top + 4, 2]]);
    /* The database itself refuses a second fix 1 for the shot. */
    await expect(db().execute({ sql: "INSERT INTO rig_agent_steps(id,run_id,seq,tool,label,purpose,node_id,attempt,prepared,state,fix,created_at,updated_at) VALUES(?,?,?,?,?,?,?,0,'[]','next',1,0,0)",
      args: [`${runId}:999`, runId, 999, "fix", "dup", "fix", shot1] })).rejects.toThrow(/UNIQUE/);
    /* The view shows a fix as its own step, with its number, and nobody can tap it yet. */
    const shown = (await view()).paid.filter((p) => p.fix != null);
    expect(shown.map((p) => [p.tool, p.fix, p.state, p.canRender])).toEqual([["fix", 1, "next", false], ["verify", 1, "next", false], ["fix", 2, "next", false], ["verify", 2, "next", false]]);
  });
});

test("a fix is sent under its own key per attempt and never replayed: a lost reply is followed by its key; one that never arrived is fenced and the next attempt uses a new key; the fixed take is what its check reads", async () => {
  await inRun("fix-keys", async (ws) => {
    const agent = await import("../../lib/workbench/rig-agent");
    const { agentNodeId } = await import("../../lib/workbench/rig-agent-plan");
    const { requestKeyFor, fixRequestKey } = await import("../../lib/workbench/rig-agent-runs");
    const { patchStep } = await import("../../lib/workbench/rig-agent-store");
    const { withGenerationRequestData } = await import("../../lib/generationRequests");
    const { preparedClaimFingerprint } = await import("../../lib/admissionSupport");
    const { db } = await import("../../lib/db");
    const r = renders(ws, () => 0.3);
    const box: Record<string, Awaited<ReturnType<RigVerify>>[]> = {};
    const check = checks(box);
    const deps = await depsFor(ws, r, { verify: check.verify });
    const runId = await approvedRun(deps, { limit: 500, mode: "auto", shots: 1 });
    const shot1 = agentNodeId(runId, "shot-1");
    box[shot1] = [{ state: "fail", credits: 1, reason: "Identity failed." }, { state: "pass", credits: 1, reason: "Fixed." }];
    await agent.advanceRigAgentRun(runId, deps);
    const [take] = await renderRows();
    await settleTake(take.id, "succeeded", 0.3);
    expect(await agent.advanceRigAgentRun(runId, deps)).toEqual({ state: "needs_you", more: false });
    /* The fix path (the owner's to settle) marks the failed check as handled and adds fix 1, approved at its price. */
    await patchStep(db(), (await stepOfNode(runId, "verify", shot1)).id, { state: "done" }, ["paused"]);
    await addFix(r, runId, shot1, 1);
    await db().execute({ sql: "UPDATE rig_agent_runs SET state='running',reason=NULL WHERE id=?", args: [runId] });
    /* Its reply is lost: the step keeps its key, and the next tick follows the job it made — nothing is sent twice. */
    r.behaviour.throwAfterReply = true;
    expect(await agent.advanceRigAgentRun(runId, deps)).toEqual({ state: "running", more: false });
    expect((await stepOfNode(runId, "fix", shot1, 1)).state).toBe("sending");
    const fixJob = (await renderRows())[1];
    expect(fixJob.prompt).toMatch(/^Replace the face/);
    expect(await agent.advanceRigAgentRun(runId, deps)).toEqual({ state: "running", more: false, waitFor: { genId: fixJob.id } });
    expect(r.calls.map((c) => c.key)).toEqual([requestKeyFor(runId, shot1, 1), fixRequestKey(runId, shot1, 1, 1)]);
    expect(r.calls[1].run).toMatchObject({ id: runId, limitCredits: 500, band: 1 });
    expect(await renderRows()).toHaveLength(2);
    /* The fixed take lands; its check reads the fixed take, not the failed one; it passes and the run is done. */
    await settleTake(fixJob.id, "succeeded", 0.3);
    expect(await agent.advanceRigAgentRun(runId, deps)).toEqual({ state: "done", more: false });
    expect(check.seen.map((c) => c.takeId)).toEqual([take.id, fixJob.id]);
    const run = await view();
    expect(run.paid.map((p) => [p.tool, p.fix, p.state])).toEqual([["render", null, "done"], ["verify", null, "done"], ["fix", 1, "done"], ["verify", 1, "done"]]);
    expect(run.paid[2]).toMatchObject({ charged: await credits(0.3) });
    /* Every paid action carries the run's id. */
    const { runCharges } = await import("../../lib/generationRequests");
    expect((await runCharges(runId)).map((c) => c.id)).toEqual(expect.arrayContaining([take.id, fixJob.id]));
    /* A second shot's fix whose request never left: fenced, then sent again under a new key. */
    const lost = await approvedRun(deps, { limit: 500, mode: "auto", shots: 1 });
    const node = agentNodeId(lost, "shot-1");
    box[node] = [{ state: "fail", credits: 0, reason: "Identity failed." }];
    await agent.advanceRigAgentRun(lost, deps);
    await settleTake((await renderRows())[2].id, "succeeded", 0.3);
    await agent.advanceRigAgentRun(lost, deps);
    await patchStep(db(), (await stepOfNode(lost, "verify", node)).id, { state: "done" }, ["paused"]);
    await addFix(r, lost, node, 1);
    await db().execute({ sql: "UPDATE rig_agent_runs SET state='running',reason=NULL WHERE id=?", args: [lost] });
    r.behaviour.throwBeforeClaim = true;
    await agent.advanceRigAgentRun(lost, deps);
    expect((await stepOfNode(lost, "fix", node, 1)).state).toBe("sending");
    await agent.advanceRigAgentRun(lost, deps);
    expect(r.calls.slice(-2).map((c) => c.key)).toEqual([fixRequestKey(lost, node, 1, 1), fixRequestKey(lost, node, 1, 2)]);
    /* The fenced key answers any late arrival with its refusal, and admits nothing. */
    const fixStep = await stepOfNode(lost, "fix", node, 1);
    let ran = false;
    const late = await withGenerationRequestData({ userId: OWNER, key: fixRequestKey(lost, node, 1, 1), fingerprint: preparedClaimFingerprint(fixStep.admission!) }, async () => { ran = true; return Response.json({}); });
    expect(late.status).toBe(409);
    expect(ran).toBe(false);
    expect(fixStep).toMatchObject({ attempt: 2, requestKey: fixRequestKey(lost, node, 1, 2), state: "rendering" });
  });
});

test("a fix is never priced as a fresh render of its shot, and Auto never sends a fix without a tap", async () => {
  await inRun("fix-guards", async (ws) => {
    const agent = await import("../../lib/workbench/rig-agent");
    const { agentNodeId } = await import("../../lib/workbench/rig-agent-plan");
    const { patchStep } = await import("../../lib/workbench/rig-agent-store");
    const { workbenchTransaction } = await import("../../lib/workbench/records");
    const { insertLiveSteps } = await import("../../lib/workbench/rig-agent-store");
    const { db, now } = await import("../../lib/db");
    const { creditFigure } = await import("../../lib/runLimit");
    const r = renders(ws, () => 0.3);
    const box: Record<string, Awaited<ReturnType<RigVerify>>[]> = {};
    const deps = await depsFor(ws, r, { verify: checks(box).verify });
    const runId = await approvedRun(deps, { limit: 500, mode: "auto", shots: 1 });
    const shot1 = agentNodeId(runId, "shot-1");
    box[shot1] = [{ state: "fail", credits: 0, reason: "Identity failed." }];
    await agent.advanceRigAgentRun(runId, deps);
    await settleTake((await renderRows())[0].id, "succeeded", 0.3);
    await agent.advanceRigAgentRun(runId, deps);
    await patchStep(db(), (await stepOfNode(runId, "verify", shot1)).id, { state: "done" }, ["paused"]);
    /* A fix step with no edit written for it yet: it waits for a person, and nothing prices the shot afresh. */
    await workbenchTransaction((tx) => insertLiveSteps(tx, runId, fixSteps(shot1, "01 — Opening", 1), now()));
    await db().execute({ sql: "UPDATE rig_agent_runs SET state='running',reason=NULL WHERE id=?", args: [runId] });
    const pricedBefore = r.prepared.length;
    expect(await agent.advanceRigAgentRun(runId, deps)).toEqual({ state: "needs_you", more: false });
    expect(r.prepared).toHaveLength(pricedBefore);
    expect(await stepOfNode(runId, "fix", shot1, 1)).toMatchObject({ state: "paused", pause: "check", admission: null });
    await agent.stopRigAgent({ productionId: "prod-1", runId, userId: OWNER });
    /* A priced fix in Auto, a draft under the line: it still waits for a tap (whether Auto may fix on its own is the owner's call). */
    const second = await approvedRun(deps, { limit: 500, mode: "auto", shots: 1 });
    const node = agentNodeId(second, "shot-1");
    box[node] = [{ state: "fail", credits: 0, reason: "Identity failed." }];
    await agent.advanceRigAgentRun(second, deps);
    await settleTake((await renderRows())[1].id, "succeeded", 0.3);
    await agent.advanceRigAgentRun(second, deps);
    await patchStep(db(), (await stepOfNode(second, "verify", node)).id, { state: "done" }, ["paused"]);
    await addFix(r, second, node, 1, false);
    await db().execute({ sql: "UPDATE rig_agent_runs SET state='running',reason=NULL WHERE id=?", args: [second] });
    const sent = r.calls.length;
    expect(await agent.advanceRigAgentRun(second, deps)).toEqual({ state: "needs_you", more: false });
    expect(r.calls).toHaveLength(sent);
    expect((await view()).reason).toBe(`Fix 1 for 01 — Opening is ready to render · about ${creditFigure(await credits(0.3))} cr.`);
    expect(await stepOfNode(second, "fix", node, 1)).toMatchObject({ state: "waiting", approvedBy: null });
  });
});

/* ── Stop and the cron: checks and fixes ──────────────────────────────── */

test("stop lets go of every check and fix not sent; a fix whose request never left is fenced; a fix in flight settles at what it cost", async () => {
  await inRun("stop-fixes", async (ws) => {
    const agent = await import("../../lib/workbench/rig-agent");
    const { agentNodeId } = await import("../../lib/workbench/rig-agent-plan");
    const { STOPPED_UNSENT, fixRequestKey } = await import("../../lib/workbench/rig-agent-runs");
    const { patchStep } = await import("../../lib/workbench/rig-agent-store");
    const { checkGenerationRequest } = await import("../../lib/generationRequests");
    const { preparedClaimFingerprint } = await import("../../lib/admissionSupport");
    const { db } = await import("../../lib/db");
    const r = renders(ws, () => 0.3);
    const box: Record<string, Awaited<ReturnType<RigVerify>>[]> = {};
    const deps = await depsFor(ws, r, { verify: checks(box).verify });
    /* Fix 1 approved, fix 2 waiting, checks not run: a stop lets all of them go, nothing charged. */
    const quiet = await approvedRun(deps, { limit: 500, mode: "auto", shots: 1 });
    const shotQ = agentNodeId(quiet, "shot-1");
    box[shotQ] = [{ state: "fail", credits: 0, reason: "Identity failed." }];
    await agent.advanceRigAgentRun(quiet, deps);
    await settleTake((await renderRows())[0].id, "succeeded", 0.3);
    await agent.advanceRigAgentRun(quiet, deps);
    await addFix(r, quiet, shotQ, 1);
    await addFix(r, quiet, shotQ, 2, false);
    const beforeStop = await balance(ws);
    const stopped = await agent.stopRigAgent({ productionId: "prod-1", runId: quiet, userId: TEAMMATE });
    expect(stopped.paid.map((p) => [p.tool, p.fix, p.state])).toEqual([
      ["render", null, "done"], ["verify", null, "skipped"], ["fix", 1, "skipped"], ["verify", 1, "skipped"], ["fix", 2, "skipped"], ["verify", 2, "skipped"],
    ]);
    /* The fixes were never sent: nothing charged for them. (The failed check keeps what it was charged.) */
    expect(stopped.paid.filter((p) => p.tool === "fix").map((p) => [p.charged, p.charge])).toEqual([[null, null], [null, null]]);
    expect(stopped.paid[1]).toMatchObject({ tool: "verify", charged: 0, reason: agent.STOPPED_AFTER_SPEND });
    expect((await stepOfNode(quiet, "fix", shotQ, 1)).reason).toBe(STOPPED_UNSENT);
    expect(await balance(ws)).toBe(beforeStop);
    /* A fix whose request never left: the stop asks by its key, fences it, and lets it go; nothing is sent again. */
    const lost = await approvedRun(deps, { limit: 500, mode: "auto", shots: 1 });
    const shotL = agentNodeId(lost, "shot-1");
    box[shotL] = [{ state: "fail", credits: 0, reason: "Identity failed." }];
    await agent.advanceRigAgentRun(lost, deps);
    await settleTake((await renderRows())[1].id, "succeeded", 0.3);
    await agent.advanceRigAgentRun(lost, deps);
    await patchStep(db(), (await stepOfNode(lost, "verify", shotL)).id, { state: "done" }, ["paused"]);
    await addFix(r, lost, shotL, 1);
    await db().execute({ sql: "UPDATE rig_agent_runs SET state='running',reason=NULL WHERE id=?", args: [lost] });
    r.behaviour.throwBeforeClaim = true;
    await agent.advanceRigAgentRun(lost, deps);
    expect((await stepOfNode(lost, "fix", shotL, 1)).state).toBe("sending");
    const sent = r.calls.length;
    await agent.stopRigAgent({ productionId: "prod-1", runId: lost, userId: OWNER });
    expect(await stepOfNode(lost, "fix", shotL, 1)).toMatchObject({ state: "skipped", reason: STOPPED_UNSENT });
    const fixStep = await stepOfNode(lost, "fix", shotL, 1);
    expect(await checkGenerationRequest({ userId: OWNER, key: fixRequestKey(lost, shotL, 1, 1), fingerprint: preparedClaimFingerprint(fixStep.admission!) })).toEqual({ state: "absent" });
    expect(await agent.advanceRigAgentRun(lost, deps)).toEqual({ state: "stopped", more: false });
    expect(r.calls).toHaveLength(sent);
    /* A fix in flight at the stop settles at what it cost, and its step records it. */
    const flying = await approvedRun(deps, { limit: 500, mode: "auto", shots: 1 });
    const shotF = agentNodeId(flying, "shot-1");
    box[shotF] = [{ state: "fail", credits: 0, reason: "Identity failed." }];
    await agent.advanceRigAgentRun(flying, deps);
    await settleTake((await renderRows()).at(-1)!.id, "succeeded", 0.3);
    await agent.advanceRigAgentRun(flying, deps);
    await patchStep(db(), (await stepOfNode(flying, "verify", shotF)).id, { state: "done" }, ["paused"]);
    await addFix(r, flying, shotF, 1);
    await db().execute({ sql: "UPDATE rig_agent_runs SET state='running',reason=NULL WHERE id=?", args: [flying] });
    await agent.advanceRigAgentRun(flying, deps);
    const fixJob = (await renderRows()).at(-1)!;
    await agent.stopRigAgent({ productionId: "prod-1", runId: flying, userId: OWNER });
    expect((await stepOfNode(flying, "fix", shotF, 1)).state).toBe("rendering");
    await settleTake(fixJob.id, "succeeded", 0.3);
    expect(await stepOfNode(flying, "fix", shotF, 1)).toMatchObject({ state: "done", creditsSettled: await credits(0.3) });
  });
});

test("a check in flight when its run stops is followed through its development job, never started again: never started, still admitted, running, settled, refused, failed", async () => {
  await inRun("stop-checks", async (ws) => {
    const agent = await import("../../lib/workbench/rig-agent");
    const { agentNodeId } = await import("../../lib/workbench/rig-agent-plan");
    const { STOPPED_UNSENT, checkRequestId } = await import("../../lib/workbench/rig-agent-runs");
    const { insertLiveSteps, patchStep } = await import("../../lib/workbench/rig-agent-store");
    const { workbenchTransaction } = await import("../../lib/workbench/records");
    const { developmentReady } = await import("../../lib/workbench/development-server");
    const { reserveGenerationSpend } = await import("../../lib/generationRequests");
    const { meter } = await import("../../lib/meter");
    const { db, now } = await import("../../lib/db");
    const r = renders(ws, () => 0.3);
    const deps = await depsFor(ws, r);
    const runId = await approvedRun(deps, { limit: 500, mode: "ask", shots: 1 });
    const shot = agentNodeId(runId, "shot-1");
    await developmentReady();
    /* Seven checks of the shot (as the verify path will record them), each in a different place. */
    const made = await workbenchTransaction((tx) => insertLiveSteps(tx, runId,
      [1, 2, 3, 4, 5, 6, 7].map((n) => ({ tool: "verify" as const, purpose: "verify" as const, label: `Check fix ${n} · 01 — Opening`, nodeId: shot, fix: n })), now()));
    const job = async (id: string, requestId: string, status: string, settled: boolean) => db().execute({
      sql: `INSERT INTO workbench_development_jobs(id,owner,project_id,production_project_id,request_id,fingerprint,request_body,source_hash,snapshot,model_body,chunks,status,estimate_usd,estimate_credits,funded_by_platform,settled,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)`,
      args: [id, OWNER, "draft-1", "prod-1", requestId, "f", JSON.stringify({ kind: "verify", model: MOCK_PLANNER_MODEL }), "s", "{}", "{}", "[]", status, 0.2, 2, settled ? 1 : 0, now(), now()],
    });
    const charge = async (id: string, usd: number, end: "running" | "succeeded" | "failed") => {
      await reserveGenerationSpend({ id, kind: "text", engine: "vercel", model: MOCK_PLANNER_MODEL, status: "running", engineCostUsd: 0.2, projectId: "prod-1", createdBy: OWNER },
        { run: { id: runId, limitCredits: 500, band: 1 } });
      if (end !== "running") await meter({ id, kind: "text", engine: "vercel", model: MOCK_PLANNER_MODEL, status: end, engineCostUsd: usd, projectId: "prod-1", createdBy: OWNER, ...(end === "failed" ? { unbilled: true } : {}) }, { critical: true });
    };
    const ids = (n: number) => ({ request: checkRequestId(runId, shot, n, 1), job: `wb_development_00000000-0000-4000-8000-00000000000${n}` });
    const place = async (n: number, state: "sending" | "rendering", withJob: boolean) =>
      patchStep(db(), made[n - 1].id, { state, request_key: n === 7 ? null : ids(n).request, attempt: 1, ...(state === "rendering" && withJob ? { job_id: ids(n).job } : {}) }, ["next"]);
    /* 1: its request id saved, no job: never started. */
    await place(1, "sending", false);
    /* 2: its job still being admitted. */
    await place(2, "sending", false); await job(ids(2).job, ids(2).request, "queued", false);
    /* 3: running. */
    await place(3, "rendering", true); await job(ids(3).job, ids(3).request, "running", false); await charge(ids(3).job, 0, "running");
    /* 4: finished and settled at what it used. */
    await place(4, "rendering", true); await job(ids(4).job, ids(4).request, "succeeded", true); await charge(ids(4).job, 0.05, "succeeded");
    /* 5: refused at its reservation (nothing reserved). */
    await place(5, "rendering", true); await job(ids(5).job, ids(5).request, "failed", true);
    /* 6: failed, released unbilled. */
    await place(6, "rendering", true); await job(ids(6).job, ids(6).request, "failed", true); await charge(ids(6).job, 0.2, "failed");
    /* 7: marked as being sent with no request id: its record is incomplete. */
    await place(7, "sending", false);
    await agent.stopRigAgent({ productionId: "prod-1", runId, userId: OWNER });
    const state = async (n: number) => {
      const s = (await stepsOf(runId)).find((x) => x.id === made[n - 1].id)!;
      return { state: s.state, pause: s.pause, jobId: s.jobId, charged: s.creditsSettled, outcome: s.outcome, reason: s.reason };
    };
    const used = (await meterRow(ids(4).job))!.credits;
    expect(await state(1)).toMatchObject({ state: "skipped", reason: STOPPED_UNSENT });
    expect(await state(2)).toMatchObject({ state: "sending" });
    expect(await state(3)).toMatchObject({ state: "rendering", jobId: ids(3).job });
    expect(await state(4)).toMatchObject({ state: "done", charged: used, outcome: null });
    expect(await state(5)).toMatchObject({ state: "skipped", reason: STOPPED_UNSENT });
    expect(await state(6)).toMatchObject({ state: "failed", outcome: "not_billed", charged: 0 });
    expect(await state(7)).toMatchObject({ state: "paused", pause: "record" });
    /* The cron finds what is still open, and closes it once its job has ended: free reads, nothing started again. */
    expect(await agent.drainRigAgentWakeups()).toMatchObject({ swept: 1 });
    expect(await state(2)).toMatchObject({ state: "sending" });
    await db().execute({ sql: "UPDATE workbench_development_jobs SET status='failed',settled=1 WHERE id=?", args: [ids(2).job] });
    await db().execute({ sql: "UPDATE workbench_development_jobs SET status='succeeded',settled=1 WHERE id=?", args: [ids(3).job] });
    await meter({ id: ids(3).job, kind: "text", engine: "vercel", model: MOCK_PLANNER_MODEL, status: "succeeded", engineCostUsd: 0.04, projectId: "prod-1", createdBy: OWNER }, { critical: true });
    expect(await agent.drainRigAgentWakeups()).toMatchObject({ swept: 1 });
    expect(await state(2)).toMatchObject({ state: "skipped", reason: STOPPED_UNSENT });
    expect(await state(3)).toMatchObject({ state: "done", charged: (await meterRow(ids(3).job))!.credits });
    expect(await agent.drainRigAgentWakeups()).toMatchObject({ swept: 0 });
    expect(r.calls).toEqual([]);
  });
});

/* ── A step's own paid text, modelled on the planning charge ──────────── */

test("a fix writer's turn is metered like planning: reserved at its ceiling inside the run's limit, refused past it with nothing reserved, settled at what it used, released unbilled when it fails", async () => {
  await inRun("step-charge", async (ws) => {
    const { agentNodeId } = await import("../../lib/workbench/rig-agent-plan");
    const charges = await import("../../lib/workbench/rig-agent-charges");
    const { workbenchTransaction } = await import("../../lib/workbench/records");
    const { insertLiveSteps, openStepCharge, getRun } = await import("../../lib/workbench/rig-agent-store");
    const { runCharges, RUN_LIMIT_REACHED } = await import("../../lib/generationRequests");
    const { quotedCredits } = await import("../../lib/credits");
    const { db, now } = await import("../../lib/db");
    const r = renders(ws, () => 0.3);
    const runId = await approvedRun(await depsFor(ws, r), { limit: 50, mode: "ask", shots: 1 });
    const run = (await getRun(db(), runId))!;
    const shot = agentNodeId(runId, "shot-1");
    const [fix1] = await workbenchTransaction((tx) => insertLiveSteps(tx, runId, fixSteps(shot, "01 — Opening", 1), now()));
    const live = async () => null;
    const turn = (attempt: number, ceilingUsd: number) => ({ id: charges.stepChargeEventId(runId, fix1.seq, attempt), engine: "vercel", model: MOCK_PLANNER_MODEL, ceilingUsd });
    const start = await balance(ws);
    /* Reserved at its ceiling, under the run's id; the step records it. */
    const first = turn(1, 0.2);
    expect(await charges.reserveStepCharge(run, fix1, first, live)).toBeNull();
    expect(await meterRow(first.id)).toMatchObject({ status: "running", credits: quotedCredits(0.2, "text") });
    expect(await stepOfNode(runId, "fix", shot, 1)).toMatchObject({ charge: "reserved", chargeId: first.id });
    expect((await runCharges(runId)).find((c) => c.id === first.id)).toMatchObject({ running: true });
    expect(await intent(first.id)).toBe("accepted");
    /* One charge at a time on a step. */
    expect(await openStepCharge(db(), fix1.id, turn(2, 0.2).id)).toBe(false);
    /* Settled at what it used, never above the ceiling. */
    expect(await charges.settleStepCharge(run, fix1, first, { billed: true, usedUsd: 0.05 })).toBe(true);
    const settled = await meterRow(first.id);
    expect(settled).toMatchObject({ status: "succeeded" });
    expect(settled!.credits).toBeGreaterThan(0);
    expect(settled!.credits).toBeLessThanOrEqual(quotedCredits(0.2, "text"));
    expect(await intent(first.id)).toBe("resolved");
    expect(await stepOfNode(runId, "fix", shot, 1)).toMatchObject({ charge: "settled" });
    expect(await balance(ws)).toBe(start - settled!.credits);
    /* A turn that fails is released unbilled. */
    const failing = turn(2, 0.2);
    expect(await charges.reserveStepCharge(run, fix1, failing, live)).toBeNull();
    expect(await charges.settleStepCharge(run, fix1, failing, { billed: false, usedUsd: 0.01 })).toBe(true);
    expect(await meterRow(failing.id)).toMatchObject({ status: "failed", credits: 0 });
    expect(await intent(failing.id)).toBe("resolved");
    expect(await stepOfNode(runId, "fix", shot, 1)).toMatchObject({ charge: "released" });
    /* Past the run's limit (here, just above what it has spent): refused, nothing reserved, the step's record released. */
    const spent = (await runCharges(runId)).reduce((sum, c) => sum + c.credits, 0);
    const over = turn(3, 0.2);
    expect(await charges.reserveStepCharge({ ...run, capCredits: spent + 0.1 }, fix1, over, live)).toBe(RUN_LIMIT_REACHED);
    expect(await meterRow(over.id)).toBeNull();
    expect(await stepOfNode(runId, "fix", shot, 1)).toMatchObject({ charge: "released", chargeId: over.id });
    /* A run that was stopped reserves nothing. */
    const late = turn(4, 0.1);
    expect(await charges.reserveStepCharge(run, fix1, late, async () => "This run was stopped. Nothing was charged.")).toBe("This run was stopped. Nothing was charged.");
    expect(await meterRow(late.id)).toBeNull();
    expect(await balance(ws)).toBe(start - settled!.credits);
  });
});

test("a step's turn left reserved is released unbilled — at the stop, by the cron for a run that ended, and by the cron for a live run nobody holds once its turn would have timed out — and never sent again", async () => {
  await inRun("step-charge-loose", async (ws) => {
    const agent = await import("../../lib/workbench/rig-agent");
    const { agentNodeId } = await import("../../lib/workbench/rig-agent-plan");
    const charges = await import("../../lib/workbench/rig-agent-charges");
    const { workbenchTransaction } = await import("../../lib/workbench/records");
    const { insertLiveSteps, openStepCharge, getRun } = await import("../../lib/workbench/rig-agent-store");
    const { db, now } = await import("../../lib/db");
    const r = renders(ws, () => 0.3);
    const deps = await depsFor(ws, r);
    const start = await balance(ws);
    const reserved = async (runId: string, n: number, attempt = 1) => {
      const run = (await getRun(db(), runId))!;
      const [fix] = await workbenchTransaction((tx) => insertLiveSteps(tx, runId, fixSteps(agentNodeId(runId, "shot-1"), "01 — Opening", n), now()));
      const id = charges.stepChargeEventId(runId, fix.seq, attempt);
      expect(await charges.reserveStepCharge(run, fix, { id, engine: "vercel", model: MOCK_PLANNER_MODEL, ceilingUsd: 0.2 }, async () => null)).toBeNull();
      return { fix, id };
    };
    const planned = async (runId: string) => (await meterRow(agent.planEventId(runId)))!.credits;
    /* The worker died mid-turn; the stop (nobody holding the run) releases it, unbilled. */
    const a = await approvedRun(deps, { limit: 500, mode: "ask", shots: 1 });
    const left = await reserved(a, 1);
    expect(await balance(ws)).toBeLessThan(start - (await planned(a)));
    await agent.stopRigAgent({ productionId: "prod-1", runId: a, userId: TEAMMATE });
    expect(await meterRow(left.id)).toMatchObject({ status: "failed", credits: 0 });
    expect(await intent(left.id)).toBe("resolved");
    expect((await stepsOf(a)).find((s) => s.id === left.fix.id)).toMatchObject({ charge: "released" });
    expect(await balance(ws)).toBe(start - (await planned(a)));
    /* A record of a turn whose reservation never landed: released, and the ledger has nothing for it. */
    const b = await approvedRun(deps, { limit: 500, mode: "ask", shots: 1 });
    const [fixB] = await workbenchTransaction((tx) => insertLiveSteps(tx, b, fixSteps(agentNodeId(b, "shot-1"), "01 — Opening", 1), now()));
    const ghost = charges.stepChargeEventId(b, fixB.seq, 1);
    expect(await openStepCharge(db(), fixB.id, ghost)).toBe(true);
    await db().execute({ sql: "UPDATE rig_agent_runs SET state='failed',updated_at=0 WHERE id=?", args: [b] });
    expect(await agent.drainRigAgentWakeups()).toMatchObject({ swept: 1 });
    expect((await stepsOf(b)).find((s) => s.id === fixB.id)).toMatchObject({ charge: "released" });
    expect(await meterRow(ghost)).toBeNull();
    /* A live run nobody holds: a fresh turn is left alone (its worker may still be in it); one older than a turn can take is released. */
    const c = await approvedRun(deps, { limit: 500, mode: "ask", shots: 1 });
    /* (Its build is not due: this is about the cron's sweep, not its wake.) */
    await db().execute({ sql: "UPDATE rig_agent_runs SET wake_at=NULL WHERE id=?", args: [c] });
    const fresh = await reserved(c, 1);
    const stale = await reserved(c, 2);
    await db().execute({ sql: "UPDATE rig_agent_steps SET updated_at=? WHERE id=?", args: [now() - charges.PAID_TEXT_TIMEOUT_MS - 120_000, stale.fix.id] });
    const drained = await agent.drainRigAgentWakeups();
    expect(drained.released).toBeGreaterThanOrEqual(1);
    expect(await meterRow(stale.id)).toMatchObject({ status: "failed", credits: 0 });
    expect(await meterRow(fresh.id)).toMatchObject({ status: "running" });
    const steps = await stepsOf(c);
    expect(steps.find((s) => s.id === stale.fix.id)).toMatchObject({ charge: "released" });
    expect(steps.find((s) => s.id === fresh.fix.id)).toMatchObject({ charge: "reserved" });
    /* Nothing in any of this sent a render. */
    expect(r.calls).toEqual([]);
  });
});
