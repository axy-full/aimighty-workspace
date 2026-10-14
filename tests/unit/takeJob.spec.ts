import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";
import { JOBS, isJob, jobHint, jobOf, jobOfRow } from "../../lib/takeJob";

/**
 * A take's job label (lib/takeJob.ts; docs/plans/step-0-data.md item 1): derived from facts, a hint only where the facts do not decide and only if it is on the closed list
 * and fits the kind; takes made before it read a label only in the certain cases, in code and in SQL alike, and everything else is null. Nothing renders, nothing is billed.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-take-job-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

test("the closed list, and a hint that must be on it, fit the kind and, where the take decides the job itself, agree with the take", () => {
  expect(JOBS).toHaveLength(14);
  expect(JOBS.every(isJob)).toBe(true);
  for (const bad of ["", "Shot", "shot ", "movie", 3, {}, ["shot"], true]) expect(isJob(bad), JSON.stringify(bad)).toBe(false);
  expect(jobHint(undefined, { kind: "video" })).toEqual({ hint: null });
  expect(jobHint(null, { kind: "image" })).toEqual({ hint: null });
  expect(jobHint("storyboard", { kind: "image", task: "generate" })).toEqual({ hint: "storyboard" });
  expect(jobHint("ad", { kind: "video", task: "generate" })).toEqual({ hint: "ad" });
  expect(jobHint("shot", { kind: "video", task: "generate" })).toEqual({ hint: "shot" });
  expect(jobHint("other", { kind: "audio", task: "speech" })).toEqual({ hint: "other" });
  for (const [hint, kind] of [["storyboard", "video"], ["keyframe", "audio"], ["shot_final", "image"], ["voice", "video"], ["music", "image"], ["cast", "video"], ["ad", "audio"]] as const)
    expect(jobHint(hint, { kind, task: "generate", draft: true, finalOf: true }), `${hint} on ${kind}`).toHaveProperty("error");
  for (const bad of ["", "Shot", 7, ["shot"], {}, false]) expect(jobHint(bad, { kind: "video" }), JSON.stringify(bad)).toHaveProperty("error");
  /* fix, upscale, draft, final, voice, music and sound are the take's own to decide: a hint that the take does not bear out is refused, one it does is just the fact. */
  const plainClip = { kind: "video", task: "generate" } as const, plainStill = { kind: "image", task: "generate" } as const;
  for (const hint of ["fix", "upscale", "shot_draft", "shot_final"] as const) expect(jobHint(hint, plainClip), `${hint} on a plain clip`).toHaveProperty("error");
  for (const hint of ["fix", "upscale"] as const) expect(jobHint(hint, plainStill), `${hint} on a plain still`).toHaveProperty("error");
  expect(jobHint("upscale", { kind: "image", task: "outpaint" })).toHaveProperty("error");
  expect(jobHint("fix", { kind: "video", task: "upscale" })).toHaveProperty("error");
  for (const hint of ["voice", "music"] as const) expect(jobHint(hint, { kind: "audio", task: "sound" }), `${hint} on a sound effect`).toHaveProperty("error");
  expect(jobHint("fix", { kind: "video", task: "edit" })).toEqual({ hint: "fix" });
  expect(jobHint("upscale", { kind: "image", task: "upscale" })).toEqual({ hint: "upscale" });
  expect(jobHint("shot_draft", { kind: "video", task: "generate", draft: true })).toEqual({ hint: "shot_draft" });
  expect(jobHint("shot_final", { kind: "video", task: "generate", finalOf: true })).toEqual({ hint: "shot_final" });
  expect(jobHint("sound", { kind: "audio", task: "sound" })).toEqual({ hint: "sound" });
});

test("the label comes from the facts first: the task, a final, a draft, the audio task; then a valid hint; then a default", () => {
  /* Sound. */
  for (const [task, job] of [["speech", "voice"], ["dialogue", "voice"], ["voiceChange", "voice"], ["dub", "voice"], ["sound", "sound"], ["music", "music"]] as const)
    expect(jobOf({ kind: "audio", task }), task).toBe(job);
  expect(jobOf({ kind: "audio", task: "speech", hint: "other" })).toBe("voice");
  /* A clip. */
  expect(jobOf({ kind: "video", task: "generate" })).toBe("other");
  expect(jobOf({ kind: "video", task: "generate", onShot: true })).toBe("shot");
  expect(jobOf({ kind: "video", task: "generate", onShot: true, hint: "ad" })).toBe("ad");
  expect(jobOf({ kind: "video", task: "generate", draft: true, hint: "shot_final" })).toBe("shot_draft");
  expect(jobOf({ kind: "video", task: "generate", finalOf: true, onShot: true })).toBe("shot_final");
  for (const task of ["edit", "extend", "motion", "reframe", "genjutsu"]) expect(jobOf({ kind: "video", task, hint: "shot" }), task).toBe("fix");
  expect(jobOf({ kind: "video", task: "upscale" })).toBe("upscale");
  /* A still. */
  expect(jobOf({ kind: "image", task: "generate" })).toBe("other");
  expect(jobOf({ kind: "image", task: "generate", useAs: "first" })).toBe("keyframe");
  expect(jobOf({ kind: "image", task: "generate", useAs: "cast" })).toBe("cast");
  expect(jobOf({ kind: "image", task: "generate", useAs: "loose" })).toBe("other");
  expect(jobOf({ kind: "image", task: "generate", useAs: "first", hint: "storyboard" })).toBe("storyboard");
  expect(jobOf({ kind: "image", task: "upscale" })).toBe("upscale");
  expect(jobOf({ kind: "image", task: "outpaint" })).toBe("fix");
  expect(jobOf({ kind: "image", task: "cutout" })).toBe("fix");
});

const row = (kind: string, task: string, params: unknown = {}) => ({ kind, task, params });

test("a take made before the label reads one only where the facts are certain; everything else is null, never a guess", () => {
  expect(jobOfRow(row("audio", "speech"))).toBe("voice");
  expect(jobOfRow(row("audio", "voiceChange"))).toBe("voice");
  expect(jobOfRow(row("audio", "generate", { task: "dub" }))).toBe("voice");
  expect(jobOfRow(row("audio", "sound"))).toBe("sound");
  expect(jobOfRow(row("audio", "music"))).toBe("music");
  expect(jobOfRow(row("audio", "generate"))).toBeNull();
  expect(jobOfRow(row("video", "upscale"))).toBe("upscale");
  expect(jobOfRow(row("video", "edit"))).toBe("fix");
  expect(jobOfRow(row("image", "outpaint"))).toBe("fix");
  expect(jobOfRow(row("video", "generate", { finalOf: "gen_draft" }))).toBe("shot_final");
  expect(jobOfRow(row("video", "generate", { draft: true }))).toBe("shot_draft");
  expect(jobOfRow(row("video", "generate", { finalGenId: "gen_final" }))).toBe("shot_draft");
  /* Old stills and plain clips cannot honestly be told apart. */
  expect(jobOfRow(row("image", "generate"))).toBeNull();
  expect(jobOfRow(row("video", "generate"))).toBeNull();
  expect(jobOfRow(row("image", "generate", { useAs: "first", cast: ["Ana"] }))).toBeNull();
  /* The stored label wins; a label that is not on the list is not one; unreadable params are no facts. */
  expect(jobOfRow(row("image", "generate", { job: "storyboard" }))).toBe("storyboard");
  expect(jobOfRow(row("image", "generate", JSON.stringify({ job: "cast" })))).toBe("cast");
  expect(jobOfRow(row("image", "generate", { job: "movie" }))).toBeNull();
  expect(jobOfRow(row("video", "generate", "{not json"))).toBeNull();
  expect(jobOfRow({})).toBeNull();
});

test("the ?job= filter reads the same label as the code: the stored one, and the certain cases for old takes; the read carries it", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { listGenerations } = await import("../../lib/jobs");
  const ws: TenantWorkspace = {
    id: "ws_take_job", name: "ws_take_job", slug: "ws_take_job", legacy: false, dbUrl: `file:${path.join(dir, "ws_take_job.db")}`, dbToken: null, keys: {}, usesPlatformKeys: false, allowanceUsd: null,
    ownerId: "u1", createdAt: 0, gatewayKeyId: null, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null,
  };
  const takes: [string, string, string, Record<string, unknown>][] = [
    ["a1", "audio", "speech", {}], ["a2", "audio", "sound", {}], ["a3", "audio", "music", {}], ["a4", "audio", "generate", { task: "dub" }], ["a5", "audio", "generate", {}],
    ["v1", "video", "generate", {}], ["v2", "video", "generate", { job: "shot" }], ["v3", "video", "generate", { draft: true }], ["v4", "video", "generate", { finalOf: "v3" }],
    ["v5", "video", "extend", {}], ["v6", "video", "generate", { finalGenId: "v4" }], ["i1", "image", "generate", {}], ["i2", "image", "generate", { job: "storyboard" }],
    ["i3", "image", "upscale", {}], ["i4", "image", "generate", { job: "cast" }], ["i5", "image", "generate", { job: "movie" }],
  ];
  await runInTenant(ws, async () => {
    await ready();
    await db().batch(takes.map(([id, kind, task, params], n) => ({
      sql: `INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,kind,task,deleted,created_by) VALUES(?,'m','p',?,'succeeded',?,?,?,?,0,'u1')`,
      args: [id, JSON.stringify(params), 100 + n, 100 + n, kind, task],
    })), "write");
    const all = await listGenerations({ viewer: null, limit: 100 });
    expect(all).toHaveLength(takes.length);
    const byId = Object.fromEntries(all.map((g) => [g.id, g.job]));
    for (const [id, kind, task, params] of takes) expect(byId[id], id).toBe(jobOfRow({ kind, task, params }));
    for (const job of JOBS) {
      const want = takes.filter(([, kind, task, params]) => jobOfRow({ kind, task, params }) === job).map(([id]) => id).sort();
      const got = (await listGenerations({ viewer: null, limit: 100, job })).map((g) => g.id).sort();
      expect(got, job).toEqual(want);
    }
  });
});
