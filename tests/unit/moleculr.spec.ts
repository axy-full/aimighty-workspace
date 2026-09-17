import { test, expect } from "@playwright/test";
import {
  EMPTY_MOLECULR,
  MOLECULR_FORMATS,
  moleculrNode,
  moleculrPrompt,
  moleculrReferences,
  variantAssets,
  type MoleculrBrief,
} from "../../lib/workbench/moleculr";
import { moleculrSchema, saveSchema } from "../../lib/workbench/studio-schema";
import { newProject, type Asset } from "../../lib/workbench/studio";

const brief = (changes: Partial<MoleculrBrief> = {}): MoleculrBrief => ({
  ...EMPTY_MOLECULR,
  productAssetIds: [],
  castAssetIds: [],
  hooks: [],
  variants: [],
  ...changes,
});
const asset = (id: string, changes: Partial<Asset> = {}): Asset => ({
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
  ...changes,
});

test("legacy drafts stay valid and campaign selections survive a saved-project roundtrip", () => {
  const project = newProject("Existing film");
  const old = saveSchema.parse({
    project: JSON.parse(JSON.stringify(project)),
    revision: 4,
  });
  expect(old.project).toEqual(project);
  expect(old.project).not.toHaveProperty("moleculr");
  project.assets = [
    asset("product"),
    asset("cast"),
    asset("render", { nodeId: "variant-node", generationId: "generation" }),
  ];
  project.nodes = [
    moleculrNode("variant-node", "Show the product", "First hook", 0, "image"),
  ];
  project.moleculr = brief({
    productName: "Pocket camera",
    productUrl: "https://example.test/camera",
    productAssetIds: ["product"],
    castAssetIds: ["cast"],
    format: "tutorial",
    hooks: ["Carry the moment"],
    notes: "Keep the supplied packaging",
    variants: [
      {
        id: "variant-one",
        nodeId: "variant-node",
        hook: "Carry the moment",
        castAssetId: "cast",
      },
    ],
  });
  const saved = saveSchema.parse({
    project: JSON.parse(JSON.stringify(project)),
    revision: 5,
  });
  expect(saved.project.moleculr).toEqual(project.moleculr);
  expect(saved.project.assets).toEqual(project.assets);
  expect(saved.revision).toBe(5);
  expect(moleculrSchema.parse(brief())).toEqual(EMPTY_MOLECULR);
});

test("reference, hook and variant counts accept their boundary and reject overflow before saving", () => {
  const counts = [
    ["productAssetIds", 5, (i: number) => `product-${i}`],
    ["castAssetIds", 6, (i: number) => `cast-${i}`],
    ["hooks", 12, (i: number) => `Hook ${i}`],
    [
      "variants",
      100,
      (i: number) => ({
        id: `variant-${i}`,
        nodeId: `node-${i}`,
        hook: `Hook ${i}`,
      }),
    ],
  ] as const;
  for (const [field, max, item] of counts) {
    const atLimit = {
      ...brief(),
      [field]: Array.from({ length: max }, (_, i) => item(i)),
    };
    expect(moleculrSchema.safeParse(atLimit).success, field).toBe(true);
    const tooMany = {
      ...brief(),
      [field]: Array.from({ length: max + 1 }, (_, i) => item(i)),
    };
    expect(
      saveSchema.safeParse({
        project: { ...newProject("Overflow"), moleculr: tooMany },
        revision: 0,
      }).success,
      field,
    ).toBe(false);
  }
});

test("campaign text, reference IDs and nested variant fields are bounded and reject unsupported action fields", () => {
  for (const [field, max] of [
    ["productName", 200],
    ["productUrl", 2000],
    ["notes", 6000],
  ] as const) {
    expect(
      moleculrSchema.safeParse(brief({ [field]: "x".repeat(max) })).success,
      field,
    ).toBe(true);
    expect(
      moleculrSchema.safeParse(brief({ [field]: "x".repeat(max + 1) })).success,
      field,
    ).toBe(false);
  }
  for (const field of ["productAssetIds", "castAssetIds", "hooks"] as const) {
    const max = field === "hooks" ? 500 : 100;
    expect(
      moleculrSchema.safeParse(brief({ [field]: ["x".repeat(max)] })).success,
      field,
    ).toBe(true);
    expect(
      moleculrSchema.safeParse(brief({ [field]: ["x".repeat(max + 1)] }))
        .success,
      field,
    ).toBe(false);
  }
  for (const [field, max] of [
    ["id", 100],
    ["nodeId", 100],
    ["hook", 500],
    ["castAssetId", 100],
  ] as const) {
    const variant = {
      id: "variant",
      nodeId: "node",
      hook: "Hook",
      [field]: "x".repeat(max),
    };
    expect(
      moleculrSchema.safeParse(brief({ variants: [variant] })).success,
      field,
    ).toBe(true);
    expect(
      moleculrSchema.safeParse(
        brief({ variants: [{ ...variant, [field]: "x".repeat(max + 1) }] }),
      ).success,
      field,
    ).toBe(false);
  }
  expect(moleculrSchema.safeParse({ ...brief(), publish: true }).success).toBe(
    false,
  );
  expect(
    moleculrSchema.safeParse({
      ...brief(),
      variants: [{ id: "v", nodeId: "n", hook: "h", publish: true }],
    }).success,
  ).toBe(false);
  expect(
    moleculrSchema.safeParse({ ...brief(), format: "ad-buyer" }).success,
  ).toBe(false);
});

test("references resolve only selected images in the current draft without duplicates or mutation", () => {
  const project = newProject("Current project");
  project.assets = [
    asset("product"),
    asset("cast-one"),
    asset("cast-two"),
    asset("unused"),
    asset("clip", { kind: "video" }),
    asset("audio", { kind: "audio" }),
  ];
  project.sharedAssets = [
    asset("foreign", { name: "Not imported into this draft" }),
  ];
  const selection = brief({
    productAssetIds: ["product", "product", "clip", "foreign", "missing"],
    castAssetIds: ["cast-one", "cast-two", "audio"],
  });
  const before = JSON.stringify({ project, selection });
  expect(moleculrReferences(project, selection).map((item) => item.id)).toEqual(
    ["product", "cast-one", "cast-two"],
  );
  expect(
    moleculrReferences(project, selection, "cast-two").map((item) => item.id),
  ).toEqual(["product", "cast-two"]);
  expect(
    moleculrReferences(project, selection, "foreign").map((item) => item.id),
  ).toEqual(["product"]);
  expect(
    moleculrReferences(project, selection, "clip").map((item) => item.id),
  ).toEqual(["product"]);
  expect(JSON.stringify({ project, selection })).toBe(before);
});

test("a product-only campaign has no implicit cast or unselected reference", () => {
  const project = newProject("Product only");
  project.assets = [asset("product"), asset("cast", { category: "Character" })];
  expect(
    moleculrReferences(project, brief({ productAssetIds: ["product"] })).map(
      (item) => item.id,
    ),
  ).toEqual(["product"]);
  expect(moleculrReferences(project, brief())).toEqual([]);
});

test("each advertised campaign format is accepted and produces its named creative instruction", () => {
  const project = newProject("Camera launch");
  const prompts = MOLECULR_FORMATS.map((format) => {
    const selection = moleculrSchema.parse(
      brief({ format: format.id, productName: "Pocket camera" }),
    );
    const prompt = moleculrPrompt(project, selection, "Carry the moment");
    expect(prompt).toContain(
      `Create a ${format.label.toLowerCase()} for Pocket camera.`,
    );
    return prompt;
  });
  expect(new Set(prompts).size).toBe(MOLECULR_FORMATS.length);
});

test("prompt uses the selected hook and cast, supplied offer and direction without pretending to fetch a URL", () => {
  const project = newProject("Camera launch");
  project.direction = "Warm afternoon light.";
  project.marketingBrief = {
    objective: "Introduce the camera",
    offer: "A 120 gram camera; no stated discount",
    audience: "Commuters",
    channels: ["Instagram"],
    tone: "Direct",
    constraints: "No battery-life claim.",
  };
  project.assets = [
    asset("cast-a", { name: "Asha", description: "Blue jacket." }),
    asset("cast-b", {
      name: "Unused cast",
      description: "This detail must stay out.",
    }),
  ];
  const selection = brief({
    productName: "Pocket camera",
    productUrl: "https://example.test/product",
    notes: "Keep the original packaging.",
    castAssetIds: ["cast-a", "cast-b"],
  });
  const before = JSON.stringify({ project, selection });
  const prompt = moleculrPrompt(
    project,
    selection,
    "  Carry the moment  ",
    "cast-a",
  );
  for (const content of [
    "Pocket camera",
    "Campaign hook: Carry the moment",
    "context only; use only the reviewed description above",
    selection.productUrl,
    project.marketingBrief.offer,
    project.marketingBrief.audience,
    "Asha",
    "Blue jacket.",
    selection.notes,
    project.direction,
    project.marketingBrief.constraints,
  ]) {
    expect(prompt).toContain(content);
  }
  expect(prompt).not.toContain("Unused cast");
  expect(prompt).not.toContain("This detail must stay out.");
  expect(prompt).toContain("Do not invent product claims or testimonials.");
  expect(prompt).toContain(
    "Preserve the product geometry, packaging, labels and identity",
  );
  expect(JSON.stringify({ project, selection })).toBe(before);
});

test("blank optional fields use the project and neutral hook without invented cast or offer context", () => {
  const project = newProject("Existing product project");
  const prompt = moleculrPrompt(project, brief(), " \n\t ", "missing-cast");
  expect(prompt).toContain("for Existing product project.");
  expect(prompt).toContain("Campaign hook: Introduce the product clearly.");
  for (const field of [
    "Product reference URL",
    "offer information:",
    "Audience:",
    "Match the selected cast reference:",
    "Direction:",
    "undefined",
    "null",
  ]) {
    expect(prompt).not.toContain(field);
  }
});

test("valid maximum-length creative context cannot truncate mandatory claims and product safeguards", () => {
  const project = newProject("Large campaign");
  project.direction = "D".repeat(30000);
  project.marketingBrief = {
    objective: "",
    offer: "O".repeat(3000),
    audience: "A".repeat(2000),
    channels: [],
    tone: "",
    constraints: "Do not depict a discount or customer testimonial.",
  };
  project.assets = [asset("cast", { description: "C".repeat(5000) })];
  const selection = brief({
    productName: "P".repeat(200),
    productUrl: "https://example.test/".padEnd(2000, "u"),
    notes: "N".repeat(6000),
    castAssetIds: ["cast"],
  });
  project.moleculr = selection;
  expect(saveSchema.safeParse({ project, revision: 0 }).success).toBe(true);
  const prompt = moleculrPrompt(project, selection, "H".repeat(500), "cast");
  expect(prompt.length).toBeLessThanOrEqual(12000);
  for (const required of [
    "Do not invent product claims or testimonials.",
    "Preserve the product geometry, packaging, labels and identity",
    "add final typography in post",
    project.marketingBrief.constraints,
  ]) {
    expect(prompt.includes(required), `Preserve instruction: ${required}`).toBe(
      true,
    );
  }
});

test("prompt never promises a cast reference that the image resolver excluded", () => {
  const project = newProject("Image campaign");
  project.assets = [
    asset("product"),
    asset("invalid-cast", {
      kind: "video",
      name: "Unusable video cast",
      description: "Unusable appearance details",
    }),
  ];
  const selection = brief({
    productAssetIds: ["product"],
    castAssetIds: ["invalid-cast"],
  });
  expect(
    moleculrReferences(project, selection, "invalid-cast").map(
      (item) => item.id,
    ),
  ).toEqual(["product"]);
  const prompt = moleculrPrompt(
    project,
    selection,
    "Show the product",
    "invalid-cast",
  );
  expect(prompt).not.toContain("Match the selected cast reference:");
  expect(prompt).not.toContain("Unusable appearance details");
});

test("variant outputs are scoped by node identity, keeping every take and excluding similarly named unrelated assets", () => {
  const project = newProject("Variant campaign");
  project.assets = [
    asset("take-one", { nodeId: "node-a", generationId: "g1", version: 1 }),
    asset("unrelated", {
      nodeId: "other-node",
      category: "Variant",
      name: "Same hook",
    }),
    asset("take-two", { nodeId: "node-a", generationId: "g2", version: 2 }),
    asset("video-take", {
      kind: "video",
      nodeId: "node-b",
      generationId: "g3",
    }),
    asset("unbound", { name: "Same hook" }),
  ];
  project.sharedAssets = [asset("not-in-draft", { nodeId: "node-a" })];
  const selection = brief({
    variants: [
      { id: "v1", nodeId: "node-a", hook: "Same hook" },
      { id: "v2", nodeId: "node-b", hook: "Other hook" },
      { id: "v3", nodeId: "node-a", hook: "Repeated node" },
    ],
  });
  const before = JSON.stringify({ project, selection });
  expect(variantAssets(project, selection).map((item) => item.id)).toEqual([
    "take-one",
    "take-two",
    "video-take",
  ]);
  expect(variantAssets(project, brief())).toEqual([]);
  expect(JSON.stringify({ project, selection })).toBe(before);
});

test("variant nodes retain their prompt and media type and can be saved without overlapping positions", () => {
  const project = newProject("Draft variants");
  const prompt = moleculrPrompt(project, brief(), "A clear product view");
  project.nodes = Array.from({ length: 4 }, (_, index) =>
    moleculrNode(
      `node-${index}`,
      prompt,
      "T".repeat(400),
      index,
      index % 2 ? "video" : "image",
    ),
  );
  expect(new Set(project.nodes.map((node) => `${node.x}:${node.y}`)).size).toBe(
    4,
  );
  for (const [index, node] of project.nodes.entries()) {
    expect(node).toMatchObject({
      id: `node-${index}`,
      type: "generate",
      mode: index % 2 ? "Video" : "Image",
      text: prompt,
      linked: [],
    });
    expect(node.title.length).toBeLessThanOrEqual(300);
  }
  expect(saveSchema.safeParse({ project, revision: 0 }).success).toBe(true);
});

test("variants near the node limit stay within the saved canvas coordinate bounds", () => {
  const project = newProject("Large canvas");
  project.nodes = [168, 200, 249].map((index) =>
    moleculrNode(
      `variant-${index}`,
      "A product film",
      "Bounded variant",
      index,
      "video",
    ),
  );
  expect(saveSchema.safeParse({ project, revision: 0 }).success).toBe(true);
  expect(project.nodes.every((node) => node.y <= 20000)).toBe(true);
});
