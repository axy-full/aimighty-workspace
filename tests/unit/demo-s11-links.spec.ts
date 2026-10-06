import { test, expect } from "@playwright/test";
import { ADS_CARD_REGION, ADS_SCREEN, SOCIAL_SCREEN, adsSocialRegion, boardCardId, wantsDesigner } from "../../lib/shell/ads-social";
import { SCREENS, route } from "../../lib/shell/screens";
import { posterFor, posterHeadline, withAsset } from "../../components/graphite/board/ads/designer-model";
import { EMPTY_MOLECULR } from "../../lib/workbench/moleculr";
import { newProject, type Asset } from "../../lib/workbench/studio";

/* Stream 11 · the Ads and Social addresses (README § 1.1, § 1.2) and the Designer's pure steps. */
test("both boards have landed, and own the frame and card params", () => {
  expect([ADS_SCREEN.landed, SOCIAL_SCREEN.landed]).toEqual([true, true]);
  expect(ADS_SCREEN.params).toEqual(["frame", "card"]);
  expect(SCREENS.find((s) => s.id === "board-ads")).toBe(ADS_SCREEN);
});

test("every old Business address opens the Ads board on its card, with the switch on or off (the board is for everyone)", () => {
  const on = (search: string) => route(search);
  const off = (search: string) => route(search);
  const target = (sp: string) => `?suite=moleculr&page=marketing&sp=${sp}`;
  expect(new URLSearchParams(on(target("brand"))).toString()).toBe("view=board&kind=ads&frame=1&card=brand");
  expect(new URLSearchParams(on(target("hooks"))).toString()).toBe("view=board&kind=ads&frame=2&card=hooks");
  expect(new URLSearchParams(on(target("format"))).toString()).toBe("view=board&kind=ads&frame=2&card=formats");
  expect(new URLSearchParams(on(target("dtc"))).toString()).toBe("view=board&kind=ads&frame=2&card=image-ad");
  expect(new URLSearchParams(on(target("design"))).toString()).toBe("view=board&kind=ads&frame=3");
  expect(new URLSearchParams(on(target("setup"))).toString()).toBe("view=board&kind=ads&frame=1");
  /* The switch off is the same board: the old page is not shown to anyone. */
  for (const sp of ["brand", "product", "reference", "format", "hooks", "dtc", "design", "setup"]) {
    expect(new URLSearchParams(off(target(sp))).toString(), sp).toBe(new URLSearchParams(on(target(sp))).toString());
    expect(new URLSearchParams(off(target(sp))).get("view"), sp).toBe("board");
  }
});

test("a frame or card names the region the board opens at, and the card the board selects", () => {
  expect(adsSocialRegion("ads", "1", null)).toBe("brand");
  expect(adsSocialRegion("ads", "2", null)).toBe("hooks");
  expect(adsSocialRegion("ads", "3", null)).toBeNull();
  expect(adsSocialRegion("ads", "2", "image-ad")).toBe("ads");
  expect(adsSocialRegion("ads", null, "reference")).toBe("product");
  expect(adsSocialRegion("social", "1", null)).toBe("source");
  expect(adsSocialRegion("social", "2", null)).toBe("hooks");
  expect(adsSocialRegion("social", null, "effects")).toBe("effects");
  expect(adsSocialRegion("studio", "1", null)).toBeNull();
  expect(adsSocialRegion("ads", "__proto__", "constructor")).toBeNull();
  expect(Object.keys(ADS_CARD_REGION)).toEqual(["brand", "product", "reference", "hooks", "formats", "image-ad"]);
  expect(boardCardId("ads", "hooks")).toBe("ads:hooks");
  expect(boardCardId("social", "effects")).toBe("social:effects");
  expect(boardCardId("ads", "effects")).toBeNull();
  expect(boardCardId("ads", "toString")).toBeNull();
  expect([wantsDesigner("ads", "3"), wantsDesigner("ads", "2"), wantsDesigner("social", "3")]).toEqual([true, false, false]);
});

const image = (id: string): Asset => ({ id, generationId: id, name: `${id}.png`, kind: "image", category: "Take", url: `/api/media/${id}`, description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [] });
let n = 0;
const makeId = (prefix: string) => `${prefix}-${++n}`;

test("the poster's headline is the first hook, else the tagline, else the product, else the project", () => {
  expect(posterHeadline({ ...EMPTY_MOLECULR, hooks: ["", " Water, simply. "] }, "P")).toBe("Water, simply.");
  expect(posterHeadline({ ...EMPTY_MOLECULR, productName: "Glass bottle" }, "P")).toBe("Glass bottle");
  expect(posterHeadline(undefined, "Campaign")).toBe("Campaign");
});

test("the Designer opens on the project's poster, or makes one; an image from a result goes under the type", () => {
  const project = { ...newProject("Campaign"), moleculr: { ...EMPTY_MOLECULR, hooks: ["Water, simply."], brandKit: { name: "", tagline: "", voice: "", audience: "", colors: ["#0A84FF"], font: "system" as const } } };
  const made = posterFor(project, makeId);
  expect(made.poster.background).toBe("#0A84FF");
  expect(made.poster.layers.map((l) => [l.name, l.kind])).toEqual([["Headline", "text"], ["Call to action", "text"]]);
  expect((made.poster.layers[0] as { text: string }).text).toBe("Water, simply.");
  /* Opening again returns the same poster and writes nothing. */
  expect(posterFor(made.project, makeId).project).toBe(made.project);
  const withImage = posterFor(made.project, makeId, image("g1"));
  expect(withImage.poster.layers.map((l) => l.kind)).toEqual(["image", "text", "text"]);
  expect(withImage.project.assets.map((a) => [a.id, a.category])).toEqual([["g1", "Campaign design"]]);
  /* The same image twice is one layer, and one asset. */
  const twice = posterFor(withImage.project, makeId, image("g1"));
  expect(twice.poster.layers.filter((l) => l.kind === "image")).toHaveLength(1);
  expect(twice.project.assets).toHaveLength(1);
  expect(withAsset(twice.project, image("g1"), "x")!.project).toBe(twice.project);
});
