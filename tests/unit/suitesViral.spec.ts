import { test, expect } from "@playwright/test";
import {
  INITIAL_VIRAL, REFERENCE_MAX, VIRAL_COPY, VIRAL_PAGES, addMedia, estimateLive, estimateReason, genjutsuInput, moveReference, viralBlock, type ViralMedia,
} from "../../lib/shell/viral";
import { consumerGenjutsuInputSchema } from "../../lib/higgsfield-consumer/genjutsu-contract";

const video = (id: string, seconds: number | null): ViralMedia => ({ id: `upload:${id}`, sourceId: id, origin: "upload", kind: "video", name: `${id}.mp4`, url: null, seconds });
const image = (id: string, origin: "upload" | "generation" = "upload"): ViralMedia => ({ id: `${origin}:${id}`, sourceId: id, origin, kind: "image", name: `${id}.png`, url: null, seconds: null });
const ready = { connected: true, owner: true, hasProject: true };

test("the two pages are the two Genjutsu variants, with the prototype's words", () => {
  expect(VIRAL_PAGES).toEqual({ motion: "motion-transfer", swap: "object-swap" });
  expect(VIRAL_COPY.motion.verb).toBe("Transfer motion");
  expect(VIRAL_COPY.swap.promptLabel).toBe("What to replace · optional");
  expect(VIRAL_COPY.mediaLabel).toBe("Source video · 4–30 s, then up to 30 ordered reference images");
});

test("the well takes exactly one 4–30 s video at index 0 and up to 30 ordered images", () => {
  let s = INITIAL_VIRAL;
  expect(addMedia(s, video("long", 45)).note).toBe("The source video must be 4–30 s; this one is 45 s.");
  ({ state: s } = addMedia(s, video("src", 12)));
  expect(s.source?.sourceId).toBe("src");
  const replaced = addMedia(s, video("src2", 8));
  expect(replaced.note).toBe("Source video replaced with src2.mp4.");
  ({ state: s } = addMedia(s, image("a")));
  ({ state: s } = addMedia(s, image("b", "generation")));
  expect(addMedia(s, image("a")).note).toBe("a.png is already a reference.");
  expect(moveReference(s, "generation:b", -1).references.map((r) => r.sourceId)).toEqual(["b", "a"]);
  expect(moveReference(s, "upload:a", -1)).toBe(s);
  let full = s;
  for (let i = 0; i < REFERENCE_MAX; i++) full = addMedia(full, image(`r${i}`)).state;
  expect(full.references).toHaveLength(REFERENCE_MAX);
  expect(addMedia(full, image("one-more")).note).toBe(`Up to ${REFERENCE_MAX} reference images.`);
});

test("the primary says why it cannot run, in order", () => {
  expect(viralBlock(INITIAL_VIRAL, { ...ready, hasProject: false })).toBe("Open a project first.");
  expect(viralBlock(INITIAL_VIRAL, { ...ready, owner: false })).toBe("Only the workspace owner can run the connected account.");
  expect(viralBlock(INITIAL_VIRAL, { ...ready, connected: false })).toBe("Connect the account in Workspace › Engines.");
  expect(viralBlock(INITIAL_VIRAL, ready)).toBe("Add one source video (4–30 s).");
  const withSource = addMedia(INITIAL_VIRAL, video("src", 10)).state;
  expect(viralBlock(withSource, ready)).toBe("Add at least one reference image.");
  expect(viralBlock(addMedia(withSource, image("a")).state, ready)).toBeNull();
});

test("the input is the existing service's own contract: source at index 0, ordered references, distinct originals", () => {
  const s = addMedia(addMedia(addMedia(INITIAL_VIRAL, video("src", 10)).state, image("a")).state, image("b", "generation")).state;
  const input = genjutsuInput("swap", { ...s, prompt: " keep the hands " })!;
  expect(input).toEqual({ variant: "object-swap", resolution: "720p", prompt: "keep the hands", source: { uploadId: "src" }, references: [{ uploadId: "a" }, { genId: "b" }] });
  expect(consumerGenjutsuInputSchema.safeParse(input).success).toBe(true);
  expect(genjutsuInput("motion", INITIAL_VIRAL)).toBeNull();
});

test("only a live estimate for exactly this input lets it run", () => {
  const now = 1_000_000;
  expect(estimateLive(null, "k", now)).toBe(false);
  expect(estimateLive({ key: "k", expiresAt: now + 1 }, "k", now)).toBe(true);
  expect(estimateLive({ key: "k", expiresAt: now }, "k", now)).toBe(false);
  expect(estimateLive({ key: "other", expiresAt: now + 1 }, "k", now)).toBe(false);
  expect(estimateReason(null, "k", now)).toBe("Waiting for the account’s estimate…".replace("’", "'"));
  expect(estimateReason({ key: "k", expiresAt: now + 1, credits: null, error: "The connected account could not complete this request." }, "k", now)).toBe("The connected account could not complete this request.");
  expect(estimateReason({ key: "k", expiresAt: now - 1, credits: 22, error: null }, "k", now)).toBe("The estimate expired. A fresh one is being read.");
  expect(estimateReason({ key: "k", expiresAt: now + 1, credits: 22, error: null }, "k", now)).toBeNull();
});
