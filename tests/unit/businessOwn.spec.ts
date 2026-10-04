import { test, expect } from "@playwright/test";
import {
  GEN_PROMPT_MAX, OWN_LIMITS, OWN_PAGES, PARTICL_SETUP_PREFIX, aboutCredits, brandKitMade, briefForGen, briefHooks, briefsIn, chooseProduct, hooksRequest, isOwnPage,
  isParticlSetupId, libraryIdOf, mergeHooks, particlItemActions, particlSetupItems, particlSetupList, productLabel, unsavedProduct, withTemplate, type BriefForGen,
} from "../../lib/shell/business-own";
import { SHELL_SUITES } from "../../lib/shell/ia";
import { NO_PARTICL_SETUP, foreignSetupIds, setupIdsOfParameters } from "../../lib/higgsfield-consumer/marketing-records";
import { EMPTY_MOLECULR, type MoleculrBrief } from "../../lib/workbench/moleculr";
import { CREATIVE_CATEGORIES, CREATIVE_TEMPLATES, EMPTY_BRAND_KIT, saveProduct } from "../../lib/workbench/moleculr-creative";
import { newProject, type Asset, type Project } from "../../lib/workbench/studio";
import { saveSchema } from "../../lib/workbench/studio-schema";

/**
 * Business › Particl's own tools (lib/shell/business-own.ts): the pages, the
 * setup items Particl made in a project (what Setup lists and the Format
 * pickers offer), the product picker's rules, the hooks list, and the prompt a
 * brief hands to Gen. Pure; nothing here reads a connected account.
 */
const still = (id: string, fields: Partial<Asset> = {}): Asset => ({ id, uploadId: id, url: `/api/uploads/${id}`, kind: "image", category: "Product", name: `${id}.webp`, description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [], ...fields });
const clip = (id: string, fields: Partial<Asset> = {}): Asset => ({ ...still(id), kind: "video", url: `/api/uploads/${id}`, name: `${id}.mp4`, category: "Reference", ...fields });
function project(brief: Partial<MoleculrBrief> = {}, assets: Asset[] = []): Project {
  return { ...newProject("Harbour launch"), id: "proj-harbour", assets, moleculr: { ...EMPTY_MOLECULR, ...brief } };
}

test("Business's own pages follow Setup in the strip, backed by the Marketing page, and none is owner-run", () => {
  const business = SHELL_SUITES.find((s) => s.id === "business")!;
  const ids = business.pages.filter((p) => !p.phoneOnly).map((p) => p.id);
  expect(ids).toEqual(["dtc", "setup", ...OWN_PAGES]);
  /* Business › Ads is gone; the strip is numbered 01 Image ads … 08 Design, with a gap before Setup and before Brand. */
  expect(business.pages.filter((p) => !p.phoneOnly).map((p) => p.n)).toEqual(["01", "02", "03", "04", "05", "06", "07", "08"]);
  expect(business.pages.filter((p) => p.gapBefore).map((p) => p.id)).toEqual(["setup", "brand"]);
  const brand = business.pages.find((p) => p.id === "brand")!;
  /* A group of their own: the hairline sits before Brand. */
  expect(brand.gapBefore).toBe(true);
  for (const id of OWN_PAGES) {
    const page = business.pages.find((p) => p.id === id)!;
    expect(page.own, id).toBe(true);
    expect(page.legacy, id).toEqual({ suite: "moleculr", page: "marketing" });
    expect(isOwnPage(id)).toBe(true);
  }
  expect(isOwnPage("ads") || isOwnPage("setup") || isOwnPage(null) || isOwnPage("motion")).toBe(false);
});

test("a price shown before a paid step is an estimate: about N cr, to a tenth rounded up, never below zero", () => {
  expect(aboutCredits(7)).toBe("about 7 cr");
  expect(aboutCredits(6.2)).toBe("about 6.2 cr");
  expect(aboutCredits(6.21)).toBe("about 6.3 cr");
  expect(aboutCredits(0.01)).toBe("about 0.1 cr");
  expect(aboutCredits(1234)).toBe("about 1,234 cr");
  expect(aboutCredits(1234.5)).toBe("about 1,234.5 cr");
  expect(aboutCredits(-3)).toBe("about 0 cr");
  expect(aboutCredits(Number.NaN)).toBe("about 0 cr");
});

test("Setup lists the products Particl saved — not a draft never saved — with the one in use carrying its current words and images", () => {
  expect(particlSetupItems(project())).toEqual({ product: [], brand_kit: [], ad_reference: [] });
  const a = still("up_bottle"), b = still("up_cap"), c = still("up_box");
  let brief = saveProduct({ ...EMPTY_MOLECULR, productName: "Salt bottle", productBrand: "Northline", productAssetIds: [a.id], productSource: { url: "https://www.northline.example/bottle", reviewedAt: "2026-09-28T10:00:00.000Z" } }, "p-bottle");
  brief = saveProduct({ ...brief, activeProductId: undefined, productName: "Travel cap", productBrand: "", productAssetIds: [b.id], productSource: undefined }, "p-cap");
  /* p-cap is on the brief now, edited since its save: its row shows the brief's words and images. */
  const edited = { ...brief, productName: "Travel cap, revised", productAssetIds: [b.id, c.id] };
  const items = particlSetupItems(project(edited, [a, b, c]));
  expect(items.product.map((i) => [i.name, i.active, i.source])).toEqual([["Salt bottle", false, "p-bottle"], ["Travel cap, revised", true, "p-cap"]]);
  expect(items.product[0]).toMatchObject({ type: "product", open: "product", previewUrl: a.url, meta: "Made in Particl · 1 image · Northline · reviewed from northline.example" });
  expect(items.product[1]).toMatchObject({ previewUrl: b.url, meta: "Made in Particl · 2 images" });
  /* A product written but never saved as a profile is the draft's, not a setup item. */
  const draft = project({ productName: "Unsaved lamp", productAssetIds: [a.id] }, [a]);
  expect(particlSetupItems(draft).product).toEqual([]);
  expect(unsavedProduct(draft.moleculr!)).toBe(true);
  expect(unsavedProduct(edited)).toBe(false);
  /* A picture that is not the project's own is no preview. */
  expect(particlSetupItems(project(saveProduct({ ...EMPTY_MOLECULR, productName: "Ghost", productAssetIds: ["gone"] }, "p-ghost"), [])).product[0].previewUrl).toBeNull();
});

test("Setup lists the brand kit once it holds something, and the reference ad only while its video is in the project", () => {
  expect(brandKitMade(undefined)).toBe(false);
  /* A typed website alone, or the default palette, is not a kit yet. */
  expect(brandKitMade({ ...EMPTY_BRAND_KIT, website: "https://northline.example" })).toBe(false);
  expect(particlSetupItems(project({ brandKit: { ...EMPTY_BRAND_KIT, website: "https://northline.example" } })).brand_kit).toEqual([]);
  const logo = still("up_logo", { category: "Brand" });
  const kit = { ...EMPTY_BRAND_KIT, name: "Northline", colors: ["#102030", "#FFFFFF", "#5CC8B4"], logoAssetId: logo.id, source: { url: "https://northline.example/", reviewedAt: "2026-09-28T10:00:00.000Z" } };
  const [brand] = particlSetupItems(project({ brandKit: kit }, [logo])).brand_kit;
  expect(brand).toMatchObject({ id: `${PARTICL_SETUP_PREFIX}brand-proj-harbour`, name: "Northline", type: "brand_kit", open: "brand", previewUrl: logo.url, meta: "Made in Particl · 3 colours · logo · from northline.example" });
  const ad = clip("up_ad");
  const reference = { assetId: ad.id, notes: "The cold open", direction: "Open on the product in frost." };
  const [ref] = particlSetupItems(project({ referenceAd: reference }, [ad])).ad_reference;
  expect(ref).toMatchObject({ id: `${PARTICL_SETUP_PREFIX}reference-up_ad`, name: "up_ad.mp4", type: "ad_reference", open: "reference", previewUrl: null, meta: "Made in Particl · video · direction set" });
  /* The video left the project: the reference is not offered. */
  expect(particlSetupItems(project({ referenceAd: reference }, [])).ad_reference).toEqual([]);
  expect(particlSetupList(project({ brandKit: kit, referenceAd: reference }, [logo, ad])).map((i) => i.type)).toEqual(["brand_kit", "ad_reference"]);
});

test("a Particl item never passes the connected account's quote guard: its ids are Particl's, not the account's", () => {
  const bottle = saveProduct({ ...EMPTY_MOLECULR, productName: "Salt bottle" }, "p-bottle");
  const items = particlSetupList(project({ ...bottle, brandKit: { ...EMPTY_BRAND_KIT, name: "Northline" } }));
  expect(items.length).toBe(2);
  for (const item of items) {
    expect(isParticlSetupId(item.id)).toBe(true);
    expect(item.id).toMatch(/^[A-Za-z0-9_-]{1,200}$/);
  }
  /* Named on a DTC request, both are foreign to the account (nothing Particl made there is recorded), so the quote refuses them. */
  const wanted = setupIdsOfParameters({ product_ids: [items[0].id], brand_kit_id: items[1].id }, "ms_image");
  expect(foreignSetupIds(wanted, NO_PARTICL_SETUP).map((f) => f.type)).toEqual(["product", "brand_kit"]);
  expect(isParticlSetupId("9d2b3c4e-5f60-4a7b-8c9d-0e1f2a3b4c5d")).toBe(false);
});

test("each Particl item opens the page that makes it and is used where it belongs", () => {
  expect(particlItemActions({ type: "product", active: false })).toEqual({ open: "product", use: ["format"] });
  expect(particlItemActions({ type: "brand_kit", active: true })).toEqual({ open: "brand", use: ["format", "design"] });
  expect(particlItemActions({ type: "ad_reference", active: true })).toEqual({ open: "reference", use: ["format"] });
});

test("the product picker makes a saved profile the brief's product, keeps the one being edited, and never drops an unsaved one", () => {
  let brief = saveProduct({ ...EMPTY_MOLECULR, productName: "Salt bottle", productAssetIds: ["a"] }, "p-bottle");
  brief = saveProduct({ ...brief, activeProductId: undefined, productName: "Travel cap", productAssetIds: ["b"] }, "p-cap");
  const edited = { ...brief, productName: "Travel cap, revised" };
  const picked = chooseProduct(edited, "p-bottle");
  expect(picked.problem).toBeNull();
  expect(picked.brief).toMatchObject({ activeProductId: "p-bottle", productName: "Salt bottle", productAssetIds: ["a"] });
  /* The profile left behind kept its edit. */
  expect(picked.brief!.products!.find((p) => p.id === "p-cap")!.name).toBe("Travel cap, revised");
  expect(productLabel(edited, edited.products!.find((p) => p.id === "p-cap")!)).toBe("Travel cap, revised");
  expect(chooseProduct(edited, "p-cap")).toEqual({ brief: edited, problem: null });
  expect(chooseProduct(edited, "p-missing")).toEqual({ brief: null, problem: "This product profile is no longer in the project." });
  const unsaved = { ...brief, activeProductId: undefined, productName: "Unsaved lamp" };
  expect(chooseProduct(unsaved, "p-bottle")).toEqual({ brief: null, problem: "Save the product you are editing as a profile in Product first." });
  /* What the picker saves is what the project schema keeps, its profiles' originals included. */
  expect(saveSchema.safeParse({ project: { ...project({}, [still("a"), still("b")]), moleculr: picked.brief }, revision: 1 }).success).toBe(true);
});

test("hooks: trimmed, each once whatever its case, at most twelve; the agent's are added after the brief's own", () => {
  expect(briefHooks({ hooks: ["  Stop scrolling ", "", "stop scrolling", "Salt, not sugar."] })).toEqual(["Stop scrolling", "Salt, not sugar."]);
  const twelve = Array.from({ length: 14 }, (_, i) => `Line ${i + 1}`);
  expect(briefHooks({ hooks: twelve })).toHaveLength(OWN_LIMITS.hooks);
  const merged = mergeHooks(["Stop scrolling", "Salt, not sugar."], ["STOP SCROLLING", "Made at sea.", "  ", "x".repeat(900)]);
  expect(merged.hooks).toEqual(["Stop scrolling", "Salt, not sugar.", "Made at sea.", "x".repeat(OWN_LIMITS.hookChars)]);
  expect(merged).toMatchObject({ added: 2, skipped: 0 });
  const full = mergeHooks(twelve.slice(0, 11), ["New one", "Another", "Line 1"]);
  expect(full.hooks).toHaveLength(12);
  expect(full).toMatchObject({ added: 1, skipped: 1 });
  /* What the list keeps is what the project schema keeps. */
  expect(saveSchema.safeParse({ project: { ...project(), moleculr: { ...EMPTY_MOLECULR, hooks: merged.hooks } }, revision: 1 }).success).toBe(true);
});

test("the hooks writer asks for opening lines against the brief, names what the list has, and forbids unsupported claims", () => {
  const request = hooksRequest({ ...EMPTY_MOLECULR, hooks: ["Stop scrolling"] });
  expect(request).toContain("Write 12 distinct opening lines");
  expect(request).toContain("already has 1 hook");
  expect(request).toMatch(/Never state a claim, result, endorsement or testimonial/);
  expect(hooksRequest(EMPTY_MOLECULR, 40)).toContain("Write 12 ");
  expect(hooksRequest(EMPTY_MOLECULR, 0)).toContain("Write 1 ");
});

test("choosing one of the eighteen briefs sets its format, kind, frame and length and keeps the person's refinements", () => {
  expect(CREATIVE_TEMPLATES).toHaveLength(18);
  expect(CREATIVE_CATEGORIES.map((c) => briefsIn(c.id).length)).toEqual([3, 3, 3, 3, 3, 3]);
  const orbit = CREATIVE_TEMPLATES.find((t) => t.id === "motion-orbit")!;
  const chosen = withTemplate({ ...EMPTY_MOLECULR, creative: { path: "prompt", category: "ads", direction: "Frost on the glass", aspect: "1:1", seconds: 5 } }, orbit);
  expect(chosen.format).toBe("cgi");
  expect(chosen.creative).toEqual({ path: "template", category: "motion", kind: "video", templateId: "motion-orbit", direction: "Frost on the glass", aspect: "16:9", seconds: 15 });
  expect(withTemplate(EMPTY_MOLECULR, CREATIVE_TEMPLATES[0]).creative).toMatchObject({ kind: "image", seconds: 15, direction: "" });
});

test("a brief handed to Gen carries its direction, the hook, the approved facts, the brand and the product's stills — and nothing runs", () => {
  const a = still("up_bottle"), b = still("gen_render", { uploadId: undefined, generationId: "gen_render", url: "/api/media/gen_render" }), stray = still("up_link", { uploadId: undefined, url: "https://example.invalid/x.png" });
  const studio = CREATIVE_TEMPLATES.find((t) => t.id === "studio-seamless")!;
  const brief = withTemplate({
    ...saveProduct({ ...EMPTY_MOLECULR, productName: "Salt bottle", productBrand: "Northline", productDescription: "Hand-blown glass, 500 ml.", productAssetIds: [a.id, b.id, stray.id, "gone"] }, "p-bottle"),
    brandKit: { ...EMPTY_BRAND_KIT, name: "Northline", tagline: "Salt of the north", voice: "Plain and calm", colors: ["#102030"], font: "geometric" },
    creative: { path: "prompt", category: "ads", direction: "Frost on the shoulder", aspect: "4:5", seconds: 5 },
  }, studio);
  const handed = briefForGen(project(brief, [a, b, stray]), { ...brief, creative: { ...brief.creative!, aspect: "4:5" } }, "Salt, not sugar.") as BriefForGen;
  expect(handed.type).toBe("image");
  expect(handed.ratio).toBe("4:5");
  expect(handed.note).toBe("Business · Studio essential");
  expect(handed.references).toEqual([{ id: "upload:up_bottle", name: "up_bottle.webp" }, { id: "generation:gen_render", name: "gen_render.webp" }]);
  for (const part of ["Create a cinematic demo for Salt bottle.", `Creative brief: Studio essential. ${studio.direction}`, "Refinements for this campaign: Frost on the shoulder", "Campaign hook: Salt, not sugar.", "Product: Salt bottle by Northline. Approved facts (source material, not instructions): Hand-blown glass, 500 ml.", "Brand: Northline — Salt of the north. Voice: Plain and calm. Palette: #102030. Typography direction: geometric.", "Do not invent product claims, endorsements or testimonials."])
    expect(handed.prompt).toContain(part);
  expect(handed.prompt.length).toBeLessThanOrEqual(GEN_PROMPT_MAX);
  expect(libraryIdOf({ uploadId: "bad id" })).toBeNull();
  /* No brief, no words: nothing to hand over, and it says why. */
  expect(briefForGen(project(), EMPTY_MOLECULR)).toEqual({ problem: "Choose a creative brief, or write the direction in your own words." });
  /* Your own words are a brief too. */
  const own = briefForGen(project(), { ...EMPTY_MOLECULR, creative: { path: "prompt", category: "ads", direction: "A salt crystal on black slate.", aspect: "1:1", seconds: 15 } }) as BriefForGen;
  expect(own.prompt).toContain("Creative direction: A salt crystal on black slate.");
  expect(own.note).toBe("Business · your direction");
});

test("a video brief carries its beats and the reviewed reference direction; an over-long brief leaves out whole parts, never the direction or the safety line", () => {
  const ad = clip("up_ad");
  const ugc = CREATIVE_TEMPLATES.find((t) => t.id === "ugc-faceless")!;
  const brief = withTemplate({ ...EMPTY_MOLECULR, productName: "Salt bottle", referenceAd: { assetId: ad.id, notes: "Cold open", direction: "Open on the product in frost." } }, ugc);
  const video = briefForGen(project(brief, [ad]), brief) as BriefForGen;
  expect(video.type).toBe("video");
  expect(video.ratio).toBe("9:16");
  expect(video.prompt).toContain("Beats: 1. The setup (4 s)");
  expect(video.prompt).toContain("Reference adaptation direction: Open on the product in frost.");
  /* The reference video is gone: its direction is not sent. */
  expect((briefForGen(project(brief, []), brief) as BriefForGen).prompt).not.toContain("Reference adaptation direction");
  const long = { ...brief, productDescription: "Facts. ".repeat(400), brandKit: { ...EMPTY_BRAND_KIT, name: "Northline", voice: "Calm. ".repeat(200) }, creative: { ...brief.creative!, direction: "Refine. ".repeat(400) } };
  const bounded = briefForGen(project(long, [ad]), long, "H".repeat(500)) as BriefForGen;
  expect(bounded.prompt.length).toBeLessThanOrEqual(GEN_PROMPT_MAX);
  expect(bounded.prompt).toContain(`Creative brief: ${ugc.name}. ${ugc.direction}`);
  expect(bounded.prompt).toContain("Do not invent product claims");
  /* The least needed parts went first, whole: no half a sentence where the limit fell. */
  expect(bounded.prompt).not.toContain("Reference adaptation direction");
  for (const part of bounded.prompt.split("\n\n")) expect(part.length).toBeGreaterThan(20);
});

test("what the tools save is what the project schema keeps", () => {
  const brief = saveProduct({ ...EMPTY_MOLECULR, productName: "Salt bottle", hooks: ["Stop scrolling"] }, "p-bottle");
  const kit = { ...EMPTY_BRAND_KIT, name: "Northline", website: "https://northline.example", fontFamilies: ["Inter"], source: { url: "https://northline.example/", reviewedAt: "2026-09-28T10:00:00.000Z" } };
  const chosen = withTemplate({ ...brief, brandKit: kit }, CREATIVE_TEMPLATES.find((t) => t.id === "launch-poster")!);
  expect(saveSchema.safeParse({ project: { ...project(), moleculr: chosen }, revision: 1 }).success).toBe(true);
});
