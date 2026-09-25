import { test, expect } from "@playwright/test";
import { merge3, rebaseDraft, sameJson } from "../../lib/workbench/merge";
import { newProject, type CanvasNode, type Project } from "../../lib/workbench/studio";

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

  test("lists that are neither records nor distinct strings: one changed side wins, both changed keeps mine", () => {
    expect(merge3([1, 2], [1, 2], [1, 2, 3])).toEqual([1, 2, 3]);
    expect(merge3([1, 2], [2], [1, 2])).toEqual([2]);
    /* Vectors are never mixed element by element. */
    expect(merge3([0, 0, 0], [1, 0, 0], [0, 2, 0])).toEqual([1, 0, 0]);
    /* A list of strings that repeats one is a sequence, not a set. */
    expect(merge3(["a", "a"], ["a", "a", "m"], ["a", "a", "t"])).toEqual(["a", "a", "m"]);
    /* Records without any identity field fall back the same way. */
    expect(merge3([{ page: 1 }], [{ page: 1 }, { page: 2 }], [{ page: 3 }])).toEqual([{ page: 1 }, { page: 2 }]);
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

  test("a secondary key that repeats within a side is not an identity: the list falls back to mine", () => {
    const base = { layers: [{ assetId: "a", x: 0 }] };
    const mine = { layers: [{ assetId: "a", x: 0 }, { assetId: "a", x: 5 }] };
    const theirs = { layers: [{ assetId: "a", x: 9 }] };
    expect(merge3(base, mine, theirs)).toEqual(mine);
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
