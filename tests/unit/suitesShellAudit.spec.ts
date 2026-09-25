import { test, expect } from "@playwright/test";
import { newProject, type Asset, type CanvasNode, type Project } from "../../lib/workbench/studio";
import { projectSchema } from "../../lib/workbench/studio-schema";
import { keepWiring, watchWiring, watchedWiring, wireShot, wiringDecision, type RigWiring } from "../../lib/shell/rig-wire";
import { DTC_ADS_MODEL, INITIAL_ADS, INITIAL_IMAGE_ADS, PRESET_TYPES, adsFromPreset, imageAdsFromPreset, presetKey, readPreset } from "../../lib/shell/business";
import { MIRROR_ECHO_MS, listedJobs, mirrorSeek, pendingJobIds, runAfterStatus, type MirrorMark, type ViralRun } from "../../lib/shell/viral";
import { libraryHasTools } from "../../lib/shell/production-tools";
import { QUOTE_RETRY_MS, RESUME_TRIES, composerBusy, connectedJobKey, forgetJob, quoteLands, resumeLands, resumeRetry, settledState, submitRefused } from "../../lib/shell/use-connected-job";
import { branchFromTake } from "../../lib/production/rig-build";
import { atomikSheetRuns } from "../../lib/shell/atomik-sheet";
import { freshOver, freshRead } from "../../lib/shell/use-fresh-project";
import type { ConnectedJob } from "../../lib/higgsfield-consumer/generation-client";

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

/* Business › Setup → a composer. */
test("Setup's picks reach the composer they were meant for, and only what that composer takes", () => {
  expect(presetKey("ads")).not.toBe(presetKey("dtc"));
  expect(PRESET_TYPES.dtc).not.toContain("avatar");
  expect(readPreset(JSON.stringify({ type: "avatar", id: "a1" }), "ads")).toEqual({ type: "avatar", id: "a1" });
  expect(readPreset(JSON.stringify({ type: "avatar", id: "a1" }), "dtc")).toBeNull();
  expect(readPreset("not json", "ads")).toBeNull();
  expect(readPreset(null, "dtc")).toBeNull();
  expect(adsFromPreset({ type: "product", id: "p1" })).toEqual({ ...INITIAL_ADS, productId: "p1" });
  expect(adsFromPreset(null)).toBe(INITIAL_ADS);
  /* Products, brand kits and styles ride only on the DTC engine, so a pick of one switches to it. */
  expect(imageAdsFromPreset({ type: "product", id: "p1" })).toEqual({ ...INITIAL_IMAGE_ADS, engine: DTC_ADS_MODEL, productIds: ["p1"] });
  expect(imageAdsFromPreset({ type: "brand_kit", id: "bk1" })).toMatchObject({ engine: DTC_ADS_MODEL, brandKitId: "bk1" });
  expect(imageAdsFromPreset({ type: "image_style", id: "st1" })).toMatchObject({ engine: DTC_ADS_MODEL, styleId: "st1" });
  expect(imageAdsFromPreset(null)).toBe(INITIAL_IMAGE_ADS);
});

/* Business › a submitted job is resumed, not stranded. */
test("a Business job is remembered per project and composer, and a status read settles the composer", () => {
  expect(connectedJobKey("ads", "p1")).not.toBe(connectedJobKey("dtc", "p1"));
  expect(connectedJobKey("ads", "p1")).not.toBe(connectedJobKey("ads", "p2"));
  const job = (status: ConnectedJob["status"]) => ({ id: "j", status } as ConnectedJob);
  expect(settledState(job("accepted")).phase).toBe("running");
  expect(settledState(job("uncertain")).phase).toBe("running");
  expect(settledState(job("completed")).phase).toBe("done");
  expect(settledState(job("failed"))).toMatchObject({ phase: "failed", error: expect.stringContaining("not billed") });
  expect(QUOTE_RETRY_MS).toBeGreaterThanOrEqual(10_000);
  /* A price read while a remembered job was being resumed never replaces it (its polling would stop). */
  const running = settledState(job("accepted"));
  expect(quoteLands(running, { phase: "quoted", job: job("quoted") })).toBe(running);
  expect(quoteLands({ phase: "submitting", job: job("quoted") }, { phase: "quoting" }).phase).toBe("submitting");
  expect(quoteLands({ phase: "idle" }, { phase: "quoting" }).phase).toBe("quoting");
  expect(quoteLands(settledState(job("completed")), { phase: "quoting" }).phase).toBe("quoting");
});

test("a resumed Business job lands only on the composer still waiting for it, and never clears a newer job", () => {
  const job = (id: string, status: ConnectedJob["status"]) => ({ id, status } as ConnectedJob);
  /* While the remembered job is read back the composer prices and submits nothing. */
  expect(composerBusy("resuming")).toBe(true);
  expect(composerBusy("submitting")).toBe(true);
  expect(composerBusy("running")).toBe(true);
  expect(composerBusy("quoted")).toBe(false);
  expect(quoteLands({ phase: "resuming" }, { phase: "quoted", job: job("q", "quoted") }).phase).toBe("resuming");
  /* The read for J1 comes back after J2 was submitted: J2 keeps the composer (and its polling). */
  const j2 = { phase: "running" as const, job: job("j2", "accepted") };
  expect(resumeLands(j2, settledState(job("j1", "completed")))).toBe(j2);
  expect(resumeLands({ phase: "submitting", job: job("j2", "quoted") }, settledState(job("j1", "accepted"))).phase).toBe("submitting");
  expect(resumeLands({ phase: "resuming" }, settledState(job("j1", "completed")))).toMatchObject({ phase: "done", job: { id: "j1" } });
  /* A status read that finds the job still quoted: the submit never reached the account. */
  expect(settledState(job("j", "quoted"))).toMatchObject({ phase: "failed", error: expect.stringContaining("nothing was billed") });

  /* Compare-and-remove: an older job settling leaves a newer job's id in place. */
  const kept = new Map<string, string>([["k", "j2"]]);
  const storage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) };
  forgetJob(storage, "k", "j1");
  expect(kept.get("k")).toBe("j2");
  forgetJob(storage, "k", "j2");
  expect(kept.has("k")).toBe(false);
  forgetJob(null, "k", "j2");

  /* A missed resume read: forget what the server does not know, stop where this person may not read it (keeping the id), back off otherwise, and give up in the end. */
  expect(resumeRetry(404, 1)).toBe("forget");
  expect(resumeRetry(400, 1)).toBe("forget");
  expect(resumeRetry(403, 1)).toBe("stop");
  expect(resumeRetry(401, 1)).toBe("stop");
  const waits = Array.from({ length: RESUME_TRIES - 1 }, (_, i) => resumeRetry(503, i + 1));
  expect(waits).toEqual([4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  expect(resumeRetry(Number.NaN, 1)).toBe(4000);
  expect(resumeRetry(503, RESUME_TRIES)).toBe("stop");

  /* A refused submit (4xx) sent nothing; a 5xx or a lost reply may have reached the account, so its status is read, never re-sent. */
  expect(submitRefused(409)).toBe(true);
  expect(submitRefused(429)).toBe(true);
  expect(submitRefused(503)).toBe(false);
  expect(submitRefused(Number.NaN)).toBe(false);
});

/* Viral › History lists what ran and keeps polling what the account still holds. */
test("History and Recent leave estimates out; every pending job is polled, the one submitted here first", () => {
  const jobs = [{ id: "q", status: "quoted" }, { id: "a", status: "accepted" }, { id: "c", status: "completed" }, { id: "u", status: "uncertain" }, { id: "d", status: "dispatching" }, { id: "f", status: "failed" }];
  expect(listedJobs(jobs).map((j) => j.id)).toEqual(["a", "c", "u", "d", "f"]);
  expect(pendingJobIds(jobs, null)).toEqual(["a", "u", "d"]);
  expect(pendingJobIds(jobs, "a")).toEqual(["a", "u", "d"]);
  expect(pendingJobIds(jobs, "new")).toEqual(["new", "a", "u", "d"]);
  expect(pendingJobIds([], null)).toEqual([]);
});

test("a Viral submit whose reply was lost follows the account: listed as taken, the run shows it rendering, then done", () => {
  type J = { id: string; status: string };
  const lost: ViralRun<J> = { phase: "failed", job: { id: "j", status: "quoted" }, error: "The connected account could not complete this request." };
  expect(runAfterStatus(lost, { id: "j", status: "accepted" })).toEqual({ phase: "running", job: { id: "j", status: "accepted" } });
  expect(runAfterStatus({ phase: "running", job: { id: "j", status: "accepted" } }, { id: "j", status: "completed" }).phase).toBe("done");
  expect(runAfterStatus({ phase: "running", job: { id: "j", status: "accepted" } }, { id: "j", status: "failed" })).toMatchObject({ phase: "failed", error: expect.stringContaining("not billed") });
  /* Another listed job never takes over the composer, nor does anything replace a finished or idle one. */
  expect(runAfterStatus(lost, { id: "other", status: "completed" })).toBe(lost);
  const done: ViralRun<J> = { phase: "done", job: { id: "j", status: "completed" } };
  expect(runAfterStatus(done, { id: "j", status: "accepted" })).toBe(done);
  expect(runAfterStatus({ phase: "idle" }, { id: "j", status: "accepted" }).phase).toBe("idle");
  expect(runAfterStatus({ phase: "failed", job: null, error: "x" }, { id: "j", status: "accepted" }).phase).toBe("failed");
});

/* Library › Tools only where the page has tools of its own. */
test("the Library has Tools on the Studio stages and the spec pages, not on Gen, Business, Viral or the phone's pickers", () => {
  expect(libraryHasTools("suite", "studio", "brief")).toBe(true);
  expect(libraryHasTools("suite", "studio", "deliver")).toBe(true);
  expect(libraryHasTools("suite", "atomik", "agent")).toBe(true);
  expect(libraryHasTools("gen", "studio", "brief")).toBe(false);
  expect(libraryHasTools("suite", "business", "ads")).toBe(false);
  expect(libraryHasTools("suite", "viral", "history")).toBe(false);
  expect(libraryHasTools("suite", "studio", "home")).toBe(false);
  expect(libraryHasTools("suite", "studio", "stages")).toBe(false);
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
