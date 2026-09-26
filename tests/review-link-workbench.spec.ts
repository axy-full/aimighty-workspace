import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

/* The client review page (brief 2.6), at every checked size: each take in the
   player its kind needs, phone-sized targets, and no sideways scroll. The API
   is mocked in the shape app/api/review/[token]/route.ts returns. */

const token = "r".repeat(40);
const clip = readFileSync(path.resolve("tests/fixtures/astra-source.mp4"));
const review = {
  workspace: { name: "Studio", logo: null },
  production: { name: "Coast Road", description: "Final selects" },
  takes: [
    { id: "gen_video", kind: "video", shot: "SH010", title: "The jetty", version: 2, prompt: "A boat at dawn.", approvedBy: null, media: `/api/review/${token}/media/gen_video`, notes: [] },
    { id: "gen_audio", kind: "audio", shot: "SH020", title: "Voice over", version: 1, prompt: "A calm read.", approvedBy: null, media: `/api/review/${token}/media/gen_audio`, notes: [] },
    { id: "gen_model", kind: "model", shot: "SH030", title: "The parcel", version: 1, prompt: "A parcel.", approvedBy: null, media: `/api/review/${token}/media/gen_model`, notes: [] },
  ],
  expiresAt: Date.UTC(2026, 11, 1),
};

test("a review link shows each take in its own player, with phone-sized fields and no sideways scroll", async ({ page }) => {
  await page.route(`**/api/review/${token}`, (route) => route.fulfill({ json: review }));
  await page.route(`**/api/review/${token}/media/**`, (route) =>
    route.fulfill({ status: 200, contentType: "video/mp4", body: clip }));
  await page.goto(`/review/${token}`);
  await expect(page.getByRole("heading", { name: "Coast Road" })).toBeVisible();

  const takes = page.locator(".rv-take");
  await expect(takes).toHaveCount(3);
  await expect(takes.nth(0).locator("video")).toHaveCount(1);
  await expect(takes.nth(1).locator("audio")).toHaveCount(1);
  await expect(takes.nth(1).locator("video")).toHaveCount(0);
  await expect(takes.nth(2).getByRole("link", { name: "Download 3D model" })).toHaveAttribute("href", `/api/review/${token}/media/gen_model`);
  await expect(takes.nth(2).locator("video")).toHaveCount(0);

  const sizes = await page.evaluate(() => ({
    phone: innerWidth < 768 || matchMedia("(pointer: coarse)").matches,
    fields: Array.from(document.querySelectorAll<HTMLElement>(".rv-in")).map((el) => ({ h: el.getBoundingClientRect().height, font: parseFloat(getComputedStyle(el).fontSize) })),
    sends: Array.from(document.querySelectorAll<HTMLElement>(".rv-send")).map((el) => el.getBoundingClientRect().height),
    download: document.querySelector<HTMLElement>(".rv-file")?.getBoundingClientRect().height ?? 0,
    overflow: document.documentElement.scrollWidth - innerWidth,
  }));
  expect(sizes.overflow).toBeLessThanOrEqual(1);
  expect(sizes.download).toBeGreaterThanOrEqual(44);
  for (const field of sizes.fields) expect(field.h).toBeGreaterThanOrEqual(44);
  for (const send of sizes.sends) expect(send).toBeGreaterThanOrEqual(44);
  // Every phone size in the matrix is a touch screen; 16px keeps iOS from zooming on focus.
  expect(sizes.phone).toBe((page.viewportSize()?.width ?? 1440) < 900);
  if (sizes.phone) for (const field of sizes.fields) expect(field.font).toBeGreaterThanOrEqual(16);
});
