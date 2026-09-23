import type { BeatSheet, BeatShot } from "./beats";

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
] as const;
export type BoardModel = (typeof BOARD_MODELS)[number]["id"];

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
