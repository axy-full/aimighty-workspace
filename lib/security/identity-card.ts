import { consentLive, consentSummary, type ConsentRecord } from "./consent-words";

/**
 * What the Cast card for a character says about its identity and its consent tick (Gaps A, Identity frames: not
 * ticked, ticked, training, ready, failed). Pure: the card and the tests read the same answer.
 *
 * A tick, not a gate (owner, 23 Oct 2026): training is offered whether or not the consent is ticked; the tick is only
 * recorded and shown. Only what is recorded is said:
 * - the consent is the cast member's newest tick (a live one first);
 * - the identity is the one the card renders with, else the one a training request citing the consent started;
 * - training shows no percentage or time left: the trainer reports none (an indeterminate bar, lead decision 20);
 * - a failed training says "Nothing billed" only when the ledger shows nothing was billed for it, the charge when it
 *   shows one, and that the charge is not confirmed when it shows neither (the provider's outcome, never a guess).
 */
export type IdentityLike = { id: string; name: string; status: "submitting" | "training" | "ready" | "failed" | "uncertain"; creditsBilled: number | null; error: string | null; createdAt: number };

/* "review": a training whose submission is uncertain. Nothing is offered to press again until it is reconciled. */
/* "sent": a training was sent from this production and its reply was not read here (the person left the production while
   it was out); the request is saved, and Recover asks about that same request, never sending it twice. */
/* "started": a training started from this card that couldn't be attached to it (its card was renamed since the press):
   kept parked, and said in words; never a Train press for it again. */
export type IdentityStage = "no-consent" | "recorded" | "training" | "ready" | "failed" | "review" | "sent" | "started" | "unread";
export type Tone = "done" | "working" | "waiting" | "idle";

export type IdentityCardView = {
  stage: IdentityStage;
  /** The state line on the card. */
  text: string;
  tone: Tone;
  /** The consent line: the tick in words, or that there is none. */
  consent: string;
  /** The live tick a training request cites; null when there is none (training is offered all the same). */
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

/**
 * The reading person's own live ticks for a cast member, newest first. Each person's "Consent given" is their own:
 * another member may tick beside a live tick that isn't theirs, and unticking withdraws only their own.
 */
export function ownLiveTicks(records: readonly ConsentRecord[], subjectKey: string, at = Date.now()): ConsentRecord[] {
  return records.filter((r) => r.subjectKey === subjectKey && r.mine && consentLive(r, at)).sort((a, b) => b.recordedAt - a.recordedAt);
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
  /** The consent ticks or the identities could not be read: the card says so, and offers no training it can't place. */
  readFailed?: boolean;
  /** A training request from this production is saved with its reply unread: the card offers Recover, never Train. */
  requestSaved?: boolean;
  /** A training started from this card is held for it, under the name it was started for (the card was renamed since). */
  startedFor?: string | null;
  at?: number;
}): IdentityCardView {
  const at = input.at ?? Date.now();
  const consent = currentConsent(input.consents, input.subjectKey, at);
  /* Any live tick is cited: what it covers and the uses are optional notes for the lawyer, never a condition. */
  const live = consent && consentLive(consent, at) ? consent : null;
  const started = consent?.identityId ? input.identities?.find((i) => i.id === consent.identityId) ?? null : null;
  const identity = input.bound ?? started;
  const consentLine = consent ? consentSummary(consent, at) : input.earlier ?? "Not ticked. Only a person ticks it.";
  const base = { consent: consentLine, consentId: live?.id ?? null, billed: null, why: null, identity };
  if (identity?.status === "ready") return { ...base, stage: "ready", text: `Identity ready · ${identity.name}`, tone: "done" };
  if (identity?.status === "submitting" || identity?.status === "training") return { ...base, stage: "training", text: "Training", tone: "working" };
  if (identity?.status === "failed" || identity?.status === "uncertain") {
    return {
      ...base, stage: identity.status === "uncertain" ? "review" : "failed", tone: "waiting",
      text: identity.status === "uncertain" ? "Training needs review" : "Training failed",
      billed: billedWords(identity.creditsBilled), why: identity.error,
    };
  }
  if (input.readFailed) return { ...base, stage: "unread", text: "Couldn't read this · reload", tone: "waiting" };
  if (input.requestSaved) return { ...base, stage: "sent", text: "Training sent · reply not read yet", tone: "waiting" };
  if (input.startedFor != null) return { ...base, stage: "started", text: `Training started for ${input.startedFor || "this cast member"}`, tone: "waiting" };
  if (live) return { ...base, stage: "recorded", text: "Consent ticked · ready to train", tone: "idle" };
  return { ...base, stage: "no-consent", text: "No identity yet", tone: "idle" };
}
