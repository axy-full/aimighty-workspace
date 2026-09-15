import { test, expect } from "@playwright/test";
import { usageSummary, usageLine, castThumbs } from "../../lib/castUsage";

/** Cast that carries across everything (brief 2.4): a name's use summed across productions, and the still behind a cited name. */
test("a name's use is summed across productions, failed takes aside, and reads as one line", () => {
  const rows = [
    { id: "a", kind: "video", shotCode: "SH010", projectId: "p1", status: "succeeded" },
    { id: "b", kind: "video", shotCode: "SH010", projectId: "p1", status: "succeeded" },
    { id: "c", kind: "image", shotCode: null, projectId: "p2", status: "succeeded" },
    { id: "d", kind: "video", shotCode: "SH020", projectId: "p2", status: "failed" },
    { id: "e", kind: "video", shotCode: null, projectId: null, status: "running" },
  ];
  const s = usageSummary(rows);
  expect(s).toEqual({ takes: 3, stills: 1, shots: 1, productions: 2 });
  expect(usageLine(s)).toBe("1 SHOT · 3 TAKES · 1 STILL · ACROSS 2 PROJECTS");
  expect(usageLine(usageSummary([]))).toBe("0 SHOTS · 0 TAKES");
  expect(usageLine(usageSummary([rows[0]]))).toBe("1 SHOT · 1 TAKE");
});

test("each cited name finds its still by name, case blind, or none", () => {
  const cast = [{ name: "Mara", uploadId: "img_1" }, { name: "Mule", uploadId: null }];
  expect(castThumbs(["mara", "Mule", "Nobody"], cast)).toEqual([
    { name: "mara", uploadId: "img_1" }, { name: "Mule", uploadId: null }, { name: "Nobody", uploadId: null },
  ]);
});
