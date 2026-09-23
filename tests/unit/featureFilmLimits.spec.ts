import { test, expect } from "@playwright/test";
import { gunzipSync, gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { projectSchema, saveSchema } from "../../lib/workbench/studio-schema";
import { PROJECT_ENCODING_HEADER, PROJECT_LIMITS } from "../../lib/workbench/project-limits";
import { readProjectBody } from "../../lib/workbench/request-body";
import { draftBody } from "../../lib/workbench/draft-request";
import { movieSnapshot } from "../../lib/workbench/movie-handoff";
import { buildFromBoards } from "../../lib/production/rig-build";
import { featureProject } from "../helpers/featureProject";

/**
 * Owner, 23 September: raise the project limits for feature films. A feature's
 * project (900 shots, 2,700 assets, a 258,000-character script) is past the
 * old 250-node / 500-asset / 3.5 MB save, so it must validate, travel gzipped
 * both ways, and export only the cut to the movie renderer.
 */
const put = (body: BodyInit, headers: Record<string, string> = {}) => new Request("http://localhost/api/workbench/projects", { method: "PUT", body, headers });

test("a feature film's project validates; one past the new limits does not", () => {
  const feature = featureProject();
  expect(JSON.stringify(feature).length).toBeGreaterThan(3_500_000);
  expect(saveSchema.safeParse({ project: feature, revision: 0 }).success).toBe(true);
  const [node] = feature.nodes, [asset] = feature.assets;
  const full = { ...feature, nodes: Array.from({ length: PROJECT_LIMITS.nodes }, (_, i) => ({ ...node, id: `n-${i}` })) };
  expect(saveSchema.safeParse({ project: full, revision: 0 }).success).toBe(true);
  expect(saveSchema.safeParse({ project: { ...full, nodes: [...full.nodes, { ...node, id: "one-more" }] }, revision: 0 }).success).toBe(false);
  const assets = Array.from({ length: PROJECT_LIMITS.assets + 1 }, (_, i) => ({ ...asset, id: `a-${i}` }));
  expect(projectSchema.safeParse({ ...feature, assets }).success).toBe(false);
});

test("a large save is gzipped by the browser and read back whole; small saves stay plain", async () => {
  const small = await draftBody(JSON.stringify({ revision: 0 }));
  expect(small.headers[PROJECT_ENCODING_HEADER]).toBeUndefined();
  const json = JSON.stringify({ project: featureProject(), revision: 0 });
  const packed = await draftBody(json);
  expect(packed.headers[PROJECT_ENCODING_HEADER]).toBe("gzip");
  const bytes = new Uint8Array(packed.body as ArrayBuffer);
  expect(bytes.byteLength).toBeLessThan(json.length / 5);
  expect(gunzipSync(bytes).toString("utf8")).toBe(json);
  const read = await readProjectBody(put(bytes, packed.headers));
  expect(read).toEqual({ ok: true, value: JSON.parse(json) });
});

test("a gzipped save is bounded on the wire and once unpacked; an uncompressed one at 4 MB", async () => {
  /* 30 MB of zeros packs to a few kilobytes: the unpacked bound refuses it. */
  const bomb = gzipSync(Buffer.alloc(30_000_000, 0x20));
  expect(await readProjectBody(put(bomb, { [PROJECT_ENCODING_HEADER]: "gzip" }))).toEqual({ ok: false, status: 413, error: "Project exceeds the 24 MB limit." });
  /* Random bytes do not pack: 4.2 MB on the wire is refused before unpacking. */
  const noise = gzipSync(randomBytes(4_200_000));
  expect((await readProjectBody(put(noise, { [PROJECT_ENCODING_HEADER]: "gzip" }))).ok).toBe(false);
  const plain = JSON.stringify({ project: featureProject(), revision: 0 });
  expect(await readProjectBody(put(plain))).toEqual({ ok: false, status: 413, error: "Project exceeds the 4 MB limit for an uncompressed save." });
  expect(await readProjectBody(put(Buffer.from("not gzip"), { [PROJECT_ENCODING_HEADER]: "gzip" }))).toMatchObject({ ok: false, status: 400 });
});

test("the movie export carries the cut, its sound and grade, and only the assets they use", () => {
  const feature = featureProject();
  const snapshot = movieSnapshot({ ...feature, audioAssetId: feature.assets[0].id });
  expect(snapshot.shots).toHaveLength(900);
  expect(new Set(snapshot.assets.map((a) => a.id))).toEqual(new Set([...feature.shots.map((s) => s.assetId), feature.assets[0].id]));
  expect(snapshot.nodes).toEqual([]);
  expect(snapshot.production).toBeUndefined();
  expect(JSON.stringify(snapshot).length).toBeLessThan(3_500_000);
  expect(projectSchema.safeParse(snapshot).success).toBe(true);
});

test("the Rig builds a shot for every storyboard frame of a feature, on the canvas, and the project still saves", () => {
  const { project, added } = buildFromBoards(featureProject("Rigless", { rig: false }), "dreamina-seedance-2-5-260628");
  expect(added).toBe(900);
  expect(project.nodes).toHaveLength(1800);
  for (const node of project.nodes) {
    expect(node.x).toBeGreaterThanOrEqual(-10000); expect(node.x).toBeLessThanOrEqual(20000);
    expect(node.y).toBeGreaterThanOrEqual(-10000); expect(node.y).toBeLessThanOrEqual(20000);
  }
  /* Shots wrap into columns instead of running off the bottom of the canvas. */
  expect(new Set(project.nodes.filter((n) => n.boardShotId).map((n) => n.x)).size).toBeGreaterThan(1);
  const parsed = saveSchema.safeParse({ project, revision: 0 });
  expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 2))).toBe(true);
});
