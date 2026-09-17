import { test, expect } from "@playwright/test";
import type { PublicPipelineRun } from "../../lib/pipeline/public";
import {
  atomikPage,
  projectCatalog,
  recipeFromRun,
  savedRecipes,
  stageCost,
  stageStatus,
  needsApproval,
  type AtomikCatalog,
  type RecordedTake,
} from "../../components/suites/atomik-suite-data";

const run = (): PublicPipelineRun => ({
  id: "run-a",
  owner: "owner",
  pipelineId: "pipeline-a",
  pipelineVersion: 1,
  revision: 4,
  state: "needs_review",
  name: "Dawn",
  context: { projectId: "production-a", bibleVersion: 2 },
  maximumUnits: 1,
  createdAt: 10,
  updatedAt: 20,
  stages: [
    {
      definition: {
        id: "image",
        label: "Keyframe",
        kind: "image",
        model: "gemini-3-pro-image",
        prompt: { source: "brief" },
        inputs: [],
        ratio: "16:9",
        resolution: "2k",
        seed: null,
        units: 1,
      },
      dependencies: [],
      outputKind: "image",
      prompt: "Dawn",
    },
    {
      definition: {
        id: "review",
        label: "Choose take",
        kind: "review",
        candidates: [{ stageId: "image", unit: 0 }],
      },
      dependencies: ["image"],
      outputKind: "image",
      prompt: undefined,
    },
  ],
  attempts: [
    {
      id: "attempt-a",
      runId: "run-a",
      stageId: "image",
      unit: 0,
      number: 1,
      requestKey: "request-a",
      state: "succeeded",
      generationId: "take-a",
      error: null,
      createdAt: 10,
      updatedAt: 20,
      kind: "image",
      estimatedCredits: 8,
      price: 8,
      currency: "cr",
      model: "gemini-3-pro-image",
      url: "/api/media/take-a?stream=1",
    },
  ],
  quotes: [],
  selections: [],
  assemblies: {},
});
const take: RecordedTake = {
  id: "take-a",
  projectId: "production-a",
  status: "succeeded",
  costUsd: 0.4,
  refineCostUsd: 0.1,
  creditsBilled: 6,
  provider: "google",
};

test("Atomik catalog only includes the stored draft production, never a similarly named project", () => {
  const first = run(),
    second = {
      ...run(),
      id: "run-b",
      context: { ...first.context, projectId: "production-b" },
    };
  const catalog = {
    runs: [first, second],
    publications: [
      { projectId: "production-a", name: "Dawn" },
      { projectId: "production-b", name: "Dawn" },
    ],
    models: [],
    audioModels: {},
  } as unknown as AtomikCatalog;
  expect(
    projectCatalog(catalog, "production-a").runs.map((item) => item.id),
  ).toEqual(["run-a"]);
  expect(
    projectCatalog(catalog, "production-a").publications.map(
      (item) => item.projectId,
    ),
  ).toEqual(["production-a"]);
  expect(projectCatalog(catalog, "missing").runs).toEqual([]);
  expect(atomikPage("budget")).toBe("budget");
  expect(atomikPage("spend")).toBe("runs");
});
test("saved recipe keeps exact stage/context definitions without inheriting approvals or paid attempts", () => {
  const original = run(),
    recipe = recipeFromRun(original);
  expect(recipe).toEqual({
    schemaVersion: 1,
    name: "Dawn",
    context: original.context,
    stages: original.stages.map((stage) => stage.definition),
  });
  expect(Object.keys(recipe)).not.toContain("attempts");
  expect(Object.keys(recipe)).not.toContain("quotes");
  recipe.stages[0].label = "Changed";
  expect(original.stages[0].definition.label).toBe("Keyframe");
  expect(
    savedRecipes([
      original,
      { ...original, id: "new-run", updatedAt: 30 },
      { ...original, id: "version-two", pipelineVersion: 2 },
    ]).map((item) => item.id),
  ).toEqual(["new-run", "version-two"]);
});
test("recorded actuals never substitute estimates, unknown rows, another project or unsettled billing", () => {
  const original = run();
  expect(stageCost(original, "image", [], true)).toMatchObject({
    actual: null,
    estimate: null,
  });
  expect(stageCost(original, "image", [take], true).actual).toBe(6);
  expect(stageCost(original, "image", [take], false).actual).toBe(0.5);
  original.quotes.push({
    id: "q",
    stageId: "image",
    baseRevision: original.revision,
    inputHash: "hash",
    fingerprint: "fingerprint",
    units: [{ unit: 0, number: 2 }],
    estimatedCredits: 8,
    price: 8,
    currency: "cr",
    expiresAt: 100,
    approvedAt: null,
  });
  expect(stageCost(original, "image", [take], true)).toEqual({
    estimate: 8,
    estimateUnit: "cr",
    actual: 6,
  });
  expect(stageStatus(original, "image", 50)).toBe("Awaiting approval");
  expect(stageStatus(original, "image", 101)).toBe("Complete");
  expect(
    stageCost(original, "image", [{ ...take, projectId: "production-b" }], true)
      .actual,
  ).toBeNull();
  expect(
    stageCost(original, "image", [{ ...take, status: "running" }], true).actual,
  ).toBeNull();
  expect(
    stageCost(original, "image", [{ ...take, creditsBilled: null }], true)
      .actual,
  ).toBeNull();
  expect(
    stageCost(original, "image", [{ ...take, creditsBilled: 0 }], true).actual,
  ).toBe(0);
});
test("checkpoint and retry status use saved selections and the latest attempt per unit", () => {
  const original = run();
  expect(stageStatus(original, "image")).toBe("Complete");
  expect(stageStatus(original, "review")).toBe("Checkpoint");
  expect(needsApproval(original)).toBe(true);
  original.attempts.push({
    ...original.attempts[0],
    id: "retry",
    number: 2,
    state: "uncertain",
    generationId: null,
  });
  expect(stageStatus(original, "image")).toBe("Needs recovery");
  original.selections.push({
    stageId: "review",
    candidate: { stageId: "image", unit: 0 },
    generationId: "take-a",
    kind: "image",
    selectedBy: "owner",
    selectedAt: 30,
  });
  expect(stageStatus(original, "review")).toBe("Selected");
  expect(needsApproval({ ...original, state: "succeeded" })).toBe(false);
});
