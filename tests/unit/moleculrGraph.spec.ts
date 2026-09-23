import { PROJECT_LIMITS, limitText } from "../../lib/workbench/project-limits";
import { expect, test } from "@playwright/test";
import { bindMoleculrReferences } from "../../lib/workbench/moleculr-graph";
import { generationReferenceIds } from "../../lib/workbench/node-graph";
import { saveSchema } from "../../lib/workbench/studio-schema";
import {
  newProject,
  type Asset,
  type CanvasNode,
  type Project,
} from "../../lib/workbench/studio";

const image = (id: string, fields: Partial<Asset> = {}): Asset => ({
  id,
  name: id,
  kind: "image",
  category: "Reference",
  url: `/api/uploads/${id}`,
  description: "",
  prompt: "",
  status: "Draft",
  locked: false,
  version: 1,
  refs: [],
  uploadId: id,
  ...fields,
});
const node = (id: string, fields: Partial<CanvasNode> = {}): CanvasNode => ({
  id,
  title: id,
  type: "generate",
  text: "Keep the selected product and character.",
  x: 800,
  y: 80,
  width: 300,
  linked: [],
  mode: "Video",
  ...fields,
});
const ids = () => {
  let next = 0;
  return () => `new-source-${++next}`;
};
function saved(
  project: Project,
  result: ReturnType<typeof bindMoleculrReferences>,
) {
  const next = {
    ...project,
    nodes: [
      ...project.nodes.filter((item) => item.id !== result.node.id),
      ...result.sources,
      result.node,
    ],
  };
  return saveSchema.parse(
    JSON.parse(JSON.stringify({ project: next, revision: 1 })),
  ).project as Project;
}

test("saved variants retain original product and Soul references after reloading into Rig", () => {
  const project = newProject("Campaign");
  const product = image("product"),
    cast = image("portrait", {
      soulIdentityId: "local-soul",
      category: "Character",
    });
  project.assets = [product, cast];
  project.nodes = [
    node("product-source", { type: "media", assetId: product.id }),
  ];
  const before = JSON.stringify(project);
  const result = bindMoleculrReferences(
    project,
    node("variant"),
    [product, cast, product],
    ids(),
  );
  expect(result.sources).toHaveLength(1);
  expect(result.node.linked).toEqual(["product-source", "new-source-1"]);
  const reloaded = saved(project, result);
  const variant = reloaded.nodes.find((item) => item.id === "variant")!;
  expect(generationReferenceIds(variant, reloaded)).toEqual([
    product.id,
    cast.id,
  ]);
  expect(reloaded.assets.find((item) => item.id === cast.id)).toMatchObject({
    soulIdentityId: "local-soul",
    uploadId: "portrait",
  });
  expect(JSON.stringify(project)).toBe(before);
});

test("only current-project images bind and source metadata comes from the original asset", () => {
  const project = newProject("Scoped campaign");
  project.assets = [
    image("product", { name: "Original product" }),
    image("clip", { kind: "video" }),
  ];
  project.sharedAssets = [image("shared")];
  const result = bindMoleculrReferences(
    project,
    node("variant"),
    [
      image("foreign"),
      image("shared"),
      image("clip"),
      image("product", {
        name: "Forged title",
        url: "https://other.invalid/image",
      }),
    ],
    ids(),
  );
  expect(result.sources).toHaveLength(1);
  expect(result.sources[0]).toMatchObject({
    title: "Original product",
    assetId: "product",
    type: "media",
  });
  const reloaded = saved(project, result);
  expect(generationReferenceIds(reloaded.nodes.at(-1)!, reloaded)).toEqual([
    "product",
  ]);
});

test("transformed, bypassed, locked and generated leaves cannot replace an original source", () => {
  const variants: Partial<CanvasNode>[] = [
    {
      operations: [
        {
          id: "grade",
          kind: "grade",
          enabled: true,
          values: { contrast: 130 },
        },
      ],
    },
    {
      operations: [
        { id: "disabled", kind: "grade", enabled: false, values: {} },
      ],
    },
    { linked: ["upstream"] },
    { bypassed: true },
    { locked: true },
    { type: "grade" },
    { type: "generate" },
  ];
  for (const fields of variants) {
    const project = newProject("Original input");
    project.assets = [image("product")];
    project.nodes = [
      node("existing-source", { type: "media", assetId: "product", ...fields }),
    ];
    const result = bindMoleculrReferences(
      project,
      node("variant"),
      project.assets,
      ids(),
    );
    expect(result.sources, JSON.stringify(fields)).toHaveLength(1);
    expect(result.node.linked).toEqual(["new-source-1"]);
  }
});

test("reconfiguring preserves variant fields, reuses plain sources and never links the node to itself", () => {
  const project = newProject("Another take");
  project.assets = [image("product"), image("cast")];
  const variant = node("variant", {
    assetId: "product",
    mode: "Image",
    x: 135,
    status: "approved",
    linked: ["old-source"],
    operations: [
      {
        id: "direction",
        kind: "direction",
        enabled: true,
        values: { note: "Preserve framing" },
      },
    ],
  });
  project.nodes = [
    variant,
    node("cast-source", { type: "character", assetId: "cast" }),
  ];
  const result = bindMoleculrReferences(
    project,
    variant,
    project.assets,
    ids(),
  );
  expect(result.node).toEqual({
    ...variant,
    linked: ["new-source-1", "cast-source"],
  });
  expect(result.sources).toHaveLength(1);
  expect(result.node.linked).not.toContain(variant.id);
  const repeated = bindMoleculrReferences(
    saved(project, result),
    result.node,
    project.assets,
    () => {
      throw new Error("Should reuse sources");
    },
  );
  expect(repeated.sources).toEqual([]);
});

test("node capacity includes the new variant and sources but does not count an existing variant twice", () => {
  const project = newProject("Full project");
  project.assets = [image("product")];
  project.nodes = Array.from({ length: PROJECT_LIMITS.nodes - 2 }, (_, index) =>
    node(`existing-${index}`),
  );
  const atLimit = bindMoleculrReferences(
    project,
    node("variant"),
    project.assets,
    ids(),
  );
  expect(saved(project, atLimit).nodes).toHaveLength(PROJECT_LIMITS.nodes);
  project.nodes.push(node(`existing-${PROJECT_LIMITS.nodes - 2}`));
  let allocated = 0;
  expect(() =>
    bindMoleculrReferences(project, node("variant"), project.assets, () => {
      allocated++;
      return "source";
    }),
  ).toThrow(`${limitText(PROJECT_LIMITS.nodes)}-node project limit`);
  expect(allocated).toBe(0);
  const replacement = bindMoleculrReferences(
    project,
    project.nodes[0],
    project.assets,
    ids(),
  );
  expect(saved(project, replacement).nodes).toHaveLength(PROJECT_LIMITS.nodes);
});

test("reference nodes stay within schema bounds even at opposite canvas edges", () => {
  for (const position of [-10_000, 20_000]) {
    const project = newProject("Canvas edge");
    project.assets = Array.from({ length: 11 }, (_, index) =>
      image(`image-${index}`),
    );
    const result = bindMoleculrReferences(
      project,
      node("variant", { x: position, y: position }),
      project.assets,
      ids(),
    );
    expect(saved(project, result).nodes).toHaveLength(12);
    expect(
      new Set(result.sources.map((item) => `${item.x}:${item.y}`)).size,
    ).toBe(11);
  }
});

test("locked variants and colliding generated IDs fail without mutating the draft", () => {
  const project = newProject("Protected graph");
  project.assets = [image("product")];
  const before = JSON.stringify(project);
  expect(() =>
    bindMoleculrReferences(
      project,
      node("variant", { locked: true }),
      project.assets,
      ids(),
    ),
  ).toThrow("Unlock this variant");
  expect(() =>
    bindMoleculrReferences(
      project,
      node("variant"),
      project.assets,
      () => "variant",
    ),
  ).toThrow("unique reference node");
  expect(JSON.stringify(project)).toBe(before);
});
