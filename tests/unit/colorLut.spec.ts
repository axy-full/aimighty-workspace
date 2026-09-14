import { test, expect } from "@playwright/test";
import { parseCube, sampleCube } from "../../lib/workbench/color-lut";
import { defaultColorGrade } from "../../lib/workbench/color";
import { seedProject, assetFilename } from "../../lib/workbench/studio";
import { saveSchema } from "../../lib/workbench/studio-schema";
import { collectExportAssets } from "../../lib/workbench/studio-export";
const rows = Array.from(
  { length: 8 },
  (_, i) => `${i & 1} ${(i >> 1) & 1} ${(i >> 2) & 1}`,
).join("\n");
test("3D LUT interpolation preserves identity, channel order, nonuniform domains and boundary clamping", () => {
  const lut = parseCube(
    `TITLE "Look #1" # outside comment\nLUT_3D_SIZE 2\n${rows}`,
  );
  expect(lut.title).toBe("Look #1");
  for (const rgb of [
    [0, 0, 0],
    [1, 1, 1],
    [0.15, 0.4, 0.9],
    [1, 0, 0],
    [0, 1, 0],
  ]) {
    sampleCube(lut, rgb).forEach((n, i) => expect(n).toBeCloseTo(rgb[i], 6));
  }
  const domain = parseCube(
    `LUT_3D_SIZE 2\nDOMAIN_MIN -1 0 0\nDOMAIN_MAX 1 2 4\n${rows}`,
  );
  expect(sampleCube(domain, [0, 1, 2])).toEqual([0.5, 0.5, 0.5]);
  expect(sampleCube(domain, [-20, 20, 0])).toEqual([0, 1, 0]);
});
test("malformed, incomplete, excessive and combined shaper LUTs are rejected before upload", () => {
  for (const text of [
    "",
    `LUT_3D_SIZE 2\n${rows}\n0 0 0`,
    `LUT_3D_SIZE 2\n0 0 0`,
    `LUT_3D_SIZE 128\n${rows}`,
    `LUT_1D_SIZE 8\n${rows}`,
    `LUT_3D_SIZE 2\nDOMAIN_MIN 1 0 0\n${rows}`,
    `LUT_3D_SIZE 2\n${rows.replace("1 1 1", "NaN 1 1")}`,
    `LUT_3D_SIZE 2\nLUT_3D_SIZE 2\n${rows}`,
    `LUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nLUT_3D_INPUT_RANGE 0 1\n${rows}`,
  ])
    expect(() => parseCube(text)).toThrow();
});
test("sequence color settings persist and editorial handoffs retain their immutable original LUT", () => {
  const project = seedProject();
  const lut = {
    ...project.assets[0],
    id: "lut",
    uploadId: "upload-lut",
    kind: "document" as const,
    category: "LUT",
    name: "Look.cube",
    url: "/api/uploads/upload-lut",
    mime: "application/octet-stream",
    refs: [],
  };
  project.assets.push(lut);
  project.colorGrade = { ...defaultColorGrade, lutAssetId: lut.id, mix: 0.4 };
  expect(saveSchema.parse({ project, revision: 0 }).project.colorGrade).toEqual(
    project.colorGrade,
  );
  expect(collectExportAssets(project).map((a) => a.id)).toContain(lut.id);
  expect(assetFilename(lut)).toBe("lut_Look.cube");
  project.colorGrade.bypassed = true;
  expect(collectExportAssets(project).map((a) => a.id)).toContain(lut.id);
  for (const change of [
    () => (project.assets = project.assets.filter((a) => a.id !== lut.id)),
    () => (project.colorGrade!.brightness = Infinity),
    () => (project.colorGrade!.mix = -1),
    () => (lut.url = "/api/uploads/someone-else"),
    () => (lut.name = "look.txt"),
  ]) {
    const valid = structuredClone(project);
    change();
    expect(saveSchema.safeParse({ project, revision: 0 }).success).toBe(false);
    Object.assign(project, valid);
    Object.assign(
      lut,
      valid.assets.find((a) => a.id === "lut"),
    );
    project.assets = project.assets.map((a) => (a.id === "lut" ? lut : a));
  }
});
