import { test, expect } from "@playwright/test";
import { newProject, type Asset, type CanvasNode, type Project } from "../../lib/workbench/studio";
import { addInput, removeShots, restoreShots, RigBuildError } from "../../lib/production/rig-build";

/** Owner, 23 September: "unable to delete things from the rig section". */
const img = (id: string): Asset => ({ id, name: id, kind: "image", category: "Storyboard", url: `/api/media/${id}`, description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [] });
const shot = (id: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({ id, title: id, type: "scene", x: 100, y: 100, width: 300, linked: [], ...extra });
function rig(): Project {
  let p: Project = { ...newProject("Rig"), nodes: [shot("s1"), shot("s2"), shot("s3", { locked: true })] };
  p = addInput(p, "s1", img("frame-1"));
  p = addInput(p, "s2", img("frame-2"));
  /* One input both shots use. */
  const shared = p.nodes.find((n) => n.assetId === "frame-2")!;
  p = { ...p, nodes: p.nodes.map((n) => (n.id === "s1" ? { ...n, linked: [...n.linked, shared.id], activeInput: shared.id } : n)) };
  return p;
}

test("a shot goes with the inputs only it used; a shared input stays, unlinked from it", () => {
  const before = rig();
  const own = before.nodes.find((n) => n.assetId === "frame-1")!.id, shared = before.nodes.find((n) => n.assetId === "frame-2")!.id;
  const { project, removed } = removeShots(before, ["s1"]);
  expect(project.nodes.map((n) => n.id)).toEqual(["s2", "s3", shared]);
  expect(removed.removed.map((n) => n.id).sort()).toEqual(["s1", own].sort());
  expect(project.nodes.some((n) => n.linked.includes("s1"))).toBe(false);
  expect(project.assets.map((a) => a.id)).toEqual(expect.arrayContaining(["frame-1", "frame-2"]));
});

test("deleting the second user of a shared input takes the input too, and links to the shot are cut", () => {
  const before = rig();
  const shared = before.nodes.find((n) => n.assetId === "frame-2")!.id;
  const after = removeShots(removeShots(before, ["s1"]).project, ["s2"]).project;
  expect(after.nodes.map((n) => n.id)).toEqual(["s3"]);
  const wired = { ...before, nodes: before.nodes.map((n) => (n.id === "s3" ? { ...n, linked: ["s2"] } : n)) };
  const cut = removeShots(wired, ["s2"]).project;
  expect(cut.nodes.find((n) => n.id === "s3")!.linked).toEqual([]);
  expect(cut.nodes.some((n) => n.id === shared)).toBe(true);
});

test("a locked shot is refused; restoring puts the shot, its inputs and the links back", () => {
  expect(() => removeShots(rig(), ["s3"])).toThrow(RigBuildError);
  expect(() => removeShots(rig(), ["nope"])).toThrow("no longer in the Rig");
  const before = { ...rig(), nodes: rig().nodes.map((n) => (n.id === "s3" ? { ...n, locked: false, linked: ["s2"] } : n)) };
  const { project, removed } = removeShots(before, ["s2"]);
  const back = restoreShots(project, removed);
  expect(back.nodes.map((n) => n.id).sort()).toEqual(before.nodes.map((n) => n.id).sort());
  expect(back.nodes.find((n) => n.id === "s3")!.linked).toEqual(["s2"]);
  expect(back.nodes.find((n) => n.id === "s1")!.linked.length).toBe(2);
});
