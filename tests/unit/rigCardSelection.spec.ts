import { test, expect } from "@playwright/test";
import { INITIAL_STATE, applyUrl, fromSearch, toSearch } from "../../lib/workspace/navigation";
import type { AppState, SelectableItem } from "../../lib/workspace/types";
import { newProject, type Asset, type CanvasNode, type Project } from "../../lib/workbench/studio";
import { assetOrigin, cardSource, cardUsers, cardVersions } from "../../lib/workspace/rig";

/*
 * Any Rig card can be picked (plan PR 2): a shot into the shot Inspector, any
 * other card — a reference, a note, a look board — as selection kind "node",
 * into the Card Inspector with its kind, source and versions.
 */

const shots: SelectableItem[] = [{ id: "s1", name: "Wide", status: "ready" }, { id: "s2", name: "Close", status: "ready" }];
const onRig = (over: Partial<AppState> = {}): AppState => ({ ...INITIAL_STATE, view: "studio", suite: "particl", page: "rig", lists: { shots, takes: [], cast: [] }, ...over });


test("a picked card is in the URL and comes back from it; on another page the URL's card is repaired away", () => {
  const picked = onRig({ selKind: "node", selId: "look", projectId: "p1" });
  const search = toSearch(picked);
  expect(search).toContain("sel=node%3Alook");
  const url = fromSearch(search);
  expect(url.sel).toEqual({ kind: "node", id: "look" });
  const restored = applyUrl(INITIAL_STATE, url);
  expect([restored.page, restored.selKind, restored.selId]).toEqual(["rig", "node", "look"]);
  const elsewhere = applyUrl({ ...INITIAL_STATE, lists: { shots, takes: [], cast: [] } }, fromSearch("?suite=particl&page=takes&sel=node:look"));
  expect(elsewhere.selKind).toBe("take");
  expect(fromSearch("?page=rig&sel=bogus:look").sel).toBeNull();
});

const asset = (id: string, extra: Partial<Asset> = {}): Asset => ({ id, name: id, kind: "image", category: "Reference", url: `/api/uploads/${id}`, description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [], ...extra });
const node = (id: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({ id, title: id, type: "media", x: 0, y: 0, width: 220, linked: [], ...extra });

test("a card's source: its own, or what its input feeds it; said as kind, origin and filing", () => {
  const p: Project = {
    ...newProject("Cards"),
    assets: [asset("plate", { uploadId: "up1", category: "Environment", version: 3 }), asset("clip", { kind: "video", generationId: "g1", url: "/api/media/g1" }), asset("seed", { url: "/campaign/hero.webp" })],
    nodes: [node("env", { type: "element", assetId: "plate" }), node("grade", { type: "grade", linked: ["env"] }), node("clip-ref", { assetId: "clip" }), node("note", { type: "note", text: "Hold" }), node("seed-ref", { assetId: "seed" }), node("lost", { assetId: "gone" })],
  };
  const of = (id: string) => cardSource(p, p.nodes.find((n) => n.id === id)!);
  expect(of("env")).toMatchObject({ asset: { id: "plate" }, kind: "Image", origin: "Uploaded", own: true });
  expect(of("grade")).toMatchObject({ asset: { id: "plate" }, own: false });
  expect(of("clip-ref")).toMatchObject({ kind: "Video", origin: "Generated", own: true });
  expect(of("seed-ref")).toMatchObject({ origin: "Sample" });
  expect(of("note")).toBeNull();
  expect(of("lost")).toBeNull();
  expect(assetOrigin({ url: "https://example.test/a.png" })).toBe("Linked");
});

test("a card's versions: the source's line newest first with the current one marked, then the versions saved on the card", () => {
  const p: Project = {
    ...newProject("Versions"),
    assets: [
      asset("v1", { version: 1, name: "Harbour" }),
      asset("v2", { version: 2, name: "Harbour, dusk", parentId: "v1" }),
      asset("v3", { version: 3, name: "Harbour, night", parentId: "v2" }),
      asset("v2b", { version: 2, name: "Harbour, fog", parentId: "v1" }),
      asset("other", { version: 5, name: "Unrelated" }),
    ],
    nodes: [
      node("ref", { assetId: "v2", versions: [
        { id: "sv1", label: "Version 1", operations: [], savedAt: "2026-09-20T10:00:00.000Z" },
        { id: "sv2", label: "Before the grade", operations: [], savedAt: "2026-09-21T10:00:00.000Z" },
      ] }),
      node("bare"),
      node("s", { type: "scene", linked: ["ref"] }),
      node("g", { type: "grade", linked: ["ref"] }),
    ],
  };
  const rows = cardVersions(p, p.nodes[0]);
  expect(rows.map((r) => [r.v, r.label, r.current, r.saved])).toEqual([
    ["v3", "Harbour, night", false, false],
    ["v2", "Current · Harbour, dusk", true, false],
    ["v2", "Harbour, fog", false, false],
    ["v1", "Harbour", false, false],
    ["Saved", "Before the grade", false, true],
    ["Saved", "Version 1", false, true],
  ]);
  expect(rows[0].meta).toBe("Image");
  expect(rows[4].meta).toMatch(/^\d{2} Sept?$/);
  expect(cardVersions(p, p.nodes[1])).toEqual([]);
  /* An asset the draft both holds and shares is listed once. */
  const shared: Project = { ...p, sharedAssets: [p.assets[1], p.assets[2]] };
  expect(cardVersions(shared, shared.nodes[0]).filter((r) => !r.saved).map((r) => r.id)).toEqual(["v3", "v2", "v2b", "v1"]);
  /* A parent chain that loops never hangs the Inspector. */
  const loop: Project = { ...p, assets: [asset("a", { parentId: "b" }), asset("b", { parentId: "a", version: 2 })], nodes: [node("x", { assetId: "a" })] };
  expect(cardVersions(loop, loop.nodes[0]).map((r) => r.id)).toEqual(["b", "a"]);
  expect(cardUsers(p, "ref")).toEqual([{ id: "s", name: "s" }, { id: "g", name: "g" }]);
  expect(cardUsers(p, "s")).toEqual([]);
});
