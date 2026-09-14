import { test, expect } from "@playwright/test";
import {
  compilePipeline,
  pipelineHash,
  type PublishedPipelineContext,
} from "../../lib/pipeline/compile";

export const publication: PublishedPipelineContext = {
  projectId: "production",
  version: 3,
  body: {
    brief: "A quiet sunrise over a city.",
    script: "Good morning.",
    direction: "Natural light.",
    nodes: [{ id: "shot", text: "A cyclist crosses the frame." }],
    assets: [
      {
        id: "look",
        kind: "image",
        uploadId: "upload",
        url: "/api/uploads/upload",
        version: 1,
      },
    ],
  },
};
export const image = (id = "stills", units = 2) => ({
  id,
  label: "Stills",
  kind: "image",
  model: "gemini-image",
  prompt: { source: "node", nodeId: "shot" },
  resolution: "1K",
  units,
});
export const spec = () => ({
  schemaVersion: 1,
  name: "Morning",
  context: { projectId: "production", bibleVersion: 3 },
  stages: [
    image(),
    {
      id: "choose",
      label: "Choose a take",
      kind: "review",
      candidates: [
        { stageId: "stills", unit: 0 },
        { stageId: "stills", unit: 1 },
      ],
    },
    {
      id: "motion",
      label: "Motion",
      kind: "video",
      model: "seedance",
      prompt: { source: "brief" },
      resolution: "720p",
      duration: 5,
      inputs: [{ source: "stage", stageId: "choose", role: "first_frame" }],
    },
    {
      id: "voice",
      label: "Voice",
      kind: "audio",
      model: "eleven_multilingual_v2",
      prompt: { source: "script" },
      task: "speech",
    },
    {
      id: "delivery",
      label: "Edit",
      kind: "assembly",
      fps: 24,
      aspect: "16:9",
      clips: [{ stageId: "motion", durationFrames: 120 }],
      soundtrack: { stageId: "voice" },
    },
  ],
});

test("compiler freezes published text and produces a stable ordered typed DAG", () => {
  const source = structuredClone(publication),
    input = spec();
  const compiled = compilePipeline(input, source);
  expect(compiled.order).toEqual([
    "stills",
    "choose",
    "motion",
    "voice",
    "delivery",
  ]);
  expect(compiled.maximumUnits).toBe(4);
  expect(compiled.stages[2].dependencies).toEqual(["choose"]);
  expect(compiled.stages[0].prompt).toBe(publication.body.nodes[0].text);
  source.body.nodes[0].text = "A private later edit";
  expect(compiled.stages[0].prompt).not.toContain("private");
  expect(compilePipeline(input, publication).fingerprint).toBe(
    compiled.fingerprint,
  );
  expect(pipelineHash({ b: 1, a: 2 })).toBe(pipelineHash({ a: 2, b: 1 }));
  expect(() =>
    compilePipeline(
      { ...input, context: { ...input.context, bibleVersion: 4 } },
      publication,
    ),
  ).toThrow(/exact published/);
  expect(() =>
    compilePipeline({ ...input, privateDraft: source.body }, publication),
  ).toThrow(/Unrecognized/);
});

test("compiler refuses cycles, dangling outputs, invalid variants and mismatched media roles", () => {
  const base = spec();
  expect(() =>
    compilePipeline(
      {
        ...base,
        stages: [
          {
            ...image(),
            inputs: [
              { source: "stage", stageId: "stills", role: "first_frame" },
            ],
          },
        ],
      },
      publication,
    ),
  ).toThrow(/cycle/);
  expect(() =>
    compilePipeline(
      {
        ...base,
        stages: [
          {
            ...image(),
            inputs: [
              { source: "stage", stageId: "missing", role: "first_frame" },
            ],
          },
        ],
      },
      publication,
    ),
  ).toThrow(/missing/);
  expect(() =>
    compilePipeline(
      {
        ...base,
        stages: [
          image(),
          {
            id: "review",
            label: "Select",
            kind: "review",
            candidates: [{ stageId: "stills", unit: 2 }],
          },
        ],
      },
      publication,
    ),
  ).toThrow(/output 3/);
  expect(() =>
    compilePipeline(
      {
        ...base,
        stages: [
          image(),
          {
            ...image("next"),
            inputs: [
              { source: "stage", stageId: "stills", role: "reference_video" },
            ],
          },
        ],
      },
      publication,
    ),
  ).toThrow(/incompatible/);
  expect(() =>
    compilePipeline(
      {
        ...base,
        stages: [
          {
            ...image(),
            inputs: [0, 1].map(() => ({
              source: "asset",
              assetId: "look",
              role: "first_frame",
            })),
          },
        ],
      },
      publication,
    ),
  ).toThrow(/more than one/);
});

test("stored identities and their transitive published lineage are mandatory", () => {
  const input = {
    ...spec(),
    stages: [
      {
        ...image(),
        inputs: [{ source: "asset", assetId: "look", role: "reference_image" }],
      },
    ],
  };
  const compiled = compilePipeline(input, publication);
  expect(compiled.stages[0].inputs[0]).toMatchObject({
    source: "asset",
    media: { source: "upload", id: "upload", assetId: "look", version: 1 },
  });
  for (const asset of [
    { ...publication.body.assets[0], url: "https://example.com/private.png" },
    { ...publication.body.assets[0], generationId: "other" },
    { ...publication.body.assets[0], refs: ["private-only"] },
    { ...publication.body.assets[0], parentId: "look" },
  ])
    expect(() =>
      compilePipeline(input, {
        ...publication,
        body: { ...publication.body, assets: [asset] },
      }),
    ).toThrow();
});

test("bounded units, prompt size, and actual assembly duration are enforced", () => {
  expect(() =>
    compilePipeline(
      {
        ...spec(),
        stages: Array.from({ length: 9 }, (_, i) => image("image" + i, 8)),
      },
      publication,
    ),
  ).toThrow(/64/);
  expect(() =>
    compilePipeline(spec(), {
      ...publication,
      body: {
        ...publication.body,
        nodes: [{ id: "shot", text: "x".repeat(12001) }],
      },
    }),
  ).toThrow(/12000/);
  const base = spec();
  base.stages[4] = {
    ...base.stages[4],
    clips: [{ stageId: "motion", durationFrames: 5400 }],
  } as (typeof base.stages)[4];
  expect(() => compilePipeline(base, publication)).toThrow(/three minutes/);
});
