import { test, expect } from "@playwright/test";
import { merge3, noteTakenOut, rebaseDraft, recordMade, sameJson, TAKEN_OUT_KEEP, type MadeRecords } from "../../lib/workbench/merge";
import { mergeDraft } from "../../lib/workbench/draft-merge";
import { draftWriter, writeMergedDraft } from "../../lib/workbench/draft-request";
import { saveSchema } from "../../lib/workbench/studio-schema";
import { newProject, type Asset, type CanvasNode, type Project } from "../../lib/workbench/studio";
import { shotPatch } from "../../lib/workspace/shots";
import { createSoundNode, findSoundNode } from "../../lib/workbench/sound-generate";
import { connectNodes, graphEdges } from "../../lib/workspace/rig-graph";
import { canConnect } from "../../lib/workbench/node-graph";
import { removeShots, restoreShots } from "../../lib/production/rig-build";
import { environmentsFromBeats, newEnvironmentEntry, sourcedPlaceId } from "../../lib/production/environment";
import { beatSheetFrom } from "../../lib/production/beats";
import { applyTeamPatch, catchUpForTeam, diffForTeam, emptyTeamCanvas } from "../../lib/workbench/team-canvas-model";
import { recoverMediaAssets, type MediaJob } from "../../lib/workbench/job-recovery";
import { addInput, buildFromBoards } from "../../lib/production/rig-build";
import { deleteDrawing } from "../../lib/production/boards";
import { prepareMoleculrVariants } from "../../lib/workbench/moleculr-storyboard";
import { EMPTY_MOLECULR } from "../../lib/workbench/moleculr";
import { uid } from "../../lib/workbench/studio";
import { popUndo, pushUndo, restoreUndo, type UndoEntry } from "../../lib/shell/undo";

/* lib/workbench/merge.ts: how two saves of one draft come together. */

const node = (id: string, extra: Partial<CanvasNode> = {}): CanvasNode =>
  ({ id, title: id, type: "scene", x: 0, y: 0, width: 238, linked: [], ...extra }) as CanvasNode;
const entry = (id: string, name: string) => ({ id, kind: "character" as const, name, description: "", prompt: "", takes: [] as { genId: string; at: string }[] });

function project(shape: (p: Project) => void = () => {}): Project {
  const p = newProject("Merge");
  p.id = "project-merge";
  p.createdAt = "2026-09-25T00:00:00Z";
  p.nodes = [node("n1", { title: "Opening" }), node("n2", { title: "Second" })];
  p.production = { cast: { entries: [entry("cast-1", "Mara")] } };
  shape(p);
  return p;
}
const clone = <T,>(value: T): T => structuredClone(value);
const ids = (list: { id: string }[]) => list.map((x) => x.id);
const duplicates = (list: string[]) => list.filter((id, i) => list.indexOf(id) !== i);

test.describe("which side a value comes from", () => {
  test("a side that left the value as it was takes the other side's", () => {
    expect(merge3(1, 1, 2)).toBe(2);
    expect(merge3(1, 3, 1)).toBe(3);
    expect(merge3("a", "a", "b")).toBe("b");
    expect(merge3({ a: 1 }, { a: 1 }, { a: 2, b: 3 })).toEqual({ a: 2, b: 3 });
  });

  test("both sides making the same change is one change", () => {
    expect(merge3(1, 2, 2)).toBe(2);
    expect(merge3({ a: [1] }, { a: [1, 2] }, { a: [1, 2] })).toEqual({ a: [1, 2] });
  });

  test("primitives both sides changed: mine wins", () => {
    expect(merge3(1, 2, 3)).toBe(2);
    expect(merge3("base", "mine", "theirs")).toBe("mine");
    expect(merge3(true, false, false)).toBe(false);
    expect(merge3<unknown>(null, "mine", 0)).toBe("mine");
    expect(merge3<unknown>("was", null, "theirs")).toBe(null);
  });

  test("lists of numbers are values: one changed side wins, both changed keeps mine", () => {
    expect(merge3([1, 2], [1, 2], [1, 2, 3])).toEqual([1, 2, 3]);
    expect(merge3([1, 2], [2], [1, 2])).toEqual([2]);
    /* Vectors are never mixed element by element. */
    expect(merge3([0, 0, 0], [1, 0, 0], [0, 2, 0])).toEqual([1, 0, 0]);
  });

  test("other lists of strings, and records without an identity, merge as sequences: what each side changed elsewhere is kept", () => {
    /* A list of strings that repeats one is a sequence, not a set: both insertions stay. */
    expect(merge3(["a", "a"], ["a", "a", "m"], ["a", "a", "t"])).toEqual(["a", "a", "m", "t"]);
    /* Theirs rewrote the first record, mine added a second: both. */
    expect(merge3([{ note: "one" }], [{ note: "one" }, { note: "two" }], [{ note: "three" }])).toEqual([{ note: "three" }, { note: "two" }]);
    /* Mine only deleted what theirs rewrote: the rewrite is kept. */
    expect(merge3(["Open wide.", "Hold."], ["Hold."], ["Open wider.", "Hold."])).toEqual(["Open wider.", "Hold."]);
    /* Both rewrote one stretch: mine's rewrite stands. */
    expect(merge3(["Open wide.", "Hold."], ["Open close.", "Hold."], ["Open wider.", "Hold."])).toEqual(["Open close.", "Hold."]);
  });

  test("lists of distinct strings merge as sets: both sides' additions stay, both sides' removals hold", () => {
    expect(merge3(["a", "b"], ["a", "b"], ["a", "b", "c"])).toEqual(["a", "b", "c"]);
    expect(merge3(["a", "b"], ["b"], ["a", "b"])).toEqual(["b"]);
    expect(merge3(["a", "b"], ["a", "b", "m"], ["a", "b", "t"])).toEqual(["a", "b", "m", "t"]);
    /* Mine unlinks a, theirs links t: a stays unlinked, t is linked. */
    expect(merge3(["a", "b"], ["b"], ["a", "b", "t"])).toEqual(["b", "t"]);
    /* Both link the same input: once. */
    expect(merge3(["a"], ["a", "x", "m"], ["a", "x"])).toEqual(["a", "x", "m"]);
    const once = merge3(["a", "b"], ["b", "m"], ["a", "b", "t"]);
    expect(merge3(["a", "b"], ["b", "m"], once)).toEqual(once);
    /* A reorder only theirs made is kept; mine's additions follow it. */
    expect(merge3(["a", "b", "c"], ["a", "b", "c", "m"], ["c", "a", "b"])).toEqual(["c", "a", "b", "m"]);
    /* Theirs moved only what mine removed: what theirs put in stays where it put it (before a) — and merging again agrees. */
    const edge = merge3(["a", "b"], ["a", "m"], ["b", "t", "a"]);
    expect(edge).toEqual(["t", "a", "m"]);
    expect(merge3(["a", "b"], ["a", "m"], edge)).toEqual(edge);
  });

  test("two windows each connecting an input to the same shot keep both links", () => {
    const base = project();
    const mine = clone(base); mine.nodes.push(node("m-in", { type: "media" })); mine.nodes[0].linked = ["m-in"];
    const theirs = clone(base); theirs.nodes.push(node("t-in", { type: "media" })); theirs.nodes[0].linked = ["t-in"];
    const merged = merge3(base, mine, theirs);
    expect(merged.nodes[0].linked).toEqual(["m-in", "t-in"]);
    expect(ids(merged.nodes)).toEqual(["n1", "n2", "m-in", "t-in"]);
  });

  test("an undefined key is an absent key (the draft as JSON)", () => {
    expect(sameJson({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(sameJson({ a: 1 }, { a: 1, b: undefined })).toBe(true);
    expect(sameJson({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameJson([1, undefined], [1, null])).toBe(true);
    expect(sameJson({ b: 1, a: 2 }, { a: 2, b: 1 })).toBe(true);
    /* Mine cleared a key that theirs left alone: it stays cleared. */
    expect(merge3({ a: 1, b: 2 }, { a: 1, b: undefined }, { a: 5, b: 2 })).toEqual({ a: 5 });
  });
});

test.describe("objects", () => {
  test("keys merge one by one; each side's new keys are kept", () => {
    expect(merge3({ a: 1, b: 1 }, { a: 2, b: 1, m: true }, { a: 1, b: 3, t: true })).toEqual({ a: 2, b: 3, m: true, t: true });
  });

  test("a key deleted by one side goes only if the other left it unchanged", () => {
    expect(merge3({ a: 1, b: 1 }, { a: 1 }, { a: 2, b: 1 })).toEqual({ a: 2 });
    expect(merge3({ a: 1, b: 1 }, { a: 2, b: 1 }, { a: 1 })).toEqual({ a: 2 });
    /* Deleted on one side, changed on the other: the change is kept. */
    expect(merge3({ a: 1, b: 1 }, { a: 1 }, { a: 1, b: 9 })).toEqual({ a: 1, b: 9 });
    expect(merge3({ a: 1, b: 1 }, { a: 1, b: 9 }, { a: 1 })).toEqual({ a: 1, b: 9 });
    /* Deleted on both sides. */
    expect(merge3({ a: 1, b: 1 }, { a: 2 }, { a: 1, c: 3 })).toEqual({ a: 2, c: 3 });
  });

  test("nested objects merge all the way down", () => {
    const base = { production: { cast: { entries: [entry("c1", "Mara")], agentJobId: "j1" }, beats: { updatedAt: "t0", scenes: [] as { id: string }[] } } };
    const mine = clone(base); mine.production.cast.agentJobId = "j2";
    const theirs = clone(base); theirs.production.beats.updatedAt = "t1"; theirs.production.beats.scenes.push({ id: "s1" });
    expect(merge3(base, mine, theirs)).toEqual({ production: { cast: { entries: [entry("c1", "Mara")], agentJobId: "j2" }, beats: { updatedAt: "t1", scenes: [{ id: "s1" }] } } });
  });

  test("a key both sides added merges as if its base were empty", () => {
    expect(merge3<Record<string, unknown>>({}, { x: { a: 1, list: [{ id: "m" }] } }, { x: { b: 2, list: [{ id: "t" }] } }))
      .toEqual({ x: { a: 1, b: 2, list: [{ id: "m" }, { id: "t" }] } });
  });
});

test.describe("lists of records merge by id", () => {
  test("a Rig node edit and a new Cast entry, saved from two editors, are both kept", () => {
    const base = project();
    const rig = clone(base); rig.nodes[0].text = "A fox crosses the ice";
    const cast = clone(base); cast.production!.cast!.entries.push(entry("cast-2", "Tom"));
    for (const [mine, theirs] of [[rig, cast], [cast, rig]]) {
      const merged = merge3(base, mine, theirs);
      expect(merged.nodes[0].text).toBe("A fox crosses the ice");
      expect(merged.production!.cast!.entries.map((e) => e.name)).toEqual(["Mara", "Tom"]);
    }
  });

  test("both sides add different ids: each addition stays where its side put it; at one place, mine's first", () => {
    const base = project();
    const mine = clone(base); mine.nodes.push(node("m1"), node("m2"));
    const theirs = clone(base); theirs.nodes.unshift(node("t1")); theirs.nodes.push(node("t2"));
    expect(ids(merge3(base, mine, theirs).nodes)).toEqual(["t1", "n1", "n2", "m1", "m2", "t2"]);
  });

  test("a move made by mine keeps mine's order; theirs' edits to the moved records still join", () => {
    const base = project((p) => { p.nodes.push(node("n3")); });
    const mine = clone(base); mine.nodes.reverse();
    const theirs = clone(base); theirs.nodes[1] = { ...theirs.nodes[1], title: "Renamed" };
    const merged = merge3(base, mine, theirs);
    expect(ids(merged.nodes)).toEqual(["n3", "n2", "n1"]);
    expect(merged.nodes[1].title).toBe("Renamed");
  });

  test("a move made only by theirs is kept; what both added at the end follows, mine's first", () => {
    const base = project((p) => { p.nodes.push(node("n3")); });
    const mine = clone(base); mine.nodes[1] = { ...mine.nodes[1], title: "Edited here" }; mine.nodes.push(node("m1"));
    const theirs = clone(base); theirs.nodes = [theirs.nodes[2], theirs.nodes[0], theirs.nodes[1], node("t1")];
    const merged = merge3(base, mine, theirs);
    expect(ids(merged.nodes)).toEqual(["n3", "n1", "n2", "m1", "t1"]);
    expect(merged.nodes.find((n) => n.id === "n2")?.title).toBe("Edited here");
    expect(merge3(base, mine, merged)).toEqual(merged);
  });

  test("both sides moved records: each side's move stands, mine's where they cross; nothing is lost", () => {
    const base = project((p) => { p.nodes.push(node("n3")); });
    /* Mine puts Second before Opening; theirs puts n3 first. */
    const mine = clone(base); mine.nodes = [mine.nodes[1], mine.nodes[0], mine.nodes[2]];
    const theirs = clone(base); theirs.nodes = [theirs.nodes[2], theirs.nodes[0], theirs.nodes[1]];
    const merged = merge3(base, mine, theirs);
    expect(ids(merged.nodes)).toEqual(["n3", "n2", "n1"]);
    expect(merge3(base, mine, merged)).toEqual(merged);
    /* Both move n1, to different places: mine's place. */
    const here = clone(base); here.nodes = [here.nodes[1], here.nodes[2], here.nodes[0]];
    const there = clone(base); there.nodes = [there.nodes[1], there.nodes[0], there.nodes[2]];
    expect(ids(merge3(base, here, there).nodes)).toEqual(["n2", "n3", "n1"]);
  });

  test("the same record changed on both sides: its fields merge, and a field both changed keeps mine", () => {
    const base = project();
    const mine = clone(base); mine.nodes[0] = { ...mine.nodes[0], title: "Mine", x: 40 };
    const theirs = clone(base); theirs.nodes[0] = { ...theirs.nodes[0], title: "Theirs", y: 90, linked: ["n2"] };
    const merged = merge3(base, mine, theirs);
    expect(merged.nodes[0]).toMatchObject({ id: "n1", title: "Mine", x: 40, y: 90, linked: ["n2"] });
    expect(ids(merged.nodes)).toEqual(["n1", "n2"]);
  });

  test("a record deleted on one side and changed on the other is kept, changed", () => {
    const base = project();
    const deleted = clone(base); deleted.nodes = deleted.nodes.filter((n) => n.id !== "n2");
    const changed = clone(base); changed.nodes[1] = { ...changed.nodes[1], title: "Still here" };
    expect(merge3(base, deleted, changed).nodes.find((n) => n.id === "n2")?.title).toBe("Still here");
    expect(merge3(base, changed, deleted).nodes.find((n) => n.id === "n2")?.title).toBe("Still here");
  });

  test("a record deleted on one side and untouched on the other is deleted", () => {
    const base = project();
    const deleted = clone(base); deleted.nodes = deleted.nodes.filter((n) => n.id !== "n2");
    const other = clone(base); other.brief = "Another edit";
    expect(ids(merge3(base, deleted, other).nodes)).toEqual(["n1"]);
    expect(ids(merge3(base, other, deleted).nodes)).toEqual(["n1"]);
    expect(merge3(base, other, deleted).brief).toBe("Another edit");
  });

  test("both sides adding the same id make one record", () => {
    const base = project();
    const mine = clone(base); mine.nodes.push(node("x", { title: "Mine", text: "from mine" }));
    const theirs = clone(base); theirs.nodes.push(node("x", { title: "Theirs", role: "Editor" }));
    const merged = merge3(base, mine, theirs);
    expect(ids(merged.nodes)).toEqual(["n1", "n2", "x"]);
    /* No base for it: what each side alone set is kept, and a field both set keeps mine. */
    expect(merged.nodes[2]).toMatchObject({ title: "Mine", text: "from mine", role: "Editor" });
  });

  test("a merge never makes a repeat, and never collapses one a side holds", () => {
    const base = project();
    /* Both add one id: one record. */
    const mine = clone(base); mine.nodes.push(node("x"));
    const theirs = clone(base); theirs.nodes.push(node("x"), node("t1"));
    expect(ids(merge3(base, mine, theirs).nodes)).toEqual(["n1", "n2", "x", "t1"]);
    /* A draft holding two assets under one id (saveable; export asks to resolve it): the n-th pairs with the n-th, both stay. */
    const asset = (id: string, url: string) => ({ id, name: id, kind: "image", category: "Reference", url, description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [] }) as Asset;
    const twice = project((p) => { p.assets = [asset("dup", "/v1.png"), asset("dup", "/v2.png")]; });
    const here = clone(twice); here.assets.push(asset("mine-upload", "/m.png")); here.assets[1] = { ...here.assets[1], name: "v2, renamed" };
    const there = clone(twice); there.assets.push(asset("their-upload", "/t.png"));
    const merged = mergeDraft(twice, here, there);
    expect(merged.assets.map((a) => `${a.id}@${a.url}`)).toEqual(["dup@/v1.png", "dup@/v2.png", "mine-upload@/m.png", "their-upload@/t.png"]);
    expect(merged.assets[1].name).toBe("v2, renamed");
    expect(merge3(twice, here, merged)).toEqual(merged);
  });

  test("takes key by genId, pending renders by jobId, plates by assetId", () => {
    const takes = { entries: [{ ...entry("c1", "Mara"), takes: [{ genId: "g0", at: "t0" }] }] };
    const mine = clone(takes); mine.entries[0].takes.unshift({ genId: "g1", at: "t1" });
    const theirs = clone(takes); theirs.entries[0].takes.unshift({ genId: "g2", at: "t2" });
    /* Newest first: both windows' new takes lead, mine's first — neither is taken for the oldest. */
    expect(merge3(takes, mine, theirs).entries[0].takes.map((t) => t.genId)).toEqual(["g1", "g2", "g0"]);
    /* The same take filed by two windows is one take. */
    const same = clone(takes); same.entries[0].takes.unshift({ genId: "g1", at: "t9" });
    expect(merge3(takes, mine, same).entries[0].takes.map((t) => t.genId)).toEqual(["g1", "g0"]);

    const pending = { pending: [{ jobId: "j0", at: "t0" }] };
    expect(merge3(pending, { pending: [] }, { pending: [{ jobId: "j0", at: "t0" }, { jobId: "j1", at: "t1" }] })).toEqual({ pending: [{ jobId: "j1", at: "t1" }] });

    const plates = { plates: [{ assetId: "a0", at: "t0", source: "render" }] };
    expect(merge3(plates, { plates: [{ assetId: "a1", at: "t1", source: "upload" }, ...plates.plates] }, { plates: [...plates.plates, { assetId: "a2", at: "t2", source: "render" }] }).plates.map((x) => x.assetId))
      .toEqual(["a1", "a0", "a2"]);
  });

  test("a secondary key that repeats within a side is not an identity: the list merges as a sequence", () => {
    const base = { layers: [{ assetId: "a", x: 0 }] };
    const mine = { layers: [{ assetId: "a", x: 0 }, { assetId: "a", x: 5 }] };
    const theirs = { layers: [{ assetId: "a", x: 9 }] };
    /* Theirs moved the layer, mine added a second one: both. */
    expect(merge3(base, mine, theirs)).toEqual({ layers: [{ assetId: "a", x: 9 }, { assetId: "a", x: 5 }] });
  });
});

test.describe("guarantees", () => {
  test("merging again with the result changes nothing (a lost reply is safe to reconcile)", () => {
    const base = project();
    const mine = clone(base); mine.nodes.push(node("m1")); mine.nodes[0].title = "Mine"; mine.production!.cast!.entries.push(entry("cast-m", "Ines"));
    const theirs = clone(base); theirs.nodes.push(node("t1")); theirs.nodes = theirs.nodes.filter((n) => n.id !== "n2"); theirs.brief = "Theirs";
    const once = merge3(base, mine, theirs);
    expect(merge3(base, mine, once)).toEqual(once);
    /* Our save landed, then another save built on it: merging over that adds nothing twice. */
    const onTop = clone(once); onTop.nodes.push(node("later")); onTop.production!.cast!.entries[0].name = "Mara Vey";
    const again = merge3(base, mine, onTop);
    expect(ids(again.nodes)).toEqual(ids(onTop.nodes));
    expect(again.production!.cast!.entries.map((e) => e.id)).toEqual(onTop.production!.cast!.entries.map((e) => e.id));
    expect(again.production!.cast!.entries[0].name).toBe("Mara Vey");
  });

  test("rebaseDraft: no edits in flight gives exactly what was saved; edits in flight are laid over it", () => {
    const sent = project();
    const saved = { ...sent, productionProjectId: "prj_1", shotMappings: { n1: "shot_1" } };
    expect(rebaseDraft(sent, sent, saved)).toBe(saved);
    const local = { ...sent, brief: "Typed while saving", nodes: [...sent.nodes, node("n3")] };
    const next = rebaseDraft(sent, local, saved);
    expect(next).toMatchObject({ brief: "Typed while saving", productionProjectId: "prj_1", shotMappings: { n1: "shot_1" } });
    expect(ids(next.nodes)).toEqual(["n1", "n2", "n3"]);
  });

  /* A seeded walk over random edits on both sides: every invariant, every time. */
  test("random edits on both sides: nothing added or changed is lost, deletions hold, no id doubles, merging is idempotent", () => {
    let seed = 0x9e3779b9;
    const random = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const pick = <T,>(list: T[]) => list[Math.floor(random() * list.length)];
    let fresh = 0;
    type Side = { project: Project; added: Set<string>; deleted: Set<string>; changed: Set<string> };
    const edit = (base: Project, tag: string): Side => {
      const p = clone(base), side: Side = { project: p, added: new Set(), deleted: new Set(), changed: new Set() };
      for (let i = 0, n = 1 + Math.floor(random() * 4); i < n; i++) {
        const live = p.nodes.filter((x) => !side.added.has(x.id));
        const roll = random();
        if (roll < 0.3 || !live.length) { const id = `${tag}-${fresh++}`; p.nodes.push(node(id, { title: id })); side.added.add(id); }
        else if (roll < 0.5) { const target = pick(live); p.nodes = p.nodes.filter((x) => x.id !== target.id); side.deleted.add(target.id); side.changed.delete(target.id); }
        else if (roll < 0.65 && p.nodes.length > 1) { const target = pick(p.nodes); p.nodes = p.nodes.filter((x) => x !== target); p.nodes.splice(Math.floor(random() * (p.nodes.length + 1)), 0, target); }
        else if (roll < 0.85) { const target = pick(live); if (!side.deleted.has(target.id)) { Object.assign(target, { title: `${tag} ${fresh++}` }); side.changed.add(target.id); } }
        else p.brief = `${tag} brief ${fresh++}`;
      }
      return side;
    };
    for (let round = 0; round < 600; round++) {
      const base = project((p) => { p.nodes = Array.from({ length: 1 + Math.floor(random() * 6) }, (_, i) => node(`b${i}`)); });
      const mine = edit(base, "m"), theirs = edit(base, "t");
      const merged = merge3(base, mine.project, theirs.project);
      const got = new Map(merged.nodes.map((x) => [x.id, x]));
      expect(duplicates(ids(merged.nodes))).toEqual([]);
      for (const side of [mine, theirs]) {
        const other = side === mine ? theirs : mine;
        for (const id of side.added) expect(got.has(id), `round ${round}: ${id} added`).toBe(true);
        for (const id of side.changed) {
          expect(got.has(id), `round ${round}: ${id} changed, never dropped`).toBe(true);
          if (!other.changed.has(id)) expect(got.get(id)!.title).toBe(side.project.nodes.find((x) => x.id === id)!.title);
        }
        for (const id of side.deleted) if (!other.changed.has(id)) expect(got.has(id), `round ${round}: ${id} deleted`).toBe(false);
      }
      for (const id of mine.changed) if (theirs.changed.has(id)) expect(got.get(id)!.title).toBe(mine.project.nodes.find((x) => x.id === id)!.title);
      /* Order of what both still hold: the one side's that moved it; base's when neither did (both: checked by merging again). */
      const was = ids(base.nodes), m = ids(mine.project.nodes), t = ids(theirs.project.nodes);
      const shared = was.filter((id) => m.includes(id) && t.includes(id));
      const mineMoved = m.filter((id) => shared.includes(id)).join() !== shared.join();
      const theirsMoved = t.filter((id) => shared.includes(id)).join() !== shared.join();
      if (!(mineMoved && theirsMoved)) expect(ids(merged.nodes).filter((id) => shared.includes(id)), `round ${round}: order`).toEqual((theirsMoved ? t : m).filter((id) => shared.includes(id)));
      expect(merge3(base, mine.project, merged), `round ${round}: idempotent`).toEqual(merged);
    }
  });

  test("random edits to lists of distinct strings: additions kept, removals hold, no repeats, idempotent", () => {
    let seed = 0x2545f491;
    const random = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    let fresh = 0;
    const edit = (base: string[], tag: string) => {
      const list = [...base], added = new Set<string>(), removed = new Set<string>();
      for (let i = 0, n = 1 + Math.floor(random() * 4); i < n; i++) {
        const roll = random();
        if (roll < 0.35 || !list.length) { const item = `${tag}${fresh++}`; list.splice(Math.floor(random() * (list.length + 1)), 0, item); added.add(item); }
        else if (roll < 0.65) { const [item] = list.splice(Math.floor(random() * list.length), 1); if (added.has(item)) added.delete(item); else removed.add(item); }
        else { const [item] = list.splice(Math.floor(random() * list.length), 1); list.splice(Math.floor(random() * (list.length + 1)), 0, item); }
      }
      return { list, added, removed };
    };
    for (let round = 0; round < 400; round++) {
      const base = Array.from({ length: Math.floor(random() * 6) }, (_, i) => `b${i}`);
      const mine = edit(base, "m"), theirs = edit(base, "t");
      const merged = merge3(base, mine.list, theirs.list);
      expect(duplicates(merged), `round ${round}`).toEqual([]);
      for (const side of [mine, theirs]) {
        for (const item of side.added) expect(merged, `round ${round}: ${item} added`).toContain(item);
        for (const item of side.removed) expect(merged, `round ${round}: ${item} removed`).not.toContain(item);
      }
      for (const item of base) if (!mine.removed.has(item) && !theirs.removed.has(item)) expect(merged, `round ${round}: ${item} kept`).toContain(item);
      expect(merge3(base, mine.list, merged), `round ${round}: idempotent`).toEqual(merged);
    }
  });
});

/* ── Folded from the break hunts of 26 September: each is a case a merge once got wrong. ── */

test.describe("sequences, text and keys", () => {
  test("keyframes added in two windows: both windows' keyframes are kept, in frame order", () => {
    const key = (frame: number, x = 0) => ({ frame, position: [x, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
    expect(merge3({ keyframes: [key(1)] }, { keyframes: [key(1), key(24)] }, { keyframes: [key(1), key(48)] }).keyframes.map((k) => k.frame)).toEqual([1, 24, 48]);
    expect(merge3({ keyframes: [key(1)] }, { keyframes: [key(1), key(48)] }, { keyframes: [key(1), key(24)] }).keyframes.map((k) => k.frame)).toEqual([1, 24, 48]);
    /* The same frame keyed in both: one keyframe, mine. */
    expect(merge3({ keyframes: [key(1)] }, { keyframes: [key(1), key(24, 5)] }, { keyframes: [key(1), key(24, 9)] }).keyframes).toEqual([key(1), key(24, 5)]);
  });

  test("a screenplay typed in two windows, in different scenes: both scenes are kept", () => {
    const base = { ...newProject("Script"), script: "INT. HARBOUR - DUSK\n\nIce.\n\nEXT. LIGHTHOUSE - NIGHT\n\nWind.\n" };
    const mine = { ...base, script: base.script.replace("Ice.", "Ice. A fox crosses.") };
    const theirs = { ...base, script: base.script.replace("Wind.", "Wind. The lamp turns.") };
    expect(merge3(base, mine, theirs).script).toBe("INT. HARBOUR - DUSK\n\nIce. A fox crosses.\n\nEXT. LIGHTHOUSE - NIGHT\n\nWind. The lamp turns.\n");
    /* The same line rewritten in both: mine's line. */
    const clash = { ...base, script: base.script.replace("Ice.", "Ice cracks.") };
    expect(merge3(base, mine, clash).script).toBe(mine.script);
  });

  test("two windows rewriting the same marketing hook keep twelve hooks: mine's rewrite", () => {
    const hooks = Array.from({ length: 12 }, (_, i) => `Hook ${i}`);
    const sharper = [...hooks], shorter = [...hooks];
    sharper[3] = "Hook 3, sharper";
    shorter[3] = "Hook 3, shorter";
    expect(merge3(hooks, sharper, shorter)).toEqual(sharper);
  });

  test("a key named __proto__ that one side added is data: it survives the merge, and nothing's prototype changes", () => {
    const base = JSON.parse('{"scriptReviews": {}}');
    const mine = JSON.parse('{"scriptReviews": {"__proto__": {"sourceKey": "k", "intent": "Mine", "beats": []}}}');
    const theirs = JSON.parse('{"scriptReviews": {"scene-2": {"sourceKey": "k", "intent": "Theirs", "beats": []}}}');
    const merged = merge3(base, mine, theirs) as { scriptReviews: Record<string, unknown> };
    expect(Object.keys(merged.scriptReviews).sort()).toEqual(["__proto__", "scene-2"]);
    expect(Object.getPrototypeOf(merged.scriptReviews)).toBe(Object.prototype);
  });
});

test.describe("a merge of two valid saves is a valid save (mergeDraft)", () => {
  const image = (id: string): Asset => ({ id, name: id, kind: "image", category: "Reference", url: `/api/uploads/${id}`, description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [] });
  const at = "2026-09-26T00:00:00.000Z";
  const valid = (p: Project) => saveSchema.safeParse({ project: p, revision: 1 }).success;
  function place(references: number, plates: number, pending: string[] = []): Project {
    const p = project();
    p.assets = Array.from({ length: Math.max(references, plates) + 4 }, (_, i) => image(`a${i}`));
    p.production = { environment: { world: "", model: "gemini-3.1-flash-image", entries: [{
      id: "env-1", name: "Harbour", notes: "", prompt: "",
      references: p.assets.slice(0, references).map((a) => a.id),
      plates: p.assets.slice(0, plates).map((a) => ({ assetId: a.id, at, source: "render" as const })),
      ...(pending.length ? { pending: pending.map((jobId) => ({ jobId, at })) } : {}),
    }] } };
    return p;
  }
  const env = (p: Project) => p.production!.environment!.entries[0];

  test("each window adds a reference to a place holding five of six: the saved one's stands, the merge saves", () => {
    const base = place(5, 0);
    const mine = clone(base); mine.assets.push(image("mine-ref")); env(mine).references.push("mine-ref");
    const theirs = clone(base); theirs.assets.push(image("their-ref")); env(theirs).references.push("their-ref");
    const merged = mergeDraft(base, mine, theirs);
    expect(valid(merged)).toBe(true);
    /* What the saved version had first, as the stage's own add would have left it; the upload itself stays in the library. */
    expect(env(merged).references).toEqual([...env(base).references, "their-ref"]);
    expect(merged.assets.map((a) => a.id)).toEqual(expect.arrayContaining(["mine-ref", "their-ref"]));
  });

  test("each window files a plate on a place holding thirty: both new plates, the oldest trimmed", () => {
    const base = place(0, 30);
    const file = (p: Project, id: string) => { p.assets.push(image(id)); env(p).plates = [{ assetId: id, at, source: "render" as const }, ...env(p).plates].slice(0, 30); };
    const mine = clone(base); file(mine, "mine-plate");
    const theirs = clone(base); file(theirs, "their-plate");
    const merged = mergeDraft(base, mine, theirs);
    expect(valid(merged)).toBe(true);
    expect(env(merged).plates.map((x) => x.assetId).slice(0, 2)).toEqual(["mine-plate", "their-plate"]);
    expect(env(merged).plates).toHaveLength(30);
  });

  test("each window queues renders on one place: the latest five in flight, as the stage keeps them", () => {
    const base = place(0, 0, ["job-0", "job-1"]);
    const mine = clone(base); env(mine).pending!.push({ jobId: "job-a", at }, { jobId: "job-b", at });
    const theirs = clone(base); env(theirs).pending!.push({ jobId: "job-c", at }, { jobId: "job-d", at });
    const merged = mergeDraft(base, mine, theirs);
    expect(valid(merged)).toBe(true);
    expect(env(merged).pending!.map((x) => x.jobId)).toEqual(["job-1", "job-c", "job-d", "job-a", "job-b"]);
  });

  test("each window files a take on a character holding twenty: both new takes, the oldest trimmed", () => {
    const base = project((p) => { p.production = { cast: { entries: [{ ...entry("cast-1", "Mara"), takes: Array.from({ length: 20 }, (_, i) => ({ genId: `g${i}`, at })) }] } }; });
    const file = (p: Project, genId: string) => { const e = p.production!.cast!.entries[0]; e.takes = [{ genId, at }, ...e.takes].slice(0, 20); e.selected = genId; };
    const mine = clone(base); file(mine, "g-mine");
    const theirs = clone(base); file(theirs, "g-theirs");
    const merged = mergeDraft(base, mine, theirs);
    expect(valid(merged)).toBe(true);
    expect(merged.production!.cast!.entries[0].takes.slice(0, 2).map((t) => t.genId)).toEqual(["g-mine", "g-theirs"]);
  });
});

test.describe("links after a merge (mergeDraft)", () => {
  function graph(): Project {
    return project((p) => {
      p.nodes = [node("n1", { title: "Opening" }), node("m1", { type: "media", title: "Plate", assetId: "a1" }), node("n2", { title: "Second", linked: ["m1"] }), node("g1", { type: "grade", title: "Warm grade" })];
      p.assets = [{ id: "a1", name: "plate.png", kind: "image", url: "/x.png", category: "Shot", description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [] }];
    });
  }
  const dangling = (p: Project) => { const known = new Set(ids(p.nodes)); return p.nodes.flatMap((n) => n.linked.filter((id) => !known.has(id)).map((id) => `${n.id} -> ${id}`)); };
  const wire = (p: Project, from: string, to: string) => { const out = connectNodes(clone(p), from, to); if ("error" in out) throw new Error(out.error); return out.project; };

  test("mine wires Opening into a grade, theirs deleted Opening: the wire goes with it, and the grade takes another input", () => {
    const base = graph();
    const merged = mergeDraft(base, wire(base, "n1", "g1"), removeShots(clone(base), ["n1"]).project);
    expect(dangling(merged)).toEqual([]);
    expect(ids(merged.nodes)).not.toContain("n1");
    expect(graphEdges(merged.nodes).filter((e) => e.target === "g1")).toEqual([]);
    expect(canConnect(merged.nodes, "n2", "g1")).toBeNull();
  });

  test("theirs wires a plate into another shot, mine deleted the shot it fed (and so the plate): the plate stays, wired", () => {
    const base = graph();
    const mine = removeShots(clone(base), ["n2"]).project;
    expect(ids(mine.nodes)).not.toContain("m1");
    const merged = mergeDraft(base, mine, wire(base, "m1", "n1"));
    expect(merged.nodes.find((n) => n.id === "n1")?.linked).toEqual(["m1"]);
    expect(ids(merged.nodes)).toContain("m1");
    expect(dangling(merged)).toEqual([]);
  });
});

test.describe("what two windows make at once is made once", () => {
  test("a shot's first direction note typed in two windows is one direction operation", () => {
    const base = project((p) => { p.nodes = [node("n1", { title: "Opening", type: "scene" })]; });
    const mine = shotPatch(clone(base), "n1", { note: "Note typed in the Rig" });
    const theirs = shotPatch(clone(base), "n1", { note: "Note typed in another window" });
    const directions = (merge3(base, mine, theirs).nodes[0].operations ?? []).filter((op) => op.kind === "direction");
    expect(directions.map((op) => op.values.note)).toEqual(["Note typed in the Rig"]);
  });

  test("a sound lane made in two windows is one lane; a locked lane gets a new one beside it", () => {
    const base = project();
    const merged = merge3(base, { ...base, nodes: [...base.nodes, createSoundNode(base, "music")] }, { ...base, nodes: [...base.nodes, createSoundNode(base, "music")] });
    expect(merged.nodes.filter((n) => n.role === findSoundNode(merged, "music")?.role)).toHaveLength(1);
    const locked = { ...merged, nodes: merged.nodes.map((n) => (n.type === "audio" ? { ...n, locked: true } : n)) };
    expect(createSoundNode(locked, "music").id).not.toBe(findSoundNode(merged, "music")!.id);
  });

  test("two tabs taking one agent run's places, or one breakdown, hold each once", () => {
    const base = project((p) => { p.production = { environment: { world: "", model: "gemini-3.1-flash-image", entries: [] } }; });
    const take = (p: Project) => { const out = clone(p); out.production!.environment!.entries = ["Harbour", "Lighthouse", "Fish market"].map((name) => newEnvironmentEntry(name, "", "", sourcedPlaceId("wb_development_job-1", name))); out.production!.environment!.agentJobId = "wb_development_job-1"; return out; };
    const merged = merge3(base, take(base), take(base));
    expect(merged.production!.environment!.entries.map((e) => e.name)).toEqual(["Harbour", "Lighthouse", "Fish market"]);
    const scenes = [{ heading: "INT. HARBOUR", summary: "", beats: ["Ice."], shots: [], characters: [], locations: [], props: [] }] as unknown as Parameters<typeof beatSheetFrom>[0];
    const a = beatSheetFrom(scenes, "0".repeat(64), "wb_development_job-2"), b = beatSheetFrom(scenes, "0".repeat(64), "wb_development_job-2");
    const sheets = merge3<Project>(project(), { ...project(), production: { beats: a } }, { ...project(), production: { beats: { ...b, updatedAt: "2026-09-26T01:00:00.000Z" } } });
    expect(sheets.production!.beats!.scenes).toHaveLength(1);
    expect(sheets.production!.beats!.scenes[0].beats).toHaveLength(1);
  });
});

test.describe("an undo that puts back a shot another window changed since", () => {
  test("the shot merges from what it was when deleted: the other window's edit stands, once", () => {
    const opening = node("n1", { title: "Opening", operations: [{ id: "op1", kind: "direction", enabled: true, values: { note: "Original note" } }] });
    const before = project((p) => { p.nodes = [opening, node("n2")]; });
    const deleted = removeShots(clone(before), ["n1"]);
    /* Another window still held Opening, changed its note, and its merge kept the change: the server has Opening back. */
    const theirs = { ...deleted.project, nodes: [{ ...opening, operations: [{ id: "op1", kind: "direction" as const, enabled: true, values: { note: "Teammate note" } }] }, ...deleted.project.nodes] };
    const mine = restoreShots(clone(deleted.project), deleted.removed);
    const ancestors = new Map(deleted.removed.removed.map((n) => [n.id, n]));
    const merged = mergeDraft(deleted.project, mine, theirs, { ancestors });
    expect(duplicates(ids(merged.nodes))).toEqual([]);
    expect(merged.nodes.find((n) => n.id === "n1")?.operations?.[0].values.note).toBe("Teammate note");
    /* Without an ancestor it would be two unrelated additions, mine winning field by field. */
    expect(mergeDraft(deleted.project, mine, theirs).nodes.find((n) => n.id === "n1")?.operations?.[0].values.note).toBe("Original note");
  });
});

/**
 * A revision-checked server that records each tagged save under its writer and
 * answers `check-write` (lib/workbench/records.ts); `afterLanding` runs once,
 * right after the first PUT lands: another window saves on top of it. `offline`
 * drops every request.
 */
function tagServer(start: Project, afterLanding?: (landed: Project) => Project) {
  const state = { project: start, revision: 1, offline: false, dropFirst: true, calls: [] as string[], writes: new Map<string, { seq: number; revision: number | null }>() };
  globalThis.fetch = async (_url, init) => {
    const method = init?.method ?? "GET";
    state.calls.push(method);
    if (state.offline) throw new TypeError("Failed to fetch");
    if (method === "PUT") {
      const body = JSON.parse(String(init?.body)) as { project: Project; revision: number; write?: { writer: string; seq: number } };
      const seen = body.write ? state.writes.get(body.write.writer) : undefined;
      if (body.revision !== state.revision || (seen && seen.seq >= body.write!.seq)) return reply({ error: "This project changed in another window.", code: "revision_conflict" }, 409);
      state.project = { ...body.project, productionProjectId: "production", shotMappings: {} };
      state.revision += 1;
      if (body.write) state.writes.set(body.write.writer, { seq: body.write.seq, revision: state.revision });
      if (state.dropFirst) {
        state.dropFirst = false;
        if (afterLanding) { state.project = { ...afterLanding(structuredClone(state.project)), productionProjectId: "production", shotMappings: {} }; state.revision += 1; }
        else state.offline = true;
        throw new TypeError("Failed to fetch");
      }
      return reply({ revision: state.revision, productionProjectId: "production", shotMappings: {} });
    }
    if (method === "POST") {
      const { write } = JSON.parse(String(init?.body)) as { write: { writer: string; seq: number } };
      const row = state.writes.get(write.writer);
      const landed = row && row.seq === write.seq && row.revision !== null ? row.revision : null;
      if (landed === null && (!row || row.seq < write.seq)) state.writes.set(write.writer, { seq: write.seq, revision: null });
      return reply({ landed, project: state.project, revision: state.revision });
    }
    return reply({ project: state.project, revision: state.revision });
  };
  return state;
}
const nativeFetch = globalThis.fetch;
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

test.describe("a save whose reply was lost (writeMergedDraft)", () => {
  test.afterEach(() => { globalThis.fetch = nativeFetch; });

  test("it landed and another window built on it: what that window did stands — a rewrite, a rename, a delete", async () => {
    const base = project((p) => { p.brief = "Original brief"; p.nodes = [node("n1")]; });
    const cases: [Project, (landed: Project) => Project, (saved: Project) => unknown, unknown][] = [
      [{ ...base, brief: "Brief typed here" }, (landed) => ({ ...landed, brief: "Rewritten after reading it" }), (saved) => saved.brief, "Rewritten after reading it"],
      [{ ...base, nodes: [...base.nodes, node("m1", { title: "Added here" })] }, (landed) => ({ ...landed, nodes: landed.nodes.map((n) => (n.id === "m1" ? { ...n, title: "Renamed there" } : n)) }), (saved) => saved.nodes.find((n) => n.id === "m1")?.title, "Renamed there"],
      [{ ...base, nodes: [...base.nodes, node("m1")] }, (landed) => ({ ...landed, nodes: landed.nodes.filter((n) => n.id !== "m1") }), (saved) => ids(saved.nodes), ["n1"]],
    ];
    for (const [mine, onTop, read, expected] of cases) {
      const state = tagServer(base, onTop);
      const saved = await writeMergedDraft("/api/workbench", "scope", { base, mine, revision: 1, writer: draftWriter() });
      expect(read(state.project), state.calls.join(",")).toEqual(expected);
      expect(read(saved.project)).toEqual(expected);
      /* Checked, never sent again. */
      expect(state.calls).toEqual(["PUT", "POST"]);
    }
  });

  test("it landed but the check was lost too: what is changed back meanwhile (an undo, a cleared field) is saved as such", async () => {
    const base = project((p) => { p.brief = ""; p.nodes = [node("n1"), node("keep-me", { title: "A shot the team made" })]; });
    const cases: [Project, Project, (p: Project) => unknown, unknown][] = [
      /* Typed, then cleared. */
      [{ ...base, brief: "Typed" }, base, (p) => p.brief, ""],
      /* Added, then removed again (and something else edited). */
      [{ ...base, nodes: [...base.nodes, node("oops")] }, { ...base, brief: "Next edit" }, (p) => ids(p.nodes), ["n1", "keep-me"]],
      /* Deleted, then brought back with ⌘Z. */
      [{ ...base, nodes: [node("n1")] }, { ...base, brief: "Next edit" }, (p) => ids(p.nodes), ["n1", "keep-me"]],
    ];
    for (const [first, then, read, expected] of cases) {
      const state = tagServer(base);
      const writer = draftWriter();
      await expect(writeMergedDraft("/api/workbench", "scope", { base, mine: first, revision: 1, writer })).rejects.toMatchObject({ uncertain: true });
      expect(writer.unconfirmed).not.toBeNull();
      state.offline = false;
      /* The editor still holds the pre-save base; its writer settles the lost save first. */
      const saved = await writeMergedDraft("/api/workbench", "scope", { base, mine: then, revision: 1, writer });
      expect(read(saved.project)).toEqual(expected);
      expect(read(state.project)).toEqual(expected);
      expect(writer.unconfirmed).toBeNull();
    }
  });
});

test.describe("the team canvas follows an edit field by field", () => {
  test("a merge that brings in another window's title never puts a stale prompt over a teammate's", () => {
    const opening = node("n1", { title: "Opening", text: "Original prompt" });
    let canvas = applyTeamPatch(emptyTeamCanvas(), { upsertNodes: [opening, node("n2")], removeNodes: [], upsertAssets: [], order: null, at: 1 });
    /* A teammate's whole-node edit, as the route takes it: it overwrites. */
    canvas = applyTeamPatch(canvas, { upsertNodes: [{ ...opening, text: "Teammate prompt" }], removeNodes: [], upsertAssets: [], order: null, at: 2 });
    const before = project((p) => { p.nodes = [opening, node("n2")]; });
    const after = { ...before, nodes: [{ ...opening, title: "Opening (retitled)" }, node("n2")] };
    const patch = diffForTeam(before, after, 3)!;
    expect(patch.fields).toEqual({ n1: ["title"] });
    expect(applyTeamPatch(canvas, patch).nodes.n1).toMatchObject({ title: "Opening (retitled)", text: "Teammate prompt" });
  });

  test("a shot an undo puts back joins the canvas, unless a teammate put it back first", () => {
    const opening = node("n1", { title: "Opening", text: "Original prompt" });
    const before = project((p) => { p.nodes = [node("n2")]; });
    const restore = diffForTeam(before, { ...before, nodes: [node("n2"), opening] }, 5)!;
    expect(restore.made).toEqual(["n1"]);
    const gone = applyTeamPatch(applyTeamPatch(emptyTeamCanvas(), { upsertNodes: [opening, node("n2")], removeNodes: [], upsertAssets: [], order: null, at: 1 }), { upsertNodes: [], removeNodes: ["n1"], upsertAssets: [], order: null, at: 2 });
    expect(applyTeamPatch(gone, restore).nodes.n1?.text).toBe("Original prompt");
    const back = applyTeamPatch(gone, { upsertNodes: [{ ...opening, text: "Teammate prompt" }], removeNodes: [], upsertAssets: [], order: null, at: 3 });
    expect(applyTeamPatch(back, restore).nodes.n1?.text).toBe("Teammate prompt");
  });
});

/* ── Folded from the break hunt of 26 September, round 2. ── */

/** What an editor notes as made for the change from `before` to `after` (use-draft-editor, the Rig's builds). */
const madeBy = (before: Project, after: Project, made: MadeRecords = new Map()) => { recordMade(made, before, after); return made; };
/** An edit as an editor makes it: what it takes out of the records windows make alike is noted in the draft (noteTakenOut). */
const edit = (before: Project, change: (p: Project) => void) => { const after = clone(before); change(after); return noteTakenOut(before, after); };

test.describe("what two windows make from one source, then edit in one of them", () => {
  test("Environment: the first tab's edits to the places an agent run made, and a place it removed, survive the second tab taking the same run", () => {
    const base = project((p) => { p.production = { environment: { world: "", model: "gemini-3.1-flash-image", entries: [] } }; });
    const take = (p: Project) => {
      const out = clone(p);
      out.production!.environment!.world = "Winter, always dusk.";
      out.production!.environment!.entries = ["Harbour", "Lighthouse", "Fish market"].map((name) => newEnvironmentEntry(name, `${name} as the agent wrote it`, "", sourcedPlaceId("wb_development_job-1", name)));
      out.production!.environment!.agentJobId = "wb_development_job-1";
      return out;
    };
    /* Tab A took it, then the person rewrote Harbour's notes, went on writing the world, and removed Fish market. */
    const theirs = edit(take(base), (p) => {
      p.production!.environment!.entries[0].notes = "Rewritten by the person";
      p.production!.environment!.world = "Winter, always dusk. Fog rolls in at six.";
      p.production!.environment!.entries = p.production!.environment!.entries.filter((e) => e.name !== "Fish market");
    });
    expect(theirs.takenOut, "the editor notes what it took out").toEqual([sourcedPlaceId("wb_development_job-1", "Fish market")]);
    /* Tab B, stale, takes the same run; its editor noted what that made. */
    const mine = take(base);
    const env = mergeDraft(base, mine, theirs, { made: madeBy(base, mine) }).production!.environment!;
    expect({ places: env.entries.map((e) => e.name), harbour: env.entries[0].notes, world: env.world }).toEqual({ places: ["Harbour", "Lighthouse"], harbour: "Rewritten by the person", world: "Winter, always dusk. Fog rolls in at six." });
    /* This side's own edits since it made them still count: a place renamed here, taken out there, stays. */
    const edited = clone(mine); edited.production!.environment!.entries[2].notes = "Kept here";
    expect(mergeDraft(base, edited, theirs, { made: madeBy(base, mine) }).production!.environment!.entries.map((e) => e.name)).toEqual(["Harbour", "Lighthouse", "Fish market"]);
  });

  test("Beats: the first tab's edit to a breakdown and a scene it removed survive the second tab taking the same breakdown", () => {
    const scenes = [
      { heading: "INT. HARBOUR", summary: "", beats: ["Ice."], shots: [], characters: [], locations: [], props: [] },
      { heading: "EXT. PIER", summary: "", beats: ["Wind."], shots: [], characters: [], locations: [], props: [] },
    ] as unknown as Parameters<typeof beatSheetFrom>[0];
    const base = project((p) => { p.production = {}; });
    const theirs = edit({ ...clone(base), production: { beats: beatSheetFrom(scenes, "0".repeat(64), "wb_development_job-2") } } as Project, (p) => {
      p.production!.beats!.scenes[0].beats[0].text = "Ice, and the fox's tracks across it.";
      p.production!.beats!.scenes = p.production!.beats!.scenes.slice(0, 1);
    });
    const mine = { ...clone(base), production: { beats: beatSheetFrom(scenes, "0".repeat(64), "wb_development_job-2") } } as Project;
    const sheet = mergeDraft(base, mine, theirs, { made: madeBy(base, mine) }).production!.beats!;
    expect({ scenes: sheet.scenes.map((x) => x.heading), beat: sheet.scenes[0].beats[0].text }).toEqual({ scenes: ["INT. HARBOUR"], beat: "Ice, and the fox's tracks across it." });
  });

  test("a take both windows' pollers file: the first window's lock and rename of it survive the second window filing it", () => {
    const base = project((p) => { p.productionProjectId = "prod-1"; p.shotMappings = { n1: "shot-1" }; });
    const job: MediaJob = { id: "gen-take-1", status: "succeeded", kind: "video", shotId: "shot-1", prompt: "A fox", model: "kling", version: 1 };
    const theirs = recoverMediaAssets(clone(base), [job]);
    theirs.assets = theirs.assets.map((a) => (a.id === job.id ? { ...a, name: "Hero take — keep", locked: true } as Asset : a));
    const mine = recoverMediaAssets(clone(base), [job]);
    const take = mergeDraft(base, mine, theirs, { made: madeBy(base, mine) }).assets.find((a) => a.id === job.id)!;
    expect({ name: take.name, locked: take.locked }).toEqual({ name: "Hero take — keep", locked: true });
  });

  test("Rig › Build from Storyboards in two windows: the first window's rename and prompt of a built shot survive the second window building", () => {
    const scenes = [{ heading: "INT. HARBOUR", summary: "", beats: ["Ice."], shots: [{ description: "Wide on the ice", framing: "Wide", movement: "", lighting: "", sound: "" }], characters: [], locations: [], props: [] }] as unknown as Parameters<typeof beatSheetFrom>[0];
    const base = project((p) => {
      p.nodes = [];
      const beats = beatSheetFrom(scenes, "0".repeat(64), "wb_development_job-3");
      p.production = { beats, boards: { style: "color-sketch", model: "gemini-3.1-flash-image", frames: { [beats.scenes[0].shots[0].id]: { prompt: "Wide on the ice", takes: [{ genId: "gen-frame-1", style: "color-sketch", at: "2026-09-26T00:00:00.000Z" }] } } } } as Project["production"];
    });
    const theirs = buildFromBoards(clone(base), "kling-v3").project;
    const built = theirs.nodes.find((n) => n.boardShotId)!;
    theirs.nodes = theirs.nodes.map((n) => (n.id === built.id ? { ...n, title: "Opening — renamed", text: "The person's own prompt" } : n));
    const mine = buildFromBoards(clone(base), "kling-v3").project;
    const merged = mergeDraft(base, mine, theirs, { made: madeBy(base, mine) });
    expect(merged.nodes.filter((n) => n.boardShotId)).toHaveLength(1);
    expect(merged.nodes.find((n) => n.id === built.id)).toMatchObject({ title: "Opening — renamed", text: "The person's own prompt" });
  });

  test("Marketing › Prepare hook × cast variants in two windows prepares each combination once, as one window refuses to prepare it twice", () => {
    const hero: Asset = { id: "product-1", name: "bottle.png", kind: "image", category: "Product", url: "/campaign/hero.webp", mime: "image/png", description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [] };
    const base = project((p) => { p.nodes = []; p.assets = [hero]; p.moleculr = { ...EMPTY_MOLECULR, productName: "Still Water", productAssetIds: [hero.id], hooks: ["Quiet mornings", "Cold, clean, yours"] }; });
    const theirs = prepareMoleculrVariants(clone(base), "image", () => uid("campaign"));
    expect(() => prepareMoleculrVariants(clone(theirs), "image", () => uid("campaign"))).toThrow(/already prepared/);
    const merged = mergeDraft(base, prepareMoleculrVariants(clone(base), "image", () => uid("campaign")), theirs);
    expect({ variants: merged.moleculr!.variants.length, nodes: merged.nodes.length }).toEqual({ variants: 2, nodes: theirs.nodes.length });
    expect(duplicates(ids(merged.nodes))).toEqual([]);
  });

  test("a direction note first typed in two windows is still mine: typing is not a source both windows share", () => {
    const base = project((p) => { p.nodes = [node("n1", { title: "Opening", type: "scene" })]; });
    const mine = shotPatch(clone(base), "n1", { note: "Note typed in the Rig" });
    const theirs = shotPatch(clone(base), "n1", { note: "Note typed in another window" });
    expect(mergeDraft(base, mine, theirs).nodes[0].operations?.map((op) => op.values.note)).toEqual(["Note typed in the Rig"]);
  });
});

test.describe("what one window took out stays out, and only that (Project.takenOut)", () => {
  test("what each window made differently from one source is all kept: a variant for a hook one window added, a shot from a frame it made ready, a place from a beat sheet line it added", () => {
    /* Marketing: A prepared the variants of the two hooks it had; B added a third hook, then prepared. */
    const hero: Asset = { id: "product-1", name: "bottle.png", kind: "image", category: "Product", url: "/campaign/hero.webp", mime: "image/png", description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [] };
    const brief = project((p) => { p.nodes = []; p.assets = [hero]; p.moleculr = { ...EMPTY_MOLECULR, productName: "Still Water", productAssetIds: [hero.id], hooks: ["Quiet mornings", "Cold, clean, yours"] }; });
    const prepared = prepareMoleculrVariants(clone(brief), "image", () => uid("campaign"));
    const made: MadeRecords = new Map();
    const hooked = edit(brief, (p) => { p.moleculr!.hooks.push("A third hook"); });
    madeBy(brief, hooked, made);
    const mine = prepareMoleculrVariants(clone(hooked), "image", () => uid("campaign"));
    madeBy(hooked, mine, made);
    const merged = mergeDraft(brief, mine, prepared, { made });
    expect(merged.moleculr!.variants.map((v) => v.hook).sort()).toEqual(["A third hook", "Cold, clean, yours", "Quiet mornings"]);
    expect(merged.moleculr!.variants.every((v) => merged.nodes.some((n) => n.id === v.nodeId)), "every variant keeps its node").toBe(true);
    expect(duplicates(ids(merged.nodes))).toEqual([]);

    /* Rig › Build from Storyboards: A built the two frames ready in its copy; B made a third ready, then built. */
    const scenes = [{ heading: "INT. HARBOUR", summary: "", beats: ["Ice."], shots: ["Wide on the ice", "Close on the fox", "The pier"].map((description) => ({ description, framing: "Wide", movement: "", lighting: "", sound: "" })), characters: [], locations: [], props: [] }] as unknown as Parameters<typeof beatSheetFrom>[0];
    const beats = beatSheetFrom(scenes, "0".repeat(64), "wb_development_job-4");
    const frame = (i: number) => ({ prompt: "p", takes: [{ genId: `gen-frame-${i}`, style: "color-sketch" as const, at: "2026-09-26T00:00:00.000Z" }] });
    const boards = project((p) => { p.nodes = []; p.production = { beats, boards: { style: "color-sketch", model: "gemini-3.1-flash-image", frames: { [beats.scenes[0].shots[0].id]: frame(1), [beats.scenes[0].shots[1].id]: frame(2) } } } as Project["production"]; });
    const built = buildFromBoards(clone(boards), "kling-v3").project;
    const ready = edit(boards, (p) => { p.production!.boards!.frames[beats.scenes[0].shots[2].id] = frame(3); });
    const shots = new Map() as MadeRecords;
    madeBy(boards, ready, shots);
    const three = buildFromBoards(clone(ready), "kling-v3").project;
    madeBy(ready, three, shots);
    expect(mergeDraft(boards, three, built, { made: shots }).nodes.filter((n) => n.boardShotId).map((n) => n.title)).toEqual(["1.1 — Wide on the ice", "1.2 — Close on the fox", "1.3 — The pier"]);

    /* Environment › Add from the beat sheet: A added the one place its sheet had; B added a location to a scene, then added. */
    const located = (locations: string[]) => [{ heading: "INT. HARBOUR", summary: "", beats: ["Ice."], shots: [], characters: [], locations, props: [] }] as unknown as Parameters<typeof beatSheetFrom>[0];
    const sheet = project((p) => { p.production = { beats: beatSheetFrom(located(["Harbour"]), "0".repeat(64), "wb_development_job-5"), environment: { world: "", model: "gemini-3.1-flash-image", entries: [] } } as Project["production"]; });
    const added = edit(sheet, (p) => { p.production!.environment!.entries = environmentsFromBeats(p.production!.beats, []); });
    const places: MadeRecords = new Map();
    const relocated = edit(sheet, (p) => { p.production!.beats!.scenes[0].locations = ["Harbour", "Fish market"]; });
    madeBy(sheet, relocated, places);
    const both = edit(relocated, (p) => { p.production!.environment!.entries = environmentsFromBeats(p.production!.beats, []); });
    madeBy(relocated, both, places);
    expect(mergeDraft(sheet, both, added, { made: places }).production!.environment!.entries.map((e) => e.name)).toEqual(["Harbour", "Fish market"]);
  });

  test("a record another window took out before this window's copy was read, made again here on purpose, stays", () => {
    const run = (p: Project) => { p.production!.environment!.entries.push(newEnvironmentEntry("Fish market", "", "", sourcedPlaceId("wb_development_job-6", "Fish market"))); };
    const start = project((p) => { p.production = { environment: { world: "", model: "gemini-3.1-flash-image", entries: [] } } as Project["production"]; });
    /* Taken once, taken out, saved: the base this window reads says so. */
    const base = edit(edit(start, run), (p) => { p.production!.environment!.entries = []; });
    expect(base.takenOut).toEqual([sourcedPlaceId("wb_development_job-6", "Fish market")]);
    const mine = edit(base, run);
    const theirs = edit(base, (p) => { p.production!.environment!.world = "Winter."; });
    const merged = mergeDraft(base, mine, theirs, { made: madeBy(base, mine) });
    expect({ places: merged.production!.environment!.entries.map((e) => e.name), world: merged.production!.environment!.world }).toEqual({ places: ["Fish market"], world: "Winter." });
  });

  test("what an edit takes out is noted once, only for records windows make alike, newest last, and the list merges as a set and saves", () => {
    const start = project((p) => {
      p.nodes = [node("n1"), node(`node-${"a".repeat(16)}`), node(`variant-source-${"b".repeat(16)}`)];
      p.moleculr = { ...EMPTY_MOLECULR, variants: [{ id: `variant-${"c".repeat(16)}`, nodeId: `variant-${"c".repeat(16)}`, hook: "Quiet mornings", createdAt: "2026-09-26T00:00:00.000Z" }] };
      p.nodes.push(node(`variant-${"c".repeat(16)}`));
    });
    /* A hand-made shot (a random id) is not noted: no other window can make it again. */
    expect(edit(start, (p) => { p.nodes = p.nodes.filter((n) => n.id !== "n1"); }).takenOut).toBeUndefined();
    const out = edit(start, (p) => { p.nodes = p.nodes.filter((n) => n.id === "n1"); p.moleculr!.variants = []; });
    expect(out.takenOut).toEqual([`node-${"a".repeat(16)}`, `variant-source-${"b".repeat(16)}`, `variant-${"c".repeat(16)}`]);
    /* Noted again, it moves to the end; the list keeps the newest. */
    const many = { ...out, takenOut: Array.from({ length: TAKEN_OUT_KEEP }, (_, i) => `env-${i.toString(16).padStart(16, "0")}`) };
    const again = noteTakenOut({ ...many, nodes: [...many.nodes, node(`node-${"d".repeat(16)}`)] }, many);
    expect({ length: again.takenOut!.length, last: again.takenOut!.at(-1), first: again.takenOut![0] }).toEqual({ length: TAKEN_OUT_KEEP, last: `node-${"d".repeat(16)}`, first: `env-${(1).toString(16).padStart(16, "0")}` });
    /* Both windows' notes are kept, and the draft saves. */
    const a = edit(start, (p) => { p.nodes = p.nodes.filter((n) => !n.id.startsWith("node-")); });
    const b = edit(start, (p) => { p.nodes = p.nodes.filter((n) => !n.id.startsWith("variant-source-")); });
    const merged = mergeDraft(start, a, b);
    expect([...merged.takenOut!].sort()).toEqual([`node-${"a".repeat(16)}`, `variant-source-${"b".repeat(16)}`]);
    expect(saveSchema.safeParse({ project: merged, revision: 1 }).success).toBe(true);
  });
});

test.describe("lines both windows put in at one place", () => {
  test("two paragraphs added at the same place each keep their blank line, a cue the other window repeated stays, and merging again changes nothing", () => {
    const at = (middle: string) => `INT. HARBOUR - NIGHT\n\nThe ice cracks.\n\n${middle}FADE OUT.`;
    const merged = merge3(at(""), at("Mara runs.\n\n"), at("Jonas follows.\n\n"));
    expect(merged).toBe(at("Mara runs.\n\nJonas follows.\n\n"));
    expect(merge3(at(""), at("Mara runs.\n\n"), merged)).toBe(merged);
    const cues = "MARA\nWhere were you?\n\nEND";
    const both = merge3(cues, cues.replace("\n\nEND", "\nJONAS\nOut.\n\nEND"), cues.replace("\n\nEND", "\nJONAS\nLater.\n\nEND"));
    expect(both.split("\n")).toEqual(["MARA", "Where were you?", "JONAS", "Out.", "JONAS", "Later.", "", "END"]);
  });
});

test.describe("the rebase of a save made while typing", () => {
  test("is this window's edits over what the server saved, with its ids — at once, even on a feature", () => {
    const sent = project((p) => {
      p.assets = Array.from({ length: 6000 }, (_, i) => ({ id: `a${i}`, name: `a${i}.png`, kind: "image", category: "Reference", url: `https://example.com/a${i}.png`, description: "", prompt: `A prompt for asset ${i}`, status: "Draft", locked: false, version: 1, refs: [] }) as Asset);
      p.nodes = Array.from({ length: 3990 }, (_, i) => node(`n${i}`, { title: `Shot ${i}`, text: `Scene ${i}`, linked: i > 0 ? [`n${i - 1}`] : [] }));
    });
    const saved = { ...sent, productionProjectId: "prj_saved", shotMappings: { n1: "shot-1" } };
    const local = { ...sent, nodes: sent.nodes.map((n, i) => (i === 7 ? { ...n, title: "Typed while the save was out" } : n)) };
    mergeDraft(sent, local, saved);
    const at = performance.now();
    const next = mergeDraft(sent, local, saved);
    const ms = performance.now() - at;
    expect({ title: next.nodes[7].title, id: next.productionProjectId, mappings: next.shotMappings }).toEqual({ title: "Typed while the save was out", id: "prj_saved", mappings: { n1: "shot-1" } });
    expect(next.nodes).toBe(local.nodes);
    expect(ms, "no merge to repair or check: what each side changed does not meet").toBeLessThan(100);
  });
});

test.describe("sequences: one side's deletions hold over the other's", () => {
  const BRIEF = ["A fox crosses a frozen harbour at dusk.", "Audience: families", "Tone: quiet, no narration.", "Length: 90 seconds."];
  test("Brief: this window deletes lines 2–3, another deleted line 2 only (and the mirror): line 3 stays deleted", () => {
    const base = project((p) => { p.brief = BRIEF.join("\n"); });
    const both = { ...base, brief: [BRIEF[0], BRIEF[3]].join("\n") }, one = { ...base, brief: [BRIEF[0], BRIEF[2], BRIEF[3]].join("\n") };
    expect(mergeDraft(base, both, one).brief.split("\n")).toEqual([BRIEF[0], BRIEF[3]]);
    expect(mergeDraft(base, one, both).brief.split("\n")).toEqual([BRIEF[0], BRIEF[3]]);
  });

  test("Marketing hooks and plain phrase lists: an item one side removed and the other left as it was is removed", () => {
    const hooks = ["Quiet mornings", "Cold, clean, yours", "Still water, still you", "Bottled at the source"];
    const base = project((p) => { p.moleculr = { ...EMPTY_MOLECULR, productName: "Still Water", hooks }; });
    const mine = { ...base, moleculr: { ...base.moleculr!, hooks: [hooks[0], hooks[3]] } };
    const theirs = { ...base, moleculr: { ...base.moleculr!, hooks: [hooks[0], hooks[2], hooks[3]] } };
    expect(mergeDraft(base, mine, theirs).moleculr!.hooks).toEqual([hooks[0], hooks[3]]);
    const phrases = ["red fox", "blue ice", "grey gulls", "sodium lamps"];
    expect(merge3(phrases, ["red fox", "sodium lamps"], ["red fox", "grey gulls", "sodium lamps"])).toEqual(["red fox", "sodium lamps"]);
    expect(merge3(phrases, ["red fox", "grey gulls", "sodium lamps"], ["red fox", "sodium lamps"])).toEqual(["red fox", "sodium lamps"]);
  });

  test("a line one side rewrote while the other deleted it: the rewrite stays, the deletions around it hold", () => {
    expect(merge3("a\nb\nc\nd", "a\nd", "a\nB, rewritten\nc\nd")).toBe("a\nB, rewritten\nd");
  });
});

test.describe("text merged line by line", () => {
  test("two windows each editing a different line, with no blank line between them: both edits are kept", () => {
    expect(merge3("Tone: quiet\nAudience: families\nLength: 90 seconds", "Tone: quiet and cold\nAudience: families\nLength: 90 seconds", "Tone: quiet\nAudience: families with young kids\nLength: 90 seconds"))
      .toBe("Tone: quiet and cold\nAudience: families with young kids\nLength: 90 seconds");
    /* The Brief: line 1 typed here, line 2 rewritten elsewhere. */
    const brief = "A fox crosses a frozen harbour at dusk.\nAudience: families\nLength: 90 seconds, no narration.";
    expect(merge3(brief, brief.replace("dusk.", "dusk. The ice is thin."), brief.replace("Audience: families", "Audience: families with children under ten")))
      .toBe("A fox crosses a frozen harbour at dusk. The ice is thin.\nAudience: families with children under ten\nLength: 90 seconds, no narration.");
  });

  test("a dialogue line rewritten in one window, its character cue in another: both are kept", () => {
    const base = "INT. KITCHEN - NIGHT\n\nMARA\nWhere were you?\n\nJONAS\nOut.";
    const merged = merge3(base, base.replace("MARA\n", "MARA (O.S.)\n"), base.replace("Where were you?", "Where have you been?"));
    expect(merged).toBe("INT. KITCHEN - NIGHT\n\nMARA (O.S.)\nWhere have you been?\n\nJONAS\nOut.");
  });

  test("a character renamed on 600 lines of a feature script in one window, one word typed in another: both are kept", () => {
    const base = Array.from({ length: 3000 }, (_, i) => (i % 5 === 0 ? "MARA" : i % 5 === 1 ? `Line ${i}.` : i % 5 === 2 ? "" : i % 5 === 3 ? "JONAS" : `Reply ${i}.`)).join("\n");
    const theirs = base.replace(/^MARA$/gm, "NORA");
    for (const mine of [base.replace("Line 1501.", "Line 1501, fixed."), `${base} typed-here`]) {
      const merged = merge3(base, mine, theirs);
      expect({ mara: (merged.match(/^MARA$/gm) ?? []).length, nora: (merged.match(/^NORA$/gm) ?? []).length, mine: merged.includes("Line 1501, fixed.") || merged.endsWith(" typed-here") }).toEqual({ mara: 0, nora: 600, mine: true });
    }
  });

  test("a one-line text both changed: mine, unless theirs went on from the same edit (the agent's world, then more)", () => {
    expect(merge3("", "Winter, always dusk.", "Winter, always dusk. Fog rolls in at six.")).toBe("Winter, always dusk. Fog rolls in at six.");
    expect(merge3("Opening", "Opening A", "Opening (retitled)")).toBe("Opening A");
    expect(merge3("The fox", "The red fox", "The red fox runs")).toBe("The red fox runs");
    /* Theirs kept what mine deleted: not a continuation — mine. */
    expect(merge3("abc", "ab", "abcd")).toBe("ab");
  });
});

test.describe("order", () => {
  test("a shot another window inserted mid-cut stays where it was inserted", () => {
    const shot = (id: string) => ({ id, name: id, assetId: "pic", duration: 24, sourceIn: 0, note: "" });
    const base = [shot("s1"), shot("s2"), shot("s3")];
    const mine = clone(base); mine[0].duration = 48;
    expect(merge3(base, mine, [shot("s1"), shot("x"), shot("s2"), shot("s3")]).map((s) => s.id)).toEqual(["s1", "x", "s2", "s3"]);
  });

  test("two windows each moving a different shot in the cut: both moves are kept, and merging again changes nothing", () => {
    const base = ["s1", "s2", "s3", "s4"].map((id) => ({ id }));
    const mine = [{ id: "s2" }, { id: "s1" }, { id: "s3" }, { id: "s4" }];
    const merged = merge3(base, mine, [{ id: "s1" }, { id: "s2" }, { id: "s4" }, { id: "s3" }]);
    expect(merged.map((s) => s.id)).toEqual(["s2", "s1", "s4", "s3"]);
    expect(merge3(base, mine, merged)).toEqual(merged);
  });

  test("Storyboards: a take another window filed on a full frame is not the first to be trimmed", () => {
    const file = (p: Project, genId: string) => {
      const out = clone(p);
      const frame = out.production!.boards!.frames["shot-a1"];
      out.production!.boards!.frames["shot-a1"] = { ...frame, takes: [{ genId, style: "live" as const, at: "2026-09-26T00:00:00.000Z" }, ...frame.takes].slice(0, 20), selected: genId };
      return out;
    };
    const base = project((p) => { p.production = { boards: { style: "live", model: "gemini-3.1-flash-image", frames: { "shot-a1": { prompt: "The fox on the ice", takes: Array.from({ length: 18 }, (_, i) => ({ genId: `gen-old-${18 - i}`, style: "live" as const, at: "2026-09-20T00:00:00.000Z" })) } } } } as Project["production"]; });
    const merged = mergeDraft(base, file(base, "gen-b"), file(base, "gen-a"));
    const next = file(merged, "gen-c").production!.boards!.frames["shot-a1"].takes.map((t) => t.genId);
    expect({ keepsA: next.includes("gen-a"), dropsOldest: !next.includes("gen-old-1"), order: next.slice(0, 3) }).toEqual({ keepsA: true, dropsOldest: true, order: ["gen-c", "gen-b", "gen-a"] });
  });
});

test.describe("a merge of two valid saves is a save the server takes, and keeps what it uses", () => {
  const image = (id: string, extra: Partial<Asset> = {}): Asset => ({ id, name: `${id}.png`, kind: "image", category: "Reference", url: `/api/uploads/${id}`, description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [], ...extra });
  const valid = (p: Project) => saveSchema.safeParse({ project: p, revision: 1 });
  const issues = (p: Project) => { const parsed = valid(p); return parsed.success ? [] : parsed.error.issues.map((i) => i.message); };

  test("Fade in set in one window and Fade out in another, or a clip trimmed under another's fade: this window's fade stands, the other fits the clip", () => {
    const withClip = () => project((p) => {
      p.assets = [image("pic"), image("music", { kind: "audio", name: "music.mp3", url: "https://example.com/music.mp3" })];
      p.shots = [{ id: "shot-1", name: "01 — pic", assetId: "pic", duration: 120, sourceIn: 0, note: "" }];
      p.audioClips = [{ id: "clip-1", assetId: "music", lane: "music", startFrame: 0, sourceIn: 0, duration: 24, gainDb: 0, pan: 0, fadeIn: 0, fadeOut: 0, muted: false, solo: false }];
    });
    const base = withClip();
    const fadeIn = clone(base); fadeIn.audioClips![0].fadeIn = 20;
    const fadeOut = clone(base); fadeOut.audioClips![0].fadeOut = 20;
    const merged = mergeDraft(base, fadeIn, fadeOut);
    expect(issues(merged)).toEqual([]);
    expect(merged.audioClips![0]).toMatchObject({ fadeIn: 20, fadeOut: 4 });
    const trimmed = clone(base); trimmed.audioClips![0].duration = 10;
    const cut = mergeDraft(base, trimmed, fadeOut);
    expect(issues(cut)).toEqual([]);
    expect(cut.audioClips![0]).toMatchObject({ duration: 10, fadeOut: 10 });
  });

  test("a screenplay imported in one tab while a line was typed into the old one in another: both kept, the import marked edited", () => {
    const base = project((p) => { p.script = "INT. HARBOUR - NIGHT\n\nThe ice cracks."; });
    const imported = "EXT. LIGHTHOUSE - DAWN\n\nA fox waits.\n\nMARA\nThere you are.";
    const mine = clone(base);
    mine.assets = [...mine.assets, { id: "up-script", uploadId: "up-script", name: "draft.pdf", kind: "document", category: "Screenplay", url: "/api/uploads/up-script", description: "Original screenplay source", prompt: "", status: "Draft", locked: false, version: 1, refs: [] }];
    mine.script = imported;
    mine.scriptReviews = {};
    mine.scriptSource = { assetId: "up-script", filename: "draft.pdf", sha256: "a".repeat(64), pages: [{ page: 1, start: 0, end: imported.length }], importedAt: "2026-09-26T00:00:00.000Z", edited: false, acknowledgedEmptyPages: [] };
    const theirs = clone(base); theirs.script = `${base.script}\n\nMara runs.`;
    const merged = mergeDraft(base, mine, theirs);
    expect(issues(merged)).toEqual([]);
    expect(merged.script).toContain("There you are.");
    expect(merged.script).toContain("Mara runs.");
    expect(merged.scriptSource?.edited).toBe(true);
  });

  test("Storyboards deletes a line drawing another window just made a Rig input, or put in a product profile: the original stays, and this window is told", () => {
    const drawing = image("drawing", { category: "Line drawing", name: "drawing.png" });
    const base = project((p) => { p.assets = [drawing]; p.nodes = [node("n1", { title: "Opening" })]; p.moleculr = { ...EMPTY_MOLECULR, productName: "Still Water" }; });
    const boards = deleteDrawing(clone(base), "drawing");
    const rig = addInput(clone(base), "n1", drawing, drawing.name, "media-1");
    const marketing = clone(base); marketing.moleculr = { ...marketing.moleculr!, products: [{ id: "product-1", name: "Still Water", url: "", description: "", brand: "", assetIds: ["drawing"] }], activeProductId: "product-1" } as Project["moleculr"];
    for (const theirs of [rig, marketing]) {
      for (const [mine, other] of [[boards, theirs], [theirs, boards]] as const) {
        const notes: string[] = [];
        const merged = mergeDraft(base, mine, other, { notes });
        expect(issues(merged)).toEqual([]);
        expect(merged.assets.map((a) => a.id)).toEqual(["drawing"]);
        expect(notes.some((note) => note.includes("drawing.png")), JSON.stringify(notes)).toBe(mine === boards);
      }
    }
    /* In one window, a drawing a product profile holds is refused, like one the Rig uses. */
    expect(() => deleteDrawing(marketing, "drawing")).toThrow(/Product profile/);
  });

  test("wires each window was allowed to make still obey the graph once merged: a grade takes one input (mine's), and no loop", () => {
    const base = project((p) => { p.nodes = [node("n1", { title: "Opening" }), node("n2", { title: "Second" }), node("g1", { type: "grade", title: "Warm grade" })]; });
    const wire = (p: Project, from: string, to: string) => { const out = connectNodes(clone(p), from, to); if ("error" in out) throw new Error(out.error); return out.project; };
    const grade = mergeDraft(base, wire(base, "n2", "g1"), wire(base, "n1", "g1")).nodes.find((n) => n.id === "g1")!;
    expect(grade.linked).toEqual(["n2"]);
    const loop = mergeDraft(base, wire(base, "n2", "n1"), wire(base, "n1", "n2"));
    expect(canConnect(loop.nodes.map((n) => ({ ...n, linked: [] })), "n1", "n2")).toBeNull();
    expect({ n1: loop.nodes.find((n) => n.id === "n1")!.linked, n2: loop.nodes.find((n) => n.id === "n2")!.linked }).toEqual({ n1: ["n2"], n2: [] });
  });

  test("a reference this window added to a place another window filled: the place keeps the saved six, and the note names what did not fit", () => {
    const base = project((p) => {
      p.assets = ["r1", "r2", "r3", "r4", "r5"].map((id) => image(id));
      p.production = { environment: { world: "", model: "gemini-3.1-flash-image", entries: [{ id: "env-1", name: "Harbour", notes: "", prompt: "", references: ["r1", "r2", "r3", "r4", "r5"], plates: [] }] } };
    });
    const mine = clone(base); mine.assets.push(image("ice", { name: "ice.png" })); mine.production!.environment!.entries[0].references.push("ice");
    const theirs = clone(base); theirs.assets.push(image("teammate-ref")); theirs.production!.environment!.entries[0].references.push("teammate-ref");
    const notes: string[] = [];
    const merged = mergeDraft(base, mine, theirs, { notes });
    expect(issues(merged)).toEqual([]);
    expect(merged.production!.environment!.entries[0].references).toEqual(["r1", "r2", "r3", "r4", "r5", "teammate-ref"]);
    expect(merged.assets.some((a) => a.id === "ice"), "the upload stays in the library").toBe(true);
    expect(notes).toEqual(["Harbour holds 6 references, and another window filled it first: ice.png not added."]);
  });

  test("at the 4,000-node cap, an input this window wired in that does not fit takes its link with it, and is named", () => {
    const base = project((p) => { p.assets = [image("pic")]; p.nodes = Array.from({ length: 3998 }, (_, i) => node(`n${i}`)); });
    const mine = addInput(clone(base), "n0", base.assets[0], "pic.png", "media-mine");
    const theirs = clone(base); theirs.nodes.push(node("their-shot-1"), node("their-shot-2"));
    const notes: string[] = [];
    const merged = mergeDraft(base, mine, theirs, { notes });
    const present = new Set(ids(merged.nodes));
    expect({ valid: valid(merged).success, count: merged.nodes.length, dangling: merged.nodes.flatMap((n) => n.linked.filter((id) => !present.has(id))) }).toEqual({ valid: true, count: 4000, dangling: [] });
    expect(notes.join(" ")).toContain("pic.png");
  });
});

test.describe("a feature-sized project merges in well under a second", () => {
  function big(): Project {
    return project((p) => {
      p.assets = Array.from({ length: 6000 }, (_, i) => ({ id: `a${i}`, name: `a${i}.png`, kind: "image", category: "Reference", url: `https://example.com/a${i}.png`, description: `Asset ${i}`, prompt: `A prompt for asset ${i} `.repeat(4), status: "Draft", locked: false, version: 1, refs: [] }) as Asset);
      p.nodes = Array.from({ length: 3990 }, (_, i) => node(`n${i}`, { title: `Shot ${i}`, text: `Scene ${i}\nThe fox crosses.`, x: i % 100, y: Math.floor(i / 100), linked: i > 0 ? [`n${i - 1}`] : [], operations: [{ id: `op${i}`, kind: "direction", enabled: true, values: { note: `Note ${i}` } }] }));
      p.shots = Array.from({ length: 1500 }, (_, i) => ({ id: `s${i}`, name: `Shot ${i}`, assetId: `a${i}`, duration: 24, sourceIn: 0, note: "" }));
      p.script = Array.from({ length: 6000 }, (_, i) => (i % 3 === 2 ? "" : `Line ${i} of the screenplay.`)).join("\n");
    });
  }
  const time = (fn: () => unknown) => { const at = performance.now(); fn(); return performance.now() - at; };
  test("one edit and one new shot each side, every shot changed on both sides, and a screenplay edited all through on both", () => {
    const base = big();
    expect(saveSchema.safeParse({ project: base, revision: 1 }).success, "a valid save to start from").toBe(true);
    const a = clone(base); a.nodes[10].title = "Mine"; a.nodes.push(node("mine-new"));
    const b = clone(base); b.nodes[20].title = "Theirs"; b.nodes.push(node("their-new"));
    expect(time(() => mergeDraft(base, a, b))).toBeLessThan(1000);
    const moved = clone(base); moved.nodes.forEach((n, i) => { n.x = i; });
    const retitled = clone(base); retitled.nodes.forEach((n, i) => { n.title = `Retitled ${i}`; });
    expect(time(() => mergeDraft(base, moved, retitled))).toBeLessThan(1000);
    const lines = base.script!.split("\n");
    const here = clone(base); here.script = lines.map((l, i) => (i % 7 === 0 ? `${l} (mine)` : l)).join("\n");
    const there = clone(base); there.script = lines.map((l, i) => (i % 11 === 0 ? `${l} (theirs)` : l)).join("\n");
    let merged = "";
    expect(time(() => { merged = mergeDraft(base, here, there).script!; })).toBeLessThan(1000);
    /* Both windows' edits all through, not one window's over the other's: theirs on its 546 lines, less the 78 both edited, where mine's stands. */
    expect({ mine: merged.split("\n").filter((l) => l.endsWith("(mine)")).length, theirs: merged.split("\n").filter((l) => l.endsWith("(theirs)")).length }).toEqual({ mine: 858, theirs: 546 - 78 });
  });
});

/**
 * A server that answers the next three saves 503 before they reach the draft,
 * lets the fourth land, runs `afterLanding` (another window saves on top), and
 * loses that reply; then it answers as tagServer does.
 */
function flakyServer(start: Project, afterLanding: (landed: Project) => Project) {
  const state = tagServer(start);
  const inner = globalThis.fetch;
  let puts = 0;
  globalThis.fetch = async (url, init) => {
    if ((init?.method ?? "GET") !== "PUT" || puts >= 4) return inner(url, init);
    puts++;
    if (puts <= 3) return reply({ error: "Service unavailable" }, 503);
    state.dropFirst = false;
    const answer = await inner(url, init);
    if (!answer.ok) return answer;
    state.project = { ...afterLanding(structuredClone(state.project)), productionProjectId: "production", shotMappings: {} };
    state.revision += 1;
    throw new TypeError("Failed to fetch");
  };
  return state;
}

test.describe("a save whose last try landed with its reply lost (writeMergedDraft)", () => {
  test.afterEach(() => { globalThis.fetch = nativeFetch; });

  test("is settled by the next save, never merged again over what another window did since: a rewrite stands, a delete holds", async () => {
    const base = project((p) => { p.production = { cast: { entries: [entry("cast-1", "Mara")] } }; });
    const typed = clone(base); typed.production!.cast!.entries[0].description = "A fox-eyed deckhand.";
    const added = clone(base); added.production!.cast!.entries.push(entry("cast-new", "Tom"));
    const cases: [Project, (p: Project) => Project, (p: Project) => unknown, unknown][] = [
      [typed, (p) => { p.production!.cast!.entries[0].description = "Rewritten in another window."; return p; }, (p) => p.production!.cast!.entries[0].description, "Rewritten in another window."],
      [added, (p) => { p.production!.cast!.entries = p.production!.cast!.entries.filter((e) => e.id === "cast-1"); return p; }, (p) => ids(p.production!.cast!.entries), ["cast-1"]],
    ];
    for (const [mine, onTop, read, expected] of cases) {
      const state = flakyServer(base, onTop);
      const writer = draftWriter();
      await expect(writeMergedDraft("/api/workbench", "scope", { base, mine, revision: 1, writer })).rejects.toMatchObject({ uncertain: true });
      expect(writer.unconfirmed, "the last try stays unconfirmed on the writer").not.toBeNull();
      /* The stage tries again on its own, from the base it had. */
      const saved = await writeMergedDraft("/api/workbench", "scope", { base, mine, revision: 1, writer });
      expect(read(saved.project)).toEqual(expected);
      expect(read(state.project)).toEqual(expected);
    }
  });

  test("a save that settled an earlier landed one, then never landed itself: what is undone next is saved as undone", async () => {
    const base = project((p) => { p.brief = ""; p.nodes = [node("n1"), node("keep-me")]; });
    const state = tagServer(base);
    const writer = draftWriter();
    /* 1. A shot added: the save lands, its reply and the check are lost. */
    const added = { ...base, nodes: [...base.nodes, node("oops")] };
    await expect(writeMergedDraft("/api/workbench", "scope", { base, mine: added, revision: 1, writer })).rejects.toMatchObject({ uncertain: true });
    /* 2. The next edit: that save is found to have landed, and this one never reaches the draft (every try 503). */
    state.offline = false;
    const inner = globalThis.fetch;
    let refusing = true;
    globalThis.fetch = async (url, init) => ((init?.method ?? "GET") === "PUT" && refusing ? reply({ error: "Service unavailable" }, 503) : inner(url, init));
    const typed = { ...added, brief: "Next edit" };
    await expect(writeMergedDraft("/api/workbench", "scope", { base, mine: typed, revision: 1, writer })).rejects.toMatchObject({ uncertain: true });
    expect(writer.unconfirmed).not.toBeNull();
    /* 3. The shot is taken out again (the editor still holds the base it read): it stays out. */
    refusing = false;
    const undone = { ...typed, nodes: typed.nodes.filter((n) => n.id !== "oops") };
    const saved = await writeMergedDraft("/api/workbench", "scope", { base, mine: undone, revision: 1, writer });
    expect({ nodes: ids(saved.project.nodes), brief: saved.project.brief }).toEqual({ nodes: ["n1", "keep-me"], brief: "Next edit" });
    expect({ nodes: ids(state.project.nodes), brief: state.project.brief }).toEqual({ nodes: ["n1", "keep-me"], brief: "Next edit" });
  });

  test("a server answering 503 is asked again only after a pause that doubles each try, never back to back", async () => {
    const base = project();
    tagServer(base);
    const inner = globalThis.fetch;
    const puts: number[] = [];
    globalThis.fetch = async (url, init) => {
      if ((init?.method ?? "GET") !== "PUT") return inner(url, init);
      puts.push(Date.now());
      return reply({ error: "Service unavailable" }, 503);
    };
    const writer = draftWriter();
    await expect(writeMergedDraft("/api/workbench", "scope", { base, mine: { ...base, brief: "Typed" }, revision: 1, writer })).rejects.toMatchObject({ uncertain: true });
    /* One save: its first try and three more, each checked first; the last one's outcome stays on the writer. */
    expect(puts).toHaveLength(4);
    const gaps = puts.slice(1).map((at, i) => at - puts[i]);
    gaps.forEach((gap, i) => expect(gap, `pause before try ${i + 2}`).toBeGreaterThanOrEqual(250 * 2 ** i - 5));
    expect(writer.unconfirmed).not.toBeNull();
  });
});

test.describe("undo on the open project", () => {
  test("⌘Z takes the open project's own newest undo; another project's waits where it stood", () => {
    const entry = (label: string, projectId?: string): UndoEntry => ({ label, undo: () => {}, projectId });
    let stack: UndoEntry[] = [];
    for (const e of [entry("B's shot back", "b"), entry("take restored"), entry("A's shot back", "a")]) stack = pushUndo(stack, e);
    const onB = popUndo(stack, "b")!;
    expect(onB.entry.label).toBe("take restored");
    const again = popUndo(onB.rest, "b")!;
    expect(again.entry.label).toBe("B's shot back");
    expect(again.rest.map((e) => e.label)).toEqual(["A's shot back"]);
    /* Only another project's left: the newest, which says which project to open — and back where it stood if refused. */
    const other = popUndo(again.rest, "b")!;
    expect(other.entry.label).toBe("A's shot back");
    expect(restoreUndo(other.rest, other.entry, other.at).map((e) => e.label)).toEqual(["A's shot back"]);
  });
});

test.describe("the team canvas catches up with a merge only where it still holds what the Rig had", () => {
  const opening = node("n1", { title: "Opening", text: "Original prompt" }), second = node("n2", { title: "Second", text: "Second prompt" });
  const seeded = (...nodes: CanvasNode[]) => applyTeamPatch(emptyTeamCanvas(), { upsertNodes: nodes, removeNodes: [], upsertAssets: [], order: null, at: 1 });
  const before = project((p) => { p.nodes = [opening, second]; });

  test("a field another window changed: written where the canvas still has the old value, never over a teammate's later edit", () => {
    const after = { ...before, nodes: [{ ...opening, title: "Title from window B" }, second] };
    const patch = catchUpForTeam(before, after, 3)!;
    /* The canvas missed that save (it had the Rig's copy): it catches up. */
    expect(applyTeamPatch(seeded(opening, second), patch).nodes.n1.title).toBe("Title from window B");
    /* A teammate renamed it since: theirs stands. */
    const renamed = applyTeamPatch(seeded(opening, second), { upsertNodes: [{ ...opening, title: "Teammate title" }], fields: { n1: ["title"] }, removeNodes: [], upsertAssets: [], order: null, at: 2 });
    expect(applyTeamPatch(renamed, patch).nodes.n1.title).toBe("Teammate title");
  });

  test("a shot another window added joins a canvas that never held it; one a teammate took off stays off", () => {
    const added = node("elsewhere-1", { title: "From Brief" });
    const patch = catchUpForTeam(before, { ...before, nodes: [opening, second, added] }, 3)!;
    expect(Object.keys(applyTeamPatch(seeded(opening, second), patch).nodes).sort()).toEqual(["elsewhere-1", "n1", "n2"]);
    const takenOff = applyTeamPatch(seeded(opening, second, added), { upsertNodes: [], removeNodes: ["elsewhere-1"], upsertAssets: [], order: null, at: 2 });
    expect(Object.keys(applyTeamPatch(takenOff, patch).nodes).sort()).toEqual(["n1", "n2"]);
  });

  test("a shot another window deleted comes off a canvas that still has it as it was, not one a teammate edited back", () => {
    const patch = catchUpForTeam(before, { ...before, nodes: [opening] }, 3)!;
    expect(Object.keys(applyTeamPatch(seeded(opening, second), patch).nodes)).toEqual(["n1"]);
    const editedBack = applyTeamPatch(seeded(opening, second), { upsertNodes: [{ ...second, text: "Teammate keeps Second" }], fields: { n2: ["text"] }, removeNodes: [], upsertAssets: [], order: null, at: 2 });
    expect(applyTeamPatch(editedBack, patch).nodes.n2?.text).toBe("Teammate keeps Second");
  });
});
