import { consentLive, consentSummary, type ConsentRecord } from "./consent-words";

/**
 * What the Cast card for a character says about its identity and its consent (Gaps A, Identity frames: consent not
 * recorded, consent on file, training, ready, failed). Pure: the card and the tests read the same answer.
 *
 * Only what is recorded is said:
 * - the consent is the cast member's newest record (a live one first);
 * - the identity is the one the card renders with, else the one a training request citing the consent started;
 * - training shows no percentage or time left: the trainer reports none (an indeterminate bar, lead decision 20);
 * - a failed training says "Nothing billed" only when the ledger shows nothing was billed for it, the charge when it
 *   shows one, and that the charge is not confirmed when it shows neither (the provider's outcome, never a guess).
 */
export type IdentityLike = { id: string; name: string; status: "submitting" | "training" | "ready" | "failed" | "uncertain"; creditsBilled: number | null; error: string | null; createdAt: number };

export type IdentityStage = "no-consent" | "recorded" | "training" | "ready" | "failed";
export type Tone = "done" | "working" | "waiting" | "idle";

export type IdentityCardView = {
  stage: IdentityStage;
  /** The state line on the card. */
  text: string;
  tone: Tone;
  /** The consent line: the record in words, or why there is none. */
  consent: string;
  /** The live record a training request cites; null when there is none. */
  consentId: string | null;
  /** What a failed training was billed, in words; null when not failed. */
  billed: string | null;
  /** Why it failed, as the trainer said; null when it did not say. */
  why: string | null;
  identity: IdentityLike | null;
};

/** The record that speaks for a cast member: the newest live one, else the newest of any. */
export function currentConsent(records: readonly ConsentRecord[], subjectKey: string, at = Date.now()): ConsentRecord | null {
  const mine = records.filter((r) => r.subjectKey === subjectKey).sort((a, b) => b.recordedAt - a.recordedAt);
  return mine.find((r) => consentLive(r, at)) ?? mine[0] ?? null;
}

/** "Nothing billed", "Billed 54 cr" or "Charge not confirmed yet", from the ledger's figure for this training. */
export function billedWords(creditsBilled: number | null): string {
  if (creditsBilled === 0) return "Nothing billed";
  if (typeof creditsBilled === "number" && creditsBilled > 0) return `Billed ${creditsBilled.toLocaleString("en-US")} cr`;
  return "Charge not confirmed yet";
}

export function identityCardView(input: {
  consents: readonly ConsentRecord[];
  subjectKey: string;
  /** The identity the card renders with (its identityId), when the workspace lists it. */
  bound: IdentityLike | null;
  identities: readonly IdentityLike[] | null;
  /** The consent an identity trained before records existed carries ("Training consent confirmed … by …"), if any. */
  earlier?: string | null;
  at?: number;
}): IdentityCardView {
  const at = input.at ?? Date.now();
  const consent = currentConsent(input.consents, input.subjectKey, at);
  const live = consent && consentLive(consent, at) ? consent : null;
  const started = consent?.identityId ? input.identities?.find((i) => i.id === consent.identityId) ?? null : null;
  const identity = input.bound ?? started;
  const consentLine = consent ? consentSummary(consent, at) : input.earlier ?? "Not recorded yet. Only a person records it.";
  const base = { consent: consentLine, consentId: live?.id ?? null, billed: null, why: null, identity };
  if (identity?.status === "ready") return { ...base, stage: "ready", text: `Identity ready · ${identity.name}`, tone: "done" };
  if (identity?.status === "submitting" || identity?.status === "training") return { ...base, stage: "training", text: "Training", tone: "working" };
  if (identity?.status === "failed" || identity?.status === "uncertain") {
    return {
      ...base, stage: "failed", tone: "waiting",
      text: identity.status === "uncertain" ? "Training needs review" : "Training failed",
      billed: billedWords(identity.creditsBilled), why: identity.error,
    };
  }
  if (live) return { ...base, stage: "recorded", text: "Consent recorded · ready to train", tone: "idle" };
  return { ...base, stage: "no-consent", text: "Consent not recorded", tone: "waiting" };
}
