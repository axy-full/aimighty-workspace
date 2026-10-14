import { test, expect } from "@playwright/test";
import { mergeDraft } from "../../lib/workbench/draft-merge";
import { merge3, type MergeConflict } from "../../lib/workbench/merge";
import { conflictThing, conflictThings, setAt, takeTheirs, valueAt } from "../../lib/workbench/draft-conflicts";
import { newProject, type Project } from "../../lib/workbench/studio";
import { createNode } from "../../lib/workbench/node-graph";

/* "Changed since you opened it": when another window's saved change and this window's unsaved one touch the same single value, the merge keeps this
   window's AND says so, so nothing of the other's is overwritten in silence. Different fields, or the same change, are no conflict. */
const base = (): Project => ({ ...newProject("Board"), id: "d1", nodes: [{ ...createNode("scene", 0), id: "n1", title: "Shot 3", text: "A" }, { ...createNode("scene", 1), id: "n2", title: "Shot 4", text: "B" }] });
const edit = (p: Project, id: string, change: Record<string, unknown>): Project => ({ ...p, nodes: p.nodes.map((n) => (n.id === id ? { ...n, ...change } : n)) });
const conflictsOf = (b: Project, mine: Project, theirs: Project) => { const conflicts: MergeConflict[] = []; const merged = mergeDraft(b, mine, theirs, { conflicts }); return { merged, conflicts }; };

test("two windows changing the same value to different values is a reported conflict, this side's kept", () => {
  const b = base();
  const { merged, conflicts } = conflictsOf(b, edit(b, "n1", { title: "Shot Three" }), edit(b, "n1", { title: "Third shot" }));
  expect(merged.nodes.find((n) => n.id === "n1")!.title).toBe("Shot Three");
  expect(conflicts).toHaveLength(1);
  expect(conflicts[0]).toMatchObject({ path: ["nodes", "[id=n1]", "title"], mine: "Shot Three", theirs: "Third shot" });
});

test("no conflict: the same change on both sides, different fields, different cards, one side only, or theirs going on from mine", () => {
  const b = base();
  const none = (mine: Project, theirs: Project) => expect(conflictsOf(b, mine, theirs).conflicts).toEqual([]);
  none(edit(b, "n1", { title: "Same" }), edit(b, "n1", { title: "Same" }));
  none(edit(b, "n1", { title: "Mine" }), edit(b, "n1", { text: "Theirs" }));
  none(edit(b, "n1", { title: "Mine" }), edit(b, "n2", { title: "Theirs" }));
  none(edit(b, "n1", { title: "Mine" }), b);
  none(b, edit(b, "n1", { title: "Theirs" }));
  none(edit(b, "n1", { title: "Shot 3 b" }), edit(b, "n1", { title: "Shot 3 b, c" }));
});

test("a number or a switch both sides changed is a conflict too; with no `conflicts` asked for, merging is exactly as before", () => {
  const withNumber = (p: Project, x: number) => ({ ...p, nodes: p.nodes.map((n) => (n.id === "n1" ? { ...n, x } : n)) });
  const b = base();
  const { conflicts } = conflictsOf(b, withNumber(b, 10), withNumber(b, 99));
  expect(conflicts).toMatchObject([{ path: ["nodes", "[id=n1]", "x"], mine: 10, theirs: 99 }]);
  const plain = mergeDraft(b, withNumber(b, 10), withNumber(b, 99));
  expect(plain.nodes[0].x).toBe(10);
  const asked = merge3({ a: 1, b: { c: 1 } }, { a: 2, b: { c: 1 } }, { a: 3, b: { c: 1 } }, { conflicts: [] });
  expect(asked).toEqual({ a: 2, b: { c: 1 } });
});

test("a project field both sides changed names the field; the report never carries a long text", () => {
  const b = { ...base(), name: "Board", brief: "x" };
  const { conflicts } = conflictsOf(b, { ...b, name: "Mine".repeat(200) }, { ...b, name: "Theirs" });
  expect(conflicts[0].path).toEqual(["name"]);
  expect(String(conflicts[0].mine).length).toBeLessThanOrEqual(200);
});

test("taking the saved version at the conflicts changes only those places", () => {
  const b = base();
  const mine = edit(edit(b, "n1", { title: "Shot Three" }), "n2", { text: "Mine only" });
  const theirs = edit(b, "n1", { title: "Third shot" });
  const { merged, conflicts } = conflictsOf(b, mine, theirs);
  const reloaded = takeTheirs(merged, theirs, conflicts);
  expect(reloaded.nodes.find((n) => n.id === "n1")!.title).toBe("Third shot");
  expect(reloaded.nodes.find((n) => n.id === "n2")!.text).toBe("Mine only");
  // Nothing conflicting: nothing changes (the same object back).
  expect(takeTheirs(merged, theirs, [])).toBe(merged);
});

test("paths read and write by key and by [id=value]; a path that is not there changes nothing", () => {
  const p = base();
  expect(valueAt(p, ["nodes", "[id=n2]", "title"])).toBe("Shot 4");
  expect(valueAt(p, ["nodes", "[id=zz]", "title"])).toBeUndefined();
  const next = setAt(p, ["nodes", "[id=n2]", "title"], "Renamed");
  expect(next.nodes[1].title).toBe("Renamed");
  expect(p.nodes[1].title).toBe("Shot 4");
  expect(setAt(p, ["nodes", "[id=zz]", "title"], "x")).toBe(p);
  expect(setAt(p, ["nodes", "title"], "x")).toBe(p);
});

test("what the bar says it is about: the card's title, else the field in plain words, at most three", () => {
  const p = { ...base(), brief: "b" };
  const c = (...path: string[]): MergeConflict => ({ path, mine: 1, theirs: 2 });
  expect(conflictThing(p, c("nodes", "[id=n1]", "title"))).toBe("Shot 3");
  expect(conflictThing(p, c("nodes", "[id=zz]", "title"))).toBe("a card");
  expect(conflictThing(p, c("name"))).toBe("the board's name");
  expect(conflictThing({ ...p, boardStages: [{ id: "cut", label: "Edit" }] }, c("boardStages", "[id=cut]", "label"))).toBe("a stage name");
  expect(conflictThing(p, c("boardKind"))).toBe("board kind");
  expect(conflictThings(p, [c("nodes", "[id=n1]", "title"), c("nodes", "[id=n1]", "text"), c("brief")])).toEqual(["Shot 3", "the brief"]);
  expect(conflictThings(p, ["a", "b", "c", "d", "e"].map((k) => c(k)))).toEqual(["a", "b", "c", "2 more"]);
});
