import { test, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { filmBoard, openBoard } from "../helpers/boardV12";

/*
 * Sharpness (owner, 16 Oct 2026, 15:05): the Brief, Script and Storyboard steps at 2560x1440 and 3008x1692, each at two device pixels to a CSS pixel, to look at the
 * text. Crisp text, one-pixel borders, no upscaled picture. Output: <REDESIGN_SHOTS_DIR>/sharp/<name>-<w>x<h>@2x.png. Run with --project=redesign-1440x900
 * (the sizes here are its own).
 */
const SIZES = [[2560, 1440], [3008, 1692]] as const;
const SCRIPT = "PICTURE: Harbour, dawn. SOUND: Gulls, a rope on a cleat.\nVO (SKIPPER): “Every morning starts the same.”\n\nPICTURE: The boat pulls away.\nSOUND: The engine catches.";

for (const [width, height] of SIZES) {
  test(`Brief, Script and Storyboard at ${width}x${height} @2x`, async ({ browser }, info) => {
    test.setTimeout(300_000);
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, baseURL: String(info.project.use.baseURL ?? process.env.PW_BASE_URL ?? "http://localhost:4561") });
    const page = await context.newPage();
    const out = path.resolve(process.env.REDESIGN_SHOTS_DIR ?? "../redesign-shots", "sharp");
    await mkdir(out, { recursive: true });
    try {
      for (const step of ["brief", "script", "storyboard"] as const) {
        await openBoard(page, `/suites?view=board&stage=${step}`, { project: { ...filmBoard(), script: SCRIPT } });
        await expect(page.getByTestId(step === "storyboard" ? "v12-storyboard-stage" : "v12-text-stage")).toBeVisible({ timeout: 90_000 });
        await page.mouse.move(0, 0);
        await page.waitForTimeout(800);
        await writeFile(path.join(out, `${step}-${width}x${height}@2x.png`), await page.screenshot({ animations: "disabled" }));
      }
    } finally {
      await context.close();
    }
  });
}
