import { createHash } from "node:crypto";
import { newProject, type Asset, type CanvasNode, type Project } from "../../lib/workbench/studio";

/**
 * A feature film's project at full size: 180 scenes of about 1,400 characters
 * (well over 120 pages), five shots a scene (900), a storyboard frame and two
 * takes per shot, a Rig shot per frame, and a cut of every shot. `rig: false`
 * leaves the Rig empty, for building it from Storyboards.
 */
export function featureProject(name = "Feature", { rig = true } = {}): Project {
  const places = ["EXT. FROZEN HARBOUR - DUSK", "INT. HARBOUR MASTER'S HUT - NIGHT", "EXT. LIGHTHOUSE ROAD - DAWN", "INT. CANNERY - DAY"];
  const action = "Wind drives snow across the planks. MARA hauls a frozen line hand over hand, counting the knots under her breath, while the fox watches from the pilings and does not run. ";
  const script = Array.from({ length: 180 }, (_, i) => `${places[i % 4]} ${i + 1}\n\n${action.repeat(8)}\n\nMARA\nNot tonight. Not scene ${i + 1}.\n`).join("\n");
  const at = new Date().toISOString();
  const prompt = (n: string) => `Shot ${n}: a red fox crosses the frozen harbour at dusk; hold wide on the ice, the hut's lamp far off, snow driving left to right, Mara small at the pilings. `.repeat(4);
  const img = (id: string, label: string, category: string, extra: Partial<Asset> = {}): Asset => ({ id, name: label, kind: "image", category, url: `/api/media/${id}`, description: "", prompt: prompt(label), status: "Draft", locked: false, version: 1, refs: [], ...extra });
  const scenes = Array.from({ length: 180 }, (_, s) => ({
    id: `scene-${s + 1}`, heading: `${places[s % 4]} ${s + 1}`, summary: `Mara and the fox, scene ${s + 1}: the line comes in, the ice holds, the lamp goes out.`,
    act: (s < 45 ? 1 : s < 135 ? 2 : 3) as 1 | 2 | 3,
    beats: Array.from({ length: 3 }, (_, b) => ({ id: `beat-${s + 1}-${b + 1}`, text: `Beat ${b + 1}: Mara counts the knots; the fox does not run.` })),
    shots: Array.from({ length: 5 }, (_, k) => ({ id: `shot-${s + 1}-${k + 1}`, description: `The fox on the ice, ${s + 1}.${k + 1}`, framing: "Wide", movement: "Slow push", lighting: "Dusk", sound: "Wind" })),
    characters: ["Mara"], locations: ["Harbour"], props: ["Line"],
  }));
  const shotIds = scenes.flatMap((scene) => scene.shots.map((shot) => shot.id));
  const assets: Asset[] = [];
  const nodes: CanvasNode[] = [];
  const frames: Record<string, { prompt: string; takes: { genId: string; style: "live"; at: string }[]; selected: string }> = {};
  shotIds.forEach((id, i) => {
    const n = id.slice(5);
    assets.push(img(`frame-${n}`, `Frame ${n}`, "Storyboard", { productionShotId: id }));
    assets.push(img(`take-${n}-a`, `Take ${n} A`, "Generate", { kind: "video", ...(rig ? { nodeId: `node-${n}` } : {}) }), img(`take-${n}-b`, `Take ${n} B`, "Generate", { kind: "video", ...(rig ? { nodeId: `node-${n}` } : {}) }));
    frames[id] = { prompt: prompt(n), takes: [{ genId: `frame-${n}`, style: "live", at }], selected: `frame-${n}` };
    if (rig) nodes.push({ id: `node-${n}`, title: `${n} — The fox on the ice`, type: "scene", x: (i % 30) * 340, y: Math.floor(i / 30) * 300 - 5000, width: 300, linked: [], mode: "Video", engine: "dreamina-seedance-2-5-260628", durationS: 5, text: prompt(n), boardShotId: id, firstFrameId: `frame-${n}`, assetId: `take-${n}-a` });
  });
  return {
    ...newProject(name), script,
    assets, nodes,
    shots: shotIds.map((id) => ({ id: `cut-${id.slice(5)}`, name: id, assetId: `take-${id.slice(5)}-a`, duration: 120, sourceIn: 0, note: "" })),
    production: {
      scriptApproval: { at, source: "hand", sha256: createHash("sha256").update(script).digest("hex") },
      beats: { scriptSha256: createHash("sha256").update(script).digest("hex"), updatedAt: at, scenes },
      boards: { style: "live", model: "gemini-3.1-flash-image", frames },
    },
  };
}
