import { test, expect } from "@playwright/test";
import { newProject, type Asset, type CanvasNode, type Project } from "../../lib/workbench/studio";
import { projectSchema } from "../../lib/workbench/studio-schema";
import { keepWiring, watchWiring, watchedWiring, wireShot, wiringDecision, type RigWiring } from "../../lib/shell/rig-wire";
import { DTC_ADS_MODEL, INITIAL_ADS, INITIAL_IMAGE_ADS, PRESET_TYPES, adsFromPreset, imageAdsFromPreset, presetKey, readPreset } from "../../lib/shell/business";
import { listedJobs, mirrorSeek, pendingJobIds } from "../../lib/shell/viral";
import { libraryHasTools } from "../../lib/shell/production-tools";
import { QUOTE_RETRY_MS, connectedJobKey, quoteLands, settledState } from "../../lib/shell/use-connected-job";
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

/* Viral › History lists what ran and keeps polling what the account still holds. */
test("History and Recent leave estimates out; every pending job is polled, the one submitted here first", () => {
  const jobs = [{ id: "q", status: "quoted" }, { id: "a", status: "accepted" }, { id: "c", status: "completed" }, { id: "u", status: "uncertain" }, { id: "d", status: "dispatching" }, { id: "f", status: "failed" }];
  expect(listedJobs(jobs).map((j) => j.id)).toEqual(["a", "c", "u", "d", "f"]);
  expect(pendingJobIds(jobs, null)).toEqual(["a", "u", "d"]);
  expect(pendingJobIds(jobs, "a")).toEqual(["a", "u", "d"]);
  expect(pendingJobIds(jobs, "new")).toEqual(["new", "a", "u", "d"]);
  expect(pendingJobIds([], null)).toEqual([]);
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
  const last: { current: typeof a | null } = { current: null };
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
