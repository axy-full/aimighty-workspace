import { test, expect } from "@playwright/test";

/**
 * Large screens (owner, 15 Oct 2026, 22:30), for the v25 stepper rail on its test-only page app/(test)/v25-rail-parts (a 404 outside a local ENGINE_MOCK=1 development server): at 1280x800,
 * 1440x900, 1728x1117, 1920x1080 and 2560x1440 the rail keeps its own width (its height follows the canvas's, so every step stays inside it), stays 16 px from the canvas's left edge and centred on it from top to bottom, shows every step, has no word under
 * 12 px, and nothing scrolls sideways. (The board's canvas scales up above 1440 px on #748; the rail does not: the rail, the bars and every button stay their own size.)
 */
const SIZES = [[1280, 800], [1440, 900], [1728, 1117], [1920, 1080], [2560, 1440]] as const;

test("at the five sizes the rail keeps its width and its place, shows every step, and nothing is small or scrolls sideways", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one project walks all five sizes");
  test.setTimeout(240_000);
  const res = await page.goto("/v25-rail-parts");
  test.skip(res?.status() === 404, "requires a local ENGINE_MOCK=1 development server");
  await expect(page.getByTestId("v25-rail-film")).toBeVisible();
  let base: { width: number } | null = null;
  for (const [w, h] of SIZES) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(600);
    const m = await page.evaluate(() => {
      const frame = document.querySelector<HTMLElement>('[data-testid="v25-rail-film"]')!.getBoundingClientRect();
      const rail = document.querySelector<HTMLElement>('[data-testid="v25-rail-film"] [data-testid="v12-steprail"]')!.getBoundingClientRect();
      const steps = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="v25-rail-film"] .v12-steprail-step')).map((s) => { const r = s.getBoundingClientRect(); return r.top >= rail.top - 0.5 && r.bottom <= rail.bottom + 0.5; });
      const small: string[] = [];
      for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
        if (!Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? "").trim())) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1 || getComputedStyle(el).visibility === "hidden") continue;
        const size = parseFloat(getComputedStyle(el).fontSize);
        if (size < 12) small.push(`${size}px "${(el.textContent ?? "").trim().slice(0, 24)}"`);
      }
      return { frame: { left: frame.left, top: frame.top, height: frame.height }, rail: { left: rail.left, top: rail.top, width: rail.width, height: rail.height }, steps, small, overflow: document.documentElement.scrollWidth - window.innerWidth };
    });
    const label = `${w}x${h}`;
    expect(m.overflow, `${label}: no sideways scroll`).toBeLessThanOrEqual(0);
    expect(m.small, `${label}: no word under 12 px`).toEqual([]);
    expect(m.steps.length, `${label}: ten steps`).toBe(10);
    expect(m.steps.every(Boolean), `${label}: every step inside the rail`).toBe(true);
    expect(Math.abs(m.rail.left - m.frame.left - 16), `${label}: 16 px from the canvas's left edge`).toBeLessThanOrEqual(1);
    expect(Math.abs(m.rail.top + m.rail.height / 2 - (m.frame.top + m.frame.height / 2)), `${label}: centred on the canvas, top to bottom`).toBeLessThanOrEqual(2);
    if (base) {
      expect(Math.abs(m.rail.width - base.width), `${label}: the rail keeps its width`).toBeLessThanOrEqual(0.5);
    }
    base ??= { width: m.rail.width };
  }
});
