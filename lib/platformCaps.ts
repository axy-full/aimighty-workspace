/**
 * The caps that keep spend and load in check, and what every new workspace starts with: the part of the platform layer
 * (lib/platformLayer.ts, which re-exports it, so every importer reads the same value) that the platform console's Limits page draws.
 * Kept on its own so that page, a lazy chunk of the shell any member can fetch, does not bundle the platform layer, which carries the
 * verified text catalogue and the text jobs' models (a model behind Atomik's thinking is never sent to a person, Amendment (iii) §E).
 */
export type PlatformCaps = {
  /** Credits a new production starts capped at; null means no cap. */
  defaultCapCredits: number | null;
  /** Credits a new workspace opens with; null means the deployment's SIGNUP_CREDITS. */
  signupCredits: number | null;
  /** The share of a production's cap that warns the producer. */
  warnPct: number;
  /** Renders a workspace may have going at once; past it a take waits for a slot. */
  concurrency: number;
  /** Renders a workspace may start in an hour. */
  rendersPerHour: number;
  /** What a workspace may keep, in gigabytes. */
  storageGb: number;
};
export const DEFAULT_CAPS: PlatformCaps = { defaultCapCredits: null, signupCredits: null, warnPct: 80, concurrency: 4, rendersPerHour: 60, storageGb: 50 };
