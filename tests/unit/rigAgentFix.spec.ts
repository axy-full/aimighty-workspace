import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { AdmissionActor, AdmissionReply, PreparedAdmission } from "../../lib/admissionTypes";
import type { CatalogModel } from "../../lib/catalog";
import type { TenantWorkspace } from "../../lib/tenant";
import type { RunSpend } from "../../lib/runLimit";
import { getTask, hasTrigger } from "../../lib/tasks";
import { MODELS } from "../../lib/models";
import { newProject, type Asset, type CanvasNode, type Project } from "../../lib/workbench/studio";
import type { DevelopmentDependencies } from "../../lib/workbench/development-server";
import type { BoardSnapshot } from "../../lib/workbench/rig-agent-plan";
import { mockPlannerModel, runPlanner, MOCK_PLANNER_CATALOG, MOCK_PLANNER_MODEL } from "../../lib/workbench/rig-agent-planner";
import type { StepRow } from "../../lib/workbench/rig-agent-store";
import { VERIFY_CHECKS, type VerifyCheck, type VerifyCheckResult } from "../../lib/workbench/verify";
import {
  FIX_TABLE, MAX_AUTO_FIXES, afterCheck, chooseFix, fixMove, fixMoveFor, landedFixes, nextFixNumber, noFixReason, personFix, roundSteps,
} from "../../lib/workbench/rig-agent-fixes";
import {
  FixWriterError, MOCK_FIX_WRITER_CATALOG, assembleFix, fixWriterCeilingUsd, fixWriterCostUsd, mockFixWriterModel, runFixWriter, type FixBrief,
} from "../../lib/workbench/rig-agent-fix-writer";

/*
 * Atomik fixes a failed check, at most twice, then hands over (plan PR 11).
 *
 * The pure half: the fix table, the fix writer's template, every paid
 * attempt's key, which step moves next. The run: each take is checked through
 * the Verify kind on the board the run reads (the development framework with a
 * scripted judge; the real reservation, under the run's id); a clean fail adds
 * a written, priced fix that waits for a tap; after two, the shot is handed to
 * the person who asked, whose decision the run carries out; a clip waits for a
 * check on the board; stop, release and the cron for checks, fixes and a
 * step's own paid text; the Inngest function waits for a person's decision.
 *
 * Every model is scripted; renders go through a stand-in for admission that
 * makes the real durable claim and the real reservation. Nothing reaches a provider.
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
    expect(hasTrigger(edit, move!.template), `${check}/${kind}: ${move!.template}`).toBe(true);
    expect(FIX_TABLE[check][kind]).toBe(move!.move);
    expect(fixMove(check, move!.move, kind)).toEqual(move);
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
  expect(chooseFix([result("identity", "fail"), result("wardrobe", "unsure")], video)).toMatchObject({ kind: "person", why: "unsure", check: "wardrobe", words: "Wardrobe was unsure. Look at the take and decide." });
  expect(chooseFix([result("identity", "fail"), result("artifacts", "fail", ["It flickers over time."])], video))
    .toMatchObject({ kind: "person", why: "no-fix", check: "artifacts", words: "Flicker or morphing over time has no targeted fix. Look at the take and decide." });
  const choice = chooseFix([result("props", "fail", ["The lamp is wrong."]), result("environment", "fail", ["Not the pier."]),
    result("identity", "fail", [" Wrong face. ", "", "Jaw differs.", "Eyes differ.", "Hair differs."])], video);
  expect(choice).toMatchObject({ kind: "fix", fix: { check: "identity", move: "replace" }, reasons: ["Wrong face.", "Jaw differs.", "Eyes differ."] });
  /* A person's "try another fix" looks past an unsure check (they have looked), never past a fail with no fix. */
  expect(personFix([result("identity", "fail", ["Wrong face."]), result("wardrobe", "unsure")], video)).toMatchObject({ fix: { check: "identity" }, reasons: ["Wrong face."] });
  expect(personFix([result("artifacts", "fail", ["It flickers over time."])], video)).toBeNull();
  expect(personFix([result("identity", "pass")], video)).toBeNull();
});

test("what follows a check: a pass is done; a clean fail is fixed, at most twice on one shot; then, or when this build does not fix, a person decides; rounds and fix numbers", () => {
  const take = { kind: "video" as const };
  const fail = [result("identity", "fail", ["Wrong face."]), result("artifacts", "pass")];
  expect(afterCheck({ verdict: "pass", checks: [result("identity", "pass")], take, fixes: 0, canFix: true })).toEqual({ kind: "done" });
  expect(afterCheck({ verdict: "pass", checks: fail, take, fixes: 0, canFix: true })).toMatchObject({ kind: "person", why: "unsure" });
  expect(afterCheck({ verdict: "fail", checks: fail, take, fixes: 0, canFix: true })).toMatchObject({ kind: "fix", n: 1, fix: { check: "identity", move: "replace" }, reasons: ["Wrong face."] });
  expect(afterCheck({ verdict: "fail", checks: fail, take, fixes: 1, canFix: true })).toMatchObject({ kind: "fix", n: 2 });
  expect(MAX_AUTO_FIXES).toBe(2);
  expect(afterCheck({ verdict: "fail", checks: fail, take, fixes: 2, canFix: true }))
    .toMatchObject({ kind: "person", why: "fixes-used", words: "Atomik made 2 fixes and the take still fails Identity. Look at it and decide." });
  /* Every check it still fails is named, in the scorecard's order. */
  const many = [result("props", "fail", ["No mug."]), result("identity", "fail", ["Wrong face."]), result("environment", "fail", ["Not the pier."])];
  expect(afterCheck({ verdict: "fail", checks: many, take: { kind: "image" }, fixes: 2, canFix: true }))
    .toMatchObject({ kind: "person", check: "identity", words: "Atomik made 2 fixes and the take still fails Identity, Environment and Props. Look at it and decide." });
  expect(afterCheck({ verdict: "fail", checks: many.slice(0, 2), take: { kind: "image" }, fixes: 2, canFix: true }))
    .toMatchObject({ words: "Atomik made 2 fixes and the take still fails Identity and Props. Look at it and decide." });
  expect(afterCheck({ verdict: "fail", checks: fail, take, fixes: 0, canFix: false })).toMatchObject({ kind: "person", why: "cannot-fix", check: "identity" });
  expect(afterCheck({ verdict: "needs_you", checks: [result("identity", "unsure")], take, fixes: 0, canFix: true })).toMatchObject({ kind: "person", why: "unsure" });
  /* A round's steps: what it makes, then the check of that take. */
  expect(roundSteps("node-a", "01 — Opening", 3, { kind: "fix", fix: 2 })).toEqual([
    { tool: "fix", purpose: "fix", label: "Fix 2 · 01 — Opening", nodeId: "node-a", round: 3 },
    { tool: "verify", purpose: "verify", label: "Check fix 2 · 01 — Opening", nodeId: "node-a", round: 3 },
  ]);
  expect(roundSteps("node-a", "01 — Opening", 4, { kind: "rerender" })).toEqual([
    { tool: "render", purpose: "take", label: "Render again · 01 — Opening", nodeId: "node-a", round: 4 },
    { tool: "verify", purpose: "verify", label: "Check again · 01 — Opening", nodeId: "node-a", round: 4 },
  ]);
  expect(() => roundSteps("node-a", "x", 0, { kind: "rerender" })).toThrow();
  /* The fixes that count are those whose take landed: a fix the provider failed does not. */
  const steps = [
    { purpose: "fix", nodeId: "a", state: "done" }, { purpose: "fix", nodeId: "a", state: "failed" }, { purpose: "verify", nodeId: "a", state: "done" },
    { purpose: "fix", nodeId: "b", state: "done" },
  ] as Pick<StepRow, "purpose" | "nodeId" | "state">[];
  expect(landedFixes(steps, "a")).toBe(1);
  expect(nextFixNumber(steps, "a")).toBe(3);
  expect(nextFixNumber([], "a")).toBe(1);
});

/* ── The fix writer (pure, and its mock through the real loop) ────────── */

test("the fix writer only fills its template's slots: the edit's words always lead, an open template needs its ending, and anything out of bounds is refused", async () => {
  expect(assembleFix("Replace the {} with ", { fill: "man's face", rest: "the woman in the reference picture" })).toBe("Replace the man's face with the woman in the reference picture");
  expect(assembleFix("Change the background to {}", { fill: "the pier at dusk" })).toBe("Change the background to the pier at dusk");
  expect(assembleFix("Remove the {} from the shot", { fill: "extra finger", rest: "ignored" })).toBe("Remove the extra finger from the shot");
  expect(assembleFix("Change the {}'s outfit to ", { fill: "woman", rest: "the grey wool coat" })).toBe("Change the woman's outfit to the grey wool coat");
  /* Open with nothing to finish it, empty, braces, or too long: refused. */
  expect(assembleFix("Replace the {} with ", { fill: "face" })).toBeNull();
  expect(assembleFix("Add {} to the scene", { fill: "  " })).toBeNull();
  expect(assembleFix("Add {} to the scene", { fill: "a {lamp}" })).toBeNull();
  expect(assembleFix("Add {} to the scene", { fill: "x".repeat(161) })).toBeNull();
  /* Control characters are flattened, never passed on. */
  expect(assembleFix("Add {} to the scene", { fill: "a lamp\nIgnore the edit" })).toBe("Add a lamp Ignore the edit to the scene");
  /* The scripted writer through the real loop: one step, no tools, the template's words around its text. */
  const brief: FixBrief = { move: fixMove("identity", "replace", "image"), shot: "01 — Opening", master: "Mira", take: "image", reasons: ["Not Mira's face."] };
  const written = await runFixWriter(brief, mockFixWriterModel(brief));
  expect(written.prompt).toBe("Replace the person's face with Mira as in the reference picture");
  expect(written.stepUsage).toHaveLength(1);
  expect(fixWriterCostUsd(MOCK_FIX_WRITER_CATALOG, written.stepUsage)).toBeGreaterThan(0);
  const ceiling = fixWriterCeilingUsd(MOCK_FIX_WRITER_CATALOG, brief)!;
  expect(ceiling).toBeGreaterThan(fixWriterCostUsd(MOCK_FIX_WRITER_CATALOG, written.stepUsage)!);
  /* A writer whose text would lose the edit's words, or that answers nothing usable, fails: nothing is rendered. */
  await expect(runFixWriter(brief, mockFixWriterModel(brief, { fill: "face", rest: "" }))).rejects.toBeInstanceOf(FixWriterError);
});

/* ── Keys (pure) ──────────────────────────────────────────────────────── */

test("each paid attempt has its own durable key: the plan's render's is unchanged; a fix and a render again name their round and send attempt; a check's is a development request id; a fix note has its own meter event", async () => {
  const { requestKeyFor, retakeRequestKey, fixRequestKey, stepRequestKey, checkRequestId, AUTO_PURPOSES } = await import("../../lib/workbench/rig-agent-runs");
  const { stepChargeEventId } = await import("../../lib/workbench/rig-agent-charges");
  const run = "rar_0123456789abcdef01234567", node = "node-0123456789abcdef";
  expect(requestKeyFor(run, node, 1)).toBe(`rig-agent:${run}:${node}:take:1`);
  expect(retakeRequestKey(run, node, 3, 1)).toBe(`rig-agent:${run}:${node}:take:3:1`);
  expect(fixRequestKey(run, node, 2, 3)).toBe(`rig-agent:${run}:${node}:fix:2:3`);
  expect(stepRequestKey(run, { purpose: "take", nodeId: node, round: null }, 4)).toBe(requestKeyFor(run, node, 4));
  expect(stepRequestKey(run, { purpose: "take", nodeId: node, round: 3 }, 1)).toBe(retakeRequestKey(run, node, 3, 1));
  expect(stepRequestKey(run, { purpose: "fix", nodeId: node, round: 2 }, 1)).toBe(fixRequestKey(run, node, 2, 1));
  expect(() => stepRequestKey(run, { purpose: "fix", nodeId: node, round: null }, 1)).toThrow("A fix step carries its round.");
  expect(() => stepRequestKey(run, { purpose: "take", nodeId: null, round: null }, 1)).toThrow();
  const keys = [requestKeyFor(run, node, 1), requestKeyFor(run, node, 2), retakeRequestKey(run, node, 1, 1), fixRequestKey(run, node, 1, 1), fixRequestKey(run, node, 1, 2), fixRequestKey(run, node, 2, 1), fixRequestKey(run, "x".repeat(200), 8, 8)];
  expect(new Set(keys).size).toBe(keys.length);
  for (const key of keys) expect(key, key).toMatch(/^[A-Za-z0-9._:-]{8,160}$/);
  const checks = [checkRequestId(run, node, 0, 1), checkRequestId(run, node, 0, 2), checkRequestId(run, node, 1, 1), checkRequestId(run, "node-other", 0, 1)];
  expect(new Set(checks).size).toBe(checks.length);
  for (const id of checks) expect(id, id).toMatch(/^[a-zA-Z0-9_-]{8,100}$/);
  expect(stepChargeEventId(run, 12, 1)).toBe("rigfix_0123456789abcdef01234567_12_1");
  /* Auto sends renders' drafts and checks without a tap; a fix always asks. */
  expect([...AUTO_PURPOSES].sort()).toEqual(["take", "verify"]);
});

/* ── Which step moves next (pure) ─────────────────────────────────────── */

let seqs = 0;
function row(over: Partial<StepRow> & Pick<StepRow, "purpose">): StepRow {
  const seq = over.seq ?? ++seqs;
  return {
    id: `r:${seq}`, runId: "r", seq, tool: over.purpose === "take" ? "render" : over.purpose === "fix" ? "fix" : over.purpose === "verify" ? "verify" : "create",
    label: "", nodeId: null, attempt: 0, ops: [], opId: null, state: "next", result: null, requestKey: null, jobId: null, creditsReserved: null, creditsSettled: null,
    admission: null, quoteCredits: null, band: null, approvedAt: null, approvedBy: null, approvedFingerprint: null, reason: null, pause: null, settledAt: null,
    outcome: null, round: null, chargeId: null, charge: null, holdCredits: null, request: null, verdict: null, scorecard: null, resolution: null, resolvedBy: null, resolvedAt: null,
    updatedAt: 0, ...over,
  };
}

test("a shot whose check needs a person is passed over and the others move; the run waits only when nothing else can; every other wait still holds the whole run", async () => {
  const { nextPaidMove, waitScope } = await import("../../lib/workbench/rig-agent-runs");
  const on = { verify: true, lock: false };
  for (const kind of ["limit", "credits", "admin", "refused", "unpriced", "record"] as const) expect(waitScope(kind), kind).toBe("run");
  expect(waitScope("check")).toBe("shot");
  const build = row({ purpose: "build", state: "done", seq: 1 });
  const take1 = row({ purpose: "take", nodeId: "a", state: "done", seq: 2, jobId: "gen_a" });
  const check1 = row({ purpose: "verify", nodeId: "a", seq: 3, state: "paused", pause: "check", reason: "Identity failed." });
  const take2 = row({ purpose: "take", nodeId: "b", seq: 4 });
  const check2 = row({ purpose: "verify", nodeId: "b", seq: 5 });
  expect(nextPaidMove([build, take1, check1, take2, check2], on)).toEqual({ kind: "step", step: take2 });
  const done2 = { ...take2, state: "done" as const, jobId: "gen_b" }, passed2 = { ...check2, state: "done" as const };
  expect(nextPaidMove([build, take1, check1, done2, passed2], on)).toEqual({ kind: "wait", step: check1 });
  const limited = { ...take2, state: "paused" as const, pause: "limit" as const };
  expect(nextPaidMove([build, take1, check1, limited, check2], on)).toEqual({ kind: "step", step: limited });
  const tapping = { ...take2, state: "waiting" as const, reason: "02 is ready to render · about 4 cr." };
  expect(nextPaidMove([build, take1, check1, tapping, check2], on)).toEqual({ kind: "step", step: tapping });
  /* Work in flight is followed first, wherever it is in the order: one paid step in flight at a time. */
  const fixA = row({ purpose: "fix", nodeId: "a", round: 1, seq: 6, state: "rendering", jobId: "gen_fix" });
  const checkFixA = row({ purpose: "verify", nodeId: "a", round: 1, seq: 7 });
  const resolved1 = { ...check1, state: "done" as const };
  expect(nextPaidMove([build, take1, resolved1, take2, check2, fixA, checkFixA], on)).toEqual({ kind: "step", step: fixA });
  /* A check reads its shot's latest take: the fix, once it lands. */
  const landedFix = { ...fixA, state: "done" as const };
  expect(nextPaidMove([build, take1, resolved1, done2, passed2, landedFix, checkFixA], on)).toEqual({ kind: "step", step: checkFixA });
  /* A fix the provider failed: its check is the move (its shot then waits for a person). A failed render's check never runs. */
  const failedFix = { ...fixA, state: "failed" as const };
  expect(nextPaidMove([build, take1, resolved1, done2, passed2, failedFix, checkFixA], on)).toEqual({ kind: "step", step: checkFixA });
  const failedTake = { ...take2, state: "failed" as const };
  expect(nextPaidMove([build, take1, resolved1, failedTake, check2], on)).toEqual({ kind: "done" });
  /* A shot's later steps wait behind its own wait; another shot's do not. */
  const fixHeld = row({ purpose: "fix", nodeId: "a", round: 1, seq: 6, state: "approved" });
  expect(nextPaidMove([build, take1, check1, done2, passed2, fixHeld], on)).toEqual({ kind: "wait", step: check1 });
});

test("the Inngest function waits for a person's decision (rig/agent.resolved, this run's, up to seven days) when the run needs them, then ticks on", async () => {
  const { rigAgent } = await import("../../lib/workers");
  const { RIG_AGENT_RESOLVED } = await import("../../lib/dispatch");
  expect(RIG_AGENT_RESOLVED).toBe("rig/agent.resolved");
  const ticks = [{ state: "running", more: false, waitFor: { genId: "gen_abc" } }, { state: "needs_you", more: false }, { state: "done", more: false }];
  const waits: unknown[] = [];
  const step = {
    run: async (name: string) => { expect(name).toMatch(/^tick-\d+$/); return ticks.shift(); },
    waitForEvent: async (name: string, options: unknown) => { waits.push([name, options]); return null; },
    sleep: async () => {},
  };
  const handler = (rigAgent as unknown as { fn: (ctx: unknown) => Promise<unknown> }).fn;
  const out = await handler({ event: { data: { runId: "rar_0123456789abcdef01234567", productionId: "prod-1", workspaceId: "ws_1" } }, step });
  expect(out).toEqual({ runId: "rar_0123456789abcdef01234567", state: "done" });
  expect(waits).toEqual([
    ["settled-0", { event: "rig/render.settled", timeout: "20m", if: 'async.data.genId == "gen_abc"' }],
    ["resolved-1", { event: RIG_AGENT_RESOLVED, timeout: "7d", match: "data.runId" }],
  ]);
});

/* ── A paid workspace, a production with pictured masters, a board ────── */

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

/** A picture uploaded into the workspace (its bytes stored, its row saved): what a master and a shot's input are made of. */
async function uploaded(id: string, name: string, category: string, rgb: { r: number; g: number; b: number }): Promise<Asset> {
  const { db } = await import("../../lib/db");
  const { storeUpload } = await import("../../lib/storage");
  const bytes = await sharp({ create: { width: 64, height: 64, channels: 3, background: rgb } }).png().toBuffer();
  const stored = await storeUpload(id, "png", bytes, "image/png");
  await db().execute({ sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,width,height,stored_url,created_at,kind) VALUES(?,?,?,?,?,?,?,?,?,?,'image')",
    args: [id, `${name}.png`, "image/png", "png", bytes.length, stored.sha256, 64, 64, stored.url, Date.now()] });
  return { id: `asset-${id}`, name, kind: "image", category, url: `/api/uploads/${id}`, uploadId: id, description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [] };
}
const scene = (id: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({ id, title: id, type: "scene", x: 0, y: 0, width: 344, linked: [], mode: "Video", ...extra });

/** A production whose cast (Mira) and place (the pier) have pictures: the plan wires them into its shots as masters. */
async function seedBoard() {
  const { db, ready } = await import("../../lib/db");
  const { patchTeamCanvas } = await import("../../lib/workbench/team-canvas");
  await ready();
  const ws = (await import("../../lib/tenant")).requireTenant().id;
  const face = await uploaded(`up_face_${ws}`, "Mira", "Character", { r: 200, g: 150, b: 120 });
  const plate = await uploaded(`up_plate_${ws}`, "The pier", "Environment", { r: 60, g: 90, b: 140 });
  const project: Project = {
    ...newProject("Harbour"), id: "draft-1", productionProjectId: "prod-1",
    assets: [face, plate],
    production: {
      cast: { entries: [{ id: "c1", name: "Mira", kind: "character", description: "", prompt: "", takes: [], selected: face.id }] },
      environment: { world: "", model: "gemini-3.1-flash-image", entries: [{ id: "e1", name: "The pier", notes: "", prompt: "", references: [], plates: [], selected: plate.id }] },
    },
  };
  await db().execute("INSERT INTO projects(id,name,created_at) VALUES('prod-1','Harbour',0)");
  for (const who of [OWNER, TEAMMATE])
    await db().execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,0)", args: [`${who}:draft-1`, who, "draft-1", "Harbour", JSON.stringify(project)] });
  await patchTeamCanvas("prod-1", { upsertNodes: [scene("theirs", { x: 100, y: 100, title: "Ana's shot" })], removeNodes: [], upsertAssets: [], order: ["theirs"] }, OWNER);
}

async function inRun<T>(name: string, fn: (ws: TenantWorkspace) => Promise<T>, credits?: number): Promise<T> {
  const { runInTenant } = await import("../../lib/tenant");
  const ws = await paidWorkspace(name, credits);
  return runInTenant(ws, async () => { await seedBoard(); return fn(ws); });
}

/* A stand-in for admission: the real durable claim and the real reservation, filing each take on its shot. */
type Behaviour = { throwBeforeClaim?: boolean; throwAfterReply?: boolean };
/** A take's kind, as its engine makes it. */
const kindOfEngine = (body: Record<string, unknown>): "image" | "video" => (MODELS.find((m) => m.id === body.model)?.kind === "image" ? "image" : "video");
function renders(ws: TenantWorkspace, usdOf: (body: Record<string, unknown>) => number, kindOf: (body: Record<string, unknown>) => "image" | "video" = kindOfEngine) {
  const calls: { key: string; run: RunSpend | undefined; body: Record<string, unknown> }[] = [];
  const bodies: Record<string, unknown>[] = [];
  const behaviour: Behaviour = {};
  const prepare = async (body: Record<string, unknown>, actor: AdmissionActor) => {
    const { billCredits } = await import("../../lib/creditTerms");
    bodies.push(body);
    const usd = usdOf(body);
    const credits = billCredits(usd, "mock");
    const compiled = { model: { provider: "byteplus" }, estUsd: usd, kind: kindOf(body), prompt: String(body.prompt ?? "") };
    const quote = { estimatedCredits: credits, price: credits, unit: "cr" as const };
    return { ok: true as const, value: { version: 1 as const, kind: "video" as const, workspaceId: ws.id, actorId: actor.user.id, request: { ...body, maxCredits: credits }, compiled, quote: { ...quote, fingerprint: sha({ compiled, quote }) } } satisfies PreparedAdmission };
  };
  const admit = async (admission: PreparedAdmission, actor: AdmissionActor, options: { requestKey: string; run?: RunSpend }): Promise<AdmissionReply> => {
    const { db, id, now } = await import("../../lib/db");
    const { withGenerationRequestData, bindGenerationRequestStatement, reserveGenerationSpend, SpendReservationError } = await import("../../lib/generationRequests");
    const { preparedClaimFingerprint } = await import("../../lib/admissionSupport");
    calls.push({ key: options.requestKey, run: options.run, body: admission.request });
    if (behaviour.throwBeforeClaim) { behaviour.throwBeforeClaim = false; throw new Error("the function died before the request left"); }
    const compiled = admission.compiled as { estUsd: number; kind: "image" | "video" };
    const response = await withGenerationRequestData({ userId: actor.user.id, key: options.requestKey, fingerprint: preparedClaimFingerprint(admission) }, async (claim) => {
      const genId = id("gen");
      await db().batch([
        { sql: "INSERT INTO generations(id,project_id,shot_id,kind,model,prompt,params,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
          args: [genId, "prod-1", String(admission.request.shotId ?? ""), compiled.kind, "mock", String(admission.request.prompt ?? ""), JSON.stringify({ resolution: admission.request.resolution ?? null }), "queued", actor.user.id, now(), now()] },
        bindGenerationRequestStatement(claim, genId),
      ], "write");
      try {
        await reserveGenerationSpend({ id: genId, kind: compiled.kind, engine: "byteplus", model: "mock", status: "running", engineCostUsd: compiled.estUsd, projectId: "prod-1", createdBy: actor.user.id }, { run: options.run });
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
  return { prepare, admit, calls, bodies, behaviour };
}
type Renders = ReturnType<typeof renders>;

/** Test fixture only: a priced vision model (the fixture's prices, not a real rate card). */
const JUDGE: CatalogModel = { id: "anthropic/claude-sonnet-4.6", name: "Claude", owner: "anthropic", type: "language", description: "", contextWindow: 1_000_000, maxTokens: 64000,
  pricing: { input: "0.0000001", output: "0.0000003" }, inputModalities: ["text", "image"], outputModalities: ["text"] };
type Scores = Partial<Record<VerifyCheck, number | { score: number; seen?: boolean }>>;
/** The scripted judge, per shot (the take's name), in order (the last repeats); the real reservation and meter. */
function judge(answers: Record<string, Scores[]>) {
  const seen: string[] = [];
  const development: Partial<DevelopmentDependencies> = {
    models: async () => [JUDGE], allowance: async () => ({ ok: true }),
    auth: async () => ({ token: "test-only-not-sent", method: "api-key" }), funding: async () => {},
    call: async (input) => {
      const asked = JSON.parse(input.prompt) as { take: { name: string }; checks: { check: VerifyCheck }[] };
      seen.push(asked.take.name);
      const list = answers[asked.take.name] ?? [{}];
      const scores = list.length > 1 ? list.shift()! : list[0];
      return { text: JSON.stringify({ checks: asked.checks.map(({ check }) => {
        const s = scores[check] ?? 0.95, score = typeof s === "number" ? s : s.score;
        return { check, score, seen: typeof s === "number" ? true : s.seen ?? true, reasons: [`Scripted ${check}: ${score >= 0.5 ? "matches" : "not Mira's face"}.`], frame: 1 };
      }), summary: "Scripted judge." }), inputTokens: 4000, outputTokens: 300 };
    },
  };
  return { development, seen };
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
type Deps = Awaited<ReturnType<typeof depsFor>>;

async function approvedRun(deps: Deps, input: { limit: number; mode?: "ask" | "auto"; shots?: number }) {
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
  return (await db().execute("SELECT id,status,prompt,kind FROM generations ORDER BY created_at, rowid")).rows.map((r) => ({ id: String(r.id), status: String(r.status), prompt: String(r.prompt), kind: String(r.kind) }));
};
async function meterRow(id: string) {
  const { platformDb } = await import("../../lib/platform");
  const row = (await platformDb().execute({ sql: "SELECT status,billed_credits FROM meter_events WHERE id=?", args: [id] })).rows[0];
  return row ? { status: String(row.status), credits: Number(row.billed_credits ?? 0) } : null;
}
async function intent(id: string) {
  const { platformDb } = await import("../../lib/platform");
  return (await platformDb().execute({ sql: "SELECT state FROM recovery_intents WHERE id=?", args: [id] })).rows[0]?.state;
}
async function balance(ws: TenantWorkspace) {
  const { creditStateFor } = await import("../../lib/credits");
  return (await creditStateFor(ws))!.balance;
}
const stillBytes = sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 120, g: 120, b: 120 } } }).png().toBuffer();
/** The vendor finishes a take: its outcome and bill written together, delivered to the ledger; a still's bytes stored for the judge. */
async function settleTake(jobId: string, status: "succeeded" | "failed", usd: number) {
  const { db } = await import("../../lib/db");
  const kind = String((await db().execute({ sql: "SELECT kind FROM generations WHERE id=?", args: [jobId] })).rows[0].kind);
  if (status === "succeeded" && kind === "image") await (await import("../../lib/storage")).storeImageBytes(jobId, await stillBytes);
  const { writeGenerationOutcome, deliverGenerationSettlement } = await import("../../lib/generationSettlement");
  await writeGenerationOutcome({ sql: "UPDATE generations SET status=?,cost_usd=?,updated_at=? WHERE id=?", args: [status, usd, Date.now(), jobId] },
    { id: jobId, kind: kind === "image" ? "image" : "video", engine: "byteplus", model: "mock", status, engineCostUsd: usd });
  await deliverGenerationSettlement(jobId);
}
const credits = async (usd: number) => (await import("../../lib/creditTerms")).billCredits(usd, "mock");
const stepsOf = async (runId: string) => {
  const store = await import("../../lib/workbench/rig-agent-store");
  const { db } = await import("../../lib/db");
  return store.stepsOf(db(), runId);
};
const lastRender = async () => (await renderRows()).at(-1)!;
/** The still engine the tests' still shots render on (it has no draft mode, so its renders ask for a tap, in Auto too). */
const STILL_ENGINE = "gemini-3.1-flash-image";
/** The run's shots, as planned, on the still engine (before its build is applied). */
async function stillShots(runId: string) {
  const { db } = await import("../../lib/db");
  const rows = (await db().execute({ sql: "SELECT id,prepared FROM rig_agent_steps WHERE run_id=? AND tool='create'", args: [runId] })).rows;
  for (const row of rows) {
    const ops = JSON.parse(String(row.prepared)) as { kind: string; node?: CanvasNode }[];
    for (const op of ops) if (op.node?.type === "scene") op.node.engine = STILL_ENGINE;
    await db().execute({ sql: "UPDATE rig_agent_steps SET prepared=? WHERE id=?", args: [JSON.stringify(ops), String(row.id)] });
  }
}
/** Ticks until the run waits for a person, settling each take as it lands (and, with `tapRenders`, tapping each render that asks). */
async function tickTo(runId: string, deps: Deps, options: { tapRenders?: boolean; settle?: Record<string, "succeeded" | "failed"> } = {}) {
  const agent = await import("../../lib/workbench/rig-agent");
  for (let i = 0; i < 20; i++) {
    const tick = await agent.advanceRigAgentRun(runId, deps);
    if (tick.waitFor) {
      await settleTake(tick.waitFor.genId, options.settle?.[tick.waitFor.genId] ?? "succeeded", 0.3);
      continue;
    }
    if (options.tapRenders && tick.state === "needs_you") {
      const waiting = (await view()).paid.find((p) => p.tool === "render" && p.state === "waiting" && p.canRender);
      if (waiting) {
        await agent.renderRigAgentStep({ productionId: "prod-1", runId, seq: waiting.seq, fingerprint: waiting.fingerprint, userId: OWNER });
        continue;
      }
    }
    return tick;
  }
  throw new Error("the run never settled");
}

/* ── Checks in a run ──────────────────────────────────────────────────── */

test("Auto: a still shot's render asks (a still has no draft); its take is then checked on its own inside the run's limit — the run makes the shot's Verify card on the board, the check is charged under the run's id — and a pass is done", async () => {
  await inRun("check-pass", async (ws) => {
    const { readTeamCanvas } = await import("../../lib/workbench/team-canvas");
    const { runCharges } = await import("../../lib/generationRequests");
    const { agentNodeId } = await import("../../lib/workbench/rig-agent-plan");
    const r = renders(ws, () => 0.3);
    const j = judge({ "01 — Opening": [{}] });
    const deps = await depsFor(ws, r, { checks: { development: j.development } });
    const runId = await approvedRun(deps, { limit: 500, mode: "auto", shots: 1 });
    await stillShots(runId);
    const before = await balance(ws);
    expect(await tickTo(runId, deps, { tapRenders: true })).toEqual({ state: "done", more: false });
    const run = await view();
    expect(run.paid.map((p) => [p.tool, p.state, p.verdict])).toEqual([["render", "done", null], ["verify", "done", "pass"]]);
    expect(run.paid[1].scorecard!.line).toBe("4 checks passed");
    expect(j.seen).toEqual(["01 — Opening"]);
    /* The check's charge counts toward the run, under its id, at what it used. */
    const charges = await runCharges(runId);
    const check = charges.find((c) => c.id.startsWith("wb_development_"))!;
    expect(check).toMatchObject({ running: false });
    expect(run.paid[1].charged).toBe(check.credits);
    expect(await balance(ws)).toBe(before - (await credits(0.3)) - check.credits);
    /* The shot's Verify card is on the team canvas, made by the run (free), wired to the shot and its masters. */
    const canvas = (await readTeamCanvas("prod-1"))!.canvas;
    const card = Object.values(canvas.nodes).find((n) => n.type === "review" && n.linked.includes(agentNodeId(runId, "shot-1")))!;
    expect(card).toBeTruthy();
    expect(canvas.serverMade[card.id]).toBe(`agent:${runId}`);
    expect(card.linked).toEqual(expect.arrayContaining([agentNodeId(runId, "cast-1"), agentNodeId(runId, "place-1")]));
    /* A run's check is the same stored check the board reads. */
    const { db } = await import("../../lib/db");
    expect(Number((await db().execute("SELECT COUNT(*) AS n FROM take_verifications")).rows[0].n)).toBe(1);
  });
});

test("why a check asks: in Ask at its price; in Auto only when it may hold more than the per-job line, said as its price or as what it holds", async () => {
  const { checkAskWords } = await import("../../lib/workbench/rig-agent-checks");
  expect(checkAskWords("ask", "01 — Opening", 1.2, 6, 200)).toBe("01 — Opening is ready to check · about 1.2 cr.");
  expect(checkAskWords("auto", "01 — Opening", 3, 9, 2)).toBe("01 — Opening's check is about 3 cr, over the 2 cr a check may cost without asking. Check it, skip it, or stop.");
  expect(checkAskWords("auto", "01 — Opening", 1.5, 9, 2)).toBe("01 — Opening's check is about 1.5 cr but holds up to 9 cr while it runs, over the 2 cr a check may hold without asking. Check it, skip it, or stop.");
});

test("Ask: a check waits for one tap at its price; a tap at another price is refused; then it runs once", async () => {
  await inRun("check-ask", async (ws) => {
    const agent = await import("../../lib/workbench/rig-agent");
    const r = renders(ws, () => 0.3);
    const j = judge({});
    const deps = await depsFor(ws, r, { checks: { development: j.development } });
    const runId = await approvedRun(deps, { limit: 500, mode: "ask", shots: 1 });
    await stillShots(runId);
    expect(await agent.advanceRigAgentRun(runId, deps)).toEqual({ state: "needs_you", more: false });
    let run = await view();
    await agent.renderRigAgentStep({ productionId: "prod-1", runId, seq: run.paid[0].seq, fingerprint: run.paid[0].fingerprint, userId: OWNER });
    expect(await tickTo(runId, deps, { tapRenders: true })).toEqual({ state: "needs_you", more: false });
    run = await view();
    const check = run.paid[1];
    expect(check).toMatchObject({ tool: "verify", state: "waiting", canRender: true, label: "Check · 01 — Opening" });
    expect(check.quote).toBeGreaterThanOrEqual(0);
    expect(check.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(run.reason).toMatch(/^01 — Opening is ready to check · about .* cr\.$/);
    expect(j.seen).toEqual([]);
    expect((await view(TEAMMATE)).paid[1].canRender).toBe(false);
    await expect(agent.renderRigAgentStep({ productionId: "prod-1", runId, seq: check.seq, fingerprint: "0".repeat(64), userId: OWNER })).rejects.toMatchObject({ status: 409 });
    await agent.renderRigAgentStep({ productionId: "prod-1", runId, seq: check.seq, fingerprint: check.fingerprint, userId: OWNER });
    expect(await tickTo(runId, deps, { tapRenders: true })).toEqual({ state: "done", more: false });
    expect(j.seen).toEqual(["01 — Opening"]);
    expect((await view()).paid[1]).toMatchObject({ state: "done", verdict: "pass" });
  });
});

test("a check paused at the run's limit can be approved again at its price; nothing is reserved while it waits, and once the limit is raised that approval stands and it runs once", async () => {
  await inRun("check-limit", async (ws) => {
    const agent = await import("../../lib/workbench/rig-agent");
    const { db } = await import("../../lib/db");
    const { runCharges } = await import("../../lib/generationRequests");
    const r = renders(ws, () => 0.3);
    const j = judge({});
    const deps = await depsFor(ws, r, { checks: { development: j.development } });
    const runId = await approvedRun(deps, { limit: 500, mode: "ask", shots: 1 });
    await stillShots(runId);
    expect(await tickTo(runId, deps, { tapRenders: true })).toEqual({ state: "needs_you", more: false });
    let run = await view();
    let check = run.paid[1];
    expect(check).toMatchObject({ tool: "verify", state: "waiting", canRender: true });
    expect(check.worst).toBeGreaterThan(0);
    /* The limit is set to what the run has spent (a test fixture: a person can only raise it), so the check no longer fits. */
    await db().execute({ sql: "UPDATE rig_agent_runs SET cap_credits=? WHERE id=?", args: [run.money!.spent, runId] });
    await agent.renderRigAgentStep({ productionId: "prod-1", runId, seq: check.seq, fingerprint: check.fingerprint, userId: OWNER });
    expect(await agent.advanceRigAgentRun(runId, deps)).toEqual({ state: "needs_you", more: false });
    check = (await view()).paid[1];
    expect(check).toMatchObject({ state: "paused", pause: "limit", canRender: true, fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(j.seen).toEqual([]);
    expect((await runCharges(runId)).some((c) => c.id.startsWith("wb_development_"))).toBe(false);
    /* Tapped again at its price: still past the limit, it waits again, and still nothing is reserved. */
    await agent.renderRigAgentStep({ productionId: "prod-1", runId, seq: check.seq, fingerprint: check.fingerprint, userId: OWNER });
    expect(await agent.advanceRigAgentRun(runId, deps)).toEqual({ state: "needs_you", more: false });
    expect((await view()).paid[1]).toMatchObject({ state: "paused", pause: "limit" });
    expect((await runCharges(runId)).some((c) => c.id.startsWith("wb_development_"))).toBe(false);
    /* The limit raised: the approval at that price stands, and the check runs once. */
    await agent.raiseRigAgentLimit({ productionId: "prod-1", runId, limit: 500, userId: OWNER });
    expect(await tickTo(runId, deps)).toEqual({ state: "done", more: false });
    expect(j.seen).toEqual(["01 — Opening"]);
    run = await view();
    expect(run.paid[1]).toMatchObject({ state: "done", verdict: "pass" });
    expect((await runCharges(runId)).filter((c) => c.id.startsWith("wb_development_"))).toHaveLength(1);
  });
});

test("a clean fail adds fix 1: written by the fix writer (metered like planning), priced as a re-edit of the failed still — never a fresh render — asking for a tap even in Auto; it renders under its own key, its check reads the fixed take, and a pass is done", async () => {
  await inRun("fix-pass", async (ws) => {
    const agent = await import("../../lib/workbench/rig-agent");
    const { agentNodeId } = await import("../../lib/workbench/rig-agent-plan");
    const { fixRequestKey } = await import("../../lib/workbench/rig-agent-runs");
    const { stepChargeEventId } = await import("../../lib/workbench/rig-agent-charges");
    const { runCharges } = await import("../../lib/generationRequests");
    const r = renders(ws, (body) => (String(body.prompt).startsWith("Replace") ? 0.25 : 0.3));
    const j = judge({ "01 — Opening": [{ identity: 0.1 }, {}] });
    const deps = await depsFor(ws, r, { checks: { development: j.development } });
    const runId = await approvedRun(deps, { limit: 500, mode: "auto", shots: 1 });
    await stillShots(runId);
    const shot = agentNodeId(runId, "shot-1");
    /* The take renders on its own (Auto), its check fails Identity: fix 1 is written and priced, and asks. */
    expect(await tickTo(runId, deps, { tapRenders: true })).toEqual({ state: "needs_you", more: false });
    const [take] = await renderRows();
    let run = await view();
    expect(run.paid.map((p) => [p.tool, p.label, p.state, p.verdict])).toEqual([
      ["render", "01 — Opening", "done", null], ["verify", "Check · 01 — Opening", "done", "fail"],
      ["fix", "Fix 1 · 01 — Opening", "waiting", null], ["verify", "Check fix 1 · 01 — Opening", "next", null],
    ]);
    expect(run.paid[1].reason).toBe("Identity failed. Fix 1 follows.");
    const fix = run.paid[2];
    expect(fix).toMatchObject({ canRender: true, edit: "Replace the person's face with Mira as in the reference picture", quote: await credits(0.25) });
    expect(run.reason).toBe(`Fix 1 for 01 — Opening is ready to render · about ${(await import("../../lib/runLimit")).creditFigure(await credits(0.25))} cr.`);
    /* Priced as a re-edit of the failed still on the shot's own engine: the failed take first, then the master; no draft. */
    const body = r.bodies.at(-1)!;
    expect(body.prompt).toBe("Replace the person's face with Mira as in the reference picture");
    expect((body.references as { genId?: string; role: string }[])[0]).toEqual({ genId: take.id, role: "reference_image" });
    expect(body.draft).toBeUndefined();
    /* The fix note was metered into the run like planning: reserved, then settled at what it used. */
    const steps = await stepsOf(runId);
    const fixStep = steps.find((s) => s.purpose === "fix")!;
    expect(fixStep).toMatchObject({ charge: "settled", round: 1, chargeId: stepChargeEventId(runId, fixStep.seq, 1) });
    expect(await meterRow(fixStep.chargeId!)).toMatchObject({ status: "succeeded" });
    expect(await intent(fixStep.chargeId!)).toBe("resolved");
    const note = (await runCharges(runId)).find((c) => c.id === fixStep.chargeId)!;
    expect(note.credits).toBeGreaterThan(0);
    /* The card shows what writing it cost, and that the take it edits is a still. */
    expect(fix).toMatchObject({ note: { credits: note.credits, settled: true }, takeKind: "image" });
    expect(r.calls).toHaveLength(1);
    /* One tap: the fix renders under its own key; the fixed take is checked and passes. */
    await agent.renderRigAgentStep({ productionId: "prod-1", runId, seq: fix.seq, fingerprint: fix.fingerprint, userId: OWNER });
    expect(await tickTo(runId, deps, { tapRenders: true })).toEqual({ state: "done", more: false });
    expect(r.calls.map((c) => c.key)).toEqual([`rig-agent:${runId}:${shot}:take:1`, fixRequestKey(runId, shot, 1, 1)]);
    const fixed = await lastRender();
    expect(fixed.prompt).toBe("Replace the person's face with Mira as in the reference picture");
    run = await view();
    expect(run.paid.map((p) => [p.tool, p.state, p.verdict])).toEqual([["render", "done", null], ["verify", "done", "fail"], ["fix", "done", null], ["verify", "done", "pass"]]);
    /* Quoted at about 4 cr; charged what the ledger settled for the take it made. */
    expect(run.paid[2].charged).toBe(await credits(0.3));
    expect(j.seen).toEqual(["01 — Opening", "01 — Opening"]);
  });
});

test("after two fixes that still fail, the shot is handed to the person who asked with its choices; 'accept as is' records who, never 'verified', and the run finishes; deciding twice decides once", async () => {
  await inRun("handover", async (ws) => {
    const agent = await import("../../lib/workbench/rig-agent");
    const r = renders(ws, () => 0.3);
    const j = judge({ "01 — Opening": [{ identity: 0.1 }] });
    const deps = await depsFor(ws, r, { checks: { development: j.development } });
    const runId = await approvedRun(deps, { limit: 500, mode: "auto", shots: 1 });
    await stillShots(runId);
    for (let fix = 1; fix <= 2; fix++) {
      expect(await tickTo(runId, deps, { tapRenders: true })).toEqual({ state: "needs_you", more: false });
      const waiting = (await view()).paid.find((p) => p.tool === "fix" && p.state === "waiting")!;
      expect(waiting.label).toBe(`Fix ${fix} · 01 — Opening`);
      await agent.renderRigAgentStep({ productionId: "prod-1", runId, seq: waiting.seq, fingerprint: waiting.fingerprint, userId: OWNER });
    }
    /* The second fix fails too: no third fix on its own — the shot is the person's. */
    expect(await tickTo(runId, deps, { tapRenders: true })).toEqual({ state: "needs_you", more: false });
    let run = await view();
    const flagged = run.paid.at(-1)!;
    expect(flagged).toMatchObject({ tool: "verify", state: "paused", pause: "check", verdict: "fail", choices: ["accept", "fix", "rerender", "skip"], takeKind: "image" });
    /* What the choices that spend are likely to cost: what the shot's last fix and render were priced at. */
    expect(flagged.prices).toEqual({ fix: await credits(0.3), rerender: await credits(0.3) });
    expect(flagged.reason).toBe("Atomik made 2 fixes and the take still fails Identity. Look at it and decide.");
    expect(run.reason).toBe(flagged.reason);
    expect(run.paid.filter((p) => p.tool === "fix").length).toBe(2);
    expect((await view(TEAMMATE)).paid.at(-1)!.choices).toEqual([]);
    await expect(agent.resolveRigAgentShot({ productionId: "prod-1", runId, seq: flagged.seq, choice: "accept", userId: TEAMMATE, name: "Bo" })).rejects.toMatchObject({ status: 403 });
    /* Accept as is: the take stays as it is, with who decided — never marked verified. */
    const accepted = await agent.resolveRigAgentShot({ productionId: "prod-1", runId, seq: flagged.seq, choice: "accept", userId: OWNER, name: "Ana" });
    expect(accepted.paid.at(-1)).toMatchObject({ state: "done", verdict: "fail", reason: "Accepted by Ana despite a failed check.", resolution: { choice: "accept" }, choices: [] });
    expect(JSON.stringify(accepted.paid)).not.toMatch(/verified/i);
    /* The reply to that decision was lost: the same answer, decided once. */
    const again = await agent.resolveRigAgentShot({ productionId: "prod-1", runId, seq: flagged.seq, choice: "accept", userId: OWNER, name: "Ana" });
    expect(again.paid.at(-1)).toMatchObject({ state: "done", reason: "Accepted by Ana despite a failed check." });
    expect(await agent.advanceRigAgentRun(runId, deps)).toEqual({ state: "done", more: false });
    /* A shot that no longer waits cannot be decided again. */
    await expect(agent.resolveRigAgentShot({ productionId: "prod-1", runId, seq: flagged.seq, choice: "skip", userId: OWNER, name: "Ana" })).rejects.toMatchObject({ status: 409 });
    run = await view();
    expect(run.state).toBe("done");
  });
});

test("the other decisions: another fix (priced, it asks, no cap), render again through the run (its own key, then checked), skip (the take keeps its failed check); check again only when there is no verdict", async () => {
  await inRun("decisions", async (ws) => {
    const agent = await import("../../lib/workbench/rig-agent");
    const { agentNodeId } = await import("../../lib/workbench/rig-agent-plan");
    const { retakeRequestKey } = await import("../../lib/workbench/rig-agent-runs");
    const r = renders(ws, () => 0.3);
    const j = judge({ "01 — Opening": [{ identity: 0.1 }] });
    const deps = await depsFor(ws, r, { checks: { development: j.development } });
    const runId = await approvedRun(deps, { limit: 500, mode: "auto", shots: 1 });
    await stillShots(runId);
    const shot = agentNodeId(runId, "shot-1");
    const flag = async () => {
      for (let i = 0; i < 4; i++) {
        const tick = await tickTo(runId, deps, { tapRenders: true });
        expect(tick.state).toBe("needs_you");
        const waiting = (await view()).paid.find((p) => p.tool === "fix" && p.state === "waiting");
        if (!waiting) return (await view()).paid.find((p) => p.state === "paused" && p.pause === "check")!;
        await agent.renderRigAgentStep({ productionId: "prod-1", runId, seq: waiting.seq, fingerprint: waiting.fingerprint, userId: OWNER });
      }
      throw new Error("never flagged");
    };
    let flagged = await flag();
    await expect(agent.resolveRigAgentShot({ productionId: "prod-1", runId, seq: flagged.seq, choice: "recheck", userId: OWNER, name: "Ana" })).rejects.toMatchObject({ status: 409 });
    /* Another fix: a third, written and priced, and it asks for a tap. */
    let run = await agent.resolveRigAgentShot({ productionId: "prod-1", runId, seq: flagged.seq, choice: "fix", userId: OWNER, name: "Ana" });
    expect(run.paid.find((p) => p.seq === flagged.seq)).toMatchObject({ state: "done", reason: "Ana asked for another fix.", resolution: { choice: "fix" } });
    expect(await tickTo(runId, deps, { tapRenders: true })).toEqual({ state: "needs_you", more: false });
    const third = (await view()).paid.find((p) => p.tool === "fix" && p.state === "waiting")!;
    expect(third.label).toBe("Fix 3 · 01 — Opening");
    await agent.renderRigAgentStep({ productionId: "prod-1", runId, seq: third.seq, fingerprint: third.fingerprint, userId: OWNER });
    flagged = await flag();
    /* Render again: a new take of the shot, through the run, under its own key, then checked. */
    const sentBefore = r.calls.length;
    run = await agent.resolveRigAgentShot({ productionId: "prod-1", runId, seq: flagged.seq, choice: "rerender", userId: OWNER, name: "Ana" });
    expect(run.paid.slice(-2).map((p) => [p.tool, p.label, p.state])).toEqual([["render", "Render again · 01 — Opening", "next"], ["verify", "Check again · 01 — Opening", "next"]]);
    const round = (await stepsOf(runId)).find((s) => s.label === "Render again · 01 — Opening")!.round!;
    expect(await tickTo(runId, deps, { tapRenders: true })).toEqual({ state: "needs_you", more: false });
    expect(r.calls[sentBefore].key).toBe(retakeRequestKey(runId, shot, round, 1));
    /* A person's render again is the shot's own render (their choice), not an edit of a take. */
    expect(r.calls[sentBefore].body).toMatchObject({ model: STILL_ENGINE });
    expect(String(r.calls[sentBefore].body.prompt)).toMatch(/Shot 1 of 1/);
    expect(r.calls[sentBefore].body.task).toBeUndefined();
    expect(r.calls[sentBefore].body.sourceGenId).toBeUndefined();
    flagged = (await view()).paid.find((p) => p.state === "paused" && p.pause === "check")!;
    expect(flagged.label).toBe("Check again · 01 — Opening");
    /* Skip: the take keeps its failed check, and the run finishes. */
    run = await agent.resolveRigAgentShot({ productionId: "prod-1", runId, seq: flagged.seq, choice: "skip", userId: OWNER, name: "Ana" });
    expect(run.paid.find((p) => p.seq === flagged.seq)).toMatchObject({ state: "skipped", reason: "Skipped by Ana. The take keeps its failed check." });
    expect(await agent.advanceRigAgentRun(runId, deps)).toEqual({ state: "done", more: false });
  });
});

test("a clip waits for the board: the run asks a person to check it there; once a check of that take is stored, the run reads it free and carries on — its fix is a Seedance Edit of the clip with the master attached", async () => {
  await inRun("clip", async (ws) => {
    const { boardFor, takeOf } = await import("../../lib/workbench/rig-agent-checks");
    const { verifyKeyOf } = await import("../../lib/workbench/verify");
    const { verifyKeyHashes, verifyReady } = await import("../../lib/workbench/verify-server");
    const { rigCheckStored } = await import("../../lib/workbench/rig-agent-settled");
    const { getRun } = await import("../../lib/workbench/rig-agent-store");
    const { EDIT_ENGINE } = await import("../../lib/workbench/rig-agent-fix-steps");
    const { db } = await import("../../lib/db");
    const r = renders(ws, () => 0.3);
    const j = judge({});
    const deps = await depsFor(ws, r, { checks: { development: j.development } });
    const runId = await approvedRun(deps, { limit: 500, mode: "auto", shots: 1 });
    expect(await tickTo(runId, deps)).toEqual({ state: "needs_you", more: false });
    const run = await view();
    const check = run.paid[1];
    expect(check).toMatchObject({ tool: "verify", state: "paused", pause: "check", verdict: null, choices: ["accept", "rerender", "recheck", "skip"] });
    expect(check.reason).toMatch(/^Open the board to check 01 — Opening/);
    expect(check.card).toBeTruthy();
    expect(j.seen).toEqual([]);
    /* A person checks the clip on the board (its stored scorecard, as a Verify card's finished job writes it). */
    const steps = await stepsOf(runId);
    const verifyStep = steps.find((s) => s.purpose === "verify")!;
    const take = (await takeOf(steps.find((s) => s.purpose === "take")!.jobId!))!;
    const board = await boardFor((await getRun(db(), runId))!, verifyStep, take);
    if ("reason" in board) throw new Error(board.reason);
    const key = verifyKeyOf(board.subject)!;
    expect(key.framesKey).toBe("video:0.1,0.5,0.9");
    await verifyReady();
    const k = verifyKeyHashes(key);
    await db().execute({
      sql: `INSERT INTO take_verifications(id,production_id,project_id,verify_node_id,take_id,master_set_hash,master_set,masters,rubric,frames_hash,frames_key,frames,checks,verdict,judge_model,meter_event_id,credits,funded_by_platform,created_by,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: ["wb_development_board-check", "prod-1", "draft-1", board.card.id, k.takeId, k.masterSetHash, key.masterSet,
        JSON.stringify(board.subject.masters.map((m) => ({ kind: m.kind, nodeId: m.node.id, title: m.node.title, identity: m.identity, version: 1 }))), k.rubric, k.framesHash, key.framesKey, "[]",
        JSON.stringify([result("identity", "fail", ["Not Mira's face."]), result("wardrobe", "pass"), result("environment", "pass"), result("artifacts", "pass")]), "fail", JUDGE.id, "wb_development_board-check", 2, 1, OWNER, Date.now()],
    });
    await rigCheckStored(k.takeId);
    expect((await getRun(db(), runId))!.state).toBe("running");
    /* Read free: nothing charged to the run for it; the fail gives fix 1, an edit of the clip with Mira attached. */
    expect(await tickTo(runId, deps)).toEqual({ state: "needs_you", more: false });
    const after = await view();
    expect(after.paid[1]).toMatchObject({ state: "done", verdict: "fail", charged: 0 });
    expect(after.paid[2]).toMatchObject({ tool: "fix", state: "waiting" });
    const body = r.bodies.at(-1)!;
    expect(body).toMatchObject({ task: "edit", model: EDIT_ENGINE.id, sourceGenId: take.id, refine: false });
    expect(String(body.prompt)).toMatch(/^Edit @Video1: Replace the person's face with Mira/);
    expect(body.draft).toBeUndefined();
    /* Mira's master (her uploaded picture) is the edit's reference. */
    expect(body.references).toEqual([{ uploadId: expect.stringMatching(/^up_face_/), role: "reference_image" }]);
    expect(j.seen).toEqual([]);
  });
});

test("a fix the provider fails is not one of the two: its shot waits for a person with what became of the charge, and nothing is retried", async () => {
  await inRun("fix-failed", async (ws) => {
    const agent = await import("../../lib/workbench/rig-agent");
    const r = renders(ws, () => 0.3);
    const j = judge({ "01 — Opening": [{ identity: 0.1 }] });
    const deps = await depsFor(ws, r, { checks: { development: j.development } });
    const runId = await approvedRun(deps, { limit: 500, mode: "auto", shots: 1 });
    await stillShots(runId);
    expect(await tickTo(runId, deps, { tapRenders: true })).toEqual({ state: "needs_you", more: false });
    const fix = (await view()).paid.find((p) => p.tool === "fix")!;
    await agent.renderRigAgentStep({ productionId: "prod-1", runId, seq: fix.seq, fingerprint: fix.fingerprint, userId: OWNER });
    const tick = await agent.advanceRigAgentRun(runId, deps);
    await settleTake(tick.waitFor!.genId, "failed", 0);
    expect(await tickTo(runId, deps, { tapRenders: true })).toEqual({ state: "needs_you", more: false });
    const run = await view();
    expect(run.paid.find((p) => p.tool === "fix")).toMatchObject({ state: "failed", outcome: "not_billed" });
    const flagged = run.paid.at(-1)!;
    expect(flagged).toMatchObject({ tool: "verify", state: "paused", pause: "check" });
    expect(flagged.reason).toBe("Fix 1 for 01 — Opening did not render. Nothing was charged. Look at the take and decide.");
    /* Not counted: the fixes that count are those that landed. */
    const { landedFixes } = await import("../../lib/workbench/rig-agent-fixes");
    expect(landedFixes(await stepsOf(runId), (await stepsOf(runId))[0].nodeId ?? "")).toBe(0);
    expect(r.calls).toHaveLength(2);
    expect(await agent.advanceRigAgentRun(runId, deps)).toEqual({ state: "needs_you", more: false });
    expect(r.calls).toHaveLength(2);
    /* The person decides: take it as it is, that fix again, render it again, or skip it. Nothing new rendered, so nothing to check again. */
    expect(flagged.choices).toEqual(["accept", "fix", "rerender", "skip"]);
    await expect(agent.resolveRigAgentShot({ productionId: "prod-1", runId, seq: flagged.seq, choice: "recheck", userId: OWNER, name: "Ana" })).rejects.toMatchObject({ status: 409 });
    const failedFix = (await stepsOf(runId)).find((s) => s.purpose === "fix")!;
    await agent.resolveRigAgentShot({ productionId: "prod-1", runId, seq: flagged.seq, choice: "fix", userId: OWNER, name: "Ana" });
    expect(await tickTo(runId, deps)).toEqual({ state: "needs_you", more: false });
    const again = (await stepsOf(runId)).filter((s) => s.purpose === "fix");
    expect(again.map((s) => [s.label, s.state])).toEqual([["Fix 1 · 01 — Opening", "failed"], ["Fix 2 · 01 — Opening", "waiting"]]);
    /* The same fix of the same take, written again (and asking for a tap at its price). */
    expect(again[1].request).toMatchObject({ ...failedFix.request!, prompt: "Replace the person's face with Mira as in the reference picture" });
    expect(r.calls).toHaveLength(2);
  });
});

test("a render again the provider fails hands its shot back to the person who asked: accepted as is, the take keeps what its last check found", async () => {
  await inRun("rerender-failed", async (ws) => {
    const agent = await import("../../lib/workbench/rig-agent");
    const r = renders(ws, () => 0.3);
    const j = judge({ "01 — Opening": [{ identity: 0.6 }] });
    const deps = await depsFor(ws, r, { checks: { development: j.development } });
    const runId = await approvedRun(deps, { limit: 500, mode: "auto", shots: 1 });
    await stillShots(runId);
    expect(await tickTo(runId, deps, { tapRenders: true })).toEqual({ state: "needs_you", more: false });
    const unsure = (await view()).paid[1];
    expect(unsure).toMatchObject({ verdict: "needs_you", choices: ["accept", "rerender", "skip"], prices: { rerender: await credits(0.3) } });
    await agent.resolveRigAgentShot({ productionId: "prod-1", runId, seq: unsure.seq, choice: "rerender", userId: OWNER, name: "Ana" });
    /* Its render again is tapped and sent; the provider fails it, unbilled. */
    expect(await agent.advanceRigAgentRun(runId, deps)).toEqual({ state: "needs_you", more: false });
    const retake = (await view()).paid.find((p) => p.label === "Render again · 01 — Opening")!;
    await agent.renderRigAgentStep({ productionId: "prod-1", runId, seq: retake.seq, fingerprint: retake.fingerprint, userId: OWNER });
    const tick = await agent.advanceRigAgentRun(runId, deps);
    await settleTake(tick.waitFor!.genId, "failed", 0);
    expect(await tickTo(runId, deps)).toEqual({ state: "needs_you", more: false });
    const run = await view();
    const flagged = run.paid.at(-1)!;
    expect(flagged).toMatchObject({ label: "Check again · 01 — Opening", state: "paused", pause: "check", verdict: null, choices: ["accept", "rerender", "skip"] });
    expect(flagged.reason).toBe("Rendering 01 — Opening again did not work. Nothing was charged. Look at the take and decide.");
    expect(run.reason).toBe(flagged.reason);
    /* Never sent again on its own. */
    expect(await agent.advanceRigAgentRun(runId, deps)).toEqual({ state: "needs_you", more: false });
    expect(r.calls).toHaveLength(2);
    /* Accepted as is: the take it keeps was found unsure, and the words say so. */
    const accepted = await agent.resolveRigAgentShot({ productionId: "prod-1", runId, seq: flagged.seq, choice: "accept", userId: OWNER, name: "Ana" });
    expect(accepted.paid.at(-1)).toMatchObject({ state: "done", reason: "Accepted by Ana despite an unsure check." });
    expect(await agent.advanceRigAgentRun(runId, deps)).toEqual({ state: "done", more: false });
  });
});

test("a shot whose check is unsure is flagged and the run carries on with its other shots; it says it needs you once nothing else can move, and the person who asked is told once", async () => {
  await inRun("carry-on", async (ws) => {
    const agent = await import("../../lib/workbench/rig-agent");
    const { getRun } = await import("../../lib/workbench/rig-agent-store");
    const { db } = await import("../../lib/db");
    const r = renders(ws, () => 0.3);
    const j = judge({ "01 — Opening": [{ identity: 0.6 }], "02 — The turn": [{}] });
    const deps = await depsFor(ws, r, { checks: { development: j.development } });
    const runId = await approvedRun(deps, { limit: 500, mode: "auto", shots: 2 });
    await stillShots(runId);
    expect(await tickTo(runId, deps, { tapRenders: true })).toEqual({ state: "needs_you", more: false });
    const run = await view();
    expect(run.paid.map((p) => [p.tool, p.state, p.verdict])).toEqual([["render", "done", null], ["verify", "paused", "needs_you"], ["render", "done", null], ["verify", "done", "pass"]]);
    expect(run.paid[1]).toMatchObject({ pause: "check", reason: "Identity was unsure. Look at the take and decide.", choices: ["accept", "rerender", "skip"] });
    expect(run.reason).toBe("Identity was unsure. Look at the take and decide.");
    expect(j.seen).toEqual(["01 — Opening", "02 — The turn"]);
    /* Told once: the notice is stamped, and a second wait within the half hour is not told again. */
    const told = (await getRun(db(), runId))!.notifiedAt;
    expect(told).toBeGreaterThan(0);
    const first = (await view()).paid[1];
    await agent.resolveRigAgentShot({ productionId: "prod-1", runId, seq: first.seq, choice: "rerender", userId: OWNER, name: "Ana" });
    expect(await tickTo(runId, deps, { tapRenders: true })).toEqual({ state: "needs_you", more: false });
    expect((await getRun(db(), runId))!.notifiedAt).toBe(told);
  });
});

test("a fix writer that fails is not billed, and the shot waits for a person; it is never written again on its own", async () => {
  await inRun("writer-fails", async (ws) => {
    const agent = await import("../../lib/workbench/rig-agent");
    const { FixWriterError: Failure } = await import("../../lib/workbench/rig-agent-fix-writer");
    const { runCharges } = await import("../../lib/generationRequests");
    const r = renders(ws, () => 0.3);
    const j = judge({ "01 — Opening": [{ identity: 0.1 }] });
    let writes = 0;
    const deps = await depsFor(ws, r, { checks: { development: j.development }, fixes: { write: async () => { writes++; throw new Failure("Atomik could not write this fix."); } } });
    const runId = await approvedRun(deps, { limit: 500, mode: "auto", shots: 1 });
    await stillShots(runId);
    const before = await balance(ws);
    expect(await tickTo(runId, deps, { tapRenders: true })).toEqual({ state: "needs_you", more: false });
    const fixStep = (await stepsOf(runId)).find((s) => s.purpose === "fix")!;
    expect(fixStep).toMatchObject({ state: "paused", pause: "check", charge: "released", reason: "Atomik could not write this fix. Look at the take and decide." });
    expect(await meterRow(fixStep.chargeId!)).toMatchObject({ status: "failed", credits: 0 });
    expect(await intent(fixStep.chargeId!)).toBe("resolved");
    expect(await agent.advanceRigAgentRun(runId, deps)).toEqual({ state: "needs_you", more: false });
    expect(writes).toBe(1);
    expect((await view()).paid.find((p) => p.tool === "fix")!.choices).toEqual(["accept", "fix", "rerender", "skip"]);
    /* The run spent on the take and its check only. */
    const check = (await runCharges(runId)).find((c) => c.id.startsWith("wb_development_"))!;
    expect(await balance(ws)).toBe(before - (await credits(0.3)) - check.credits);
  });
});

test("a fix note a worker left reserved (it died mid-turn) is released unbilled at the next tick, and the shot waits for a person: never written again on its own", async () => {
  await inRun("writer-died", async (ws) => {
    const agent = await import("../../lib/workbench/rig-agent");
    const { agentNodeId } = await import("../../lib/workbench/rig-agent-plan");
    const charges = await import("../../lib/workbench/rig-agent-charges");
    const { workbenchTransaction } = await import("../../lib/workbench/records");
    const { insertLiveSteps, patchStep, getRun } = await import("../../lib/workbench/rig-agent-store");
    const { db, now } = await import("../../lib/db");
    const r = renders(ws, () => 0.3);
    let writes = 0;
    const deps = await depsFor(ws, r, { fixes: { write: async () => { writes++; throw new Error("never asked"); } } });
    const runId = await approvedRun(deps, { limit: 500, mode: "ask", shots: 1 });
    const shot = agentNodeId(runId, "shot-1");
    /* As a check that failed leaves it: fix 1 planned; then a worker reserved its note and died before it settled. */
    const [fix] = await workbenchTransaction((tx) => insertLiveSteps(tx, runId, roundSteps(shot, "01 — Opening", 1, { kind: "fix", fix: 1 }), now()));
    await patchStep(db(), fix.id, { request: { kind: "fix", check: "identity", move: "replace", prompt: "", master: null, masterTitle: "Mira", reasons: ["Not Mira."], source: "gen_x", take: "image" } }, ["next"]);
    const id = charges.stepChargeEventId(runId, fix.seq, 1);
    expect(await charges.reserveStepCharge((await getRun(db(), runId))!, fix, { id, engine: "vercel", model: MOCK_PLANNER_MODEL, ceilingUsd: 0.2 }, async () => null)).toBeNull();
    /* Everything before it is out of the way, so the fix is the next move. */
    await db().execute({ sql: "UPDATE rig_agent_steps SET state='skipped' WHERE run_id=? AND purpose IN ('take','verify') AND round IS NULL", args: [runId] });
    await db().execute({ sql: "UPDATE rig_agent_steps SET state='done' WHERE run_id=? AND state='queued'", args: [runId] });
    expect(await agent.advanceRigAgentRun(runId, deps)).toEqual({ state: "needs_you", more: false });
    expect((await stepsOf(runId)).find((s) => s.id === fix.id)).toMatchObject({ state: "paused", pause: "check", charge: "released", reason: "Atomik's fix note was interrupted, and it is never written again on its own. Look at the take and decide." });
    expect(await meterRow(id)).toMatchObject({ status: "failed", credits: 0 });
    expect(writes).toBe(0);
    expect(r.calls).toEqual([]);
  });
});

/* ── Live steps, stop and the cron, a step's own paid text ────────────── */

test("a shot's round and the check of it are added once, after every step the run has, whatever asks twice", async () => {
  await inRun("live-steps", async (ws) => {
    const { agentNodeId } = await import("../../lib/workbench/rig-agent-plan");
    const { workbenchTransaction } = await import("../../lib/workbench/records");
    const { insertLiveSteps, nextRound } = await import("../../lib/workbench/rig-agent-store");
    const { db, now } = await import("../../lib/db");
    const r = renders(ws, () => 0.3);
    const runId = await approvedRun(await depsFor(ws, r), { limit: 500, mode: "ask", shots: 2 });
    const before = await stepsOf(runId);
    const top = Math.max(...before.map((s) => s.seq));
    const shot1 = agentNodeId(runId, "shot-1");
    expect(await nextRound(db(), runId, shot1)).toBe(1);
    const first = await workbenchTransaction((tx) => insertLiveSteps(tx, runId, roundSteps(shot1, "01 — Opening", 1, { kind: "fix", fix: 1 }), now()));
    expect(first.map((s) => [s.seq, s.purpose, s.tool, s.round, s.state, s.label])).toEqual([
      [top + 1, "fix", "fix", 1, "next", "Fix 1 · 01 — Opening"], [top + 2, "verify", "verify", 1, "next", "Check fix 1 · 01 — Opening"],
    ]);
    const again = await workbenchTransaction((tx) => insertLiveSteps(tx, runId, roundSteps(shot1, "01 — Opening", 1, { kind: "fix", fix: 1 }), now()));
    expect(again.map((s) => s.id)).toEqual(first.map((s) => s.id));
    expect(await stepsOf(runId)).toHaveLength(before.length + 2);
    expect(await nextRound(db(), runId, shot1)).toBe(2);
    const second = await workbenchTransaction((tx) => insertLiveSteps(tx, runId, roundSteps(shot1, "01 — Opening", 2, { kind: "rerender" }), now()));
    expect(second.map((s) => [s.seq, s.purpose, s.round])).toEqual([[top + 3, "take", 2], [top + 4, "verify", 2]]);
    await expect(db().execute({ sql: "INSERT INTO rig_agent_steps(id,run_id,seq,tool,label,purpose,node_id,attempt,prepared,state,round,created_at,updated_at) VALUES(?,?,?,?,?,?,?,0,'[]','next',1,0,0)",
      args: [`${runId}:999`, runId, 999, "fix", "dup", "fix", shot1] })).rejects.toThrow(/UNIQUE/);
    const live = (await view()).paid.filter((p) => p.round != null);
    expect(live.map((p) => [p.tool, p.label, p.round, p.canRender])).toEqual([
      ["fix", "Fix 1 · 01 — Opening", 1, false], ["verify", "Check fix 1 · 01 — Opening", 1, false],
      ["render", "Render again · 01 — Opening", 2, false], ["verify", "Check again · 01 — Opening", 2, false],
    ]);
  });
});

test("stop lets go of every check and fix not sent, keeping what a check that ran was charged; a fix whose request never left is fenced; a fix in flight settles at what it cost", async () => {
  await inRun("stop-fixes", async (ws) => {
    const agent = await import("../../lib/workbench/rig-agent");
    const { agentNodeId } = await import("../../lib/workbench/rig-agent-plan");
    const { STOPPED_UNSENT, fixRequestKey } = await import("../../lib/workbench/rig-agent-runs");
    const { checkGenerationRequest } = await import("../../lib/generationRequests");
    const { preparedClaimFingerprint } = await import("../../lib/admissionSupport");
    const r = renders(ws, () => 0.3);
    const j = judge({ "01 — Opening": [{ identity: 0.1 }] });
    const deps = await depsFor(ws, r, { checks: { development: j.development } });
    /* Fix 1 waiting for its tap, its check not run: a stop lets them go, nothing charged for them. */
    const quiet = await approvedRun(deps, { limit: 500, mode: "auto", shots: 1 });
    await stillShots(quiet);
    expect(await tickTo(quiet, deps, { tapRenders: true })).toEqual({ state: "needs_you", more: false });
    const beforeStop = await balance(ws);
    const stopped = await agent.stopRigAgent({ productionId: "prod-1", runId: quiet, userId: TEAMMATE });
    expect(stopped.paid.map((p) => [p.tool, p.state])).toEqual([["render", "done"], ["verify", "done"], ["fix", "skipped"], ["verify", "skipped"]]);
    expect(stopped.paid[2]).toMatchObject({ charged: null, reason: agent.STOPPED_AFTER_SPEND });
    expect(stopped.paid[3]).toMatchObject({ charged: null, reason: STOPPED_UNSENT });
    expect(await balance(ws)).toBe(beforeStop);
    /* A fix whose request never left: the stop asks by its key, fences it, and lets it go; nothing is sent again. */
    const lost = await approvedRun(deps, { limit: 500, mode: "auto", shots: 1 });
    await stillShots(lost);
    const shotL = agentNodeId(lost, "shot-1");
    expect(await tickTo(lost, deps, { tapRenders: true })).toEqual({ state: "needs_you", more: false });
    const fix = (await view()).paid.find((p) => p.tool === "fix")!;
    await agent.renderRigAgentStep({ productionId: "prod-1", runId: lost, seq: fix.seq, fingerprint: fix.fingerprint, userId: OWNER });
    r.behaviour.throwBeforeClaim = true;
    await agent.advanceRigAgentRun(lost, deps);
    const sending = (await stepsOf(lost)).find((s) => s.purpose === "fix")!;
    expect(sending.state).toBe("sending");
    const sent = r.calls.length;
    await agent.stopRigAgent({ productionId: "prod-1", runId: lost, userId: OWNER });
    expect((await stepsOf(lost)).find((s) => s.purpose === "fix")).toMatchObject({ state: "skipped", reason: STOPPED_UNSENT });
    expect(await checkGenerationRequest({ userId: OWNER, key: fixRequestKey(lost, shotL, sending.round!, 1), fingerprint: preparedClaimFingerprint(sending.admission!) })).toEqual({ state: "absent" });
    expect(await agent.advanceRigAgentRun(lost, deps)).toEqual({ state: "stopped", more: false });
    expect(r.calls).toHaveLength(sent);
    /* A fix in flight at the stop settles at what it cost, and its step records it. */
    const flying = await approvedRun(deps, { limit: 500, mode: "auto", shots: 1 });
    await stillShots(flying);
    expect(await tickTo(flying, deps, { tapRenders: true })).toEqual({ state: "needs_you", more: false });
    const fix3 = (await view()).paid.find((p) => p.tool === "fix")!;
    await agent.renderRigAgentStep({ productionId: "prod-1", runId: flying, seq: fix3.seq, fingerprint: fix3.fingerprint, userId: OWNER });
    const tick = await agent.advanceRigAgentRun(flying, deps);
    await agent.stopRigAgent({ productionId: "prod-1", runId: flying, userId: OWNER });
    expect((await stepsOf(flying)).find((s) => s.purpose === "fix")!.state).toBe("rendering");
    await settleTake(tick.waitFor!.genId, "succeeded", 0.3);
    expect((await stepsOf(flying)).find((s) => s.purpose === "fix")).toMatchObject({ state: "done", creditsSettled: await credits(0.3) });
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
    const made = await workbenchTransaction((tx) => insertLiveSteps(tx, runId,
      [1, 2, 3, 4, 5, 6, 7].map((n) => ({ tool: "verify" as const, purpose: "verify" as const, label: `Check again · 01 — Opening`, nodeId: shot, round: n })), now()));
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
    await place(1, "sending", false);
    await place(2, "sending", false); await job(ids(2).job, ids(2).request, "queued", false);
    await place(3, "rendering", true); await job(ids(3).job, ids(3).request, "running", false); await charge(ids(3).job, 0, "running");
    await place(4, "rendering", true); await job(ids(4).job, ids(4).request, "succeeded", true); await charge(ids(4).job, 0.05, "succeeded");
    await place(5, "rendering", true); await job(ids(5).job, ids(5).request, "failed", true);
    await place(6, "rendering", true); await job(ids(6).job, ids(6).request, "failed", true); await charge(ids(6).job, 0.2, "failed");
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
    const runId = await approvedRun(await depsFor(ws, r), { limit: 500, mode: "ask", shots: 1 });
    const run = (await getRun(db(), runId))!;
    const shot = agentNodeId(runId, "shot-1");
    const [fix1] = await workbenchTransaction((tx) => insertLiveSteps(tx, runId, roundSteps(shot, "01 — Opening", 1, { kind: "fix", fix: 1 }), now()));
    const live = async () => null;
    const turn = (attempt: number, ceilingUsd: number) => ({ id: charges.stepChargeEventId(runId, fix1.seq, attempt), engine: "vercel", model: MOCK_PLANNER_MODEL, ceilingUsd });
    const start = await balance(ws);
    const first = turn(1, 0.2);
    expect(await charges.reserveStepCharge(run, fix1, first, live)).toBeNull();
    expect(await meterRow(first.id)).toMatchObject({ status: "running", credits: quotedCredits(0.2, "text") });
    expect((await stepsOf(runId)).find((s) => s.id === fix1.id)).toMatchObject({ charge: "reserved", chargeId: first.id });
    expect((await runCharges(runId)).find((c) => c.id === first.id)).toMatchObject({ running: true });
    expect(await intent(first.id)).toBe("accepted");
    expect(await openStepCharge(db(), fix1.id, turn(2, 0.2).id)).toBe(false);
    expect(await charges.settleStepCharge(run, fix1, first, { billed: true, usedUsd: 0.05 })).toBe(true);
    const settled = await meterRow(first.id);
    expect(settled).toMatchObject({ status: "succeeded" });
    expect(settled!.credits).toBeGreaterThan(0);
    expect(settled!.credits).toBeLessThanOrEqual(quotedCredits(0.2, "text"));
    expect(await intent(first.id)).toBe("resolved");
    expect(await balance(ws)).toBe(start - settled!.credits);
    const failing = turn(2, 0.2);
    expect(await charges.reserveStepCharge(run, fix1, failing, live)).toBeNull();
    expect(await charges.settleStepCharge(run, fix1, failing, { billed: false, usedUsd: 0.01 })).toBe(true);
    expect(await meterRow(failing.id)).toMatchObject({ status: "failed", credits: 0 });
    expect(await intent(failing.id)).toBe("resolved");
    const spent = (await runCharges(runId)).reduce((sum, c) => sum + c.credits, 0);
    const over = turn(3, 0.2);
    expect(await charges.reserveStepCharge({ ...run, capCredits: spent + 0.1 }, fix1, over, live)).toBe(RUN_LIMIT_REACHED);
    expect(await meterRow(over.id)).toBeNull();
    expect((await stepsOf(runId)).find((s) => s.id === fix1.id)).toMatchObject({ charge: "released", chargeId: over.id });
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
    const reserved = async (runId: string, round: number) => {
      const run = (await getRun(db(), runId))!;
      const [fix] = await workbenchTransaction((tx) => insertLiveSteps(tx, runId, roundSteps(agentNodeId(runId, "shot-1"), "01 — Opening", round, { kind: "fix", fix: round }), now()));
      const id = charges.stepChargeEventId(runId, fix.seq, 1);
      expect(await charges.reserveStepCharge(run, fix, { id, engine: "vercel", model: MOCK_PLANNER_MODEL, ceilingUsd: 0.2 }, async () => null)).toBeNull();
      return { fix, id };
    };
    const planned = async (runId: string) => (await meterRow(agent.planEventId(runId)))!.credits;
    const a = await approvedRun(deps, { limit: 500, mode: "ask", shots: 1 });
    const left = await reserved(a, 1);
    expect(await balance(ws)).toBeLessThan(start - (await planned(a)));
    await agent.stopRigAgent({ productionId: "prod-1", runId: a, userId: TEAMMATE });
    expect(await meterRow(left.id)).toMatchObject({ status: "failed", credits: 0 });
    expect(await intent(left.id)).toBe("resolved");
    expect((await stepsOf(a)).find((s) => s.id === left.fix.id)).toMatchObject({ charge: "released" });
    expect(await balance(ws)).toBe(start - (await planned(a)));
    const b = await approvedRun(deps, { limit: 500, mode: "ask", shots: 1 });
    const [fixB] = await workbenchTransaction((tx) => insertLiveSteps(tx, b, roundSteps(agentNodeId(b, "shot-1"), "01 — Opening", 1, { kind: "fix", fix: 1 }), now()));
    const ghost = charges.stepChargeEventId(b, fixB.seq, 1);
    expect(await openStepCharge(db(), fixB.id, ghost)).toBe(true);
    await db().execute({ sql: "UPDATE rig_agent_runs SET state='failed',updated_at=0 WHERE id=?", args: [b] });
    expect(await agent.drainRigAgentWakeups()).toMatchObject({ swept: 1 });
    expect((await stepsOf(b)).find((s) => s.id === fixB.id)).toMatchObject({ charge: "released" });
    expect(await meterRow(ghost)).toBeNull();
    const c = await approvedRun(deps, { limit: 500, mode: "ask", shots: 1 });
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
    expect(r.calls).toEqual([]);
  });
});
