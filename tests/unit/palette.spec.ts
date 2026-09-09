import { test, expect } from "@playwright/test";
import {
  search, flatten, routeCommands, actionCommands,
  productionCommands, shotCommands, castCommands, takeCommands, type Cmd,
} from "../../lib/palette";
import { SHORTCUTS, byScope, PLANNED } from "../../lib/shortcuts";

const projects = [
  { id: "p1", name: "Autumn Launch", code: "AUT" },
  { id: "p2", name: "Winter Teaser", code: "WIN" },
];
const shots = [
  { id: "s1", code: "AUT-010", title: "Wide establishing", projectId: "p1" },
  { id: "s2", code: "WIN-004", title: "Dolly zoom", projectId: "p2" },
  { id: "s3", code: "ORPH-1", title: "No production", projectId: null },
];
const cast = [{ id: "c1", name: "Runner", kind: "character" }];
const nameOf = (id: string | null | undefined) => projects.find((p) => p.id === id)?.name;

function everything(): Cmd[] {
  return [
    ...actionCommands(), ...routeCommands(), ...productionCommands(projects),
    ...shotCommands(shots, nameOf), ...castCommands(cast),
    ...takeCommands([{ id: "t1", prompt: "a runner at dawn", shotCode: "AUT-010" }]),
  ];
}

test("nothing in the palette spends", () => {
  /* SOW §3 rule 1. Twelve actions in this app call a vendor; none of them may
     be one Return away in a text field. The palette navigates, and its only
     verbs are `help` and `select` (which sets the production switcher).
     If a future row needs a new verb, this test is where it gets argued. */
  for (const c of everything()) {
    if (c.act) expect(["help", "select"]).toContain(c.act);
  }
});

test("no route in the palette can start a render on arrival", () => {
  /* /atomik/agent?c=<id> auto-approves a pending step when the chat is in
     auto mode. The bare route loads no chat, so it is safe; carrying a `c`
     would not be. */
  for (const c of everything()) {
    if (c.href?.startsWith("/atomik/agent")) expect(c.href).toBe("/atomik/agent");
  }
});

test("an empty query offers a short list, not the whole index", () => {
  const groups = search(everything(), "");
  const names = groups.map((g) => g.group);
  expect(names).toEqual(["Actions", "Go to", "Productions"]);
  expect(flatten(groups).length).toBeLessThan(everything().length);
});

test("a shot is found by its own code, above a shot in a matching production", () => {
  const rows = flatten(search(everything(), "WIN-004"));
  expect(rows[0].id).toBe("s:s2");
});

test("typing a production name finds the production first", () => {
  const rows = flatten(search(everything(), "autumn"));
  expect(rows[0].id).toBe("p:p1");
});

test("a shot lands on its production's canvas, deep-linked", () => {
  const [a] = shotCommands([shots[0]], nameOf);
  expect(a.href).toBe("/projects/p1/canvas?shot=s1");
});

test("a shot with no production still has somewhere to land", () => {
  const [orphan] = shotCommands([shots[2]], nameOf);
  expect(orphan.href).toBe("/shots/s3");
});

test("Nodes is reachable — it was linked from nowhere at all", () => {
  /* Rig shipped with a graph, three layers and its own routes, and the only
     two links to it in the whole codebase sat on /shots/[id] and
     /elements/[id], which are themselves unreachable. Typing "rig" has to
     find it, or a whole surface stays invisible. */
  expect(flatten(search(everything(), "nodes")).some((r) => r.href === "/projects/p1/rig")).toBe(true);
  // and by its old name, which people have already learned
  expect(flatten(search(everything(), "rig")).some((r) => r.href === "/projects/p1/rig")).toBe(true);
  // and by what it IS, not only by its name
  expect(flatten(search(everything(), "nodes")).some((r) => r.href?.endsWith("/rig"))).toBe(true);
});

test("a cast member lands on the member, not near it", () => {
  expect(castCommands(cast)[0].href).toBe("/studio?cast=c1");
});

test("initials find a shot: 'dz' reaches Dolly zoom", () => {
  const rows = flatten(search(everything(), "dz"));
  expect(rows.some((r) => r.id === "s:s2")).toBe(true);
});

test("the first row is the best match, whatever group it is in", () => {
  /* The top row is a promise about what Return does. Pinning Actions first
     broke it: "sh" put "Keyboard shortcuts" above "Shot list". */
  const groups = search(everything(), "sh");
  expect(groups[0].group).toBe("Go to");
  expect(flatten(groups)[0].label).toBe("Shot list");
});

test("an empty query keeps the stable section order", () => {
  expect(search(everything(), "").map((g) => g.group)).toEqual(["Actions", "Go to", "Productions"]);
});

test("every row the palette draws can be acted on", () => {
  for (const c of flatten(search(everything(), ""))) {
    expect(Boolean(c.href || c.act)).toBe(true);
  }
});

test("the shortcut registry is enumerable and unique — the Mac menu reads it", () => {
  /* SOW §11 5.1: native menus carry every shortcut from §10 4.2, so the whole
     set has to stay listed here even while most of it is unwired. */
  const ids = SHORTCUTS.map((s) => s.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const s of SHORTCUTS) {
    expect(s.keys.trim().length).toBeGreaterThan(0);
    expect(s.label.trim().length).toBeGreaterThan(0);
  }
  for (const id of ["palette", "help", "shuttle", "pick", "approve", "generate", "batch", "rigfind"]) {
    expect(ids).toContain(id);
  }
});

test("the ? overlay promises only keys that actually do something", () => {
  /* An overlay listing ⌘0 while ⌘0 does nothing teaches people to distrust
     the whole list. Planned rows stay in the registry and out of the UI. */
  const shown = byScope().flatMap((g) => g.items);
  expect(shown.length).toBeGreaterThan(0);
  for (const s of shown) expect(s.live).toBe(true);
  expect(shown.map((s) => s.id)).not.toContain("rigfit");
  expect(PLANNED.map((s) => s.id)).toContain("rigfit");
  // Every live row names a real handler.
  for (const s of shown) expect(s.owner).not.toBe("—");
});
