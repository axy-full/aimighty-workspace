/*
 * The sample production: an owner's own FINISHED production, marked in its own workspace as the explore-only sample
 * (lead decisions 12, 38 and 41). Nothing is made up. The mark is a `settings` row, `sampleProduction`, written only
 * by the build action (lib/demo/mark.server.ts); this file is the pure half: the row's shape, the words every paid
 * control carries, and the browser-side check. No server imports, so a browser can read it.
 */

/** The workspace `settings` key. It is not in lib/settings.ts DEFAULTS, so PATCH /api/settings can never write it. */
export const SAMPLE_SETTING_KEY = "sampleProduction";
/** The id prefix of the copy each person opens (lib/demo/open.server.ts). It survives the draft schema's key stripping. */
export const SAMPLE_DRAFT_PREFIX = "sample-";

/** What every paid control on the sample says, as the title of its disabled state and in the board's pill. */
export const SAMPLE_LINE = "Sample production · nothing here spends credits";
export const SAMPLE_BADGE = "SAMPLE";
export const SAMPLE_CARD_LINE = "Explore without spending credits";
export const SAMPLE_OPEN_TOAST = "Sample production · nothing you do here spends credits";

/** The mark. `projectId` is the production's own `projects.id` (a draft's `productionProjectId`). */
export type SampleMark = {
  version: 1;
  projectId: string;
  /** The production's name when it was marked: Home's card shows it. */
  name: string;
  /** The person's draft the sample is opened from (their finished production), and who it belongs to. */
  draftOwner: string;
  draftId: string;
  markedBy: string;
  markedAt: number;
  /** Set when the mark was undone. The row is kept, never deleted; a hidden mark reads as no sample. */
  hiddenAt?: number | null;
  hiddenBy?: string | null;
};

const text = (value: unknown, max = 300): string => (typeof value === "string" ? value.slice(0, max) : "");

/** A stored `sampleProduction` value, or null when it is absent, hidden (undone) or not a mark this code wrote. */
export function parseSampleMark(raw: unknown): SampleMark | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw); } catch { return null; }
  }
  if (!value || typeof value !== "object") return null;
  const m = value as Record<string, unknown>;
  const projectId = text(m.projectId, 100), draftOwner = text(m.draftOwner, 100), draftId = text(m.draftId, 100);
  if (m.version !== 1 || !projectId || !draftOwner || !draftId) return null;
  if (typeof m.hiddenAt === "number" && m.hiddenAt > 0) return null;
  return {
    version: 1, projectId, name: text(m.name, 160), draftOwner, draftId,
    markedBy: text(m.markedBy, 100), markedAt: typeof m.markedAt === "number" ? m.markedAt : 0,
  };
}

export function isSampleDraftId(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith(SAMPLE_DRAFT_PREFIX);
}

/** The slice of a Rig draft the check reads. */
export type SampleSubject = { id?: string | null; productionProjectId?: string | null };

/**
 * The browser-side check: is this the sample production? It is the copy a person opened (its id), or any draft of the
 * production the workspace marked (its owner's own draft included). A hint for the screens only: the server's refusal
 * (S12.4) is the wall.
 */
export function isSampleProject(project: SampleSubject | null | undefined, mark: Pick<SampleMark, "projectId"> | null | undefined): boolean {
  if (!project) return false;
  if (isSampleDraftId(project.id)) return true;
  return Boolean(mark && project.productionProjectId && project.productionProjectId === mark.projectId);
}

/**
 * What a board's context carries (stream 3's BoardCtx; streams 4 and 5 read these two words). `exploreOnly` is the line
 * a paid control shows when it is disabled; `readOnly` is for a production nothing may be written to, which the sample
 * is not: approve, reject, notes and picks stay free (decision 38).
 */
export type SampleGate = { exploreOnly: string | null; readOnly: string | null };

export function sampleGate(project: SampleSubject | null | undefined, mark: Pick<SampleMark, "projectId"> | null | undefined): SampleGate {
  return { exploreOnly: isSampleProject(project, mark) ? SAMPLE_LINE : null, readOnly: null };
}

/** A paid control's props on the sample: disabled, with the line as its title and nothing else changed (label and price stay). */
export function paidControlOnSample(gate: SampleGate): { disabled: boolean; title?: string } {
  return gate.exploreOnly ? { disabled: true, title: gate.exploreOnly } : { disabled: false };
}
