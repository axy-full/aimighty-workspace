import { db, ready } from "./db";
import { currentTenant } from "./tenant";
import { REKOGNITION_MAX_BYTES } from "./rekognition";
import { readUploadBytes } from "./storage";
import {
  ConsentMatchError, NOT_DONE, checkedScope, faceCheckOnHere, matchConsentFace,
  type ConsentMatch, type ConsentMatchCode, type ConsentScope, type ConsentSeams,
} from "./consentMatchCore";

/**
 * The consent face gate, as other tools see it (the owner's rule, 15 Oct 2026: "Consent: every real face passes Rekognition against its consent record
 * before Act-Two, cloning or lip-sync runs."). The logic and its refusals are in lib/consentMatchCore.ts; this file is the public door and the tool.
 *
 * `requireConsentMatch(castMemberId, faceImage, { projectId, use })` is the one hard gate. Lip-sync, Act-Two and cloning call it before they spend
 * anything, with the face they are about to use. It returns only when that face is the person whose live consent covers it, for that production and use,
 * and otherwise throws a ConsentMatchError saying why. It takes no switch, no reference source, no environment and no actor from its caller: it always uses
 * the real engine gate, consentReferenceImage (null until the owner chooses a source: every check is refused), the real environment, and the signed-in session.
 */
export { ConsentMatchError, CONSENT_MATCH_THRESHOLD, ENGINE_OFF, NO_LIVE_CONSENT, NO_MATCH, NO_REFERENCE, NOT_DONE, SEVERAL_FACES } from "./consentMatchCore";
export type { ConsentMatch, ConsentMatchCode, ConsentScope } from "./consentMatchCore";

export const requireConsentMatch = (castMemberId: string, faceImage: Buffer, scope: ConsentScope): Promise<ConsentMatch> => matchConsentFace(castMemberId, faceImage, scope);

/* ── The registry tool ─────────────────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * `consent.check`, declared beside its handler (docs/particl-sow-2026-10-04.md § 4.3: an app action, until A1's registry picks it up).
 * Anyone, an agent included, may run it: it reads and compares and records nothing but its score line. Recording or withdrawing consent
 * stays a person's alone (lib/security/people-only.ts); this tool only reads. It is on for the house workspace only.
 */
export const CONSENT_CHECK_TOOL = {
  id: "consent.check",
  kind: "app" as const,
  provider: "rekognition",
  /** The settings it needs; a tool without them says so and cannot run. */
  needs: ["REKOGNITION_ACCESS_KEY_ID", "REKOGNITION_SECRET_ACCESS_KEY", "REKOGNITION_ENABLED"],
  inputs: { castMemberId: "the cast member the face is for", uploadId: "an image upload in this workspace that shows the face", projectId: "the production the consent is for (required)", use: "production, identity, ads or social (required)" },
  /** Free to the person: the call's own cost is on the ledger line. */
  price: { credits: 0, note: "free to the person; the provider's cost is recorded at cost" },
  who: "anyone" as const,
};

/** The tools present for a workspace: none when the check is off for it (the kill switch, or not the house workspace). */
export async function consentTools(workspace: { id: string } | null | undefined = currentTenant()?.workspace): Promise<(typeof CONSENT_CHECK_TOOL)[]> {
  return (await faceCheckOnHere({}, workspace)) ? [CONSENT_CHECK_TOOL] : [];
}

export type ConsentCheckResult =
  | { ok: true; matched: true; similarity: number; consentId: string; faceSha256: string }
  | { ok: false; code: ConsentMatchCode | "absent"; message: string };

type ConsentCheckInput = { castMemberId?: unknown; uploadId?: unknown; projectId?: unknown; use?: unknown };

/** Runs `consent.check`. Public: it takes the input and nothing else. */
export const runConsentCheck = (input: ConsentCheckInput): Promise<ConsentCheckResult> => runConsentCheckWith(input, {});

/** The same with the test seams. Internal: only the tests import it (tests/unit/rekognitionConsent.spec.ts says so by reading the source). */
export async function runConsentCheckWith(input: ConsentCheckInput, seams: ConsentSeams): Promise<ConsentCheckResult> {
  if (!(await faceCheckOnHere(seams))) return { ok: false, code: "absent", message: "There is no such tool here." };
  await ready();
  let scope: ConsentScope;
  try { scope = checkedScope(input); } catch (error) { return error instanceof ConsentMatchError ? { ok: false, code: error.code, message: error.message } : { ok: false, code: "bad-input", message: "Name the production and the use." }; }
  const uploadId = typeof input.uploadId === "string" ? input.uploadId : "";
  const row = /^[A-Za-z0-9_.:-]{1,160}$/.test(uploadId) ? (await db().execute({ sql: "SELECT ext, mime, stored_url FROM uploads WHERE id = ? LIMIT 1", args: [uploadId] })).rows[0] : undefined;
  if (!row || !String(row.mime ?? "").startsWith("image/")) return { ok: false, code: "bad-input", message: "Pick an image from this workspace's uploads." };
  try {
    const bytes = await readUploadBytes(uploadId, String(row.ext), String(row.stored_url), REKOGNITION_MAX_BYTES);
    const match = await matchConsentFace(String(input.castMemberId ?? ""), bytes, scope, seams);
    return { ok: true, matched: true, similarity: match.similarity, consentId: match.consentId, faceSha256: match.faceSha256 };
  } catch (error) {
    if (error instanceof ConsentMatchError) return { ok: false, code: error.code, message: error.message };
    return { ok: false, code: "unavailable", message: NOT_DONE };
  }
}
