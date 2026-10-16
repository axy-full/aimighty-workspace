import { test, expect } from "@playwright/test";

/**
 * Large screens (owner, 15 Oct 2026, 22:30), for the v25 card on its test-only page app/(test)/v25-board-parts (a 404 outside a local ENGINE_MOCK=1 development server): at 1280x800,
 * 1440x900, 1728x1117, 1920x1080 and 2560x1440 no sideways scroll, every card inside the window, and no word smaller than 12 px. The test page draws gradients, not pictures, so sharpness is checked on the board (#748), where the cards hold real pictures. (The board's canvas scales up above 1440 px on #748; this page is the card alone, drawn at its own size.)
 */
const SIZES = [[1280, 800], [1440, 900], [1728, 1117], [1920, 1080], [2560, 1440]] as const;

test("at the five sizes: no sideways scroll, no card outside the window, no word under 12 px", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one project walks all five sizes");
  test.setTimeout(240_000);
  const res = await page.goto("/v25-board-parts");
  test.skip(res?.status() === 404, "requires a local ENGINE_MOCK=1 development server");
  await expect(page.getByTestId("v25-board-shots")).toBeVisible();
  for (const [w, h] of SIZES) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(600);
    const m = await page.evaluate(() => {
      const out = { overflow: document.documentElement.scrollWidth - window.innerWidth, outside: [] as string[], small: [] as string[], cards: 0 };
      for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-card]"))) {
        out.cards += 1;
        const r = el.getBoundingClientRect();
        if (r.left < -0.5 || r.right > window.innerWidth + 0.5) out.outside.push(el.getAttribute("data-card") ?? "");
      }
      for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
        if (!Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? "").trim())) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1 || getComputedStyle(el).visibility === "hidden") continue;
        const size = parseFloat(getComputedStyle(el).fontSize);
        if (size < 12) out.small.push(`${size}px "${(el.textContent ?? "").trim().slice(0, 24)}"`);
      }
      return out;
    });
    expect(m.cards, `${w}x${h}: cards`).toBeGreaterThan(8);
    expect(m.overflow, `${w}x${h}: no sideways scroll`).toBeLessThanOrEqual(0);
    expect(m.outside, `${w}x${h}: no card outside the window`).toEqual([]);
    expect(m.small, `${w}x${h}: no word under 12 px`).toEqual([]);
  }
});
