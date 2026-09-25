import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";
import {
  INITIAL_ADS, INITIAL_IMAGE_ADS, PRESET_KEY, PRESET_TTL_MS, SETUP_TYPES, OWNED_SETUP_TYPES, adsFromPreset, adsMedias, draftKey, imageAdsBlock, imageAdsFromPreset, imageAdsMedias,
  parsePreset, presetFor, presetSpent, pruneAds, pruneImageAds, restoreAds, restoreImageAds, withImageStill, withMode, withProductId, withSetup, withStill,
  type AdStill, type AdsState, type SetupItem, type SetupType,
} from "../../lib/shell/business";
import { accountOwnEntry, accountPresetEntry, sharedSetupIds, standaloneReads, standaloneSetupItems } from "../../lib/higgsfield-consumer/marketing-setup";
import { ConsumerSetupError, NO_PARTICL_SETUP, foreignSetupIds, setupIdsOfParameters, setupIdsOfVideoInput } from "../../lib/higgsfield-consumer/marketing-records";
import { parseConnectedCatalogue } from "../../lib/higgsfield-consumer/catalogue";
import { buildConnectedProposal, plannerModels } from "../../lib/higgsfield-consumer/planner-proposals";

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
  /* Avatars are Marketing Studio avatars: the engine's presets are its catalogue, like hooks, settings and styles. */
  expect([...OWNED_SETUP_TYPES]).toEqual(["product", "brand_kit", "ad_reference"]);
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

test("avatars are the engine's presets plus any Particl made; an avatar the account keeps for its user is never listed", () => {
  const avatars = { items: [
    { id: "av_preset", name: "Sofia", type: "preset", preview_url: "https://cdn.example.invalid/sofia.webp" },
    { id: "av_flag", name: "Kai", is_preset: true },
    { id: "av_custom", name: "Owner's face", type: "custom" },
    { id: "av_unmarked", name: "No mark" },
    { id: "av_made", name: "Made here", type: "custom" },
  ] };
  /* A preset needs a positive mark; anything unmarked or the user's own stays on the account. */
  expect(standaloneSetupItems(avatars, "avatar", new Set(["av_made"])).map((i) => i.id)).toEqual(["av_preset", "av_flag", "av_made"]);
  expect([...sharedSetupIds(avatars, "avatar")]).toEqual(["av_preset", "av_flag"]);
  expect(accountPresetEntry({ type: "preset", owner_id: "u_1" })).toBe(false);
  expect(accountPresetEntry({ source: "system" })).toBe(true);
  expect(standaloneSetupItems(avatars, "avatar", new Set())[0]).toMatchObject({ name: "Sofia", previewUrl: "https://cdn.example.invalid/sofia.webp" });
  /* Owned types share nothing with the guard; catalogue types share what is not the user's own. */
  expect([...sharedSetupIds({ items: [{ id: "p1", type: "preset" }] }, "product")]).toEqual([]);
  expect([...sharedSetupIds({ items: [{ id: "h1" }, { id: "h2", source: "custom" }] }, "hook")]).toEqual(["h1"]);
  const reads = standaloneReads(
    ["avatar", "product", "hook"],
    [{ value: avatars }, { unavailable: true }, { value: { items: [{ id: "h1", name: "Stop scrolling" }] } }],
    { items: { avatar: new Set(["av_made"]) } },
  );
  expect(reads.map((r) => [r.type, r.available, r.items.map((i) => i.id)])).toEqual([
    ["avatar", true, ["av_preset", "av_flag", "av_made"]],
    ["product", false, []],
    ["hook", true, ["h1"]],
  ]);
});

test("a quote naming a setup item Particl may not send is found before anything is priced", () => {
  const wanted = setupIdsOfParameters({ product_ids: ["p_made", "p_acct"], avatar_ids: ["av_preset"], brand_kit_id: "bk_acct", ad_reference_id: "r_made", hook_id: "h1" }, "marketing_studio_video");
  expect(wanted).toMatchObject({ product: ["p_made", "p_acct"], avatar: ["av_preset"], brand_kit: ["bk_acct"], ad_reference: ["r_made"], hook: ["h1"], assets: [] });
  const ours = { items: { product: new Set(["p_made"]), ad_reference: new Set(["r_made"]) } };
  /* Before the account's presets are read, a preset type is unknown too; after, only what it lists passes. */
  expect(foreignSetupIds(wanted, ours)).toEqual([{ type: "avatar", id: "av_preset" }, { type: "product", id: "p_acct" }, { type: "brand_kit", id: "bk_acct" }, { type: "hook", id: "h1" }]);
  expect(foreignSetupIds(wanted, ours, { avatar: new Set(["av_preset"]), hook: new Set(["h1"]) })).toEqual([{ type: "product", id: "p_acct" }, { type: "brand_kit", id: "bk_acct" }]);
  /* A preset list never lets an owned type through. */
  expect(foreignSetupIds(setupIdsOfParameters({ product_ids: ["p_acct"] }), NO_PARTICL_SETUP, { product: new Set(["p_acct"]) })).toEqual([{ type: "product", id: "p_acct" }]);
  /* Backend asset ids are always refused: Particl's stills ride as media. */
  expect(foreignSetupIds(setupIdsOfParameters({ assets: ["asset_1"] }), NO_PARTICL_SETUP)).toEqual([{ type: "assets", id: "asset_1" }]);
  /* Another model's style_id is not a setup id; a Marketing Studio model's is. */
  expect(setupIdsOfParameters({ style_id: "st9", hook_id: "h9" }, "nano_banana_2")).toMatchObject({ image_style: [], hook: [] });
  expect(setupIdsOfParameters({ style_id: "st9", setting_id: "s9" }, "ms_image")).toMatchObject({ image_style: ["st9"], setting: ["s9"] });
  expect(setupIdsOfVideoInput({ productIds: ["p_acct"], avatars: [{ id: "a_acct" }], adReferenceId: "r_made", hookId: "h1", settingId: "s1" }))
    .toMatchObject({ product: ["p_acct"], avatar: ["a_acct"], ad_reference: ["r_made"], hook: ["h1"], setting: ["s1"] });
  const error = new ConsumerSetupError();
  expect([error.status, error.code, error.paidAttempted]).toEqual([409, "setup_not_particl", false]);
  expect(error.message).not.toMatch(/higgsfield|cli|--/i);
});

test("Atomik's connected planner builds requests the guard sees: an account avatar or product in a proposal is caught", () => {
  const models = plannerModels(parseConnectedCatalogue(JSON.parse(readFileSync("tests/fixtures/connected-models.json", "utf8"))).models);
  const built = buildConnectedProposal({ kind: "video", title: "Ad", prompt: "A bottle.", model: "connected:marketing_studio_video", settings: { mode: "ugc", avatar_ids: ["acct_avatar_1"], product_ids: ["acct_product_1"] } }, models);
  expect(built.ok).toBe(true);
  if (!built.ok) return;
  const wanted = setupIdsOfParameters(built.input.parameters, built.input.model);
  expect(foreignSetupIds(wanted, NO_PARTICL_SETUP, { avatar: new Set(["av_preset"]) })).toEqual([{ type: "avatar", id: "acct_avatar_1" }, { type: "product", id: "acct_product_1" }]);
  const dtc = buildConnectedProposal({ kind: "image", title: "Still", prompt: "A bottle.", model: "connected:ms_image", settings: { style_id: "st_acct", brand_kit_id: "bk_acct" } }, models);
  expect(dtc.ok && foreignSetupIds(setupIdsOfParameters(dtc.input.parameters, dtc.input.model), NO_PARTICL_SETUP).map((f) => f.type)).toEqual(["brand_kit", "image_style"]);
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
  expect(adsFromPreset(presetFor(item("avatar", "av_preset"), "ads", NOW))).toMatchObject({ avatarId: "av_preset" });
  expect(adsFromPreset(null)).toBe(INITIAL_ADS);
  /* Image ads opens DTC Ads for a style, a brand kit or a product. */
  expect(imageAdsFromPreset(presetFor(item("image_style", "st_bold"), "dtc", NOW))).toMatchObject({ engine: "ms_image", styleId: "st_bold" });
  expect(imageAdsFromPreset(presetFor(item("brand_kit", "bk1"), "dtc", NOW))).toMatchObject({ engine: "ms_image", brandKitId: "bk1" });
  expect(imageAdsFromPreset(hook)).toBe(INITIAL_IMAGE_ADS);
  /* The pick is added to the ad being built, never a fresh composer. */
  const building: AdsState = { ...INITIAL_ADS, prompt: "Morning routine", productStill: still("up_plate"), avatarId: "av_preset", mode: "tv_spot" };
  expect(adsFromPreset(hook, building)).toMatchObject({ prompt: "Morning routine", productStill: still("up_plate"), avatarId: "av_preset", hookId: "h1", mode: "ugc" });
  expect(adsFromPreset(presetFor(item("avatar", "av_2"), "ads", NOW), building)).toMatchObject({ prompt: "Morning routine", mode: "tv_spot", avatarId: "av_2" });
  const image = { ...INITIAL_IMAGE_ADS, prompt: "Hero on marble", productStill: still("up_plate"), productIds: ["p1"] };
  expect(imageAdsFromPreset(presetFor(item("product", "p2"), "dtc", NOW), image)).toMatchObject({ engine: "ms_image", prompt: "Hero on marble", productStill: still("up_plate"), productIds: ["p2", "p1"] });
});

test("a composer's draft survives a trip away and back, read field by field; anything that does not read cleanly falls back", () => {
  expect(draftKey("scope-a", "proj-1", "ads")).toBe("particl-business-draft:ads:scope-a:proj-1");
  const ad: AdsState = { ...INITIAL_ADS, prompt: "Morning routine", productStill: still("up_plate"), settingStill: still("up_room"), avatarId: "av_preset", hookId: "h1", duration: 30,
    medias: [{ ...still("up_extra"), role: "start_image" }] };
  expect(restoreAds(JSON.parse(JSON.stringify(ad)))).toEqual(ad);
  /* Junk and unsafe values never come back; the server rules hold on the way in. */
  const junk = restoreAds({ prompt: 7, mode: "nope", productStill: { ...still("x"), url: "javascript:alert(1)" }, hookId: "a b", duration: 9999, aspect: "wide", medias: [{ ...still("y"), role: "poster" }] })!;
  expect(junk).toEqual(INITIAL_ADS);
  expect(restoreAds({ ...ad, mode: "tv_spot" })).toMatchObject({ mode: "tv_spot", hookId: null, settingId: null });
  expect(restoreAds({ ...ad, adReferenceId: "r1" })).toMatchObject({ adReferenceId: "r1", hookId: null });
  expect(restoreAds({ ...ad, settingStill: still("up_plate") })).toMatchObject({ productStill: still("up_plate"), settingStill: null });
  expect(restoreAds(null)).toBeNull();
  const image = { ...INITIAL_IMAGE_ADS, engine: "ms_image" as const, prompt: "Hero", productStill: still("up_plate"), styleId: "st_bold", batch: 4, productIds: ["p1"], medias: [{ id: "generation:g1", name: "g" }] };
  expect(restoreImageAds(JSON.parse(JSON.stringify(image)))).toEqual(image);
  expect(restoreImageAds({ engine: "other", batch: 99, productIds: ["ok", "not ok"], medias: [{ id: "file:/etc", name: "x" }] })).toEqual({ ...INITIAL_IMAGE_ADS, productIds: ["ok"] });
});

test("a pick Setup no longer lists is dropped rather than sent; nothing changes before a type is read", () => {
  const state = { ...INITIAL_ADS, productId: "p_acct", avatarId: "av_preset", hookId: "h1" };
  expect(pruneAds(state, {})).toBe(state);
  expect(pruneAds(state, { product: { items: [] }, avatar: { items: [item("avatar", "av_preset")] }, hook: { items: [item("hook", "h1")] } })).toEqual({ ...state, productId: null });
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

const wants = (parameters: Record<string, unknown>) => setupIdsOfParameters(parameters, "marketing_studio_video");
test("the record is per workspace and per member, and the quote guard reads it before the account", async () => {
  const tenant = await import("../../lib/tenant");
  const records = await import("../../lib/higgsfield-consumer/marketing-records");
  const a = workspace("standalone-a"), b = workspace("standalone-b");
  const asked: SetupType[][] = [];
  const presets = async (types: SetupType[]) => { asked.push(types); return { avatar: new Set(["av_preset"]), hook: new Set(["h1"]) }; };
  await tenant.runInTenant(a, async () => {
    await records.recordParticlSetupItem({ userId: "owner", type: "product", itemId: "p_made", projectId: "draft", name: "Studio bottle", origin: "created" });
    await records.recordParticlSetupItem({ userId: "owner", type: "product", itemId: "p_made", projectId: "draft", name: "again", origin: "created" });
    await records.recordParticlSetupItem({ userId: "owner", type: "product", itemId: "not an id", projectId: null, name: "x", origin: "created" });
    await records.recordParticlSetupItem({ userId: "other", type: "brand_kit", itemId: "bk_other", projectId: null, name: "Other's kit", origin: "created" });
    const ours = await records.particlSetup("owner");
    expect([...(ours.items.product ?? [])]).toEqual(["p_made"]);
    expect(ours.items.brand_kit).toBeUndefined();
    /* Particl's own product needs no account read. */
    await expect(records.refuseForeignSetup("owner", wants({ product_ids: ["p_made"] }), presets)).resolves.toBeUndefined();
    expect(asked).toEqual([]);
    /* Another member's kit is not this member's; an owned type refuses without reading the account. */
    await expect(records.refuseForeignSetup("owner", wants({ brand_kit_id: "bk_other", avatar_ids: ["av_preset"] }), presets)).rejects.toBeInstanceOf(records.ConsumerSetupError);
    await expect(records.refuseForeignSetup("owner", wants({ assets: ["asset_1"] }), presets)).rejects.toBeInstanceOf(records.ConsumerSetupError);
    expect(asked).toEqual([]);
    /* A preset avatar and hook pass once the account lists them; its user's own avatar does not. */
    await expect(records.refuseForeignSetup("owner", wants({ product_ids: ["p_made"], avatar_ids: ["av_preset"], hook_id: "h1" }), presets)).resolves.toBeUndefined();
    expect(asked).toEqual([["avatar", "hook"]]);
    await expect(records.refuseForeignSetup("owner", wants({ avatar_ids: ["av_custom"] }), presets)).rejects.toBeInstanceOf(records.ConsumerSetupError);
  });
  /* Another workspace sees none of it. */
  await tenant.runInTenant(b, async () => {
    const ours = await records.particlSetup("owner");
    expect(ours.items).toEqual({});
    await expect(records.refuseForeignSetup("owner", wants({ product_ids: ["p_made"] }), presets)).rejects.toBeInstanceOf(records.ConsumerSetupError);
    /* Naming nothing reads nothing and refuses nothing. */
    asked.length = 0;
    await expect(records.refuseForeignSetup("owner", wants({ mode: "ugc" }), presets)).resolves.toBeUndefined();
    expect(asked).toEqual([]);
  });
});
