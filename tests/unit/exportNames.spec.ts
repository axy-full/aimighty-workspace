import { test, expect } from "@playwright/test";
import { makeFCPXML, makeXMEML } from "../../lib/workbench/editorial-xml";
import { withExportNames } from "../../lib/workbench/export-names";
import { assetFilename, makeEDL, newProject, type Asset, type Project } from "../../lib/workbench/studio";

/* SOW §9 / R9: a Studio export names its media by the workspace template, not the asset id. */
const asset = (id: string, extra: Partial<Asset> = {}): Asset => ({ id, name: `Asset ${id}`, kind: "video", mime: "video/mp4", category: "Shot", url: `/api/media/${id}`, description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [], ...extra });

function project(): Project {
  return {
    ...newProject("Nike AW26"), fps: 24,
    assets: [
      asset("a-wide", { generationId: "gen_wide" }),
      asset("a-wide-copy", { generationId: "gen_wide" }),
      asset("a-close", { generationId: "gen_close" }),
      asset("a-plate", { kind: "image", mime: "image/png", uploadId: "up_plate", name: "harbour-plate.png", url: "/api/uploads/up_plate" }),
    ],
    shots: [
      { id: "s1", name: "01", assetId: "a-wide", duration: 24, sourceIn: 0, note: "" },
      { id: "s2", name: "02", assetId: "a-close", duration: 24, sourceIn: 0, note: "" },
    ],
  };
}

test("renders take their template names; a repeat gets _2; uploads keep their own; the fetch is one batched request", async () => {
  const calls: unknown[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ names: { gen_wide: "NIKEAW26_SC04_SH110_SD25_v3_Akshay", gen_close: "NIKEAW26_SC04_SH120_SD25_v1_Akshay" } }), { status: 200 });
  }) as typeof fetch;
  try {
    const named = await withExportNames(project());
    expect(calls).toEqual([{ generationIds: ["gen_wide", "gen_close"] }]);
    const byId = Object.fromEntries(named.assets.map((a) => [a.id, assetFilename(a)]));
    expect(byId).toEqual({
      "a-wide": "NIKEAW26_SC04_SH110_SD25_v3_Akshay.mp4",
      "a-wide-copy": "NIKEAW26_SC04_SH110_SD25_v3_Akshay_2.mp4",
      "a-close": "NIKEAW26_SC04_SH120_SD25_v1_Akshay.mp4",
      "a-plate": "a-plate_harbour-plate.png",
    });
    /* The EDL, FCPXML and Premiere XML point at the same names the package writes. */
    expect(makeEDL(named)).toContain("* FROM CLIP NAME: NIKEAW26_SC04_SH110_SD25_v3_Akshay.mp4");
    expect(makeFCPXML(named)).toContain('src="media/NIKEAW26_SC04_SH120_SD25_v1_Akshay.mp4"');
    expect(makeXMEML(named)).toContain("<pathurl>media/NIKEAW26_SC04_SH110_SD25_v3_Akshay.mp4</pathurl>");
  } finally { globalThis.fetch = original; }
});

test("if the names cannot be read the export keeps its previous names instead of failing", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
  try {
    const p = project();
    expect(await withExportNames(p)).toBe(p);
    expect(assetFilename(p.assets[0])).toBe("a-wide_Asset_a-wide.mp4");
  } finally { globalThis.fetch = original; }
});
