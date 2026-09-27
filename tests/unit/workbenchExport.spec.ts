import { test, expect } from "@playwright/test";
import { strFromU8, unzipSync, zipSync } from "fflate";
import { assetFilename, makeEDL, seedProject, validateSequence } from "../../lib/workbench/studio";
import { buildExportPackage, collectExportAssets } from "../../lib/workbench/studio-export";
import { makeFCPXML, makeXMEML } from "../../lib/workbench/editorial-xml";
import { PROJECT_LIMITS } from "../../lib/workbench/project-limits";

test("EDL preserves frame-exact cut boundaries and gives reused sources a stable reel", () => {
  const project = seedProject();
  project.shots[0].sourceIn = 37;
  const events = makeEDL(project).split("\r\n").filter(line => /^\d{3} /.test(line));
  expect(events).toHaveLength(3);
  expect(events[0]).toContain("00:00:01:13 00:00:05:13 01:00:00:00 01:00:04:00");
  expect(events[1]).toContain("01:00:04:00 01:00:10:00");
  expect(events[2]).toContain("01:00:10:00 01:00:15:00");
  expect(events[1].split(/\s+/)[1]).toBe(events[2].split(/\s+/)[1]);
  expect(events[0].split(/\s+/)[1]).not.toBe(events[1].split(/\s+/)[1]);
});

test("EDL refuses missing media, nonvisual sources and duplicate source identifiers", () => {
  const project = seedProject();
  project.assets = project.assets.filter(asset => asset.id !== "hero");
  expect(() => makeEDL(project)).toThrow(/source.*missing/i);
  const document = seedProject();
  document.assets[0].kind = "document";
  expect(() => makeEDL(document)).toThrow(/image or video/);
  const duplicate = seedProject();
  duplicate.assets.push({ ...duplicate.assets[0] });
  expect(() => makeEDL(duplicate)).toThrow(/same ID/);
});

test("EDL rejects fractional timing, unsupported frame rates and timecode rollover", () => {
  for (const duration of [0, -1, 3.5, NaN, Infinity]) {
    const project = seedProject();
    project.shots[0].duration = duration;
    expect(() => validateSequence(project)).toThrow(/whole-frame/);
  }
  const fractional = seedProject();
  fractional.fps = 29.97;
  expect(() => makeEDL(fractional)).toThrow(/24, 25 or 30/);
  const rollover = seedProject();
  rollover.shots[0].sourceIn = 24 * 3600 * 24 - 48;
  expect(() => makeEDL(rollover)).toThrow(/24-hour/);
  const negative = seedProject();
  negative.shots[0].sourceIn = -1;
  expect(() => makeEDL(negative)).toThrow(/whole-frame/);
});

test("missing scratch audio fails before any source downloads", async () => {
  const project = seedProject();
  project.audioAssetId = "missing-audio";
  let calls = 0;
  await expect(buildExportPackage(project, async () => {
    calls++;
    return new Response("source");
  })).rejects.toThrow(/scratch audio/);
  expect(calls).toBe(0);
});

test("source collection follows derived-take lineage and deduplicates cyclic reference metadata", () => {
  const project = seedProject();
  const derived = { ...project.assets[0], id: "derived", parentId: "hero", refs: ["character"], version: 2 };
  project.assets.push(derived);
  project.assets[1].refs = ["hero"];
  project.shots = [{ ...project.shots[0], assetId: "derived" }];
  expect(new Set(collectExportAssets(project).map(asset => asset.id))).toEqual(new Set(["derived", "hero", "character", "environment"]));
  project.assets[0].refs.push("missing-reference");
  expect(() => collectExportAssets(project)).toThrow(/bound source or reference is missing/);
});

test("package relinks exact downloaded filenames, includes reference sources and preserves bytes", async () => {
  const project = seedProject();
  project.assets[0].url = "/api/workbench/media/generated";
  project.assets[0].mime = undefined;
  project.shots[0].note = '=HYPERLINK("https://example.test")\nreview';
  const bytes = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);
  const urls: string[] = [];
  const files = await buildExportPackage(project, async url => {
    urls.push(url);
    return new Response(bytes, { headers: { "Content-Type": "image/webp" } });
  });
  expect(urls).toHaveLength(3);
  const manifest = JSON.parse(strFromU8(files["production.json"]));
  const downloaded = manifest.files as {assetId: string; file: string}[];
  expect(downloaded).toHaveLength(3);
  const hero = downloaded.find(entry => entry.assetId === "hero")!;
  expect(hero.file).toMatch(/\.webp$/);
  expect(strFromU8(files["sequence.edl"])).toContain(hero.file.replace("media/", ""));
  expect(strFromU8(files["shotlist.csv"])).toContain('"\'=HYPERLINK');
  const archive = unzipSync(zipSync(files));
  expect(archive[hero.file]).toEqual(bytes);
  expect(project.assets[0].mime).toBeUndefined();
});

test("saved website references are exported as links without fetching web pages", async () => {
  const project = seedProject();
  project.assets.push({ ...project.assets[0], id: "reference-site", kind: "link", url: "https://reference.example.test", refs: [] });
  project.assets[0].refs.push("reference-site");
  const fetched: string[] = [];
  const files = await buildExportPackage(project, async url => {
    fetched.push(url);
    return new Response("media", { headers: { "Content-Type": "image/webp" } });
  });
  expect(fetched).not.toContain("https://reference.example.test");
  expect(JSON.parse(strFromU8(files["reference-links.json"]))[0].assetId).toBe("reference-site");
});

test("expired media and 200-MB packages fail clearly instead of creating a partial archive", async () => {
  await expect(buildExportPackage(seedProject(), async () => new Response("Not found", { status: 404 }))).rejects.toThrow(/Cannot export/);
  await expect(buildExportPackage(seedProject(), async () => new Response("login", { headers: { "Content-Type": "text/html" } }))).rejects.toThrow(/usable image media/);
  await expect(buildExportPackage(seedProject(), async () => new Response("large", { headers: { "Content-Length": String(201 * 1024 * 1024) } }))).rejects.toThrow(/200 MB/);
});

test("source filename collisions cannot silently overwrite one another", async () => {
  const project = seedProject();
  project.assets[0].id = "same/id";
  project.assets[1].id = "same?id";
  project.assets[0].name = project.assets[1].name = "Source";
  project.assets[0].refs = [project.assets[1].id];
  project.shots = [{ ...project.shots[0], assetId: project.assets[0].id }];
  await expect(buildExportPackage(project, async () => new Response("media", { headers: { "Content-Type": "image/webp" } }))).rejects.toThrow(/filenames collide/);
});

test("document reference filenames use their actual content type", () => {
  const asset = { ...seedProject().assets[0], mime: "application/pdf", url: "/api/workbench/media/opaque" };
  expect(assetFilename(asset)).toMatch(/\.pdf$/);
  const project = seedProject();
  project.shots[0].note = "Review\r\n999 FAKE\u0000note";
  expect(makeEDL(project)).toContain("* COMMENT: Review  999 FAKE note");
});

test("a cut past 999 shots exports whole as FCPXML, Premiere XML and a package; only the EDL is refused", async () => {
  const long = (count: number) => {
    const project = seedProject();
    const shots = project.shots;
    project.shots = Array.from({ length: count }, (_, i) => ({ ...shots[i % shots.length], id: "shot-" + i, duration: 24 }));
    return project;
  };
  const project = long(1200);
  expect(() => validateSequence(project)).not.toThrow();
  expect(makeFCPXML(project).match(/<asset-clip /g)?.length).toBeGreaterThanOrEqual(1200);
  expect(makeXMEML(project)).toContain("<clipitem");
  expect(() => makeEDL(project)).toThrow("A CMX3600 EDL holds up to 999 events; this cut has 1,200. Use FCPXML or Premiere XML");
  expect(makeEDL(long(999)).split("\r\n").filter(line => /^\d{3} /.test(line))).toHaveLength(999);
  const files = await buildExportPackage(project, async () => new Response(new Uint8Array([82, 73, 70, 70]), { headers: { "Content-Type": "image/webp" } }));
  expect(files["sequence.edl"]).toBeUndefined();
  expect(files["sequence.fcpxml"]).toBeDefined();
  expect(files["sequence.xml"]).toBeDefined();
  expect(strFromU8(files["README.txt"])).toContain("sequence.edl: not included. CMX3600 holds 999 events and this cut has 1200");
  expect(strFromU8(files["shotlist.csv"]).split("\r\n")).toHaveLength(1201);
  expect(() => validateSequence(long(PROJECT_LIMITS.shots + 1))).toThrow("A cut holds up to 1,500 shots");
  // An oversized package points at what this cut can export instead.
  const huge = async () => new Response("large", { headers: { "Content-Length": String(201 * 1024 * 1024) } });
  await expect(buildExportPackage(project, huge)).rejects.toThrow("Export FCPXML or Premiere XML and collect large sources separately.");
  await expect(buildExportPackage(long(999), huge)).rejects.toThrow("Export the EDL and collect large sources separately.");
});
