/**
 * The sample production's entry on Home (README § 1.1; lead decision 23). Stream 12 supplies the
 * sample; Home draws its card. Until stream 12 lands, the card opens the workspace's starter
 * production (POST /api/workbench/projects `starter`: seeded once, no engine called, nothing charged).
 *
 * Off until the starter production holds no handoff placeholder names (decision 24, stream 12's
 * sweep). Stream 12 turns it on in the same PR.
 */
import { isStarterDraft } from "./home-model";
import type { ProjectSummary } from "@/lib/workspace/data";

export const SAMPLE_ENTRY_ON = false;

export const SAMPLE_BADGE = "SAMPLE";
export const SAMPLE_LINE = "Explore without spending credits";

/** The sample's card: the person's own draft of it when they have opened it before (shown once, here), else a new one. */
export function sampleCard(projects: readonly ProjectSummary[]): { id: string | null; name: string } {
  const draft = projects.find((p) => isStarterDraft(p.id));
  return draft ? { id: draft.id, name: draft.name } : { id: null, name: "Sample production" };
}
