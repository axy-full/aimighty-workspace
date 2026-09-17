import { test, expect } from "@playwright/test";
import {
  nodeRenderSize,
  renderedNodeAsset,
} from "../../lib/workbench/node-render";
import { renderNode, newOperation } from "../../lib/workbench/node-graph";
import { seedProject, type CanvasNode } from "../../lib/workbench/studio";

const originalImage = Object.getOwnPropertyDescriptor(globalThis, "Image");
const originalDocument = Object.getOwnPropertyDescriptor(
  globalThis,
  "document",
);
test.afterEach(() => {
  for (const [key, descriptor] of [
    ["Image", originalImage],
    ["document", originalDocument],
  ] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
function browser(width: number, height: number) {
  const canvases: { width: number; height: number; calls: unknown[][] }[] = [];
  class ImageFixture {
    naturalWidth = width;
    naturalHeight = height;
    onload?: () => void;
    crossOrigin = "";
    set src(_value: string) {
      queueMicrotask(() => this.onload?.());
    }
  }
  Object.defineProperty(globalThis, "Image", {
    value: ImageFixture,
    configurable: true,
  });
  Object.defineProperty(globalThis, "document", {
    value: {
      createElement: (tag: string) => {
        expect(tag).toBe("canvas");
        const canvas = {
          width: 0,
          height: 0,
          calls: [] as unknown[][],
          getContext: () => context,
        };
        const context = {
          drawImage: (...args: unknown[]) => canvas.calls.push(args),
          translate: () => {},
          rotate: () => {},
          scale: () => {},
          beginPath: () => {},
          rect: () => {},
          ellipse: () => {},
          clip: () => {},
        };
        canvases.push(canvas);
        return canvas;
      },
    },
    configurable: true,
  });
  return canvases;
}
function graph() {
  const project = seedProject();
  const source: CanvasNode = {
    id: "source",
    title: "Source",
    type: "media",
    assetId: project.assets[0].id,
    x: 0,
    y: 0,
    width: 280,
    linked: [],
  };
  const finish: CanvasNode = {
    id: "finish",
    title: "Finish",
    type: "grade",
    x: 300,
    y: 0,
    width: 236,
    linked: ["source"],
    operations: [
      newOperation("grade"),
      newOperation("transform"),
      newOperation("mask"),
    ],
  };
  project.nodes = [source, finish];
  return { project, source, finish };
}

test("source-size output keeps native pixels through upstream nodes and every image tool, preview remains bounded", async () => {
  const canvases = browser(4096, 2160),
    { project, finish } = graph();
  const result = await renderNode(finish, project, { resolution: "source" });
  expect([result.width, result.height]).toEqual([4096, 2160]);
  expect(canvases.every((c) => c.width === 4096 && c.height === 2160)).toBe(
    true,
  );
  const preview = await renderNode(finish, project);
  expect([preview.width, preview.height]).toEqual([2048, 1080]);
});
test("oversize explicit render rejects before creating an export canvas rather than silently downsampling", async () => {
  const canvases = browser(10000, 5000),
    { project, source } = graph();
  await expect(
    renderNode(source, project, { resolution: "source" }),
  ).rejects.toThrow(/40 megapixels/);
  expect(canvases).toHaveLength(0);
  expect(nodeRenderSize(16385, 100, "preview").width).toBe(2048);
  expect(() => nodeRenderSize(16385, 100, "source")).toThrow(/16,384/);
  expect(() => nodeRenderSize(0, 100, "source")).toThrow(/invalid/);
  expect(nodeRenderSize(7680, 4320, "source")).toEqual({
    width: 7680,
    height: 4320,
  });
});
test("native graph allocation budget includes intermediate operation canvases", async () => {
  const canvases = browser(8000, 5000),
    { project, source } = graph();
  source.operations = [
    newOperation("grade"),
    newOperation("transform"),
    newOperation("mask"),
  ];
  await expect(
    renderNode(source, project, { resolution: "source" }),
  ).rejects.toThrow(/memory limit/);
  expect(canvases).toHaveLength(3);
  expect(canvases.reduce((total, c) => total + c.width * c.height, 0)).toBe(
    120_000_000,
  );
});
test("rendered takes preserve source lineage but have no inherited Soul identity or generation/shot/node bindings", () => {
  const source = {
    ...seedProject().assets[0],
    soulIdentityId: "soul-trained",
    generationId: "paid-job",
    productionShotId: "paid-shot",
    nodeId: "paid-node",
    uploadId: "old-upload",
  };
  const node: CanvasNode = {
    id: "finish",
    title: "Finish",
    type: "grade",
    x: 0,
    y: 0,
    width: 236,
    linked: [],
  };
  const output = renderedNodeAsset(
    source,
    { id: "new-upload", url: "/api/uploads/new-upload" },
    node,
    { width: 4096, height: 2160 },
    ["second", source.id],
    "render direction",
  );
  expect(output).toMatchObject({
    id: "new-upload",
    uploadId: "new-upload",
    url: "/api/uploads/new-upload",
    parentId: source.id,
    refs: [source.id, "second"],
    version: source.version + 1,
    status: "Draft",
    kind: "image",
    mime: "image/png",
    description: "Node render · 4096 × 2160",
  });
  for (const key of [
    "soulIdentityId",
    "generationId",
    "productionShotId",
    "nodeId",
  ])
    expect(output).not.toHaveProperty(key);
  expect(source.soulIdentityId).toBe("soul-trained");
  expect(source.generationId).toBe("paid-job");
});
