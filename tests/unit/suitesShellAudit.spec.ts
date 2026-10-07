import { test, expect } from "@playwright/test";
import { newProject, type Asset, type CanvasNode, type Project } from "../../lib/workbench/studio";
import { projectSchema } from "../../lib/workbench/studio-schema";
import { keepWiring, watchWiring, watchedWiring, wireShot, wiringDecision, type RigWiring } from "../../lib/shell/rig-wire";
import { MIRROR_ECHO_MS, mirrorSeek, type MirrorMark } from "../../lib/shell/viral";
import { libraryHasTools } from "../../lib/shell/production-tools";
import { branchFromTake } from "../../lib/production/rig-build";
import { atomikSheetRuns } from "../../lib/shell/atomik-sheet";
import { freshOver, freshRead } from "../../lib/shell/use-fresh-project";

/* Production › Rig › "Let the agent wire this shot": applied once, recorded on the shot. */
const img = (id: string): Asset => ({ id, generationId: id, name: id, kind: "image", category: "Storyboard", url: `/api/media/${id}`, description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [] });
const shot = (id: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({ id, title: id, type: "scene", x: 0, y: 0, width: 300, linked: [], mode: "Video", ...extra });
const project = (nodes: CanvasNode[] = [shot("s1")]): Project => ({ ...newProject("Rig"), nodes, assets: [img("a1"), img("a2")] });
const wiring: RigWiring = { nodeId: "s1", prompt: "A fox crosses the ice.", notes: "Hold wide.", inputs: ["a1", "a2", "missing"], firstFrame: "a1" };
const JOB = "wb_development_1f2e3d4c-5b6a-4798-8a9b-0c1d2e3f4a5b";

test("the agent's wiring lands once: prompt, notes, inputs and first frame, with the run recorded on the shot and saved with the draft", () => {
  const { project: wired, inputs } = wireShot(project(), "s1", JOB, wiring);
  const node = wired.nodes.find((n) => n.id === "s1")!;
  expect(node.text).toBe("A fox crosses the ice.");
  expect(node.operations?.find((op) => op.kind === "direction")?.values.note).toBe("Hold wide.");
  expect(inputs).toBe(2);
  expect(node.linked).toHaveLength(2);
  expect(node.firstFrameId).toBe("a1");
  expect(node.wiredJobId).toBe(JOB);
  /* The record survives the draft's own schema, so another tab, device or teammate reads it. */
  expect(projectSchema.parse(wired).nodes.find((n) => n.id === "s1")!.wiredJobId).toBe(JOB);
  expect(projectSchema.safeParse({ ...wired, nodes: wired.nodes.map((n) => ({ ...n, wiredJobId: "../other" })) }).success).toBe(false);

  /* Recorded: never again, watched or not. */
  expect(wiringDecision(node, JOB, true)).toBe("applied");
  expect(wiringDecision(node, JOB, false)).toBe("applied");
  /* A shot that took an earlier recorded run takes the newer one; an unrecorded shot takes it only if this tab watched it finish, and is otherwise asked. */
  expect(wiringDecision({ wiredJobId: "wb_development_older" }, JOB, false)).toBe("apply");
  expect(wiringDecision(shot("s1"), JOB, true)).toBe("apply");
  expect(wiringDecision(shot("s1"), JOB, false)).toBe("offer");
  expect(wiringDecision(undefined, JOB, true)).toBe("applied");
  expect(watchedWiring(JOB)).toBe(false);
  watchWiring(JOB);
  expect(watchedWiring(JOB)).toBe(true);
  /* Keep mine: the run is recorded and the shot is left as the director had it. */
  const kept = keepWiring(project([shot("s1", { text: "Mine." })]), "s1", JOB).nodes.find((n) => n.id === "s1")!;
  expect(kept.text).toBe("Mine.");
  expect(kept.linked).toHaveLength(0);
  expect(wiringDecision(kept, JOB, false)).toBe("applied");

  /* A shot branched from a take is a new shot: it has taken no run, so a later one is offered, not applied. */
  const branched = branchFromTake(wired, "s1", img("a2"));
  const branch = branched.project.nodes.find((n) => n.id === branched.id)!;
  expect(branch.wiredJobId).toBeUndefined();
  expect(wiringDecision(branch, "wb_development_newer", false)).toBe("offer");

  /* An input already linked is not linked twice; a locked shot refuses in words. */
  const again = wireShot(wired, "s1", JOB, wiring);
  expect(again.inputs).toBe(0);
  expect(() => wireShot(project([shot("s1", { locked: true })]), "s1", JOB, wiring)).toThrow("Unlock this shot");
});

/* Viral › History and Recent are the project's Library alone (tests/unit/suitesViral.spec.ts): nothing is read from the account. */

/* Library › Tools only where the page has tools of its own. */
test("the Library has Tools on the spec pages, not on Studio, Gen, Business, Viral or the phone's pickers", () => {
  /* Studio has no stage pages: the board carries its own Library drawer. */
  expect(libraryHasTools("suite", "studio")).toBe(false);
  expect(libraryHasTools("suite", "atomik")).toBe(true);
  expect(libraryHasTools("gen", "studio")).toBe(false);
  expect(libraryHasTools("suite", "business")).toBe(false);
  expect(libraryHasTools("suite", "viral")).toBe(false);
});

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
