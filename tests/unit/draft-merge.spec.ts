import { test, expect } from "@playwright/test";
import { merge3, rebaseDraft, sameJson } from "../../lib/workbench/merge";
import { mergeDraft } from "../../lib/workbench/draft-merge";
import { draftWriter, writeMergedDraft } from "../../lib/workbench/draft-request";
import { saveSchema } from "../../lib/workbench/studio-schema";
import { newProject, type Asset, type CanvasNode, type Project } from "../../lib/workbench/studio";
import { shotPatch } from "../../lib/workspace/shots";
import { createSoundNode, findSoundNode } from "../../lib/workbench/sound-generate";
import { connectNodes, graphEdges } from "../../lib/workspace/rig-graph";
import { canConnect } from "../../lib/workbench/node-graph";
import { removeShots, restoreShots } from "../../lib/production/rig-build";
import { newEnvironmentEntry, sourcedPlaceId } from "../../lib/production/environment";
import { beatSheetFrom } from "../../lib/production/beats";
import { applyTeamPatch, diffForTeam, emptyTeamCanvas } from "../../lib/workbench/team-canvas-model";

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
    /* Theirs moved only what mine removed: nothing both still hold moved, so mine's order stands — and merging again agrees. */
    const edge = merge3(["a", "b"], ["a", "m"], ["b", "t", "a"]);
    expect(edge).toEqual(["a", "m", "t"]);
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

  test("both sides add different ids: mine's order, then what theirs added in theirs' order", () => {
    const base = project();
    const mine = clone(base); mine.nodes.push(node("m1"), node("m2"));
    const theirs = clone(base); theirs.nodes.unshift(node("t1")); theirs.nodes.push(node("t2"));
    expect(ids(merge3(base, mine, theirs).nodes)).toEqual(["n1", "n2", "m1", "m2", "t1", "t2"]);
  });

  test("a move made by mine keeps mine's order; theirs' edits to the moved records still join", () => {
    const base = project((p) => { p.nodes.push(node("n3")); });
    const mine = clone(base); mine.nodes.reverse();
    const theirs = clone(base); theirs.nodes[1] = { ...theirs.nodes[1], title: "Renamed" };
    const merged = merge3(base, mine, theirs);
    expect(ids(merged.nodes)).toEqual(["n3", "n2", "n1"]);
    expect(merged.nodes[1].title).toBe("Renamed");
  });

  test("a move made only by theirs is kept: theirs' order leads, what mine added follows", () => {
    const base = project((p) => { p.nodes.push(node("n3")); });
    const mine = clone(base); mine.nodes[1] = { ...mine.nodes[1], title: "Edited here" }; mine.nodes.push(node("m1"));
    const theirs = clone(base); theirs.nodes = [theirs.nodes[2], theirs.nodes[0], theirs.nodes[1], node("t1")];
    const merged = merge3(base, mine, theirs);
    expect(ids(merged.nodes)).toEqual(["n3", "n1", "n2", "t1", "m1"]);
    expect(merged.nodes.find((n) => n.id === "n2")?.title).toBe("Edited here");
    expect(merge3(base, mine, merged)).toEqual(merged);
  });

  test("both sides moved records: mine's order wins, nothing is lost", () => {
    const base = project((p) => { p.nodes.push(node("n3")); });
    const mine = clone(base); mine.nodes = [mine.nodes[1], mine.nodes[0], mine.nodes[2]];
    const theirs = clone(base); theirs.nodes = [theirs.nodes[2], theirs.nodes[0], theirs.nodes[1]];
    expect(ids(merge3(base, mine, theirs).nodes)).toEqual(["n2", "n1", "n3"]);
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

  test("an id is never doubled, even when a side already repeats one", () => {
    const base = project();
    const mine = clone(base); mine.nodes.push(node("n1", { title: "A repeat" }));
    const theirs = clone(base); theirs.nodes.push(node("t1"));
    const merged = merge3(base, mine, theirs);
    expect(duplicates(ids(merged.nodes))).toEqual([]);
    expect(ids(merged.nodes)).toEqual(["n1", "n2", "t1"]);
  });

  test("takes key by genId, pending renders by jobId, plates by assetId", () => {
    const takes = { entries: [{ ...entry("c1", "Mara"), takes: [{ genId: "g0", at: "t0" }] }] };
    const mine = clone(takes); mine.entries[0].takes.unshift({ genId: "g1", at: "t1" });
    const theirs = clone(takes); theirs.entries[0].takes.unshift({ genId: "g2", at: "t2" });
    expect(merge3(takes, mine, theirs).entries[0].takes.map((t) => t.genId)).toEqual(["g1", "g0", "g2"]);
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
    for (let round = 0; round < 300; round++) {
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
      /* Order: mine's, unless only theirs moved what both still hold. */
      const was = ids(base.nodes), m = ids(mine.project.nodes), t = ids(theirs.project.nodes);
      const kept = was.filter((id) => m.includes(id)), shared = kept.filter((id) => t.includes(id));
      const mineMoved = m.filter((id) => kept.includes(id)).join() !== kept.join();
      const theirsMoved = t.filter((id) => shared.includes(id)).join() !== shared.join();
      const leader = !mineMoved && theirsMoved ? t : m;
      expect(ids(merged.nodes).filter((id) => shared.includes(id)), `round ${round}: order`).toEqual(leader.filter((id) => shared.includes(id)));
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
