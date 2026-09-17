import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { strFromU8 } from "fflate";
import {
  assetFilename,
  newProject,
  type Asset,
} from "../../lib/workbench/studio";
import { buildExportPackage } from "../../lib/workbench/studio-export";
import { originalAssetDownload } from "../../lib/workbench/original-asset";
import { EMPTY_MOLECULR } from "../../lib/workbench/moleculr";

test("AVIF product originals retain exact bytes and the correct extension in downloads and editorial packages", async () => {
  const bytes = await sharp({
    create: { width: 300, height: 300, channels: 3, background: "#223344" },
  })
    .avif()
    .toBuffer();
  const asset: Asset = {
    id: "avif-original",
    uploadId: "avif-original",
    name: "Imported product.avif",
    kind: "image",
    category: "Product",
    url: "/api/uploads/avif-original",
    mime: "image/avif",
    description: "",
    prompt: "",
    status: "Draft",
    version: 1,
    locked: false,
    refs: [],
  };
  expect(assetFilename(asset)).toMatch(/\.avif$/);
  expect(originalAssetDownload(asset)?.filename).toMatch(/\.avif$/);
  const project = newProject("AVIF original");
  project.assets = [{ ...asset, mime: undefined }];
  project.shots = [
    {
      id: "shot",
      name: "Product hold",
      assetId: asset.id,
      sourceIn: 0,
      duration: 24,
      note: "",
    },
  ];
  project.moleculr = {
    ...EMPTY_MOLECULR,
    products: [
      {
        id: "product",
        name: "Product",
        description: "",
        brand: "",
        url: "",
        assetIds: [asset.id],
      },
    ],
  };
  const files = await buildExportPackage(project, async (url) => {
    expect(url).toBe("/api/uploads/avif-original?download=1");
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "image/avif",
        "Content-Length": String(bytes.length),
      },
    });
  });
  const manifest = JSON.parse(strFromU8(files["production.json"]));
  expect(manifest.files).toHaveLength(1);
  expect(manifest.files[0].file).toMatch(/\.avif$/);
  expect(manifest.project.assets[0].mime).toBe("image/avif");
  expect(files[manifest.files[0].file]).toEqual(new Uint8Array(bytes));
});
