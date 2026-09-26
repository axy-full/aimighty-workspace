import type { BeatSheet, BeatShot } from "./beats";
import { moleculrAssetBindingProblem } from "../workbench/moleculr-bindings";
import type { Project } from "../workbench/studio";

/**
 * Production › Storyboards (owner's brief, 23 September): every beat-sheet shot
 * is a frame with its own prompt; frames render in one of three looks; a rough
 * drawing uploaded for a shot is read by the agent and the frame keeps its
 * blocking. Frames are saved on the project and filed as Storyboard assets.
 */
export type BoardStyle = "live" | "color-sketch" | "bw-sketch";
export const BOARD_STYLES: { id: BoardStyle; label: string; line: string; suffix: string }[] = [
  { id: "live", label: "Live action", line: "Photographic frames, as the camera will see it.", suffix: "Cinematic live-action storyboard frame: photographic, realistic light and lenses, a still from the finished film. No text, no captions, no borders." },
  { id: "color-sketch", label: "Coloured sketch", line: "Pencil and marker with flat colour washes.", suffix: "Storyboard frame drawn as a coloured sketch: confident pencil and marker linework with flat colour washes, clear silhouettes and staging. No text, no captions, no panel borders." },
  { id: "bw-sketch", label: "Black & white sketch", line: "Graphite line and grey tone, no colour.", suffix: "Storyboard frame drawn as a black-and-white pencil sketch: clean graphite linework with grey tonal shading, no colour at all. No text, no captions, no panel borders." },
];
export const BOARD_MODELS = [
  { id: "gemini-3.1-flash-image", label: "Nano Banana 2" },
  { id: "gemini-3-pro-image", label: "Nano Banana Pro" },
  { id: "gpt-image-2", label: "GPT Image 2" },
  { id: "gpt-image-2.5-flare", label: "GPT Image 2.5" },
  { id: "grok-imagine-image-2.0", label: "Grok Imagine 2" },
] as const;
export type BoardModel = (typeof BOARD_MODELS)[number]["id"];

/**
 * The ratio and size a still engine is asked for: the project's aspect, or
 * the engine's nearest one (GPT Image 1.5 makes 3:2, not 16:9), and 1K where
 * the engine has it (GPT Image's first quality, Medium, otherwise).
 */
export function stillShape(model: { ratios: string[]; resolutions: string[] }, aspect: string): { ratio: string; resolution: string } {
  const value = (r: string) => { const [w, h] = r.split(":").map(Number); return Math.log(w / h); };
  const ratio = model.ratios.includes(aspect) ? aspect : [...model.ratios].sort((a, b) => Math.abs(value(a) - value(aspect)) - Math.abs(value(b) - value(aspect)))[0] ?? aspect;
  return { ratio, resolution: model.resolutions.includes("1K") ? "1K" : model.resolutions[0] ?? "1K" };
}

export type FrameTake = { genId: string; style: BoardStyle; at: string };
export type FramePending = { jobId: string; style: BoardStyle; at: string };
export type BoardFrame = {
  prompt: string;
  /** An uploaded rough drawing (a project asset) and what the agent read in it. */
  sketch?: { assetId: string; name: string };
  reading?: string;
  /** The agent run the reading came from, so it is taken once. */
  readingJobId?: string;
  /** This frame's own look (a line drawing converted as live action, say); the board's look otherwise. */
  style?: BoardStyle;
  /** The single-frame agent prompt run this frame took its prompt from. */
  promptJobId?: string;
  takes: FrameTake[];
  selected?: string;
  pending?: FramePending[];
};
/** `promptsJobId`: the agent's prompt run the frames last took their prompts from. */
export type Boards = { style: BoardStyle; model: BoardModel; frames: Record<string, BoardFrame>; promptsJobId?: string };

export const FRAME_PROMPT_LIMIT = 8000;
export const DEFAULT_BOARDS: Boards = { style: "live", model: "gemini-3.1-flash-image", frames: {} };
export const emptyFrame = (): BoardFrame => ({ prompt: "", takes: [] });

export type NumberedShot = { id: string; number: string; scene: string; sceneSummary: string; shot: BeatShot; characters: string[]; locations: string[] };
/** Every shot of the beat sheet in order, numbered scene.shot. */
export function boardShots(sheet: BeatSheet | null | undefined): NumberedShot[] {
  return (sheet?.scenes ?? []).flatMap((scene, si) => scene.shots.map((shot, ti) => ({
    id: shot.id, number: `${si + 1}.${ti + 1}`, scene: scene.heading, sceneSummary: scene.summary, shot, characters: scene.characters, locations: scene.locations,
  })));
}

/** A starting prompt from the shot itself, before the agent writes one. */
export function shotPrompt(s: NumberedShot): string {
  return [s.shot.description, s.shot.framing && `Framing: ${s.shot.framing}.`, s.shot.movement && `Camera: ${s.shot.movement}.`, s.shot.lighting && `Light: ${s.shot.lighting}.`, s.scene && `Scene: ${s.scene}.`]
    .filter(Boolean).join(" ").slice(0, FRAME_PROMPT_LIMIT);
}

/** What the image model receives: the frame's prompt, the look, and — with a sketch — the order to keep its blocking. */
export function renderPrompt(prompt: string, style: BoardStyle, sketch: boolean): string {
  const look = BOARD_STYLES.find((s) => s.id === style)!.suffix;
  const keep = sketch ? " The reference image is the director's rough storyboard drawing: keep its composition, camera angle and the position, pose and direction of every figure exactly; redraw it as a finished frame." : "";
  return `${prompt.trim()}\n\n${look}${keep}`.slice(0, 10_000);
}

/**
 * Deletes a line drawing (owner, 23 September): the drawing leaves the
 * project — its asset, any bin that lists it, and the beat it was on (with the
 * agent's reading of it). A drawing the Rig uses as an input is refused, so no
 * shot loses its reference. The upload itself stays in the workspace library.
 */
export function deleteDrawing<P extends { assets: { id: string }[]; nodes: { assetId?: string; title: string }[]; bins?: { assetIds: string[] }[]; production?: { boards?: Boards } }>(project: P, assetId: string): P {
  if (!project.assets.some((a) => a.id === assetId)) throw new Error("That drawing is no longer in the project.");
  const user = project.nodes.find((n) => n.assetId === assetId);
  if (user) throw new Error(`This drawing is an input of “${user.title}” in the Rig. Remove it there first.`);
  /* A campaign's product profile, logo or poster that holds it keeps it too: the draft could not be saved without it. */
  const bound = moleculrAssetBindingProblem(project as unknown as Project, assetId);
  if (bound) throw new Error(bound);
  const boards = project.production?.boards;
  const frames = boards ? Object.fromEntries(Object.entries(boards.frames).map(([id, f]) => [id, f.sketch?.assetId === assetId ? { ...f, sketch: undefined, reading: undefined, readingJobId: undefined } : f])) : undefined;
  return {
    ...project,
    assets: project.assets.filter((a) => a.id !== assetId),
    ...(project.bins ? { bins: project.bins.map((b) => ({ ...b, assetIds: b.assetIds.filter((id) => id !== assetId) })) } : {}),
    ...(boards && frames ? { production: { ...project.production, boards: { ...boards, frames } } } : {}),
  };
}
