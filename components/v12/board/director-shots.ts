import type { Project } from "@/lib/workbench/studio";
import type { RigShot } from "@/lib/workspace/shots";
import { rigShotInput } from "@/lib/workspace/rig-requests";
import { getModel } from "@/lib/models";
import { requestFields, shotSettings } from "./director-model";
import type { DirectorShot } from "./use-director-render";

/**
 * The requests a Director press would send (v25 PR 7 wiring): for each shot in the bar's scope, the request the Rig's Generate builds for it
 * (lib/workspace/rig-requests.ts `rigShotInput`: its prompt, engine, references and production mapping), with the Director settings laid over it: Quality
 * (Draft is the 480p take, Final the 1080p), Length, Ratio and Sound. A setting the shot's engine does not offer (a 480p draft on an engine with none) is left as
 * the shot has it, so a press never asks an engine for what it refuses. A shot that cannot be priced without a side effect (no production mapping yet, a
 * reference not saved, no engine) is left out; the bar says how many were. Pure.
 */
export function directorShots(project: Project, shots: readonly RigShot[], scopeIds: readonly string[]): { shots: DirectorShot[]; left: number } {
  const out: DirectorShot[] = [];
  let left = 0;
  for (const id of scopeIds) {
    const shot = shots.find((s) => s.id === id);
    const input = shot ? rigShotInput(project, shot) : null;
    if (!shot || !input) { left++; continue; }
    const want = requestFields(shotSettings(project, id));
    let def: ReturnType<typeof getModel> | null = null;
    try { def = getModel(input.model.id); } catch { def = null; }
    const offers = (list: readonly (string | number)[] | undefined, value: string | number) => !list || list.includes(value);
    const draft = want.draft && offers(def?.resolutions, want.resolution);
    out.push({
      id,
      input: {
        ...input,
        resolution: want.draft ? (draft ? want.resolution : input.resolution) : offers(def?.resolutions, want.resolution) ? want.resolution : input.resolution,
        duration: offers(def?.durations, want.duration) ? want.duration : input.duration,
        ratio: offers(def?.ratios, want.ratio) ? want.ratio : input.ratio,
        generateAudio: want.generateAudio,
        ...(draft ? { draft: true } : {}),
      },
    });
  }
  return { shots: out, left };
}
