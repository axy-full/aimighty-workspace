import type { GenerationBodyInput, GenerationReference } from "../workbench/generation-request";
import { mediaReferenceIdentity } from "../workbench/media-reference-input";
import type { Asset, Project } from "../workbench/studio";
import { getModel } from "../models";
import { stillShape } from "./boards";

/*
 * Looks (design/particl-graphite/README.md § 3.1 c; lead decision 28): before the storyboard, four stills of the
 * film in four looks, one of which a person picks. They are made on the path every still takes (quoted by the
 * server, sent at the price shown) and kept on the draft beside the storyboard (`production.boards.looks`, and the
 * pick in `production.boards.look`): optional keys, so drafts from before them read as they always did.
 *
 * Until Atomik proposes its own (S2), the four are film terms, not samples of anyone's work.
 */

export type LookTake = { genId: string; at: string };
export type LookPending = { jobId: string; at: string };
export type Look = { name: string; prompt: string; takes: LookTake[]; selected?: string; pending?: LookPending[] };

export const LOOK_LIMITS = { looks: 8, name: 80, prompt: 8000, takes: 20, pending: 4 } as const;
/** The still engine looks are made on: Nano Banana Pro at 1K (README § 4: "card: Nano Banana Pro … × 4"). */
export const LOOK_MODEL = "gemini-3-pro-image";

export type LookPreset = { id: string; name: string; words: string };
export const LOOK_PRESETS: readonly LookPreset[] = [
  { id: "golden-hour", name: "Golden hour", words: "Golden hour: low warm sun, long soft shadows, amber highlights, gentle contrast." },
  { id: "blue-hour", name: "Blue hour", words: "Blue hour: cool dusk light, deep blue shadows, soft practical lights." },
  { id: "bleach-bypass", name: "Bleach bypass", words: "Bleach bypass: muted colour, hard contrast, silvery highlights, deep blacks." },
  { id: "clean-daylight", name: "Clean daylight", words: "Clean daylight: neutral white balance, bright even light, natural colour." },
];

/** What a look's still shows: a frame of the film from its brief, in the look, with what the answers added. */
export function lookPrompt(project: Pick<Project, "brief" | "direction">, preset: LookPreset, extra = ""): string {
  const brief = project.brief.trim().slice(0, 1500);
  const direction = project.direction.trim().slice(0, 800);
  return [
    brief && `A still frame from this film: ${brief}`,
    direction && `Direction: ${direction}`,
    `Look: ${preset.words}`,
    extra.trim(),
    "Cinematic, photographic, no text, no captions, no borders.",
  ].filter(Boolean).join("\n\n").slice(0, LOOK_LIMITS.prompt);
}

/** The request one look sends: its prompt, the project's ratio at 1K, and a cast picture as the reference when one was chosen. */
export function lookRequest(project: Project, look: Pick<Look, "prompt">, reference?: Asset | null): GenerationBodyInput | null {
  if (!project.productionProjectId || !look.prompt.trim()) return null;
  const identity = reference ? mediaReferenceIdentity(reference) : null;
  const references: GenerationReference[] = identity ? [{ ...identity, role: "reference_image" }] : [];
  return {
    prompt: look.prompt, kind: "image", model: { id: LOOK_MODEL },
    mapping: { shotId: "", productionProjectId: project.productionProjectId }, ...stillShape(getModel(LOOK_MODEL), project.aspect), duration: 5,
    references, firstFrameAssetId: "",
  };
}
