import { test, expect } from "@playwright/test";
import { newProject } from "../../lib/workbench/studio";
import { MIRROR_ECHO_MS, mirrorSeek, type MirrorMark } from "../../lib/shell/viral";
import { atomikSheetRuns } from "../../lib/shell/atomik-sheet";
import { freshOver, freshRead } from "../../lib/shell/use-fresh-project";

/* Production › Rig › "Let the agent wire this shot": applied once, recorded on the shot. */


/* Viral › History and Recent are the project's Library alone (tests/unit/suitesViral.spec.ts): nothing is read from the account. */

/* Library › Tools only where the page has tools of its own. */

/* Viral › Compare: one clock, no ping-pong. */
test("a seek is mirrored once; the mirrored player's own seeked is not sent back", () => {
  const a = { currentTime: 0 }, b = { currentTime: 0 };
  const last: { current: MirrorMark<typeof a> } = { current: null };
  a.currentTime = 3.2;
  expect(mirrorSeek(a, b, last)).toBe(true);
  expect(b.currentTime).toBe(3.2);
  /* b's seeked (from the mirror, even snapped to a frame) goes nowhere. */
  b.currentTime = 3.2083;
  expect(mirrorSeek(b, a, last)).toBe(false);
  expect(a.currentTime).toBe(3.2);
  /* The next seek the viewer makes on b is mirrored again; a near-identical time is left alone. */
  b.currentTime = 7;
  expect(mirrorSeek(b, a, last)).toBe(true);
  expect(a.currentTime).toBe(7);
  expect(mirrorSeek(a, b, last)).toBe(false);
  a.currentTime = 7.02;
  expect(mirrorSeek(a, b, last)).toBe(false);
  expect(mirrorSeek(a, null, last)).toBe(false);
});

test("a mirrored seek that never fires its own seeked does not swallow the viewer's next seek", () => {
  const a = { currentTime: 0 }, b = { currentTime: 0 };
  const last: { current: MirrorMark<typeof a> } = { current: null };
  a.currentTime = 4;
  expect(mirrorSeek(a, b, last, 1000)).toBe(true);
  /* b had no metadata yet: no seeked came back. The viewer then seeks b somewhere else — it is mirrored. */
  b.currentTime = 9;
  expect(mirrorSeek(b, a, last, 1200)).toBe(true);
  expect(a.currentTime).toBe(9);
  /* a's echo is swallowed as usual. */
  expect(mirrorSeek(a, b, last, 1300)).toBe(false);
  /* A stale mark (long after, even at the same time) is not taken for an echo. */
  a.currentTime = 2;
  expect(mirrorSeek(a, b, last, 5000)).toBe(true);
  b.currentTime = 2;
  expect(mirrorSeek(b, a, last, 5000 + MIRROR_ECHO_MS + 1)).toBe(false);
  expect(last.current).toBeNull();
  b.currentTime = 6;
  expect(mirrorSeek(b, a, last, 9000)).toBe(true);
  expect(a.currentTime).toBe(6);
});

/* Atomik › a run waiting on another page is always reachable. */
test("the Atomik sheet opens a run waiting elsewhere on its page, or shows its gate when the Suites have no such page", () => {
  const run = (id: string, page: string, status: string) => ({ id, page, status });
  const here = run("r1", "deliver", "idle");
  expect(atomikSheetRuns(here, here)).toEqual({ elsewhere: null, gate: null });
  expect(atomikSheetRuns(run("r1", "deliver", "waiting"), run("r1", "deliver", "waiting")).gate?.id).toBe("r1");
  /* A page the Suites show: Open leads there, and its gate stays on that page. */
  const placed = atomikSheetRuns(null, run("r2", "deliver", "waiting"));
  expect(placed.elsewhere?.open).toEqual({ suite: "studio", page: "deliver" });
  expect(placed.gate).toBeNull();
  /* A page they do not (the legacy Generate page): no dead Open, the gate is here. */
  const unplaced = atomikSheetRuns(null, run("r3", "generate", "waiting"));
  expect(unplaced.elsewhere?.open).toBeNull();
  expect(unplaced.gate?.id).toBe("r3");
  expect(atomikSheetRuns(null, run("r3", "generate", "running")).gate).toBeNull();
  expect(atomikSheetRuns(null, run("r4", "generate", "done")).elsewhere).toBeNull();
});

/* Phone Home and Studio grid: the project as saved now, without downloading it on every open. */
test("the phone grid reads the full project only when its revision moved, and never hides a newer shell copy", () => {
  const p = { ...newProject("Grid"), id: "p1" };
  const known = { id: "p1", revision: 3, project: p };
  expect(freshRead("p1", [{ id: "p1", revision: 3 }], known)).toBe("known");
  expect(freshRead("p1", [{ id: "p1", revision: 4 }], known)).toBe("read");
  expect(freshRead("p1", [{ id: "other", revision: 3 }], known)).toBe("read");
  expect(freshRead("p1", [{ id: "p1" }], known)).toBe("read");
  expect(freshRead("p1", undefined, known)).toBe("read");
  expect(freshRead("p1", [{ id: "p1", revision: 3 }], null)).toBe("read");
  expect(freshRead("p2", [{ id: "p2", revision: 3 }], known)).toBe("read");
  const shell = { ...p, brief: "first loaded" }, saved = { ...p, brief: "saved now" };
  expect(freshOver({ base: shell, value: saved }, shell)).toBe(saved);
  /* The shell has since read a newer copy: it wins until the grid reads again. */
  const newer = { ...p, brief: "newer" };
  expect(freshOver({ base: shell, value: saved }, newer)).toBe(newer);
  expect(freshOver(null, shell)).toBe(shell);
  expect(freshOver({ base: shell, value: saved }, null)).toBeNull();
});
