import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";
import { SHOT_TYPES, SHOT_TYPE_LABELS, isShotType, shotTypeHint, shotTypeOf, shotTypeOfRow } from "../../lib/takeShotType";

/**
 * A take's shot type (lib/takeShotType.ts; owner, 14 Oct 2026: params.shotType, the 13 shot recipes): the closed list, a hint checked against the list, the kind and the Setup's shot size,
 * the three recipes the Setup tells for certain, and old takes read only those, in code and in SQL alike. Nothing renders, nothing is billed.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-take-shot-type-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

test("the closed list is the owner's 13 recipes, each with its one name", () => {
  expect(SHOT_TYPES.map((code) => SHOT_TYPE_LABELS[code])).toEqual([
    "Establishing wide", "Emotional close-up", "Product reveal", "Pack shot", "Talking to camera", "Walk and talk", "Action beat", "Detail", "Over-the-shoulder",
    "Aerial reveal", "Slow-motion moment", "Match cut", "Custom",
  ]);
  expect(SHOT_TYPES).toHaveLength(13);
  expect(new Set(SHOT_TYPES).size).toBe(13);
  for (const bad of ["", "Pack shot", "pack-shot", "face_close_up", 3, null, ["custom"], {}]) expect(isShotType(bad), JSON.stringify(bad)).toBe(false);
});

test("a hint is on the list and on a picture; the three the Setup decides must agree with the Setup; every other recipe is the person's to name", () => {
  expect(shotTypeHint(undefined, { kind: "video" })).toEqual({ hint: null });
  expect(shotTypeHint(null, { kind: "audio" })).toEqual({ hint: null });
  for (const code of SHOT_TYPES.filter((c) => !["establishing_wide", "over_the_shoulder", "detail"].includes(c)))
    for (const kind of ["video", "image"] as const) expect(shotTypeHint(code, { kind, shot: "ms" }), `${code} on ${kind}`).toEqual({ hint: code });
  for (const [code, shot] of [["establishing_wide", "evs"], ["over_the_shoulder", "ots"], ["detail", "insert"]] as const) {
    expect(shotTypeHint(code, { kind: "video", shot })).toEqual({ hint: code });
    for (const wrong of ["ms", "cu"]) expect(shotTypeHint(code, { kind: "video", shot: wrong }), `${code} with ${wrong}`).toHaveProperty("error");
    /* With the Setup's size unset (the Auto default) the recipe can be named. */
    for (const unset of [null, undefined]) expect(shotTypeHint(code, { kind: "video", shot: unset }), `${code} with the size ${unset}`).toEqual({ hint: code });
  }
  expect(shotTypeHint("custom", { kind: "audio" })).toHaveProperty("error");
  for (const bad of ["", "Custom", "movie", 4, ["custom"], {}, false]) expect(shotTypeHint(bad, { kind: "video" }), JSON.stringify(bad)).toHaveProperty("error");
});

test("what is stored: the hint, else only what the Setup's shot size says for certain, else nothing; never on a sound", () => {
  expect(shotTypeOf({ kind: "video", shot: "evs" })).toBe("establishing_wide");
  expect(shotTypeOf({ kind: "image", shot: "ots" })).toBe("over_the_shoulder");
  expect(shotTypeOf({ kind: "video", shot: "insert" })).toBe("detail");
  for (const shot of ["ecu", "cu", "mcu", "ms", "mls", "ws", "pov", null, undefined]) expect(shotTypeOf({ kind: "video", shot }), String(shot)).toBeNull();
  /* A hint beats the Setup: an aerial reveal can be an extreme wide. */
  expect(shotTypeOf({ kind: "video", shot: "evs", hint: "aerial_reveal" })).toBe("aerial_reveal");
  expect(shotTypeOf({ kind: "video", shot: "cu", hint: "emotional_close_up" })).toBe("emotional_close_up");
  expect(shotTypeOf({ kind: "audio", shot: "evs", hint: "custom" })).toBeNull();
});

const row = (kind: string, params: unknown) => ({ kind, params });
test("a take made before it reads only the three certain cases from the Setup it stored; the rest is null", () => {
  expect(shotTypeOfRow(row("video", { shotSpec: { shot: "evs" } }))).toBe("establishing_wide");
  expect(shotTypeOfRow(row("image", { shotSpec: { shot: "ots" } }))).toBe("over_the_shoulder");
  expect(shotTypeOfRow(row("video", JSON.stringify({ shotSpec: { shot: "insert" } })))).toBe("detail");
  for (const shot of ["cu", "ecu", "ws", "pov"]) expect(shotTypeOfRow(row("video", { shotSpec: { shot } })), shot).toBeNull();
  expect(shotTypeOfRow(row("video", { cast: ["Ana"], shotSpec: { shot: "cu" } }))).toBeNull();
  expect(shotTypeOfRow(row("video", {}))).toBeNull();
  expect(shotTypeOfRow(row("video", "{not json"))).toBeNull();
  expect(shotTypeOfRow(row("audio", { shotType: "custom", shotSpec: { shot: "evs" } }))).toBeNull();
  /* The stored one wins; one off the list is not one. */
  expect(shotTypeOfRow(row("video", { shotType: "pack_shot", shotSpec: { shot: "evs" } }))).toBe("pack_shot");
  expect(shotTypeOfRow(row("video", { shotType: "face_close_up" }))).toBeNull();
});

test("the ?shotType= filter reads the same as the code, and the read carries it", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { listGenerations } = await import("../../lib/jobs");
  const ws: TenantWorkspace = {
    id: "ws_shot_type", name: "ws_shot_type", slug: "ws_shot_type", legacy: false, dbUrl: `file:${path.join(dir, "ws_shot_type.db")}`, dbToken: null, keys: {}, usesPlatformKeys: false, allowanceUsd: null,
    ownerId: "u1", createdAt: 0, gatewayKeyId: null, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null,
  };
  const takes: [string, string, Record<string, unknown>][] = [
    ["a", "video", { shotSpec: { shot: "evs" } }], ["b", "image", { shotSpec: { shot: "ots" } }], ["c", "video", { shotSpec: { shot: "insert" } }], ["d", "video", { shotSpec: { shot: "cu" } }],
    ["e", "video", { shotType: "pack_shot" }], ["f", "image", { shotType: "aerial_reveal", shotSpec: { shot: "evs" } }], ["g", "audio", { shotType: "custom" }], ["h", "video", {}], ["i", "video", { shotType: "nope" }],
  ];
  await runInTenant(ws, async () => {
    await ready();
    await db().batch(takes.map(([id, kind, params], n) => ({
      sql: `INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,kind,deleted,created_by) VALUES(?,'m','p',?,'succeeded',?,?,?,0,'u1')`,
      args: [id, JSON.stringify(params), 100 + n, 100 + n, kind],
    })), "write");
    const all = await listGenerations({ viewer: null, limit: 100 });
    const byId = Object.fromEntries(all.map((g) => [g.id, g.shotType]));
    for (const [id, kind, params] of takes) expect(byId[id], id).toBe(shotTypeOfRow({ kind, params }));
    for (const type of SHOT_TYPES) {
      const want = takes.filter(([, kind, params]) => shotTypeOfRow({ kind, params }) === type).map(([id]) => id).sort();
      const got = (await listGenerations({ viewer: null, limit: 100, shotType: type })).map((g) => g.id).sort();
      expect(got, type).toEqual(want);
    }
  });
});
