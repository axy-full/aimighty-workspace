/**
 * An identity consent record, as both sides read it (Gaps A, "Identity — on the Cast card for the lead").
 *
 * Pure: no database, no React. The server validates a new record with `cleanConsent` and the screens word a stored
 * one with `consentSummary`, so the card, the dialog and the route say the same thing.
 *
 * A consent record is a person's statement that the one whose face or voice it is agreed to it: whose it is, what it
 * covers (face, voice), the uses allowed, an end date, a recording of that person agreeing, and the attest box ("I am
 * this person, or I hold their signed release"). Only a person records one (lib/security/people-only.ts).
 */

export const CONSENT_USES = ["production", "identity", "ads", "social"] as const;
export type ConsentUse = (typeof CONSENT_USES)[number];
/* "identity": training an identity of their face (review of #558, M1); every training needs it. */
export const USE_LABEL: Record<ConsentUse, string> = { production: "This production", identity: "Identity training", ads: "Ads", social: "Social posts" };
const USE_WORDS: Record<ConsentUse, string> = { production: "this production", identity: "identity training", ads: "ads", social: "social posts" };

/** The longest a record may run: ten years. */
export const MAX_CONSENT_DAYS = 3653;
export const ATTEST_LINE = "I am this person, or I hold their signed release";

export type ConsentInput = {
  projectId?: unknown;
  subjectKey?: unknown;
  subjectLabel?: unknown;
  personName?: unknown;
  face?: unknown;
  voice?: unknown;
  uses?: unknown;
  otherUse?: unknown;
  /** The last day it holds, as YYYY-MM-DD (the date field), or a time in ms. */
  until?: unknown;
  /** The recording's id (POST /api/identity-consents/recording): never an upload. */
  recordingId?: unknown;
  attested?: unknown;
};

export type CleanConsent = {
  projectId: string;
  subjectKey: string;
  subjectLabel: string;
  personName: string;
  face: boolean;
  voice: boolean;
  uses: ConsentUse[];
  otherUse: string;
  untilAt: number;
  recordingId: string;
};

/** A stored record, as the routes return it. Never carries the recording's bytes or an address. */
export type ConsentRecord = {
  id: string;
  projectId: string;
  subjectKey: string;
  subjectLabel: string;
  personName: string;
  face: boolean;
  voice: boolean;
  uses: ConsentUse[];
  otherUse: string;
  untilAt: number;
  hasRecording: boolean;
  /** The recording, served by the consent route only: the recorder, an owner or an admin, signed in. */
  recordingUrl: string | null;
  recordedAt: number;
  recordedBy: string | null;
  revokedAt: number | null;
  identityId: string | null;
};

export class ConsentError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = "ConsentError"; }
}

const ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const text = (value: unknown, max: number) => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");

/** The end of the given day in UTC, from "YYYY-MM-DD"; null when it is not a real date. */
export function endOfDay(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = Date.UTC(y, mo - 1, d, 23, 59, 59, 999);
  const back = new Date(at);
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? at : null;
}

/** "YYYY-MM-DD" for a time, in UTC (the date field's value). */
export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Validates a new record. Throws ConsentError with the words to show. */
export function cleanConsent(input: ConsentInput, at = Date.now()): CleanConsent {
  const projectId = typeof input.projectId === "string" ? input.projectId : "";
  if (!ID.test(projectId)) throw new ConsentError("Which production is this consent for?");
  const subjectKey = typeof input.subjectKey === "string" ? input.subjectKey : "";
  if (!ID.test(subjectKey)) throw new ConsentError("Which cast member is this consent for?");
  const subjectLabel = text(input.subjectLabel, 100);
  const personName = text(input.personName, 120);
  if (personName.length < 2) throw new ConsentError("Write the full name of the person whose face or voice it is, as on their release.");
  const face = input.face === true, voice = input.voice === true;
  if (!face && !voice) throw new ConsentError("Choose what it covers: their face, their voice or both.");
  const asked = Array.isArray(input.uses) ? input.uses : [];
  const uses = CONSENT_USES.filter((use) => asked.includes(use));
  const otherUse = text(input.otherUse, 200);
  if (!uses.length && !otherUse) throw new ConsentError("Choose at least one use the person allowed.");
  const untilAt = typeof input.until === "string" ? endOfDay(input.until) : typeof input.until === "number" && Number.isSafeInteger(input.until) ? input.until : null;
  if (untilAt == null) throw new ConsentError("Choose the last day this consent holds.");
  if (untilAt <= at) throw new ConsentError("The end date has to be in the future.");
  if (untilAt > at + MAX_CONSENT_DAYS * 86_400_000) throw new ConsentError("A consent record runs for ten years at most.");
  const recordingId = typeof input.recordingId === "string" ? input.recordingId : "";
  if (!ID.test(recordingId)) throw new ConsentError("Add the recording of the person saying they agree.");
  if (input.attested !== true) throw new ConsentError("Tick the statement first.");
  return { projectId, subjectKey, subjectLabel, personName, face, voice, uses, otherUse, untilAt, recordingId };
}

/** A record holds now: not withdrawn and not past its end date. */
export const consentLive = (record: Pick<ConsentRecord, "revokedAt" | "untilAt">, at = Date.now()): boolean => record.revokedAt == null && record.untilAt > at;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "30 Sep 2027", in UTC: the same on every machine. */
export const dateWords = (ms: number) => { const d = new Date(ms); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };

/** "Face and voice", "Face", "Voice". */
export const coversWords = (r: Pick<ConsentRecord, "face" | "voice">) => (r.face && r.voice ? "Face and voice" : r.face ? "Face" : "Voice");

/** "this production, ads, social posts" (and the person's own words for anything else). */
export function usesWords(r: Pick<ConsentRecord, "uses" | "otherUse">): string {
  const words = r.uses.map((use) => USE_WORDS[use]);
  if (r.otherUse) words.push(r.otherUse);
  return words.join(", ");
}

/**
 * The card's consent line, as the design writes it: "Face and voice · this production, ads, social posts · until
 * 30 Sep 2027 · recorded 6 Oct 2026 by <name>". A withdrawn or ended record says so instead.
 */
export function consentSummary(r: ConsentRecord, at = Date.now()): string {
  if (r.revokedAt != null) return `Consent withdrawn ${dateWords(r.revokedAt)}`;
  if (r.untilAt <= at) return `Consent ended ${dateWords(r.untilAt)}`;
  return [coversWords(r), usesWords(r), `until ${dateWords(r.untilAt)}`, `recorded ${dateWords(r.recordedAt)}${r.recordedBy ? ` by ${r.recordedBy}` : ""}`].join(" · ");
}

/** The key a production's consent records are filed under: the production, else the draft itself. */
export const consentProjectKey = (project: { id: string; productionProjectId?: string | null }): string => project.productionProjectId || project.id;
