import { randomUUID } from "node:crypto";
import { db, ready, now } from "./db";
import { allowanceCheck } from "./allowance";
import { invalidate, PROJECTS_KEY } from "./cache";
import { creditsApply, quotedCredits } from "./credits";
import { marginKeyOf } from "./creditTerms";
import { currentTenant, requireTenant } from "./tenant";
import { checkCap } from "./caps";
import { checkLimits } from "./limits";
import { readImageBytes, readUploadBytes } from "./storage";
import { reserveGenerationSpend, SpendReservationError } from "./generationRequests";
import { meter, type MeterKind } from "./meter";
import { noAnswerOutcome } from "./providerOutcome";
import { platformDb, platformReady } from "./platform";
import type { AdmissionActor, AdmissionExecution, AdmissionReply } from "./admissionTypes";
import { admissionReply, admissionCheckpoint, assertAdmissionActor } from "./admissionSupport";
import { jobLineNow, shotCapAdmin, shotCapGate } from "./shotCap";
import { getShot } from "./shots";
import { uploadOpenableBy } from "./uploadAccess";
import { mayReachProject, mayReadTake } from "./draftProject";
import { NOT_YOURS, mayChangeWork } from "./workAccess";
import { isAgentId } from "./security/people-only";
import { engineEnabled } from "./engineGate";
import { VISION_RATES } from "./vendorRates";
import { VISION_IMAGE_LIMIT_BYTES, VISION_SWITCH, VisionError, detectText, visionConfigured, type VisionWord } from "./vision";
import { LABEL_DETECTED_MAX, LABEL_EXPECTED_MAX, labelDiff, normalise, readRules, rulesProblem, type DiffOp, type LabelMode, type LabelRules, type LabelVerdict } from "./labelDiff";

/**
 * The label check (`label_check`): does the text in a take's picture say exactly what the brief requires? Google Cloud Vision reads the text (lib/vision.ts); a plain
 * character-by-character diff (lib/labelDiff.ts) compares it with the required text. **No AI model decides pass or fail** (the owner, 14 Oct 2026); a model's
 * opinion is never an input. A mismatch, or no text at all, FLAGS the take for a person; it never blocks, hides, deletes or changes it. The result is kept on the take's own
 * row (generations.params.labelCheck: the verdict, the rules, the required text, the text read with its words and boxes, and the difference): no new table, no migration.
 * A person reads it through lib/directEnginePublic.ts. One door for the button, Make, a board card, Atomik, a saved skill and an outside agent (POST /api/label-check).
 *
 * WHAT IS CHECKED. One still: the take itself when it is an image take, or `frameUploadId`, an image upload of this workspace (a video is checked on a frame the browser
 * sampled: the server has no decoder, lib/workbench/verify.ts). Where text is wanted the check reports it; it flags only a mismatch or a missing label. A take with no
 * required text is simply not checked here.
 *
 * MONEY. One image a request: VISION_RATES (lib/vendorRates.ts, verified against Google's pricing page, 16 Oct 2026) through the margin table; a person approves (`maxCredits`; over MCP only the workspace's own
 * Ask/Auto setting does: lib/directEngineMcp.ts, where a check is a draft); reserved at the quote on the meter before the call, settled at the quote when Google read the
 * picture (including a picture with no text: Google analysed it) and at nothing ("Nothing was billed") when it refused or did not answer. Never above the quote.
 *
 * PRIVACY. The picture is read from this workspace and sent as data, never as a link of ours. A frame can show private text (a name tag, a screen): what Google read is
 * kept only in this workspace's own take row, like any take's words. Google keeps no image and trains on nothing it is sent (the plan, § 4); it is processed abroad, which counsel notes.
 */
export const LABEL_CHECK_TASK = "labelCheck";
const ENTITY_ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const UPLOAD_ID = /^[A-Za-z0-9_-]{1,128}$/;
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"]);
const MAX_OPS = 100, MAX_OP_TEXT = 400, MAX_DETECTED_KEPT = 4000;

export type LabelCheckRecord = {
  v: 1; verdict: LabelVerdict; flagged: boolean; mode: LabelMode; rules: LabelRules;
  expected: string; detected: string; distance: number; ops: DiffOp[]; words: VisionWord[]; checkedAt: number;
  /** True only when the text read was cut for the work (lib/labelDiff.ts WHOLE_SLACK). */
  truncated?: true;
  source: { kind: "take" | "upload"; id: string };
};
export type LabelCheckSeams = { detect?: typeof detectText; clock?: () => number };

/**
 * The person a request acts for, or null (and the request is refused): the signed-in person or the token's owner (the request's user is that person, with their role), or, for
 * an Atomik run's own identity (`agent:<runId>`), the person who started that run (`rig_agent_runs.owner`), as a member: an agent run never gains admin (lib/workAccess.ts).
 * Anything else (the server's own pass, a run that names no one, a read error) has no person behind it and is refused: it could otherwise reach another person's private board.
 */
async function actingPerson(user: AdmissionActor["user"]): Promise<{ id: string; role: "admin" | "member"; owner?: boolean } | null> {
  if (!isAgentId(user.id)) return { id: user.id, role: user.role === "admin" ? "admin" : "member", ...(user.owner ? { owner: true } : {}) };
  if (!user.id.startsWith("agent:")) return null;
  try {
    const owner = (await db().execute({ sql: "SELECT owner FROM rig_agent_runs WHERE id = ? LIMIT 1", args: [user.id.slice("agent:".length)] })).rows[0]?.owner;
    return typeof owner === "string" && owner && !isAgentId(owner) ? { id: owner, role: "member" } : null;
  } catch { return null; }
}

export const executeLabelCheck = (input: Record<string, unknown>, got: AdmissionActor, options: AdmissionExecution): Promise<AdmissionReply> => admitLabelCheck(input, got, options, {});

/** The same with the test seams. Internal: only the tests import it (tests/unit/visionLabel.spec.ts says so by reading the source). */
export async function admitLabelCheck(input: Record<string, unknown>, got: AdmissionActor, options: AdmissionExecution, seams: LabelCheckSeams): Promise<AdmissionReply> {
  const refusal = assertAdmissionActor(got);
  if (refusal) return refusal;
  /* Off for this workspace (the switch, or not on the engine list): the tool is simply not here. */
  if (!(await engineEnabled(VISION_SWITCH))) return admissionReply({ error: "There is no such tool here." }, { status: 404 });
  const body = structuredClone(input) as Record<string, unknown>;
  const quoteOnly = body.quoteOnly === true;
  await ready();
  if (!visionConfigured()) return admissionReply({ error: "This is not set up: GOOGLE_VISION_API_KEY is needed." }, { status: 400 });
  const allowance = await allowanceCheck("vision");
  if (!allowance.ok && allowance.status !== 402) return admissionReply({ error: allowance.error }, { status: allowance.status });

  /* ── What was asked, checked ── */
  const takeId = typeof body.takeId === "string" ? body.takeId : "";
  if (!ENTITY_ID.test(takeId)) return admissionReply({ error: "Pick the take to check." }, { status: 400 });
  if (typeof body.expected !== "string" || !body.expected.trim()) return admissionReply({ error: "Write the text the label must carry." }, { status: 400 });
  if ([...body.expected].length > LABEL_EXPECTED_MAX) return admissionReply({ error: `The required text is up to ${LABEL_EXPECTED_MAX.toLocaleString("en-US")} characters.` }, { status: 400 });
  const problem = rulesProblem(body.rules);
  if (problem) return admissionReply({ error: problem }, { status: 400 });
  const rules = readRules(body.rules);
  if (body.mode != null && body.mode !== "whole" && body.mode !== "contains") return admissionReply({ error: "mode is whole (default: the picture's text is exactly the required text) or contains (the required text is in it)." }, { status: 400 });
  const mode: LabelMode = body.mode === "contains" ? "contains" : "whole";
  const expected = body.expected;
  if (!normalise(expected, rules)) return admissionReply({ error: "Write the text the label must carry." }, { status: 400 });

  const take = (await db().execute({ sql: "SELECT id, kind, status, project_id, shot_id, stored_url, created_by FROM generations WHERE id=? AND deleted=0 LIMIT 1", args: [takeId] })).rows[0];
  if (!take) return admissionReply({ error: "That take is not in this workspace." }, { status: 404 });
  /* WHO may check it, before the picture is read, anything is reserved or anything is written (the rules /api/jobs/[id] applies): the person must have a person behind them; a take in a
     private board they cannot open is as absent as an unknown id; and the result is written onto the take, so it must be one they may change (its maker, the board's owner or an admin). */
  const person = await actingPerson(got.user);
  if (!person) return admissionReply({ error: "This check needs a person behind it." }, { status: 403 });
  const takeProject = take.project_id == null ? null : String(take.project_id);
  if (!(await mayReadTake(person, takeProject)) || (takeProject && !(await mayReachProject(person, takeProject, "write")))) return admissionReply({ error: "That take is not in this workspace." }, { status: 404 });
  if (!(await mayChangeWork(person, { createdBy: take.created_by == null ? null : String(take.created_by), projectId: takeProject }))) return admissionReply({ error: NOT_YOURS.take }, { status: 403 });
  const frameId = body.frameUploadId == null ? null : body.frameUploadId;
  let source: { kind: "take" | "upload"; id: string; ext?: string; stored?: string };
  if (frameId != null) {
    if (typeof frameId !== "string" || !UPLOAD_ID.test(frameId)) return admissionReply({ error: "That frame is not valid." }, { status: 400 });
    const row = (await db().execute({ sql: "SELECT ext, mime, stored_url, bytes FROM uploads WHERE id=? LIMIT 1", args: [frameId] })).rows[0];
    const openable = !row || (await uploadOpenableBy(frameId, person));
    if (!row || !openable || !IMAGE_MIMES.has(String(row.mime ?? "").toLowerCase())) return admissionReply({ error: "Pick a frame from this workspace's image uploads." }, { status: 404 });
    if (!(Number(row.bytes) > 0) || Number(row.bytes) > VISION_IMAGE_LIMIT_BYTES) return admissionReply({ error: "A frame is up to 10 MB." }, { status: 400 });
    source = { kind: "upload", id: frameId, ext: String(row.ext), stored: String(row.stored_url) };
  } else {
    if (String(take.kind) !== "image" || String(take.status) !== "succeeded" || !take.stored_url) return admissionReply({ error: "A video is checked on a frame of it: give frameUploadId, an image upload of this workspace." }, { status: 400 });
    source = { kind: "take", id: takeId };
  }

  const usd = VISION_RATES.textDetectionUsdPerImage;
  /* The approval unit, through the margin table keyed as the reservation keys an image job (by its model). No number of ours here. */
  const marginKey = marginKeyOf("image", VISION_RATES.model);
  const estimatedCredits = quotedCredits(usd, marginKey);
  const inCredits = creditsApply(requireTenant());
  const projectId = take.project_id ? String(take.project_id) : null;
  const shotId = take.shot_id ? String(take.shot_id) : null;
  const over = jobLineNow({ credits: estimatedCredits, usd, key: "vision", actor: got, auto: options.run?.auto === true });
  if (over) return admissionReply({ error: over, needsAdmin: true }, { status: 403 });
  /* The cost approval rule (brief 2.2). A check creates no take, but its ledger line is charged to the take's shot and counts toward that shot's cap: with a cap per shot, a member's
     check past it needs an admin, refused before anything is read, reserved or written. A shot that is gone is no shot's to cap. */
  const shot = shotId ? await getShot(shotId) : null;
  if (shotId && shot) {
    /* An admin's own press only: the acting person (the run's owner, as a member, for an agent run), not on a token and not an Atomik Auto step (the test jobLineNow applies). */
    const stop = await shotCapGate({ shotId, code: shot.code, takeUsd: usd, modelId: marginKey, isAdmin: shotCapAdmin({ user: person, token: got.token }, options.run?.auto === true) });
    if (stop) return admissionReply({ error: stop, needsAdmin: true }, { status: 403 });
  }
  if (quoteOnly) return admissionReply({ estimatedCredits, price: inCredits ? estimatedCredits : usd, unit: inCredits ? "cr" : "usd", mode, rules, images: 1 });
  if (!Number.isInteger(body.maxCredits) || (body.maxCredits as number) < 0 || estimatedCredits > (body.maxCredits as number))
    return admissionReply({ error: "Approve the price first: the estimate is above the approved credit amount." }, { status: 409 });
  const wall = await allowanceCheck("vision", usd, marginKey);
  if (!wall.ok) return admissionReply({ error: wall.error }, { status: wall.status });
  const capV = await checkCap(projectId, usd, marginKey);
  if (!capV.allow) return admissionReply({ error: capV.error }, { status: 409 });
  const lim = await checkLimits();
  if (!lim.allow) return admissionReply({ error: lim.error }, { status: lim.why === "rate" ? 429 : 409 });
  const stopped = admissionCheckpoint(options, body, got, "image", usd, marginKey, { task: LABEL_CHECK_TASK, takeId, source: source.id, mode, rules, expected, projectId, shotId }, { engine: "vision" });
  if (stopped) return stopped;

  /* ── Run it: one image, reserved first and settled after ── */
  const event = { id: `vlc_${randomUUID().replace(/-/g, "")}`, kind: "image" as const, engine: "vision", model: VISION_RATES.model, projectId, shotId, createdBy: got.user.id };
  try { await reserveGenerationSpend({ ...event, status: "running", engineCostUsd: usd }, { token: got.token }); }
  catch (e) { return admissionReply({ error: e instanceof Error ? e.message : "The reservation could not be made." }, { status: e instanceof SpendReservationError ? e.status : 503 }); }
  let read: Awaited<ReturnType<typeof detectText>>;
  try {
    const bytes = source.kind === "take" ? await readImageBytes(source.id) : await readUploadBytes(source.id, source.ext!, source.stored!, VISION_IMAGE_LIMIT_BYTES);
    read = await (seams.detect ?? detectText)({ bytes });
  } catch (error) {
    await meter({ ...event, status: "failed", engineCostUsd: 0 }).catch(() => {});
    const status = error instanceof VisionError && error.rejectedBeforeWork && error.status ? error.status : 502;
    return admissionReply({ error: `${(error instanceof Error && error.message ? error.message : "The text could not be read.").slice(0, 300)} Nothing was billed.`, charged: 0 }, { status });
  }
  /* Google read the picture (even one with no text in it): the check is billed at the quote. The diff is plain code and cannot fail the bill. */
  const diff = labelDiff(expected, read.text.slice(0, LABEL_DETECTED_MAX), mode, rules);
  const record: LabelCheckRecord = {
    v: 1, verdict: diff.verdict, flagged: diff.verdict !== "match", mode, rules, expected: diff.expected, detected: diff.detected.slice(0, MAX_DETECTED_KEPT), distance: diff.distance, ...(diff.truncated ? { truncated: true as const } : {}),
    ops: diff.ops.slice(0, MAX_OPS).map((o) => ({ op: o.op, text: o.text.slice(0, MAX_OP_TEXT) })), words: read.words, checkedAt: (seams.clock ?? Date.now)(),
    source: { kind: source.kind, id: source.id },
  };
  let kept = true;
  try {
    await db().execute({ sql: "UPDATE generations SET params=json_set(params,'$.labelCheck',json(?)) WHERE id=? AND deleted=0", args: [JSON.stringify(record), takeId] });
    invalidate(PROJECTS_KEY);
  } catch { kept = false; }
  await meter({ ...event, status: "succeeded", engineCostUsd: usd }).catch(() => {});
  return admissionReply({ ok: true, takeId, estimatedCredits, kept, ...record });
}

/* ── The sweep ───────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

export const LABEL_CHECK_STALE_MS = 15 * 60_000;

/**
 * The cron's stage. A check is one request of ours, reserved before it is made and settled after; if the process dies between the two, its reservation stays running and holds
 * the workspace's money. One still running after LABEL_CHECK_STALE_MS is one the process never finished: it is settled at nothing ("Nothing billed"; whether Google read the
 * picture is unknown and the platform absorbs it), which frees the hold. Nothing is ever sent again, and no take is touched (no result was written).
 */
export async function recoverLabelChecks(options: { limit?: number; deadlineAt?: number } = {}, clock: () => number = now): Promise<{ attempted: number; failed: number; deferred: number }> {
  await ready();
  await platformReady();
  const limit = Math.max(1, Math.min(50, options.limit ?? 8));
  const deadlineAt = options.deadlineAt ?? clock() + 250_000;
  const stale = (await platformDb().execute({ sql: "SELECT id, kind, model FROM meter_events WHERE workspace_id=? AND engine='vision' AND status='running' AND created_at<? ORDER BY created_at LIMIT ?", args: [requireTenant().id, clock() - LABEL_CHECK_STALE_MS, limit] })).rows;
  let attempted = 0, failed = 0, deferred = 0;
  for (const row of stale) {
    if (clock() >= deadlineAt) { deferred++; continue; }
    attempted++;
    /* Whether Google read the picture is unknown: settled at nothing, and said so on the ledger line (a no-answer outcome, billing unknown) for the admin desk to reconcile against Google's invoice. */
    try { await meter({ id: String(row.id), kind: String(row.kind) as MeterKind, engine: "vision", model: String(row.model), status: "failed", engineCostUsd: 0, providerOutcome: noAnswerOutcome("google", "run", "this check was never finished") }); } catch { failed++; }
  }
  return { attempted, failed, deferred };
}

/* ── The registry tool ──────────────────────────────────────────────────────────────────────────────────────────────────────── */

/** The one tool, declared beside its handler (docs/particl-sow-2026-10-04.md § 4.3). One route, one price path, one approval for every consumer. */
export const LABEL_CHECK_TOOLS = [
  {
    provider: "google", kind: "engine" as const, route: "/api/label-check", needs: ["GOOGLE_VISION_API_KEY", "VISION_LABEL_CHECK_ENABLED"], who: "prepare: anyone; approve: a person" as const,
    models: [VISION_RATES.model], id: "label_check",
    inputs: { takeId: "the take to check", expected: "the text the label must carry", frameUploadId: "an image upload of this workspace (a frame of a video take); an image take needs none", mode: "whole (default) or contains", rules: "unicode nfc|none, case exact|fold, whitespace exact|collapse (strict by default)", maxCredits: "the approved price" },
    output: "a flag and the difference, kept on the take; it never blocks the take",
    draft: "a check that renders nothing: Auto may start it at or under the per-job line",
  },
];

/** The tools present for a workspace: none unless the engine is on for it. */
export async function labelCheckTools(workspace: { id: string } | null | undefined = currentTenant()?.workspace): Promise<typeof LABEL_CHECK_TOOLS> {
  if (!(await engineEnabled(VISION_SWITCH, workspace))) return [];
  return LABEL_CHECK_TOOLS;
}
