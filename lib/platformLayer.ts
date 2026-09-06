import type { ShotSpec } from "./studio";

/**
 * The platform layer: what every new workspace inherits and may change.
 *
 * A default Setup that reads as a finished frame rather than "0 of 12 rows
 * set", and a starter production — three shots pre-named, one cast member
 * — so the first screen a stranger sees already has something to render
 * against. Generic and rights-clear by construction: no client, no real
 * person, no studio. A workspace edits or deletes all of it.
 */
export const DEFAULT_SETUP: ShotSpec = {
  shot: "ws", angle: "eye", move: "static", lens: "35", light: "natural",
  time: "afternoon", look: "35mm", mood: "calm", pace: "realtime", sound: "ambient",
};

export type StarterShot = { code: string; title: string; description: string; planned: number; setup: ShotSpec; cast: string[] };
export type StarterCast = { name: string; kind: "character" | "location" | "prop" | "style"; description: string };
export type StarterProduction = { name: string; code: string; description: string; shots: StarterShot[]; cast: StarterCast[] };

export const STARTER_CAST: StarterCast = {
  name: "Mara",
  kind: "character",
  description: "A courier in her thirties. Cropped dark hair, a weathered orange jacket, a canvas bag across the chest. Always mid-errand, never posed.",
};

export const STARTER_PRODUCTION: StarterProduction = {
  name: "Starter production",
  code: "START",
  description: "Three shots to render against, so the first take is a minute away. Rename it, change anything, or delete it.",
  shots: [
    {
      code: "SH010", title: "The city, first light", planned: 5,
      description: "An establishing shot: a quiet street at dawn, wet from the night, the first light along the rooftops.",
      setup: { ...DEFAULT_SETUP, shot: "evs", time: "dawn" }, cast: [],
    },
    {
      code: "SH020", title: "The courier", planned: 5,
      description: "@Mara crosses the street with the bag held close, the camera pushing in as she passes.",
      setup: { ...DEFAULT_SETUP, shot: "ms", move: "push" }, cast: [STARTER_CAST.name],
    },
    {
      code: "SH030", title: "The hand-off", planned: 5,
      description: "A close-up: the package changes hands on a doorstep, soft light, nothing said.",
      setup: { ...DEFAULT_SETUP, shot: "cu", light: "soft" }, cast: [STARTER_CAST.name],
    },
  ],
  cast: [STARTER_CAST],
};
