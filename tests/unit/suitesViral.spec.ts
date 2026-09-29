import { test, expect } from "@playwright/test";
import {
  INITIAL_VIRAL, REFERENCE_MAX, SOURCE_SECONDS, VIRAL_COPY, VIRAL_PAGES, VIRAL_RESOLUTIONS, aboutCredits, addMedia, canCancel, estimateLive, estimateReason, genjutsuInput,
  moveReference, takeRecipe, takeWords, transformVariant, viralBlock, viralRequest, viralTakes, type ViralMedia,
} from "../../lib/shell/viral";
import { GENJUTSU_LIMITS, GENJUTSU_MODELS, GENJUTSU_RESOLUTIONS } from "../../lib/genjutsuTypes";
import { generationRequestBody } from "../../lib/workbench/generation-request";
import { projectTakes } from "../../lib/workspace/takes";
import type { LibraryEntry } from "../../lib/workspace/library";
import type { Generation } from "../../lib/jobs";
import { generation } from "../helpers/workspaceFixtures";

/**
 * Viral on Particl's API key (lib/shell/viral.ts): the well's rule, what
 * blocks the primary, the exact body the shared dispatch sends, the estimate's
 * words, and History read from the project's Library alone — the key's takes
 * and the runs made earlier on the connected account, which the Library keeps.
 */
const video = (id: string, seconds: number | null): ViralMedia => ({ id: `upload:${id}`, sourceId: id, origin: "upload", kind: "video", name: `${id}.mp4`, url: null, seconds });
const image = (id: string, origin: "upload" | "generation" = "upload"): ViralMedia => ({ id: `${origin}:${id}`, sourceId: id, origin, kind: "image", name: `${id}.png`, url: null, seconds: null });
const ready = { hasProject: true, saved: true };
const project = { id: "draft-1", productionProjectId: "prod-1" };

test("the two pages are the two Genjutsu variants; the limits are the API key's own", () => {
  expect(VIRAL_PAGES).toEqual({ motion: "motion-transfer", swap: "object-swap" });
  expect(VIRAL_COPY.motion.verb).toBe("Transfer motion");
  expect(VIRAL_COPY.swap.promptLabel).toBe("What to replace · optional");
  /* 1–8 references (the API's own limit), a 4–30 s source, and exactly the resolutions admission accepts. */
  expect(REFERENCE_MAX).toBe(GENJUTSU_LIMITS.maxImages);
  expect(REFERENCE_MAX).toBe(8);
  expect(SOURCE_SECONDS).toEqual({ min: 4, max: 30 });
  expect(VIRAL_COPY.mediaLabel).toBe("Source video · 4–30 s, then up to 8 ordered reference images");
  expect([...VIRAL_RESOLUTIONS]).toEqual([...GENJUTSU_RESOLUTIONS]);
});

test("the well takes exactly one 4–30 s video at index 0 and up to 8 ordered images", () => {
  let s = INITIAL_VIRAL;
  expect(addMedia(s, video("long", 45)).note).toBe("The source video must be 4–30 s; this one is 45 s.");
  expect(addMedia(s, video("short", 2)).note).toBe("The source video must be 4–30 s; this one is 2 s.");
  ({ state: s } = addMedia(s, video("src", 12)));
  expect(s.source?.sourceId).toBe("src");
  expect(addMedia(s, video("src2", 8)).note).toBe("Source video replaced with src2.mp4.");
  ({ state: s } = addMedia(s, image("a")));
  ({ state: s } = addMedia(s, image("b", "generation")));
  expect(addMedia(s, image("a")).note).toBe("a.png is already a reference.");
  expect(moveReference(s, "generation:b", -1).references.map((r) => r.sourceId)).toEqual(["b", "a"]);
  expect(moveReference(s, "upload:a", -1)).toBe(s);
  let full = s;
  for (let i = 0; i < REFERENCE_MAX; i++) full = addMedia(full, image(`r${i}`)).state;
  expect(full.references).toHaveLength(REFERENCE_MAX);
  expect(addMedia(full, image("one-more")).note).toBe("Up to 8 reference images.");
});

test("the primary says why it cannot run, in order, and never asks for a connected account", () => {
  expect(viralBlock(INITIAL_VIRAL, { ...ready, hasProject: false })).toBe("Open a project first.");
  expect(viralBlock(INITIAL_VIRAL, { ...ready, saved: false })).toBe("Save this project first.");
  expect(viralBlock(INITIAL_VIRAL, ready)).toBe("Add one source video (4–30 s).");
  const withSource = addMedia(INITIAL_VIRAL, video("src", 10)).state;
  expect(viralBlock(withSource, ready)).toBe("Add at least one reference image.");
  const complete = addMedia(withSource, image("a")).state;
  expect(viralBlock(complete, ready)).toBeNull();
  /* A recipe restored with more than the API takes, a direction too long, or a size this route does not offer: said, never sent. */
  expect(viralBlock({ ...complete, references: Array.from({ length: 9 }, (_, i) => image(`x${i}`)) }, ready)).toBe("Up to 8 reference images: remove 1.");
  expect(viralBlock({ ...complete, prompt: "x".repeat(GENJUTSU_LIMITS.maxPromptChars + 1) }, ready)).toBe("Keep the direction under 5,000 characters.");
  expect(viralBlock({ ...complete, resolution: "4k" }, ready)).toMatch(/^Choose 480p, 720p/);
  for (const words of [viralBlock(INITIAL_VIRAL, ready), viralBlock(withSource, ready)]) expect(words).not.toMatch(/Connect|Engines|owner/i);
});

test("the request is the key route's transform body — exactly what the Subatomik studio sends — filed to the saved project", () => {
  const s = addMedia(addMedia(addMedia(INITIAL_VIRAL, video("src", 10)).state, image("a")).state, image("b", "generation")).state;
  const input = genjutsuInput("swap", { ...s, prompt: " keep the hands " })!;
  expect(input).toEqual({ variant: "object-swap", resolution: "720p", prompt: "keep the hands", source: { uploadId: "src" }, references: [{ uploadId: "a" }, { genId: "b" }] });
  const request = viralRequest(input, project);
  expect(request.endpoint).toBe("/api/generate");
  if (!("input" in request) || !request.input) throw new Error("a generate request");
  /* Quoted as is: no shot, ratio, duration or first frame — the source decides them. */
  expect(generationRequestBody(request.input)).toEqual({
    model: GENJUTSU_MODELS["object-swap"], task: "genjutsu", sourceUploadId: "src",
    references: [{ uploadId: "a", role: "reference_image" }, { genId: "b", role: "reference_image" }],
    resolution: "720p", prompt: "keep the hands", projectId: "prod-1", workbenchProjectId: "draft-1", refine: false,
  });
  /* Sent with the approval the press was given, and nothing else added. */
  expect(generationRequestBody({ ...request.input, maxCredits: 22, quoteFingerprint: "f".repeat(64) })).toMatchObject({ maxCredits: 22, quoteFingerprint: "f".repeat(64), task: "genjutsu" });
  /* A generated source goes by its generation id; Motion Transfer is its own model. */
  const fromGen = genjutsuInput("motion", { ...s, source: { ...video("clip", 12), id: "generation:clip", origin: "generation" } })!;
  const motion = viralRequest(fromGen, project);
  if (!("input" in motion) || !motion.input) throw new Error("a generate request");
  expect(generationRequestBody(motion.input)).toMatchObject({ model: GENJUTSU_MODELS["motion-transfer"], sourceGenId: "clip" });
  expect(generationRequestBody(motion.input)).not.toHaveProperty("sourceUploadId");
  expect(genjutsuInput("motion", INITIAL_VIRAL)).toBeNull();
});

test("the button wears an estimate for exactly this input, in the words every quote uses", () => {
  const now = 1_000_000;
  expect(estimateLive(null, "k", now)).toBe(false);
  expect(estimateLive({ key: "k", expiresAt: now + 1 }, "k", now)).toBe(true);
  expect(estimateLive({ key: "k", expiresAt: now }, "k", now)).toBe(false);
  expect(estimateLive({ key: "other", expiresAt: now + 1 }, "k", now)).toBe(false);
  expect(estimateReason(null, "k", now)).toBe("Getting the estimate…");
  expect(estimateReason({ key: "k", expiresAt: now + 1, credits: null, error: "A live transform price could not be verified. Nothing was submitted. Try a fresh quote." }, "k", now)).toMatch(/could not be verified/);
  expect(estimateReason({ key: "k", expiresAt: now + 1, credits: null, error: null }, "k", now)).toBe("No estimate for this input. Nothing was sent.");
  expect(estimateReason({ key: "k", expiresAt: now - 1, credits: 22, error: null }, "k", now)).toBe("Getting a fresh estimate…");
  expect(estimateReason({ key: "k", expiresAt: now + 1, credits: 22, error: null }, "k", now)).toBeNull();
  /* An estimate, never a promise; never shortened. */
  expect(aboutCredits(1234)).toBe("about 1,234 cr");
});

/* ── History: the project's Library alone ─────────────────────────────── */
const at = 1_790_000_000_000;
function entry(g: Generation): LibraryEntry {
  const [take] = projectTakes([{ origin: "generation", value: g }]);
  return { take, asset: { origin: "generation", value: g }, url: g.status === "succeeded" ? `/api/media/${g.id}` : null, media: g.status === "succeeded" ? (g.kind === "image" ? "image" : "video") : null };
}
const keyParams = (extra: Record<string, unknown> = {}) => ({
  resolution: "720p", rawPrompt: "keep the hands", sourceUploadId: "src", workbenchProjectId: "draft-1",
  references: [{ uploadId: "src", kind: "video", role: "reference_video" }, { uploadId: "a", kind: "image", role: "reference_image" }, { genId: "b", kind: "image", role: "reference_image" }],
  ...extra,
});
const keyTake = (id: string, fields: Partial<Generation> = {}) => generation({ id, kind: "video", model: GENJUTSU_MODELS["motion-transfer"], task: "genjutsu", provider: "higgsfield", params: keyParams(), createdAt: at, ...fields });
/* A run made earlier on the connected account, as the Library keeps it once collected (lib/higgsfield-consumer/original-identity.ts). */
const accountRun = (id: string, refs = 2, fields: Partial<Generation> = {}) => generation({
  id, kind: "video", model: "hf_mult_replace_object", provider: "higgsfield", prompt: "swap the bottle", createdAt: at - 60_000,
  params: { task: "genjutsu", resolution: "1080p", sourceGenId: "clip", references: Array.from({ length: refs }, (_, i) => ({ uploadId: `r${i}`, role: "reference_image", kind: "image" })), consumerJobId: "job-1", consumerCreditUnit: "higgsfield_credits" },
  ...fields,
});

test("History is the project's transform takes from the Library — the key's and the account's earlier runs — newest first, and nothing else", () => {
  const entries = [
    entry(generation({ id: "still", kind: "image", model: "gemini-3.1-flash-image", createdAt: at + 5 })),
    entry(keyTake("key-done", { createdAt: at + 3, creditsBilled: 22 })),
    entry(keyTake("key-swap", { model: GENJUTSU_MODELS["object-swap"], createdAt: at + 2, status: "running" })),
    entry(accountRun("acct")),
    /* The account's model id with some other task is not a transform. */
    entry(generation({ id: "odd", kind: "video", model: "hf_mult_motion_control", params: { task: "connected-generation" }, createdAt: at + 9 })),
  ];
  const all = viralTakes(entries);
  expect(all.map((t) => t.id)).toEqual(["key-done", "key-swap", "acct"]);
  expect(all.map((t) => [t.variant, t.account])).toEqual([["motion-transfer", false], ["object-swap", false], ["object-swap", true]]);
  expect(all[0]).toMatchObject({ resolution: "720p", prompt: "keep the hands", refs: 2, credits: 22, url: "/api/media/key-done" });
  /* Beside a composer, only that variant. */
  expect(viralTakes(entries, "object-swap").map((t) => t.id)).toEqual(["key-swap", "acct"]);
  expect(transformVariant("hf_mult_motion_control", { task: "genjutsu" })).toBe("motion-transfer");
  expect(transformVariant(GENJUTSU_MODELS["object-swap"])).toBe("object-swap");
  expect(transformVariant("marketing_studio_video", { task: "genjutsu" })).toBeNull();
});

test("a take's state is in words, and a failed one says what became of the charge only when that is on record", () => {
  const words = (g: Generation) => takeWords(viralTakes([entry(g)])[0]).label;
  expect(words(keyTake("q", { status: "queued" }))).toBe("Queued");
  expect(words(keyTake("r", { status: "running" }))).toBe("Rendering");
  expect(words(keyTake("h", { status: "held", params: keyParams({ held: { why: "credits", needs: 22 } }) }))).toBe("Held · needs 22 cr");
  expect(words(keyTake("d", { status: "succeeded", creditsBilled: 22 }))).toBe("Done");
  /* Particl's own ledger (lib/errors.ts failedChip): settled at nothing, settled at a charge, or not read — then just "Failed". */
  const failure = (charge: { credits: number; settled: boolean } | null) => ({ provider: "higgsfield" as const, stage: "run" as const, code: "failed", kind: "provider_error" as const, message: null, billing: null, payer: "platform" as const, charge });
  const unbilled = keyTake("f0", { status: "failed", creditsBilled: 0, failure: failure({ credits: 0, settled: true }) });
  expect(words(unbilled)).toBe("Failed · not billed");
  expect(words(keyTake("f1", { status: "failed", creditsBilled: 22, failure: failure({ credits: 22, settled: true }) }))).toBe("Failed · charged");
  /* A zero nobody confirmed is never called free. */
  expect(words(keyTake("f2", { status: "failed", creditsBilled: 0, costUsd: 0, error: "Could not store the original." }))).toBe("Failed");
  expect(words(keyTake("c", { status: "cancelled", creditsBilled: 0, failure: failure({ credits: 0, settled: true }) }))).toBe("Cancelled · not billed");
  /* The failed take's line: what happened, the charge, and the next step (lib/errors.ts failureLine), as the Takes page reads it. */
  const [take] = viralTakes([entry(unbilled)]);
  expect(take.failureLine).toBe(projectTakes([{ origin: "generation", value: unbilled }])[0].failureLine);
  expect(take.failureLine).toMatch(/not billed/i);
});

test("Cancel is offered only for a key take still waiting its turn, to the person who sent it or an admin", () => {
  const queued = viralTakes([entry(keyTake("q", { status: "queued", createdBy: "u-1" }))])[0];
  const running = viralTakes([entry(keyTake("r", { status: "running", createdBy: "u-1" }))])[0];
  const earlier = viralTakes([entry(accountRun("acct", 2, { status: "queued" }))])[0];
  expect(canCancel(queued, { userId: "u-1", role: "member" })).toBe(true);
  expect(canCancel(queued, { userId: "u-2", role: "member" })).toBe(false);
  expect(canCancel(queued, { userId: "u-2", role: "admin" })).toBe(true);
  expect(canCancel(queued, { userId: "u-2", role: "owner" })).toBe(true);
  expect(canCancel(running, { userId: "u-1", role: "member" })).toBe(false);
  expect(canCancel(earlier, { userId: "u-1", role: "owner" })).toBe(false);
});

test("Recreate reads a take's own recipe — key or account — and says when it cannot", () => {
  const [key] = viralTakes([entry(keyTake("k"))]);
  /* The source rides among a key take's references as its video: it is the source, not a still. */
  expect(takeRecipe(key)).toEqual({ variant: "motion-transfer", source: "upload:src", references: ["upload:a", "generation:b"], prompt: "keep the hands", resolution: "720p" });
  /* A run made earlier on the account keeps every still it used (the page loads the first eight and says so) and its own size. */
  const [earlier] = viralTakes([entry(accountRun("acct", 12))]);
  const recipe = takeRecipe(earlier);
  if ("error" in recipe) throw new Error(recipe.error);
  expect(recipe).toMatchObject({ variant: "object-swap", source: "generation:clip", prompt: "swap the bottle", resolution: "1080p" });
  expect(recipe.references).toHaveLength(12);
  for (const broken of [
    keyTake("x1", { params: keyParams({ references: undefined }) }),
    keyTake("x2", { params: keyParams({ sourceUploadId: undefined }) }),
    keyTake("x3", { params: keyParams({ references: [{ uploadId: "a", genId: "b", role: "reference_image" }] }) }),
    keyTake("x4", { params: keyParams({ references: [{ uploadId: "a", role: "first_frame" }] }) }),
  ]) expect(takeRecipe(viralTakes([entry(broken)])[0])).toHaveProperty("error");
});
