import { test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Screenshots for the PR description: the routes that changed, at each
 * viewport, signed out, plus the composer sheet open. Written under
 * docs/phase-0/ so the description can point at them by path.
 */
const SHOTS: [string, string][] = [
  ["/welcome", "welcome"], ["/", "generate"], ["/images", "images"], ["/audio", "audio"],
  ["/projects", "productions"], ["/studio", "studio"], ["/studio/shot", "shot-builder"],
  ["/usage", "usage"], ["/settings", "settings"], ["/atomik/ideas", "atomik-ideas"], ["/atomik/shots", "atomik-shots"],
];

async function settle(page: Page) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(600);
}

test.describe("screens", () => {
  test("capture", async ({ page }, info) => {
    mkdirSync("docs/phase-0", { recursive: true });
    const vp = page.viewportSize()!;
    const tag = `${vp.width}x${vp.height}`;
    for (const [route, slug] of SHOTS) {
      await page.goto(route);
      await settle(page);
      await page.screenshot({ path: `docs/phase-0/${slug}-${tag}.png`, scale: "css" });
    }
    await page.goto("/");
    await settle(page);
    await page.locator(".dock-preview").click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `docs/phase-0/sheet-${tag}.png`, scale: "css" });
    info.annotations.push({ type: "shots", description: `${SHOTS.length + 1} screenshots at ${tag}` });
  });
});
