import { test, expect } from "@playwright/test";
import { publishedContext } from "../../lib/workbench/published-context";
import { newProject, type Asset } from "../../lib/workbench/studio";
import { collectExportAssets } from "../../lib/workbench/studio-export";

const asset = (id: string, fields: Partial<Asset> = {}): Asset => ({
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
  ...fields,
});

test("published derived takes include transitive parents, references and saved node versions for a collaborator export", () => {
  const source = asset("original"),
    look = asset("look"),
    older = asset("older", { refs: [look.id] });
  const edited = asset("edited", {
    parentId: source.id,
    refs: [source.id, look.id],
  });
  const project = {
    ...newProject("Lineage"),
    assets: [source, look, edited, older],
    sharedAssets: [edited],
    sharedNodes: [
      {
        id: "node",
        title: "Take",
        type: "media" as const,
        assetId: edited.id,
        linked: [],
        x: 0,
        y: 0,
        width: 300,
        versions: [
          {
            id: "version",
            label: "Earlier",
            assetId: older.id,
            operations: [],
            savedAt: "2026-09-14",
          },
        ],
      },
    ],
  };
  const shared = publishedContext(project);
  expect(shared.assets.map((item) => item.id).sort()).toEqual([
    "edited",
    "look",
    "older",
    "original",
  ]);
  const collaborator = {
    ...newProject("Collaborator"),
    ...shared,
    shots: [
      {
        id: "shot",
        name: "Opening",
        assetId: edited.id,
        duration: 24,
        sourceIn: 0,
        note: "",
      },
    ],
  };
  expect(
    collectExportAssets(collaborator)
      .map((item) => item.id)
      .sort(),
  ).toEqual(["edited", "look", "original"]);
  project.assets[0].description = "Later private edit";
  expect(shared.assets.find((item) => item.id === source.id)?.description).toBe(
    "",
  );
});

test("missing source/parent or cyclic lineage fails publication instead of creating broken shared context", () => {
  const project = newProject("Invalid lineage");
  const first = asset("a", { parentId: "missing" });
  expect(() =>
    publishedContext({ ...project, assets: [first], sharedAssets: [first] }),
  ).toThrow(/missing/);
  const second = asset("b", { refs: ["a"] });
  first.parentId = "b";
  expect(() =>
    publishedContext({
      ...project,
      assets: [first, second],
      sharedAssets: [first],
    }),
  ).toThrow(/cycle/);
  expect(() =>
    publishedContext({
      ...project,
      sharedNodes: [
        {
          id: "node",
          title: "Lost",
          type: "media",
          x: 0,
          y: 0,
          width: 300,
          linked: ["missing"],
        },
      ],
    }),
  ).toThrow(/linked node is missing/);
});
