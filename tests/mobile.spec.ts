import { test, expect, type Page } from "@playwright/test";

/**
 * Phase 0 acceptance (docs/particl-brief.md §3): every route, signed out,
 * at 360×640, 390×844 and 844×390 —
 *   • the document is never wider than the viewport;
 *   • no visible text field is under 16px (iOS zooms into anything smaller);
 *   • the app's tab bar is padded by the safe-area inset;
 *   • the composer sheet opens with Close and Render inside the viewport;
 *   • opening the engine picker commits no long task over 50ms;
 *   • every screen renders itself, never the error boundary.
 */

const ROUTES = [
  "/welcome", "/login", "/signup", "/reset",
  "/", "/images", "/audio", "/projects", "/all", "/studio", "/studio/shot",
  "/usage", "/settings", "/connect", "/platform", "/statements/2026-09",
  "/atomik/ideas", "/atomik/treatment", "/atomik/breakdown", "/atomik/shots", "/atomik/agent",
];
async function settle(page: Page) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForLoadState("networkidle").catch(() => { /* polling routes never go idle */ });
  await page.waitForTimeout(500);
}

const overflowReport = () => ({
  scrollWidth: document.documentElement.scrollWidth,
  clientWidth: document.documentElement.clientWidth,
  offenders: Array.from(document.querySelectorAll<HTMLElement>("body *"))
    .filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.right > document.documentElement.clientWidth + 1;
    })
    .slice(0, 6)
    .map((e) => `${e.tagName.toLowerCase()}.${String(e.className).split(" ")[0]}@${Math.round(e.getBoundingClientRect().right)}`),
});

const smallFields = () => Array.from(document.querySelectorAll<HTMLElement>("input, textarea, select"))
  .filter((el) => {
    const r = el.getBoundingClientRect();
    const type = (el as HTMLInputElement).type;
    return r.width > 0 && r.height > 0 && !["checkbox", "radio", "range", "hidden", "file"].includes(type);
  })
  .map((el) => ({ tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 40), size: parseFloat(getComputedStyle(el).fontSize) }))
  .filter((f) => f.size < 16);

for (const route of ROUTES) {
  test.describe(route, () => {
    test("no horizontal overflow", async ({ page }) => {
      await page.goto(route);
      await settle(page);
      const m = await page.evaluate(overflowReport);
      expect(m.scrollWidth, `document wider than the viewport on ${route}: ${m.offenders.join(", ") || "no single offender"}`).toBe(m.clientWidth);
    });

    test("no text field under 16px", async ({ page }) => {
      await page.goto(route);
      await settle(page);
      const small = await page.evaluate(smallFields);
      expect(small, `fields under 16px on ${route}: ${small.map((f) => `${f.tag}.${f.cls}=${f.size}`).join(", ")}`).toEqual([]);
    });

    // A screen that throws lands on the error boundary, which passes both
    // checks above — so this one says the screen itself has to be there.
    test("shows its screen, not the error boundary", async ({ page }) => {
      await page.goto(route);
      await settle(page);
      await expect(page.getByText(/^This (screen|page) stopped$/)).toHaveCount(0);
    });
  });
}

test.describe("the app shell", () => {
  for (const route of ["/", "/projects", "/atomik/ideas"]) {
    test(`tab bar on ${route} is padded by the safe-area inset`, async ({ page }) => {
      await page.goto(route);
      await settle(page);
      const bar = page.locator(".tabbar");
      await expect(bar).toBeVisible();
      const info = await page.evaluate(() => {
        const el = document.querySelector(".tabbar")!;
        const pad = parseFloat(getComputedStyle(el).paddingBottom);
        // The declared rule has to name the inset: emulation reports 0 for it,
        // a Face ID iPhone reports 34px, and only the declaration proves the
        // second case.
        let declared = false;
        for (const sheet of Array.from(document.styleSheets)) {
          let rules: CSSRuleList;
          try { rules = sheet.cssRules; } catch { continue; }
          const walk = (list: CSSRuleList) => {
            for (const r of Array.from(list)) {
              if (r instanceof CSSStyleRule && r.selectorText.includes(".tabbar") && r.cssText.includes("safe-area-inset-bottom")) declared = true;
              if ("cssRules" in r) walk((r as CSSGroupingRule).cssRules);
            }
          };
          walk(rules);
        }
        const inset = Number(getComputedStyle(document.documentElement).getPropertyValue("--pw-inset") || 0);
        return { pad, declared, inset, bottom: el.getBoundingClientRect().bottom, vh: window.innerHeight };
      });
      expect(info.declared, "the .tabbar rule must pad with env(safe-area-inset-bottom)").toBe(true);
      expect(info.pad).toBeGreaterThanOrEqual(info.inset);
      expect(info.bottom).toBeLessThanOrEqual(info.vh + 1);
    });
  }

  test("the composer sheet opens with Close and Render inside the viewport", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    await page.locator(".dock-preview").click();
    const sheet = page.locator(".ws-rail.is-sheet");
    await expect(sheet).toBeVisible();
    const vp = page.viewportSize()!;
    const inside = async (name: string, box: { x: number; y: number; width: number; height: number } | null) => {
      expect(box, `${name} has no box`).not.toBeNull();
      expect(box!.x, `${name} left`).toBeGreaterThanOrEqual(-1);
      expect(box!.y, `${name} top`).toBeGreaterThanOrEqual(-1);
      expect(box!.x + box!.width, `${name} right`).toBeLessThanOrEqual(vp.width + 1);
      expect(box!.y + box!.height, `${name} bottom`).toBeLessThanOrEqual(vp.height + 1);
    };
    await inside("Close", await sheet.getByRole("button", { name: "Close" }).boundingBox());
    await inside("Render", await sheet.locator(".ws-rail-foot .btn-primary").boundingBox());
    const body = await sheet.locator(".ws-rail-body").evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight, overflowY: getComputedStyle(el).overflowY }));
    expect(body.overflowY).toBe("auto");
    await page.screenshot({ path: `test-results/sheet-${vp.width}x${vp.height}.png` });
  });

  test("opening the engine picker commits no long task over 50ms", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    await page.locator(".dock-preview").click();
    await expect(page.locator(".ws-rail.is-sheet")).toBeVisible();
    await page.evaluate(() => {
      const w = window as unknown as { __long: number[] };
      w.__long = [];
      new PerformanceObserver((list) => { for (const e of list.getEntries()) w.__long.push(Math.round(e.duration)); })
        .observe({ type: "longtask", buffered: false });
    });
    await page.waitForTimeout(300);
    await page.evaluate(() => { (window as unknown as { __long: number[] }).__long = []; });
    const chip = page.locator(".ws-rail .chip-ctl").filter({ hasText: /Seedance|Kling|Topaz|Nano/ }).first();
    await chip.click();
    await expect(page.locator(".island-menu")).toBeVisible();
    await page.waitForTimeout(600);
    const long = await page.evaluate(() => (window as unknown as { __long: number[] }).__long.filter((d) => d > 50));
    expect(long, `long tasks while opening the picker (ms): ${long.join(", ")}`).toEqual([]);
  });
});

test.describe("the audio desk", () => {
  /* A visitor's desk is a stand-in Setup with no models and no voices. Every
     track kind has to open on it: Dialogue reads the model list, which is
     the lookup that used to throw. */
  test("every track kind opens for a visitor", async ({ page }) => {
    await page.goto("/audio");
    await settle(page);
    await page.locator(".dock-preview").click();
    const sheet = page.locator(".ws-rail.is-sheet");
    await expect(sheet).toBeVisible();
    const kinds = sheet.getByRole("tablist", { name: "Track kind" });
    for (const kind of ["Ambient", "Music", "Dialogue"]) {
      await kinds.getByRole("tab", { name: kind, exact: true }).click();
      await expect(kinds.getByRole("tab", { name: kind, exact: true })).toHaveAttribute("aria-selected", "true");
      await expect(page.getByText(/^This (screen|page) stopped$/)).toHaveCount(0);
    }
    // A visitor has no models, so the select is there with nothing in it;
    // the voice search beside it is the visible proof the tab rendered.
    await expect(sheet.getByRole("combobox", { name: "Model" })).toHaveCount(1);
    await expect(sheet.getByPlaceholder("Find a voice")).toBeVisible();
  });
});
