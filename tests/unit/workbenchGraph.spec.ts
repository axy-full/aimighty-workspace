import { test, expect } from "@playwright/test";
import { canConnect, generationReferenceIds, resolveAsset } from "../../lib/workbench/node-graph";
import { seedProject } from "../../lib/workbench/studio";

test("generation carries upstream reference versions through finishing nodes without duplicates", () => {
  const project = seedProject();
  expect(new Set(generationReferenceIds(project.nodes.find(node => node.id === "result")!, project))).toEqual(new Set(["hero", "character", "environment"]));
});

test("switch and bypass reference bindings match the effective graph source", () => {
  const project = seedProject();
  const node = { ...project.nodes[0], id: "switch", type: "switch" as const, linked: ["look", "cast"], activeInput: "cast", assetId: "hero" };
  project.nodes.push(node);
  expect(resolveAsset(node, project.nodes, project.assets)?.id).toBe("character");
  expect(generationReferenceIds(node, project)).toEqual(["character"]);
  const bypassed = { ...project.nodes.find(value => value.id === "scene")!, bypassed: true, linked: ["world"] };
  expect(generationReferenceIds(bypassed, project)).toEqual(["environment"]);
});

test("graph refuses cycles, duplicate inputs and locked-target edits", () => {
  const project = seedProject();
  expect(canConnect(project.nodes, "result", "scene")).toMatch(/circular/);
  expect(canConnect(project.nodes, "scene", "scene")).toMatch(/itself/);
  expect(canConnect(project.nodes, "look", "scene")).toMatch(/already connected/);
  project.nodes.find(node => node.id === "cast")!.locked = true;
  expect(canConnect(project.nodes, "world", "cast")).toMatch(/Unlock/);
  expect(canConnect(project.nodes, "cast", "world")).toBeNull();
});
