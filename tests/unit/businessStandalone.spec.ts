import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";
import {
  INITIAL_ADS, INITIAL_IMAGE_ADS, PRESET_KEY, PRESET_TTL_MS, SETUP_TYPES, OWNED_SETUP_TYPES, adsFromPreset, adsMedias, imageAdsBlock, imageAdsFromPreset, imageAdsMedias,
  parsePreset, presetFor, presetSpent, pruneAds, pruneImageAds, withImageStill, withMode, withProductId, withSetup, withStill, type AdStill, type AdsState, type SetupItem,
} from "../../lib/shell/business";
import { accountOwnEntry, castAvatars, standaloneReads, standaloneSetupItems } from "../../lib/higgsfield-consumer/marketing-setup";
import { ConsumerSetupError, NO_PARTICL_SETUP, foreignSetupIds, setupIdsOfParameters, setupIdsOfVideoInput } from "../../lib/higgsfield-consumer/marketing-records";

/**
 * Business is standalone (owner's rule, 23 September): only what Particl made
 * is listed or sent. Pure rules first, then the record table in a real
 * isolated workspace database.
 */
const directory = mkdtempSync(path.join(tmpdir(), "particl-business-standalone-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(directory, "platform.db")}`;
process.env.KEYRING_SECRET ??= "business-standalone-isolated-test-key";
process.env.ENGINE_MOCK = "1";

const still = (id: string, name = id): AdStill => ({ id: `upload:${id}`, name, sourceId: id, origin: "upload", url: `/api/uploads/${id}` });
const item = (type: SetupItem["type"], id: string, name = id): SetupItem => ({ id, type, name, meta: type, previewUrl: null });
const NOW = 1_790_000_000_000;

test("no setup type carries a command line; the account's own library types are the owned ones", () => {
  for (const [, label, whose] of SETUP_TYPES) {
    expect(label).not.toMatch(/--|list|create|fetch/);
    expect(["owned", "catalogue"]).toContain(whose);
  }
  expect([...OWNED_SETUP_TYPES]).toEqual(["avatar", "product", "brand_kit", "ad_reference"]);
});

test("the account's own avatars, products, brand kits and ad references are never listed — only what Particl made", () => {
  const reply = { items: [{ id: "acct_p1", name: "Owner's sneaker" }, { id: "made_p2", name: "Studio bottle" }] };
  expect(standaloneSetupItems(reply, "product", new Set(["made_p2"])).map((i) => i.id)).toEqual(["made_p2"]);
  expect(standaloneSetupItems(reply, "brand_kit", new Set())).toEqual([]);
  /* Catalogue types keep the presets and drop anything the account marks as its user's own. */
  const hooks = { items: [
    { id: "h1", prompt: "Stop scrolling", source: "preset" },
    { id: "h2", prompt: "My custom hook", source: "custom" },
    { id: "h3", prompt: "Mine too", user_id: "u_42" },
    { id: "h4", prompt: "Shared", created_by: "system" },
    { id: "h5", prompt: "Flagged", is_custom: true },
  ] };
  expect(standaloneSetupItems(hooks, "hook", new Set()).map((i) => i.id)).toEqual(["h1", "h4"]);
  expect(accountOwnEntry({ visibility: "private" })).toBe(true);
  expect(accountOwnEntry({ owner_id: 7 })).toBe(true);
  expect(accountOwnEntry({ source: "preset", owner: "higgsfield" })).toBe(false);
});

test("avatars are the identities built in Cast, ready ones only, merged once with any avatar Particl made", () => {
  const characters = [
    { soulId: "soul_a", name: "Mira", type: "soul_2" as const, status: "ready" as const, previewUrl: null },
    { soulId: "soul_b", name: "Theo", type: "soul_cinematic" as const, status: "training" as const, previewUrl: null },
    { soulId: "soul_owner", name: "Trained elsewhere", type: "soul_2" as const, status: "ready" as const, previewUrl: null },
  ];
  expect(castAvatars(characters, new Set(["soul_a", "soul_b"]))).toEqual([{ id: "soul_a", type: "avatar", name: "Mira", meta: "Soul ID · Soul 2", previewUrl: null }]);
  const reads = standaloneReads(
    ["avatar", "product", "hook"],
    [{ value: { items: [{ id: "soul_a", name: "Mira" }, { id: "acct_av", name: "Owner avatar" }] } }, { unavailable: true }, { value: { items: [{ id: "h1", name: "Stop scrolling" }] } }],
    { value: { items: [{ soul_id: "soul_a", name: "Mira", status: "ready", type: "soul_2" }, { soul_id: "soul_owner", name: "Trained elsewhere", status: "ready" }] } },
    { items: { avatar: new Set(["soul_a"]) }, cast: new Set(["soul_a"]) },
  );
  expect(reads).toEqual([
    { type: "avatar", available: true, items: [{ id: "soul_a", type: "avatar", name: "Mira", meta: "Soul ID · Soul 2", previewUrl: null }] },
    { type: "product", available: false, items: [] },
    { type: "hook", available: true, items: [{ id: "h1", type: "hook", name: "Stop scrolling", meta: "hook", previewUrl: null }] },
  ]);
  /* The avatar read stands on Cast alone when the account does not list avatars. */
  expect(standaloneReads(["avatar"], [{ unavailable: true }], { value: [{ soul_id: "soul_a", name: "Mira", status: "ready" }] }, { items: {}, cast: new Set(["soul_a"]) })[0]).toMatchObject({ available: true, items: [{ id: "soul_a" }] });
});

test("a quote naming an account item Particl did not make is found before anything is priced", () => {
  const wanted = setupIdsOfParameters({ product_ids: ["p_made", "p_acct"], avatar_ids: ["soul_a"], brand_kit_id: "bk_acct", ad_reference_id: "r_made", hook_id: "h1" });
  expect(wanted).toEqual({ product: ["p_made", "p_acct"], avatar: ["soul_a"], brand_kit: ["bk_acct"], ad_reference: ["r_made"] });
  const ours = { items: { product: new Set(["p_made"]), ad_reference: new Set(["r_made"]) }, cast: new Set(["soul_a"]) };
  expect(foreignSetupIds(wanted, ours)).toEqual([{ type: "product", id: "p_acct" }, { type: "brand_kit", id: "bk_acct" }]);
  expect(foreignSetupIds(setupIdsOfParameters({ avatars: [{ id: "soul_a", type: "soul" }] }), ours)).toEqual([]);
  expect(foreignSetupIds(setupIdsOfVideoInput({ productIds: ["p_acct"], avatars: [{ id: "a_acct" }], adReferenceId: "r_made" }), ours)).toEqual([{ type: "avatar", id: "a_acct" }, { type: "product", id: "p_acct" }]);
  /* Hooks, settings and styles are the engine's catalogue: never refused here. */
  expect(foreignSetupIds(setupIdsOfParameters({ hook_id: "h9", setting_id: "s9", style_id: "st9" }), NO_PARTICL_SETUP)).toEqual([]);
  const error = new ConsumerSetupError();
  expect([error.status, error.code, error.paidAttempted]).toEqual([409, "setup_not_particl", false]);
  expect(error.message).not.toMatch(/higgsfield|cli|--/i);
});

test("Setup's pick lands on the page it names once; a stale, foreign or malformed pick is spent, another page's fresh pick waits", () => {
  const hook = presetFor(item("hook", "h1", "Stop scrolling"), "ads", NOW);
  const raw = JSON.stringify(hook);
  expect(PRESET_KEY).toBe("particl-business-preset");
  expect(parsePreset(raw, "ads", NOW + 1000)).toEqual(hook);
  expect(parsePreset(raw, "dtc", NOW)).toBeNull();
  expect(parsePreset(raw, "ads", NOW + PRESET_TTL_MS + 1)).toBeNull();
  expect(presetSpent(raw, "ads", NOW)).toBe(true);
  expect(presetSpent(raw, "dtc", NOW)).toBe(false);
  expect(presetSpent(raw, "dtc", NOW + PRESET_TTL_MS + 1)).toBe(true);
  expect(presetSpent("{nope", "ads", NOW)).toBe(true);
  expect(presetSpent(null, "ads", NOW)).toBe(false);
  /* A type the page cannot take, or an id that is not an id, never lands. */
  expect(parsePreset(JSON.stringify({ ...hook, page: "dtc" }), "dtc", NOW)).toBeNull();
  expect(parsePreset(JSON.stringify({ ...hook, id: "a b" }), "ads", NOW)).toBeNull();
  expect(adsFromPreset(hook)).toMatchObject({ hookId: "h1", adReferenceId: null });
  expect(adsFromPreset(presetFor(item("avatar", "soul_a"), "ads", NOW))).toMatchObject({ avatarId: "soul_a" });
  expect(adsFromPreset(null)).toBe(INITIAL_ADS);
  /* Image ads opens DTC Ads for a style, a brand kit or a product. */
  expect(imageAdsFromPreset(presetFor(item("image_style", "st_bold"), "dtc", NOW))).toMatchObject({ engine: "ms_image", styleId: "st_bold" });
  expect(imageAdsFromPreset(presetFor(item("brand_kit", "bk1"), "dtc", NOW))).toMatchObject({ engine: "ms_image", brandKitId: "bk1" });
  expect(imageAdsFromPreset(hook)).toBe(INITIAL_IMAGE_ADS);
});

test("a pick Setup no longer lists is dropped rather than sent; nothing changes before a type is read", () => {
  const state = { ...INITIAL_ADS, productId: "p_acct", avatarId: "soul_a", hookId: "h1" };
  expect(pruneAds(state, {})).toBe(state);
  expect(pruneAds(state, { product: { items: [] }, avatar: { items: [item("avatar", "soul_a")] }, hook: { items: [item("hook", "h1")] } })).toEqual({ ...state, productId: null });
  const image = { ...INITIAL_IMAGE_ADS, engine: "ms_image" as const, styleId: "st_gone", brandKitId: "bk1", productIds: ["p1", "p_acct"] };
  expect(pruneImageAds(image, { image_style: { items: [item("image_style", "st_bold")] }, brand_kit: { items: [item("brand_kit", "bk1")] }, product: { items: [item("product", "p1")] } }))
    .toEqual({ ...image, styleId: null, productIds: ["p1"] });
});

test("the product and setting stills ride first among the references, each once, and a pick clears its alternative", () => {
  const plate = still("up_plate"), room = still("up_room"), extra = { ...still("up_extra"), role: "start_image" as const };
  let s: AdsState = { ...INITIAL_ADS, productId: "p_made", medias: [{ ...plate, role: "image" as const }, extra] };
  s = withStill(s, "product", plate);
  expect(s.productId).toBeNull();
  expect(s.medias.map((m) => m.id)).toEqual(["upload:up_extra"]);
  s = withStill(s, "setting", room);
  expect(adsMedias(s).map((m) => [m.id, m.role])).toEqual([["upload:up_plate", "image"], ["upload:up_room", "image"], ["upload:up_extra", "start_image"]]);
  /* The same still cannot be product and setting at once. */
  expect(withStill(s, "setting", plate)).toMatchObject({ productStill: null, settingStill: plate });
  /* A preset setting replaces the setting still; a Particl product replaces the product still. */
  expect(withSetup(s, { settingId: "s1" }).settingStill).toBeNull();
  expect(withProductId(s, "p_made")).toMatchObject({ productId: "p_made", productStill: null });
  /* A setting still is a reference still: it rides in any mode. */
  expect(adsMedias(withMode(s, "tv_spot")).map((m) => m.id)).toContain("upload:up_room");
  const image = withImageStill({ ...INITIAL_IMAGE_ADS, medias: [{ id: "upload:up_plate", name: "p" }, { id: "generation:g1", name: "g" }] }, plate);
  expect(imageAdsMedias(image).map((m) => m.id)).toEqual(["upload:up_plate", "generation:g1"]);
  expect(imageAdsBlock({ ...INITIAL_IMAGE_ADS, productStill: plate, aspect: "auto" }, { connected: true, hasProject: true })).toBeNull();
});

test("DTC Ads says plainly when the account lists no ad styles, instead of asking for one", () => {
  const dtc = { ...INITIAL_IMAGE_ADS, engine: "ms_image" as const, prompt: "Hero on marble" };
  expect(imageAdsBlock(dtc, { connected: true, hasProject: true, styles: 0 })).toBe("The connected account lists no ad styles, so DTC Ads cannot run.");
  expect(imageAdsBlock(dtc, { connected: true, hasProject: true, styles: 3 })).toBe("Pick a style — the ad format. DTC Ads has no default.");
});

function workspace(id: string): TenantWorkspace {
  return {
    id, slug: id, name: id, legacy: true, dbUrl: `file:${path.join(directory, `${id}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: false,
    allowanceUsd: null, gatewayKeyId: null, ownerId: "owner", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null,
    concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null,
  };
}

test("the record is per workspace and per member, and the quote guard reads it", async () => {
  const tenant = await import("../../lib/tenant");
  const records = await import("../../lib/higgsfield-consumer/marketing-records");
  const characters = await import("../../lib/higgsfield-consumer/character-records");
  const a = workspace("standalone-a"), b = workspace("standalone-b");
  await tenant.runInTenant(a, async () => {
    await records.recordParticlSetupItem({ userId: "owner", type: "product", itemId: "p_made", projectId: "draft", name: "Studio bottle", origin: "created" });
    await records.recordParticlSetupItem({ userId: "owner", type: "product", itemId: "p_made", projectId: "draft", name: "again", origin: "created" });
    await records.recordParticlSetupItem({ userId: "owner", type: "product", itemId: "not an id", projectId: null, name: "x", origin: "created" });
    await records.recordParticlSetupItem({ userId: "other", type: "brand_kit", itemId: "bk_other", projectId: null, name: "Other's kit", origin: "created" });
    await characters.recordParticlCharacter({ soulId: "soul_a", userId: "owner", projectId: "draft", name: "Mira", type: "soul_2" });
    const ours = await records.particlSetup("owner");
    expect([...(ours.items.product ?? [])]).toEqual(["p_made"]);
    expect(ours.items.brand_kit).toBeUndefined();
    expect([...ours.cast]).toEqual(["soul_a"]);
    await expect(records.refuseForeignSetup("owner", { product: ["p_made"], avatar: ["soul_a"], brand_kit: [], ad_reference: [] })).resolves.toBeUndefined();
    await expect(records.refuseForeignSetup("owner", { product: [], avatar: [], brand_kit: ["bk_other"], ad_reference: [] })).rejects.toBeInstanceOf(records.ConsumerSetupError);
  });
  /* Another workspace sees none of it. */
  await tenant.runInTenant(b, async () => {
    const ours = await records.particlSetup("owner");
    expect(ours.items).toEqual({});
    await expect(records.refuseForeignSetup("owner", { product: ["p_made"], avatar: [], brand_kit: [], ad_reference: [] })).rejects.toBeInstanceOf(records.ConsumerSetupError);
    /* Naming nothing reads nothing and refuses nothing. */
    await expect(records.refuseForeignSetup("owner", { product: [], avatar: [], brand_kit: [], ad_reference: [] })).resolves.toBeUndefined();
  });
});
