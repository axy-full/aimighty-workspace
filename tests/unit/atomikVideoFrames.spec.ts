import { test, expect } from "@playwright/test";
import { atomikFramesKey, prepareAtomikVideoFrames, type AtomikFrameCache } from "../../lib/workbench/atomik-video-frames";
import type { AtomikVideoFrame } from "../../lib/workbench/atomik-reference-types";
import type { Asset } from "../../lib/workbench/studio";

/** Reopening the Atomik dialog, or changing its selection, reuses the stills a video already has. */
const video = (id: string, extra: Partial<Asset> = {}): Asset => ({
  id, uploadId: "up-" + id, name: id + ".mp4", kind: "video", category: "Reference", url: "/api/uploads/up-" + id,
  description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [], ...extra,
});
function harness() {
  const store = new Map<string, AtomikVideoFrame[]>();
  const cache: AtomikFrameCache = { get: (key) => store.get(key), set: (key, frames) => void store.set(key, frames) };
  let sampled = 0, saved = 0;
  const deps = {
    cache,
    sample: async (_asset: Asset, _signal: AbortSignal, referenceAd = false) => {
      sampled++;
      return [0.1, 0.5, 0.9].map((timeSeconds) => ({ blob: new Blob(["still"]), timeSeconds, ...(referenceAd ? { durationSeconds: 10 } : {}) }));
    },
    save: async () => "still-" + ++saved,
  };
  return { store, deps, counts: () => ({ sampled, saved }) };
}

test("a video's stills are saved once and reused on every later preparation", async () => {
  const h = harness(), signal = new AbortController().signal;
  const first = await prepareAtomikVideoFrames([video("a")], "project-1", "scope-a", signal, false, h.deps);
  expect(first.map((f) => f.uploadId)).toEqual(["still-1", "still-2", "still-3"]);
  expect(h.counts()).toEqual({ sampled: 1, saved: 3 });
  // The dialog reopens, and then a second video joins the selection: only the new video is sampled and saved.
  expect(await prepareAtomikVideoFrames([video("a")], "project-1", "scope-a", signal, false, h.deps)).toEqual(first);
  const both = await prepareAtomikVideoFrames([video("a"), video("b")], "project-1", "scope-a", signal, false, h.deps);
  expect(both.map((f) => f.uploadId)).toEqual(["still-1", "still-2", "still-3", "still-4", "still-5", "still-6"]);
  expect(h.counts()).toEqual({ sampled: 2, saved: 6 });
});

test("stills are never shared across scopes, projects, versions or the reference-ad sampling", async () => {
  const h = harness(), signal = new AbortController().signal;
  await prepareAtomikVideoFrames([video("a")], "project-1", "scope-a", signal, false, h.deps);
  await prepareAtomikVideoFrames([video("a")], "project-1", "scope-b", signal, false, h.deps);
  await prepareAtomikVideoFrames([video("a")], "project-2", "scope-a", signal, false, h.deps);
  await prepareAtomikVideoFrames([video("a", { version: 2 })], "project-1", "scope-a", signal, false, h.deps);
  const analysis = await prepareAtomikVideoFrames([video("a")], "project-1", "scope-a", signal, true, h.deps);
  expect(analysis.every((f) => f.durationSeconds === 10)).toBe(true);
  expect(h.counts()).toEqual({ sampled: 5, saved: 15 });
  expect(atomikFramesKey("scope-a", "project-1", video("a"), false)).not.toBe(atomikFramesKey("scope-a", "project-1", video("a"), true));
});

test("an unreadable or foreign cache entry is ignored, and a cancelled preparation caches nothing", async () => {
  const h = harness(), signal = new AbortController().signal;
  h.store.set(atomikFramesKey("scope-a", "project-1", video("a"), false), [{ assetId: "other", uploadId: "x", timeSeconds: 1 }]);
  const fresh = await prepareAtomikVideoFrames([video("a")], "project-1", "scope-a", signal, false, h.deps);
  expect(fresh.map((f) => f.assetId)).toEqual(["a", "a", "a"]);
  const aborted = new AbortController();
  aborted.abort();
  await expect(prepareAtomikVideoFrames([video("c")], "project-1", "scope-a", aborted.signal, false, h.deps)).rejects.toThrow("cancelled");
  expect(h.store.has(atomikFramesKey("scope-a", "project-1", video("c"), false))).toBe(false);
});
