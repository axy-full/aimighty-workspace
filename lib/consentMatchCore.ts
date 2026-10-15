import { createHash, randomUUID } from "node:crypto";
import { db, ready } from "./db";
import { currentTenant, requireTenant } from "./tenant";
import { engineEnabled } from "./engineGate";
import { isHouseWorkspace } from "./houseWorkspace";
import { REKOGNITION_CALL_USD, REKOGNITION_MAX_BYTES, REKOGNITION_SWITCH, RekognitionError, compareFacesWith, type FaceComparison, type RekognitionSeams } from "./rekognition";
import { consentReferenceImage } from "./consentReference";
import { liveFaceConsentFor } from "./security/consent";
import { CONSENT_USES, type ConsentUse } from "./security/consent-words";
import { securityAuditStatement } from "./securityAudit";
import { reserveGenerationSpend, SpendReservationError } from "./generationRequests";
import { meter } from "./meter";

/**
 * The consent face gate's core (lib/consentMatch.ts is the public face of it; nothing but that file and the tests imports this one).
 *
 * The owner's rule, 15 Oct 2026: "Consent: every real face passes Rekognition against its consent record before Act-Two, cloning or lip-sync runs."
 *
 * It FAILS CLOSED at every step:
 *   1. the engine is off for this workspace, or this is not the house workspace          -> refused, nothing called
 *      (the check runs for the house only, even where a customer workspace is listed, until the owner says who pays for checks there)
 *   2. no production or no use named                                                     -> refused (a consent is judged for one production and one use)
 *   3. no live consent covering the cast member's face, for that production and use       -> refused
 *   4. the consent has no face reference (lib/consentReference.ts, null today)            -> refused, nothing called
 *   5. the provider cannot answer (error, no face in an image, not set up)                -> refused, nothing billed (or billed, when AWS analysed)
 *   6. more than one face in the image                                                    -> refused ("Crop to the one face")
 *   7. the similarity is under CONSENT_MATCH_THRESHOLD                                    -> refused, for a person to look at
 *
 * Money: the call's real cost (REKOGNITION_CALL_USD) is reserved on the meter before the call (so the house's cap and limits apply) and settled at that
 * cost when AWS analysed the images (a score, several faces, or a 200 with no face), at nothing ("Nothing billed") when it answered before analysis or not at
 * all. The meter row's kind is the existing "image" (a face comparison analyses two images; no new kind).
 *
 * Privacy: the two images exist in memory for the call and nowhere else. What is kept is one security-history line: the consent's id, the similarity
 * score, whether it passed, and the time (lib/securityAudit.ts `consent.face_checked`). No image, crop or face vector. The caller gets back the SHA-256 of
 * the image that passed, so it can assert it renders the same bytes.
 */
/** Same face at or above this similarity (0 to 100), compared on the score AWS gave, unrounded. A proposal (docs/plans/provider-adapters.md § 3, owner question E): AWS's default is 80. */
export const CONSENT_MATCH_THRESHOLD = 90;
export const NO_REFERENCE = "This person's consent has no face reference yet.";
export const ENGINE_OFF = "The face check isn't on for this workspace, so a real face can't be used here yet.";
export const NO_LIVE_CONSENT = "No live consent covers this person's face for this production and use. Record it on the Cast card first.";
export const NO_MATCH = "This face doesn't look like the person who gave consent. A person needs to look at it.";
export const SEVERAL_FACES = "More than one face is in this image. Crop to the one face.";
export const NOT_DONE = "The face check could not be done. Nothing was billed.";

export type ConsentMatchCode = "off" | "no-consent" | "no-reference" | "no-face" | "several-faces" | "no-match" | "unavailable" | "bad-input";
export class ConsentMatchError extends Error {
  constructor(readonly code: ConsentMatchCode, message: string, readonly status: number) { super(message); this.name = "ConsentMatchError"; }
}
export type ConsentMatch = { consentId: string; similarity: number; matched: true; checkedAt: number; faceSha256: string };

/** What a consent is judged for: one production and one use, both required. */
export type ConsentScope = { projectId: string; use: ConsentUse };

/** The seams a test needs; the public gate passes none. */
export type ConsentSeams = {
  engine?: typeof engineEnabled;
  reference?: typeof consentReferenceImage;
  rekognition?: RekognitionSeams;
};

const ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const round1 = (n: number) => Math.round(n * 10) / 10;

/** The scope, checked: both fields present and well formed, or a refusal. */
export function checkedScope(scope: { projectId?: unknown; use?: unknown } | null | undefined): ConsentScope {
  const projectId = scope?.projectId, use = scope?.use;
  if (typeof projectId !== "string" || !ID.test(projectId)) throw new ConsentMatchError("bad-input", "Say which production this face is for.", 400);
  if (typeof use !== "string" || !(CONSENT_USES as readonly string[]).includes(use)) throw new ConsentMatchError("bad-input", "Say what the face is used for: production, identity, ads or social.", 400);
  return { projectId, use: use as ConsentUse };
}

/** Is the check on here? The engine's switch and list (lib/engineGate.ts), and the house workspace only. */
export async function faceCheckOnHere(seams: ConsentSeams = {}, workspace: { id: string } | null | undefined = currentTenant()?.workspace): Promise<boolean> {
  if (!workspace) return false;
  if (!isHouseWorkspace(workspace)) return false;
  return (seams.engine ?? engineEnabled)(REKOGNITION_SWITCH, workspace);
}

export async function matchConsentFace(castMemberId: string, faceImage: Buffer, scopeIn: { projectId?: unknown; use?: unknown }, seams: ConsentSeams = {}): Promise<ConsentMatch> {
  if (typeof castMemberId !== "string" || !ID.test(castMemberId)) throw new ConsentMatchError("bad-input", "Say which cast member this face is for.", 400);
  const scope = checkedScope(scopeIn);
  if (!Buffer.isBuffer(faceImage) || !faceImage.length || faceImage.length > REKOGNITION_MAX_BYTES) throw new ConsentMatchError("bad-input", "The face image is missing or over 5 MB.", 400);
  const workspace = requireTenant();
  if (!(await faceCheckOnHere(seams, workspace))) throw new ConsentMatchError("off", ENGINE_OFF, 403);
  await ready();
  const record = await liveFaceConsentFor(castMemberId, { projectId: scope.projectId, use: scope.use });
  if (!record) throw new ConsentMatchError("no-consent", NO_LIVE_CONSENT, 409);
  const reference = await (seams.reference ?? consentReferenceImage)(record.id);
  if (!reference?.length) throw new ConsentMatchError("no-reference", NO_REFERENCE, 409);

  /* Reserve the call's cost before it is made (the meter's one paid path), settle it after. The actor is the session's, never the caller's say-so. */
  const by = currentTenant()?.user?.id ?? null;
  const event = { id: `rkc_${randomUUID().replace(/-/g, "")}`, kind: "image" as const, engine: "rekognition", model: "compare-faces", createdBy: by };
  try { await reserveGenerationSpend({ ...event, status: "running", engineCostUsd: REKOGNITION_CALL_USD }); }
  catch (error) {
    if (error instanceof SpendReservationError) throw new ConsentMatchError("unavailable", error.message, error.status);
    throw new ConsentMatchError("unavailable", NOT_DONE, 503);
  }
  let result: FaceComparison;
  try {
    result = await compareFacesWith(reference, faceImage, seams.rekognition ?? {});
  } catch (error) {
    /* No score. A call AWS analysed (a 200 with no face) is charged; one it answered before analysis, or not at all, is not ("Nothing billed"). */
    const billed = error instanceof RekognitionError && error.billed;
    await meter({ ...event, status: billed ? "succeeded" : "failed", engineCostUsd: billed ? REKOGNITION_CALL_USD : 0 }).catch(() => {});
    if (error instanceof RekognitionError && (error.kind === "no-face" || error.kind === "bad-image"))
      throw new ConsentMatchError("no-face", `No face could be found in this image, so it can't be checked.${billed ? "" : " Nothing was billed."}`, 422);
    throw new ConsentMatchError("unavailable", NOT_DONE, 503);
  }
  await meter({ ...event, status: "succeeded", engineCostUsd: REKOGNITION_CALL_USD });
  /* Fail closed unless there is exactly one face: with several, the score cannot be said to be the person's. */
  if (result.facesFound !== 1) throw new ConsentMatchError("several-faces", SEVERAL_FACES, 422);
  /* The raw score decides; it is rounded only for the history line. */
  const matched = result.similarity >= CONSENT_MATCH_THRESHOLD;
  try {
    await db().execute(securityAuditStatement({ workspaceId: workspace.id, actorId: by, action: "consent.face_checked", targetType: "identity_consent", targetId: record.id, details: { similarity: round1(result.similarity), matched } }));
  } catch (error) { console.error(JSON.stringify({ level: "error", event: "consent_face_check.audit_failed", message: error instanceof Error ? error.message : "unknown" })); }
  if (!matched) throw new ConsentMatchError("no-match", NO_MATCH, 409);
  return { consentId: record.id, similarity: round1(result.similarity), matched: true, checkedAt: Date.now(), faceSha256: createHash("sha256").update(faceImage).digest("hex") };
}
