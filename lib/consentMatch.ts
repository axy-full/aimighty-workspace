import { randomUUID } from "node:crypto";
import { db, ready } from "./db";
import { currentTenant, requireTenant } from "./tenant";
import { engineEnabled } from "./engineGate";
import { REKOGNITION_MAX_BYTES, REKOGNITION_SWITCH, REKOGNITION_USD_PER_IMAGE, RekognitionError, compareFaces, type RekognitionDeps } from "./rekognition";
import { consentReferenceImage } from "./consentReference";
import { liveFaceConsentFor } from "./security/consent";
import type { ConsentUse } from "./security/consent-words";
import { securityAuditStatement } from "./securityAudit";
import { reserveGenerationSpend, SpendReservationError } from "./generationRequests";
import { meter } from "./meter";
import { readUploadBytes } from "./storage";

/**
 * The consent face gate (the owner's rule, 15 Oct 2026): "Consent: every real face passes Rekognition against its consent record before
 * Act-Two, cloning or lip-sync runs."
 *
 * `requireConsentMatch(castMemberId, faceImage)` is the one hard gate. Lip-sync, Act-Two and cloning call it before they spend anything,
 * with the face they are about to use; it returns only when that face is the person whose live consent covers it, and otherwise throws a
 * ConsentMatchError saying why. It FAILS CLOSED at every step:
 *
 *   1. the engine is off for this workspace (lib/engineGate.ts: REKOGNITION_ENABLED and house-or-listed)  -> refused, nothing called
 *   2. no live consent covering the cast member's face                                                    -> refused
 *   3. the consent has no face reference (lib/consentReference.ts, null today)                             -> refused, nothing called
 *   4. the provider cannot answer (error, no face in an image, not set up)                                 -> refused, nothing billed
 *   5. the similarity is under CONSENT_MATCH_THRESHOLD                                                    -> refused, for a person to look at
 *
 * Money: the call's real cost (REKOGNITION_USD_PER_IMAGE) is reserved on the meter before the call and settled at that cost when the
 * provider answered with a score, at nothing ("Nothing billed") when it did not. The row is at cost and bills no credits (a face check is a
 * safety gate, and what a customer is charged for it, if anything, is the owner's decision: lib/platformSpend.ts paidByPlatformEngine).
 *
 * Privacy: the two images exist in memory for the call and nowhere else. What is kept is a security-history line: the consent's id, the
 * similarity score, whether it passed, and the time (lib/securityAudit.ts `consent.face_checked`). No image, crop or face vector.
 */
/** Same face at or above this similarity (0 to 100). A proposal (docs/plans/provider-adapters.md § 3, owner question E): AWS's default is 80. */
export const CONSENT_MATCH_THRESHOLD = 90;
export const NO_REFERENCE = "This person's consent has no face reference yet.";
export const ENGINE_OFF = "The face check isn't on for this workspace, so a real face can't be used here yet.";
export const NO_LIVE_CONSENT = "No live consent covers this person's face. Record it on the Cast card first.";
export const NO_MATCH = "This face doesn't look like the person who gave consent. A person needs to look at it.";
export const NOT_DONE = "The face check could not be done. Nothing was billed.";

export type ConsentMatchCode = "off" | "no-consent" | "no-reference" | "no-face" | "no-match" | "unavailable" | "bad-input";
export class ConsentMatchError extends Error {
  constructor(readonly code: ConsentMatchCode, message: string, readonly status: number) { super(message); this.name = "ConsentMatchError"; }
}
export type ConsentMatch = { consentId: string; similarity: number; matched: true; checkedAt: number };

export type ConsentMatchOptions = {
  /** One production's consents only; without it any of this workspace's records for the cast member. */
  projectId?: string | null;
  /** The use the face is for (production, ads, social, identity): the record must allow it. */
  use?: ConsentUse;
  /** Who is asking, for the ledger line and the history line: a user id or an agent id. */
  by?: string | null;
  deps?: RekognitionDeps & { reference?: typeof consentReferenceImage; engine?: typeof engineEnabled };
};

const ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const round1 = (n: number) => Math.round(n * 10) / 10;

export async function requireConsentMatch(castMemberId: string, faceImage: Buffer, options: ConsentMatchOptions = {}): Promise<ConsentMatch> {
  if (typeof castMemberId !== "string" || !ID.test(castMemberId)) throw new ConsentMatchError("bad-input", "Say which cast member this face is for.", 400);
  if (!Buffer.isBuffer(faceImage) || !faceImage.length || faceImage.length > REKOGNITION_MAX_BYTES) throw new ConsentMatchError("bad-input", "The face image is missing or over 5 MB.", 400);
  const workspace = requireTenant();
  if (!(await (options.deps?.engine ?? engineEnabled)(REKOGNITION_SWITCH, workspace))) throw new ConsentMatchError("off", ENGINE_OFF, 403);
  await ready();
  const record = await liveFaceConsentFor(castMemberId, { projectId: options.projectId ?? null, use: options.use });
  if (!record) throw new ConsentMatchError("no-consent", NO_LIVE_CONSENT, 409);
  const reference = await (options.deps?.reference ?? consentReferenceImage)(record.id);
  if (!reference?.length) throw new ConsentMatchError("no-reference", NO_REFERENCE, 409);

  /* Reserve the call's cost before it is made (the meter's one paid path), settle it after. */
  const by = options.by ?? currentTenant()?.user?.id ?? null;
  const event = { id: `rkc_${randomUUID().replace(/-/g, "")}`, kind: "image" as const, engine: "rekognition", model: "compare-faces", createdBy: by };
  try { await reserveGenerationSpend({ ...event, status: "running", engineCostUsd: REKOGNITION_USD_PER_IMAGE }); }
  catch (error) {
    if (error instanceof SpendReservationError) throw new ConsentMatchError("unavailable", error.message, error.status);
    throw new ConsentMatchError("unavailable", NOT_DONE, 503);
  }
  let similarity: number;
  try {
    similarity = (await compareFaces(reference, faceImage, options.deps)).similarity;
  } catch (error) {
    /* No score: nothing is billed (AWS answers a refused image before analysis; for any other failure nothing is assumed charged). */
    await meter({ ...event, status: "failed", engineCostUsd: 0 }).catch(() => {});
    if (error instanceof RekognitionError && (error.kind === "no-face" || error.kind === "bad-image"))
      throw new ConsentMatchError("no-face", "No face could be found in this image, so it can't be checked. Nothing was billed.", 422);
    throw new ConsentMatchError("unavailable", NOT_DONE, 503);
  }
  await meter({ ...event, status: "succeeded", engineCostUsd: REKOGNITION_USD_PER_IMAGE });
  const score = round1(similarity);
  const matched = score >= CONSENT_MATCH_THRESHOLD;
  /* The history line: ids, the score, and the time. A failure to write it does not change the answer. */
  try {
    await db().execute(securityAuditStatement({ workspaceId: workspace.id, actorId: by, action: "consent.face_checked", targetType: "identity_consent", targetId: record.id, details: { similarity: score, matched } }));
  } catch (error) { console.error(JSON.stringify({ level: "error", event: "consent_face_check.audit_failed", message: error instanceof Error ? error.message : "unknown" })); }
  if (!matched) throw new ConsentMatchError("no-match", NO_MATCH, 409);
  return { consentId: record.id, similarity: score, matched: true, checkedAt: Date.now() };
}

/* ── The registry tool ─────────────────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * `consent.check`, declared beside its handler (docs/particl-sow-2026-10-04.md § 4.3: an app action, until A1's registry picks it up).
 * Anyone, an agent included, may run it: it reads and compares and records nothing but its score line. Recording or withdrawing consent
 * stays a person's alone (lib/security/people-only.ts); this tool only reads.
 */
export const CONSENT_CHECK_TOOL = {
  id: "consent.check",
  kind: "app" as const,
  provider: "rekognition",
  /** The settings it needs; a tool without them says so and cannot run. */
  needs: ["REKOGNITION_ACCESS_KEY_ID", "REKOGNITION_SECRET_ACCESS_KEY", "REKOGNITION_ENABLED"],
  inputs: { castMemberId: "the cast member the face is for", uploadId: "an image upload in this workspace that shows the face", projectId: "optional: one production's consent", use: "optional: production, ads, social or identity" },
  /** Free to the person: the call's own cost is on the ledger line, and what the owner charges for it, if anything, is priced inside the step it protects. */
  price: { credits: 0, note: "free to the person; the provider's cost is recorded at cost" },
  who: "anyone" as const,
};

/** The tools present for a workspace: none when the engine is off for it (the kill switch, or a customer workspace not on the list). */
export async function consentTools(workspace: { id: string } | null | undefined = currentTenant()?.workspace): Promise<(typeof CONSENT_CHECK_TOOL)[]> {
  return (await engineEnabled(REKOGNITION_SWITCH, workspace)) ? [CONSENT_CHECK_TOOL] : [];
}

export type ConsentCheckResult =
  | { ok: true; matched: true; similarity: number; consentId: string }
  | { ok: false; code: ConsentMatchCode | "absent"; message: string; similarity?: number };

/** Runs `consent.check`: the image is read from this workspace's own uploads (another workspace's id is simply not there). */
export async function runConsentCheck(input: { castMemberId?: unknown; uploadId?: unknown; projectId?: unknown; use?: unknown }, options: ConsentMatchOptions = {}): Promise<ConsentCheckResult> {
  if (!(await (options.deps?.engine ?? engineEnabled)(REKOGNITION_SWITCH))) return { ok: false, code: "absent", message: "There is no such tool here." };
  await ready();
  const uploadId = typeof input.uploadId === "string" ? input.uploadId : "";
  const row = ID.test(uploadId) ? (await db().execute({ sql: "SELECT ext, mime, stored_url FROM uploads WHERE id = ? LIMIT 1", args: [uploadId] })).rows[0] : undefined;
  if (!row || !String(row.mime ?? "").startsWith("image/")) return { ok: false, code: "bad-input", message: "Pick an image from this workspace's uploads." };
  try {
    const bytes = await readUploadBytes(uploadId, String(row.ext), String(row.stored_url), REKOGNITION_MAX_BYTES);
    const use = typeof input.use === "string" && ["production", "identity", "ads", "social"].includes(input.use) ? (input.use as ConsentUse) : undefined;
    const match = await requireConsentMatch(String(input.castMemberId ?? ""), bytes, { ...options, use, projectId: typeof input.projectId === "string" ? input.projectId : options.projectId });
    return { ok: true, matched: true, similarity: match.similarity, consentId: match.consentId };
  } catch (error) {
    if (error instanceof ConsentMatchError) return { ok: false, code: error.code, message: error.message };
    return { ok: false, code: "unavailable", message: NOT_DONE };
  }
}
