import { test, expect } from "@playwright/test";
import {
  EMPTY_MOLECULR,
  marketingReferenceIds,
  moleculrReferences,
} from "../../lib/workbench/moleculr";
import { newProject, type Asset } from "../../lib/workbench/studio";

const asset = (id: string, kind: Asset["kind"] = "image"): Asset => ({
  id,
  name: id,
  kind,
  category: "Reference",
  url: `/api/uploads/${id}`,
  description: "",
  prompt: "",
  status: "Draft",
  locked: false,
  version: 1,
  refs: [],
});

test("campaign references preserve selected product order before cast regardless of library order", () => {
  const project = newProject("Campaign");
  project.assets = [
    asset("cast"),
    asset("product-b"),
    asset("product-a"),
    asset("other"),
    asset("audio", "audio"),
  ];
  const brief = {
    ...EMPTY_MOLECULR,
    productAssetIds: [
      "product-a",
      "missing",
      "product-b",
      "product-a",
      "audio",
    ],
    castAssetIds: ["cast", "product-a", "foreign"],
  };
  expect(moleculrReferences(project, brief).map((item) => item.id)).toEqual([
    "product-a",
    "product-b",
    "cast",
  ]);
  expect(moleculrReferences(project, brief, "cast")[0]).toBe(project.assets[2]);
});

test("preset references are exactly the chosen canonical product followed by optional chosen cast", () => {
  const project = newProject("Campaign");
  project.assets = [
    asset("cast"),
    asset("product-b"),
    asset("product-a"),
    asset("outside"),
    asset("audio", "audio"),
  ];
  const brief = {
    ...EMPTY_MOLECULR,
    productAssetIds: ["missing", "product-a", "product-b"],
    castAssetIds: ["cast", "product-a", "audio", "missing"],
  };
  expect(marketingReferenceIds(project, brief)).toEqual(["product-a"]);
  expect(marketingReferenceIds(project, brief, "product-b", "cast")).toEqual([
    "product-b",
    "cast",
  ]);
  expect(
    marketingReferenceIds(project, brief, "product-a", "product-a"),
  ).toEqual(["product-a"]);
  for (const invalid of ["foreign", "outside", "missing", "audio"]) {
    expect(marketingReferenceIds(project, brief, invalid, "cast")).toEqual([]);
    expect(marketingReferenceIds(project, brief, "product-a", invalid)).toEqual(
      ["product-a"],
    );
  }
});
