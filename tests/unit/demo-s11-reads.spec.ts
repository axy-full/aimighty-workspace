import { test, expect } from "@playwright/test";
import { approveBrand, approveProduct, brandHome, brandReview, hostOf, siteUrl } from "../../components/graphite/board/ads/reads";
import { riggedEditor } from "../../components/graphite/board/ads/use-ads-editor";
import { EMPTY_MOLECULR } from "../../lib/workbench/moleculr";
import { newProject } from "../../lib/workbench/studio";

/* Stream 11 · the Ads board's free site reads: what is accepted, and what approving a read puts on the brief. */
const source = (url: string) => ({ requestedUrl: url, finalUrl: url, fetchedAt: "2026-10-05T10:00:00.000Z" });
const NOW = new Date("2026-10-05T12:00:00.000Z");

test("a page address is a public http or https one; the brand's home is its origin", () => {
  expect(siteUrl("")).toMatchObject({ ok: false });
  expect(siteUrl("not a url")).toMatchObject({ ok: false });
  expect(siteUrl("ftp://shop.example.test/x")).toMatchObject({ ok: false, reason: "Use a public http or https page." });
  expect(siteUrl("localhost")).toMatchObject({ ok: false });
  const bare = siteUrl("shop.example.test/bottle?x=1");
  expect(bare.ok && bare.url.href).toBe("https://shop.example.test/bottle?x=1");
  const home = siteUrl("http://www.shop.example.test:8080/a/b");
  expect(home.ok && brandHome(home.url)).toBe("http://www.shop.example.test:8080/");
  expect(hostOf("https://www.clear.example.test/x")).toBe("clear.example.test");
  expect(hostOf("nope")).toBe("");
});

const BRAND = {
  source: source("https://clear.example.test/"),
  brand: { name: "Clear Co", description: "Glassware.", tagline: "Water, simply.", colors: ["#0A84FF", "#0a84ff", "#F5F5F7"], fontFamilies: ["Inter"], tone: "Quiet." },
  logoCandidates: [], imageryCandidates: [], evidence: [], warnings: [], requiresReview: true as const,
};

test("approving a brand read sets name, words, colours, typefaces and source, and keeps the voice, audience and logo the person wrote", () => {
  expect(brandReview(BRAND).colors).toEqual(["#0A84FF", "#0a84ff", "#F5F5F7"]);
  const kit = approveBrand({ name: "Old", tagline: "", voice: "Plain.", audience: "Cooks.", colors: ["#000000"], font: "geometric", logoAssetId: "logo-1" }, BRAND, NOW);
  expect("kit" in kit && kit.kit).toMatchObject({
    name: "Clear Co", tagline: "Water, simply.", description: "Glassware.", voice: "Plain.", audience: "Cooks.", font: "geometric", logoAssetId: "logo-1", fontFamilies: ["Inter"],
    source: { url: "https://clear.example.test/", reviewedAt: "2026-10-05T12:00:00.000Z" },
  });
  /* The same colour twice, in either case, is kept once as the page wrote it. */
  expect("kit" in kit && kit.kit.colors).toEqual(["#0A84FF", "#0a84ff", "#F5F5F7"]);
  /* A value the kit cannot hold is said, never written. */
  const bad = approveBrand(undefined, { ...BRAND, brand: { ...BRAND.brand, colors: ["not a colour"] } }, NOW);
  expect(bad).toEqual({ error: "The read has colours or typefaces the kit cannot hold. Use Edit to correct them." });
});

const PRODUCT = { source: source("https://shop.example.test/bottle"), product: { name: " Glass bottle ", brand: "Clear Co", description: "Borosilicate glass." }, imageCandidates: [], evidence: [], warnings: [], requiresReview: true as const };

test("approving a product read sets the reviewed name, brand and facts and saves the profile in one step", () => {
  const out = approveProduct({ ...EMPTY_MOLECULR }, PRODUCT, "profile-1", NOW);
  expect("brief" in out && out.brief).toMatchObject({
    productName: "Glass bottle", productBrand: "Clear Co", productDescription: "Borosilicate glass.", productUrl: "https://shop.example.test/bottle", activeProductId: "profile-1",
    productSource: { url: "https://shop.example.test/bottle", reviewedAt: "2026-10-05T12:00:00.000Z" },
  });
  expect("brief" in out && out.brief.products).toMatchObject([{ id: "profile-1", name: "Glass bottle", brand: "Clear Co" }]);
  /* A profile already being edited stays the one that is saved. */
  const again = approveProduct({ ...EMPTY_MOLECULR, activeProductId: "profile-0", products: [{ id: "profile-0", name: "Old", url: "", description: "", brand: "", assetIds: [] }] }, PRODUCT, "profile-1", NOW);
  expect("brief" in again && again.brief.products?.map((p) => p.id)).toEqual(["profile-0"]);
  expect("brief" in again && again.brief.productName).toBe("Glass bottle");
  expect(approveProduct({ ...EMPTY_MOLECULR }, { ...PRODUCT, product: { ...PRODUCT.product, name: "  " } }, "p", NOW)).toEqual({ error: "The page gave no product name. Use Edit to write it." });
});

test("the board edits through the Rig's one draft: a change is an apply, saving is the Rig's save", async () => {
  const project = newProject("Fixture");
  const applied: string[] = [];
  let saves = 0;
  const editor = riggedEditor({
    status: "ready", project, saveState: "saving", saveError: null,
    apply: (fn) => { const out = fn(project); applied.push("nodes" in out ? out.name : out.project.name); return null; },
    save: async () => { saves++; return true; },
  });
  expect(editor).toMatchObject({ status: "ready", saveState: "Saving", error: "", notice: "" });
  editor.change((p) => ({ ...p, name: "Renamed" }));
  expect(applied).toEqual(["Renamed"]);
  expect(await editor.ensureSaved()).toBe(true);
  expect((await editor.refresh())?.id).toBe(project.id);
  expect(saves).toBe(2);
  expect(riggedEditor({ status: "idle", project: null, saveState: "error", saveError: "Offline", apply: () => null, save: async () => false })).toMatchObject({ status: "loading", saveState: "Not saved", error: "Offline" });
});
