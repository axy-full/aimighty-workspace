import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { applyAcceptedGeneration } from "../../lib/workbench/accepted-generation";
import { moleculrNode } from "../../lib/workbench/moleculr";
import { newProject, type Project } from "../../lib/workbench/studio";

/**
 * The one rule every host applies when GenerationDialog reports an accepted
 * request. It used to live inside Studio's dialog mount; the Marketing Studio
 * flow mounts the same dialog, so the rule is shared rather than copied.
 */

function project(options: { locked?: boolean; variant?: boolean } = {}): Project {
  const node = { ...moleculrNode("variant-1", "the original prompt", "Bottle", 0, "image"), locked: options.locked ?? false };
  return {
    ...newProject("Coastal light study"),
    nodes: [node],
    ...(options.variant === false
      ? {}
      : {
          moleculr: {
            productName: "Still Water",
            productUrl: "",
            productAssetIds: [],
            castAssetIds: [],
            format: "cinematic-demo",
            hooks: [],
            notes: "",
            variants: [{ id: "campaign-1", nodeId: "variant-1", hook: "Quiet mornings", kind: "image" as const, createdAt: "2026-09-19T10:00:00Z" }],
          },
        }),
  } as Project;
}

const accepted = { prompt: "the prompt that was sent", options: { modelId: "engine-a", ratio: "1:1", resolution: "2k" } };

test("an accepted generation records the mode, the prompt sent, and the variant's settings", () => {
  const next = applyAcceptedGeneration(project(), "variant-1", "image", accepted);
  expect(next.nodes[0]).toMatchObject({ mode: "Image", text: "the prompt that was sent" });
  expect(next.moleculr!.variants[0]).toMatchObject({ kind: "image", generation: accepted.options });
  /* The settings are what rebuilds the same request later, so they are stored whole. */
  expect(next.moleculr!.variants[0].generation).toEqual(accepted.options);
});

test("audio and video name their own mode; audio never changes a variant's kind", () => {
  expect(applyAcceptedGeneration(project(), "variant-1", "video", accepted).nodes[0].mode).toBe("Video");
  const audio = applyAcceptedGeneration(project(), "variant-1", "audio", accepted);
  expect(audio.nodes[0].mode).toBe("Audio");
  expect(audio.moleculr!.variants[0].kind).toBe("image");
});

test("a locked node is never rewritten, and a project with no campaign is left alone", () => {
  const before = project({ locked: true });
  const locked = applyAcceptedGeneration(before, "variant-1", "video", accepted);
  /* The node is returned untouched, not rewritten with the sent prompt or a new mode. */
  expect(locked.nodes[0]).toBe(before.nodes[0]);
  expect(locked.nodes[0].text).toBe("the original prompt");
  /* The variant still records the settings: the dialog priced and sent them. */
  expect(locked.moleculr!.variants[0].generation).toEqual(accepted.options);

  const bare = project({ variant: false });
  expect(applyAcceptedGeneration(bare, "variant-1", "image", accepted).moleculr).toBeUndefined();
});

test("without accepted settings only the mode moves, and another node is untouched", () => {
  const next = applyAcceptedGeneration(project(), "variant-1", "image", undefined);
  expect(next.nodes[0]).toMatchObject({ mode: "Image", text: "the original prompt" });
  expect(next.moleculr!.variants[0].generation).toBeUndefined();
  const other = applyAcceptedGeneration(project(), "someone-else", "video", accepted);
  expect(other.nodes[0].text).toBe("the original prompt");
  expect(other.moleculr!.variants[0].generation).toBeUndefined();
});

/**
 * The extraction itself: Marketing Studio's flow lives in one component, and
 * Studio no longer holds a copy of it. A future host mounts the component
 * rather than reaching back into Studio.
 */
test("the Marketing Studio flow is self-contained and Studio holds no copy of it", () => {
  const flow = readFileSync("components/suites/MarketingStudioFlow.tsx", "utf8");
  const studio = readFileSync("components/workbench/Studio.tsx", "utf8");

  /* The campaign actions and the dialog that prices them are in the flow. */
  for (const marker of [
    "buildMoleculrStoryboard",
    "prepareMoleculrVariants",
    "bindMoleculrReferences",
    "referenceAdBinding",
    "moleculrVideoPrompt",
    "GenerationDialog",
    "MoleculrWorkspace",
    "PosterDesigner",
    "/api/workbench/moleculr/import-image",
  ])
    expect(flow, marker).toContain(marker);

  /* …and nowhere else. Studio mounts the flow and supplies a draft engine. */
  for (const marker of [
    "buildMoleculrStoryboard",
    "prepareMoleculrVariants",
    "bindMoleculrReferences",
    "referenceAdBinding",
    "moleculrVideoPrompt",
    "MoleculrWorkspace",
    "PosterDesigner",
    "/api/workbench/moleculr/import-image",
  ])
    expect(studio, marker).not.toContain(marker);
  expect(studio).toContain("<MarketingStudioFlow");

  /* One rule for an accepted generation, shared rather than copied. */
  expect(flow).toContain("applyAcceptedGeneration");
  expect(studio).toContain("applyAcceptedGeneration");
  for (const source of [flow, studio]) expect(source).not.toContain("kind==='audio'?'Audio'");

  /* The flow takes its host through props only: no Studio import, no context. */
  expect(flow).not.toContain("workbench/Studio");
});
