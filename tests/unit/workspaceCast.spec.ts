import { test, expect } from "@playwright/test";
import { castCards, citingShots } from "../../lib/workspace/cast";
import { newProject, type Asset, type CanvasNode, type Project } from "../../lib/workbench/studio";
import type { SoulIdentity } from "../../lib/workbench/soul-identity";

const asset = (id: string, category: string, extra: Partial<Asset> = {}): Asset =>
  ({ id, name: id, kind: "image", category, url: `/api/uploads/${id}`, uploadId: id, description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [], ...extra });
const node = (id: string, type: CanvasNode["type"], extra: Partial<CanvasNode> = {}): CanvasNode => ({ id, title: id, type, x: 0, y: 0, width: 200, linked: [], ...extra });
const identity = (id: string, status: SoulIdentity["status"], refs: number, extra: Partial<SoulIdentity> = {}): SoulIdentity =>
  ({ id, projectId: "p", name: id, description: "", subjectType: "character", references: Array.from({ length: refs }, (_, i) => ({ uploadId: `${id}_${i}` })), status, previewUrl: null, createdAt: 1, updatedAt: 1, creditsBilled: null, error: null, ...extra });

const project: Project = {
  ...newProject("P"), id: "p",
  assets: [asset("lead", "Character", { soulIdentityId: "i1" }), asset("draft", "Character"), asset("sphere", "Element"), asset("plate", "Environment"), asset("note", "Reference")],
  nodes: [
    node("c", "character", { assetId: "lead" }), node("e", "element", { assetId: "sphere" }), node("b", "element", { assetId: "plate", bypassed: true }),
    node("s1", "scene", { linked: ["c", "e"] }), node("s2", "generate", { linked: ["e", "b"] }), node("n", "note", { linked: ["e"] }),
  ],
};

test("shots cite what their live inputs carry; bypassed inputs and non-shots do not count", () => {
  expect(citingShots(project, new Set(["sphere"]))).toEqual(["s1", "s2"]);
  expect(citingShots(project, new Set(["plate"]))).toEqual([]);
  expect(citingShots(project, new Set())).toEqual([]);
});

test("cards: groups in grid order, tags from identity state, drafts count what they need", () => {
  const cards = castCards(project, { identities: [identity("i1", "ready", 6), identity("i2", "failed", 2, { subjectType: "element" })], terms: { minPhotos: 4, maxPhotos: 20, trainingCredits: 54 } });
  expect(cards.map((c) => [c.id, c.group, c.tag])).toEqual([
    ["lead", "cast", "Identity locked"],
    ["draft", "cast", "Draft · needs 3 more"],
    ["sphere", "elements", "Cited by 2 shots"],
    ["plate", "elements", "Not cited yet"],
    ["identity:i2", "elements", "Identity failed"],
  ]);
  expect(cards[0].references).toHaveLength(6);
  expect(cards[0].citedBy).toEqual(["s1"]);
  /* Terms not loaded: no invented count. */
  expect(castCards(project, null).find((c) => c.id === "draft")?.tag).toBe("Draft");
  expect(castCards(project, null).find((c) => c.id === "lead")?.tag).toBe("Identity attached");
});
