import { test, expect } from "@playwright/test";
import { takesCsv, type ExportRow } from "../../lib/exportRows";
import { deletionAllowed } from "../../lib/deletion";

const row = (o: Partial<ExportRow>): ExportRow => ({
  id: "gen_1", createdAt: Date.UTC(2026, 8, 6), production: "Northline", shotCode: "SH010", shotTitle: "Rooftop, wide", take: "v1",
  kind: "video", engine: "Seedance 2.5", resolution: "1080P", duration: "5s", status: "succeeded", credits: 40, usd: 0,
  prompt: 'A courier crosses, "quiet"', filename: "NORTH_SH010_SD25_v1_ap.mp4", url: "/api/media/gen_1", bytes: 991017, ...o,
});

test("the takes CSV carries the money column in the workspace's unit and escapes the prompt", () => {
  const cr = takesCsv([row({})], "cr");
  expect(cr.split("\r\n")[0]).toContain(",credits,prompt,filename,url");
  expect(cr).toContain(',"A courier crosses, ""quiet""",');
  expect(cr).toContain(",40,");
  const usd = takesCsv([row({ credits: 0, usd: 2.86416 })], "$");
  expect(usd.split("\r\n")[0]).toContain(",usd,");
  expect(usd).toContain(",2.8642,");
});

test("deleting a workspace needs its exact name, and never the studio's own", () => {
  expect(deletionAllowed({ name: "Coast Road", legacy: false, role: "owner" }, "Coast Road")).toEqual({ ok: true });
  expect(deletionAllowed({ name: "Coast Road", legacy: false, role: "owner" }, "coast road").ok).toBe(false);
  expect(deletionAllowed({ name: "Coast Road", legacy: false, role: "admin" }, "Coast Road").ok).toBe(false);
  expect(deletionAllowed({ name: "Studio", legacy: true, role: "owner" }, "Studio").ok).toBe(false);
});
