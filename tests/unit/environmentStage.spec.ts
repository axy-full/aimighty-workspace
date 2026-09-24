import { test, expect } from "@playwright/test";
import { DEFAULT_ENVIRONMENT, ENVIRONMENT_CATEGORY, environmentsFromBeats, newEnvironmentEntry, plateAsset, platePrompt, plateRequest } from "../../lib/production/environment";
import { pageOfLegacy } from "../../lib/shell/ia";
import { newProject, type Asset } from "../../lib/workbench/studio";
import { projectSchema } from "../../lib/workbench/studio-schema";

/* Production › Environment (owner, 24 September): the world, place by place, before Cast. */
const sheet = { scriptSha256: "a".repeat(64), updatedAt: new Date().toISOString(), scenes: [
  { id: "s1", heading: "EXT. HARBOUR - DUSK", summary: "", beats: [], shots: [], characters: ["Mara"], locations: ["Harbour"], props: [] },
  { id: "s2", heading: "INT. HUT - NIGHT", summary: "", beats: [], shots: [], characters: [], locations: ["Hut", "harbour"], props: [] },
] };

test("the beat sheet's locations become places, each once with its scenes; places already here are skipped", () => {
  const places = environmentsFromBeats(sheet, [newEnvironmentEntry("hut")]);
  expect(places.map((p) => [p.name, p.notes])).toEqual([["Harbour", "Scenes 1, 2 · EXT. HARBOUR - DUSK · INT. HUT - NIGHT"]]);
  expect(places[0].prompt).toContain("no people");
});

test("a plate render follows the world, the film's ratio and its references — renders and uploads alike", () => {
  const project = { ...newProject("Dune"), productionProjectId: "prod-1", aspect: "16:9" as const,
    assets: [
      { id: "gen-a", generationId: "gen-a", kind: "image", url: "/api/media/gen-a" },
      { id: "up-b", uploadId: "up-b", kind: "image", url: "/api/uploads/up-b" },
      { id: "vid", generationId: "vid", kind: "video", url: "/api/media/vid" },
    ] as unknown as Asset[] };
  const entry = { ...newEnvironmentEntry("Harbour", "", "A frozen harbour at dusk"), references: ["gen-a", "up-b", "vid", "missing"] };
  const env = { ...DEFAULT_ENVIRONMENT, world: "Late winter, salt haze" };
  const input = plateRequest(project, env, entry, { ratios: ["16:9", "1:1"], resolutions: ["1K", "2K"] })!;
  expect(input).toMatchObject({ kind: "image", model: { id: env.model }, ratio: "16:9", resolution: "1K", mapping: { shotId: "", productionProjectId: "prod-1" } });
  expect(input.references).toEqual([{ genId: "gen-a", role: "reference_image" }, { uploadId: "up-b", role: "reference_image" }]);
  expect(input.prompt).toBe(platePrompt(entry, env.world));
  expect(input.prompt).toContain("The world of the film: Late winter, salt haze");
  expect(plateRequest({ ...project, productionProjectId: undefined }, env, entry, { ratios: [], resolutions: [] })).toBeNull();
  expect(plateAsset(entry, { id: "g", generationId: "g", url: "/api/media/g" }, 1)).toMatchObject({ category: ENVIRONMENT_CATEGORY, name: "Harbour", kind: "image" });
});

test("a project saves with its environment; the Cast link still opens Cast, Storyboards still opens Storyboards", () => {
  const project = { ...newProject("Dune"), production: { environment: { ...DEFAULT_ENVIRONMENT, world: "w", entries: [{ ...newEnvironmentEntry("Harbour"), plates: [{ assetId: "g", at: new Date().toISOString(), source: "upload" as const }], selected: "g" }] } } };
  expect(projectSchema.safeParse(project).success).toBe(true);
  expect(pageOfLegacy("particl", "boards")?.id).toBe("boards");
  expect(pageOfLegacy("particl", "boards", "environment")?.id).toBe("environment");
  expect(pageOfLegacy("particl", "cast")?.id).toBe("cast");
  expect(pageOfLegacy("particl", "brief")?.id).toBe("brief");
});
