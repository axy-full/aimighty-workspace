import { test, expect, type Page } from "@playwright/test";

/**
 * Phase 0 acceptance (docs/particl-sow.md §6): every route, signed out,
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
  "/make/video", "/make/images", "/make/audio", "/productions", "/library", "/studio/shot",
  "/usage", "/settings", "/connect", "/platform", "/statements/2026-09", "/admin",
  "/policy", "/terms", "/privacy", "/report",
  "/projects/demo/rig/elements", "/rig/canvas/demo", "/rig/run/demo", "/rig/recipes/demo", "/takes/demo", "/shots/demo", "/elements/demo",
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
  for (const route of ["/", "/productions", "/atomik/ideas"]) {
    test(`the dock on ${route} is padded by the safe-area inset`, async ({ page }) => {
      await page.goto(route);
      await settle(page);
      /* §14: mobile is below 768. A phone on its side is 844 wide, so it
         gets the desktop nav in the header and no dock — check that
         instead, and the dock only where it exists. */
      const width = await page.evaluate(() => window.innerWidth);
      if (width >= 768) {
        await expect(page.getByRole("banner").getByRole("navigation", { name: "Sections" }).getByRole("link")).toHaveText(["Make", "Productions", "Rig", "Library"]);
        await expect(page.locator(".shell-dock")).toBeHidden();
        return;
      }
      const bar = page.locator(".shell-dock");
      await expect(bar).toBeVisible();
      /* design/particl-v2-mobile (M1): Make · PRODS · Rig · Library — a 22px line icon over a 12px mono label. */
      await expect(bar.getByRole("link")).toHaveText(["Make", "Prods", "Rig", "Library"]);
      const icons = await bar.getByRole("link").evaluateAll((els) => els.map((a) => { const s = a.querySelector("svg")!; const r = s.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height), s.getAttribute("stroke-width")]; }));
      for (const [w, h, sw] of icons) { expect([w, h]).toEqual([22, 22]); expect(sw).toBe("1.6"); }
      const info = await page.evaluate(() => {
        const el = document.querySelector(".shell-dock")!;
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
              if (r instanceof CSSStyleRule && r.selectorText.includes(".shell-dock") && r.cssText.includes("safe-area-inset-bottom")) declared = true;
              if ("cssRules" in r) walk((r as CSSGroupingRule).cssRules);
            }
          };
          walk(rules);
        }
        const inset = Number(getComputedStyle(document.documentElement).getPropertyValue("--pw-inset") || 0);
        const links = Array.from(el.querySelectorAll("a")).map((a) => a.getBoundingClientRect().height);
        const mono = parseFloat(getComputedStyle(el.querySelector("a span")!).fontSize);
        return { pad, declared, inset, bottom: el.getBoundingClientRect().bottom, vh: window.innerHeight, links, mono };
      });
      expect(info.declared, "the .shell-dock rule must pad with env(safe-area-inset-bottom)").toBe(true);
      expect(info.pad).toBeGreaterThanOrEqual(info.inset);
      expect(info.bottom).toBeLessThanOrEqual(info.vh + 1);
      for (const h of info.links) expect(h, "every dock target is at least 44pt").toBeGreaterThanOrEqual(44);
      expect(info.mono, "nothing under 12px on a phone").toBeGreaterThanOrEqual(12);
    });
  }

  /* design/particl-v2 §10 on a phone: the one composer sits first, in the
     flow, the full width of the screen; Render is reachable by scrolling
     down, never by panning sideways (SOW rule 7). */
  test("the composer is the width of the screen and Render is reachable without panning", async ({ page }) => {
    await page.goto("/make/video");
    await settle(page);
    const composer = page.getByRole("complementary", { name: "Composer" });
    await expect(composer).toBeVisible();
    const vp = page.viewportSize()!;
    const box = await composer.boundingBox();
    expect(box, "the composer has no box").not.toBeNull();
    if (vp.width < 768) expect(Math.round(box!.width), "the composer fills a phone's width").toBe(vp.width);
    const render = composer.locator("[data-render]");
    await render.scrollIntoViewIfNeeded();
    const rb = (await render.boundingBox())!;
    expect(rb.x, "Render left").toBeGreaterThanOrEqual(-1);
    expect(rb.x + rb.width, "Render right").toBeLessThanOrEqual(vp.width + 1);
    expect(rb.y, "Render top").toBeGreaterThanOrEqual(-1);
    expect(rb.y + rb.height, "Render bottom").toBeLessThanOrEqual(vp.height + 1);
    expect(rb.height, "the primary is 48px (§10) — at least 44pt on a phone").toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: `test-results/composer-${vp.width}x${vp.height}.png` });
  });

  test("opening the engine picker commits no long task over 50ms", async ({ page }) => {
    await page.goto("/make/video");
    await settle(page);
    const composer = page.getByRole("complementary", { name: "Composer" });
    await expect(composer).toBeVisible();
    await page.evaluate(() => {
      const w = window as unknown as { __long: number[] };
      w.__long = [];
      new PerformanceObserver((list) => { for (const e of list.getEntries()) w.__long.push(Math.round(e.duration)); })
        .observe({ type: "longtask", buffered: false });
    });
    await page.waitForTimeout(300);
    await page.evaluate(() => { (window as unknown as { __long: number[] }).__long = []; });
    const chip = composer.getByRole("button", { name: "Engine" });
    await chip.scrollIntoViewIfNeeded();
    await chip.click();
    await expect(composer.getByRole("listbox", { name: "Engines" })).toBeVisible();
    await page.waitForTimeout(600);
    const long = await page.evaluate(() => (window as unknown as { __long: number[] }).__long.filter((d) => d > 50));
    expect(long, `long tasks while opening the picker (ms): ${long.join(", ")}`).toEqual([]);
  });
});

test.describe("the audio composer", () => {
  /* A visitor's composer has no models and no voices. Every track kind has
     to open on it (design/particl-v2 §10): Dialogue reads the model list,
     which is the lookup that used to throw. On a phone the composer sits
     above the wall, in the flow, the same component as the desktop rail. */
  test("every track kind opens for a visitor", async ({ page }) => {
    await page.goto("/make/audio");
    await settle(page);
    const composer = page.getByRole("complementary", { name: "Composer" });
    await expect(composer).toBeVisible();
    const kinds = composer.getByRole("group", { name: "Track kind" });
    for (const kind of ["Ambient", "Music", "Dialogue"]) {
      await kinds.getByRole("button", { name: kind, exact: true }).click();
      await expect(kinds.getByRole("button", { name: kind, exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByText(/^This (screen|page) stopped$/)).toHaveCount(0);
    }
    // A visitor has no models, so the select is there with nothing in it;
    // the voice search beside it is the visible proof the tab rendered.
    await expect(composer.getByRole("combobox", { name: "Model" })).toHaveCount(1);
    await expect(composer.getByPlaceholder("Find a voice")).toBeVisible();
    /* §14: every target is at least 44pt — either the control itself, or the
       invisible touch band (`.tap44::after`) a smaller control carries. Below
       768 only: a phone on its side (844 wide) gets the desktop rail. */
    if (page.viewportSize()!.width >= 768) return;
    const short = await composer.evaluate((root) => [...root.querySelectorAll<HTMLElement>("button")].filter((b) => {
      const r = b.getBoundingClientRect(); if (r.height === 0) return false;
      const band = parseFloat(getComputedStyle(b, "::after").height) || 0;
      return r.height < 44 && band < 44;
    }).map((b) => `${b.textContent?.trim().slice(0, 16)}:${Math.round(b.getBoundingClientRect().height)}`));
    expect(short, "every target on a phone is at least 44pt, or carries a 44pt touch band").toEqual([]);
  });
});

/**
 * Productions on a phone (design/particl-v2-mobile, board M1): the title
 * at 600 24/1.05 −0.02em over `N · N PROJECTS · N NEED YOU`, the
 * `Active · Delivered · All` segmented filling the row with 40px options,
 * no header buttons (a production starts on a desktop), the body at
 * `16px 16px 100px`. A visitor sees the frame and the sign-in line; the
 * rows and the 200px strip need a workspace and are measured when the
 * suite runs signed in.
 */
test.describe("Productions on a phone", () => {
  test("the M1 frame: title, mono totals, the full-width segmented, no header buttons", async ({ page }) => {
    test.skip(page.viewportSize()!.width >= 768, "a phone on its side gets the desktop page (§14)");
    await page.goto("/productions");
    await settle(page);
    const h1 = page.getByRole("heading", { name: "Productions" });
    await expect(h1).toBeVisible();
    const t = await h1.evaluate((el) => { const cs = getComputedStyle(el); return { size: cs.fontSize, weight: cs.fontWeight, track: cs.letterSpacing }; });
    expect(t).toEqual({ size: "24px", weight: "600", track: "-0.48px" });
    await expect(page.locator("[data-phone-body] .ui-mono").first()).toHaveText(/^\d+ · \d+ projects · \d+ need you$/i);
    const body = page.locator("[data-phone-body]");
    expect(await body.evaluate((el) => { const cs = getComputedStyle(el); return [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft]; })).toEqual(["16px", "16px", "100px", "16px"]);
    const group = page.getByRole("group", { name: "Show" });
    const vw = page.viewportSize()!.width;
    expect(await group.evaluate((el) => Math.round(el.getBoundingClientRect().width))).toBe(vw - 32);
    for (const b of await group.getByRole("button").all()) {
      const r = await b.boundingBox();
      expect(r!.height, "each option is 40px tall").toBeGreaterThanOrEqual(40);
    }
    await expect(page.getByRole("button", { name: "New production" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "New project in…" })).toHaveCount(0);
    const signedIn = await page.getByRole("button", { name: "Account" }).count();
    if (signedIn) {
      const row = page.locator("section").first();
      await expect(row).toBeVisible();
      expect(await row.evaluate((el) => { const cs = getComputedStyle(el); return [cs.borderTopLeftRadius, cs.paddingTop, cs.paddingLeft]; })).toEqual(["14px", "14px", "0px"]);
      const strip = row.locator("[data-strip]");
      expect(await strip.evaluate((el) => getComputedStyle(el).scrollSnapType)).toBe("x mandatory");
      const tile = strip.locator("a").first();
      if (await tile.count()) expect(await tile.evaluate((el) => Math.round(el.getBoundingClientRect().width))).toBe(200);
      expect(await strip.getByRole("button", { name: "+ Project" }).evaluate((el) => Math.round(el.getBoundingClientRect().width))).toBe(96);
    }
  });
});

/**
 * Atomik on a phone (design/particl-v2-mobile, board M3): the header's pill
 * opens the sheet compact — `#0F1116`, radius 24 above, the .14 rule, the
 * 36×4 grabber, the 48px header with the ring at 18 and `Expand ↑`, one
 * checkpoint card (20px headline), the ask field pinned at 48px — then
 * `Expand ↑` makes it 92% tall, `Compact ↓` returns, and Esc closes. A
 * visitor has nothing to decide, so the card says so; the numbers hold.
 */
test.describe("Atomik on a phone", () => {
  test("the header pill opens the M3 sheet compact, expands, compacts and closes", async ({ page }) => {
    test.skip(page.viewportSize()!.width >= 768, "a phone on its side gets the desktop rail (§14)");
    await page.goto("/productions");
    await settle(page);
    const pill = page.getByRole("banner").getByRole("button", { name: "Ask Atomik" });
    expect(await pill.evaluate((el) => Math.round(el.getBoundingClientRect().height))).toBe(44);
    await pill.click();
    const sheet = page.getByRole("dialog", { name: "Atomik" });
    await expect(sheet).toBeVisible();
    const vh = page.viewportSize()!.height;
    const box = await sheet.evaluate((el) => { const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); return { radius: cs.borderTopLeftRadius, border: cs.borderTopColor, bg: cs.backgroundColor, h: r.height, maxH: cs.maxHeight }; });
    expect(box.radius).toBe("24px");
    expect(box.bg).toBe("rgb(15, 17, 22)");
    expect(box.maxH).toBe("58%");
    expect(box.h).toBeLessThanOrEqual(vh * 0.58 + 1);
    const grab = sheet.locator("span.h-\\[4px\\]").first();
    expect(await grab.evaluate((el) => { const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })).toEqual([36, 4]);
    const ring = sheet.locator("svg").first();
    expect(await ring.evaluate((el) => Math.round(el.getBoundingClientRect().width))).toBe(18);
    expect(await sheet.locator("[data-headline]").evaluate((el) => getComputedStyle(el).fontSize)).toBe("20px");
    const ask = sheet.getByRole("textbox", { name: "Ask Atomik" });
    expect(await ask.evaluate((el) => Math.round(el.getBoundingClientRect().height))).toBe(48);
    expect(await ask.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
    /* §14: every target is at least 44pt — the control, or its invisible touch band. */
    const short = await sheet.evaluate((root) => [...root.querySelectorAll<HTMLElement>("button")].filter((b) => {
      const r = b.getBoundingClientRect(); if (r.height === 0) return false;
      const band = parseFloat(getComputedStyle(b, "::after").height) || 0;
      return r.height < 44 && band < 44;
    }).map((b) => `${b.textContent?.trim().slice(0, 16)}:${Math.round(b.getBoundingClientRect().height)}`));
    expect(short).toEqual([]);
    await sheet.getByRole("button", { name: /Expand/ }).click();
    expect(await sheet.evaluate((el) => getComputedStyle(el).maxHeight)).toBe("92%");
    await sheet.getByRole("button", { name: /Compact/ }).click();
    expect(await sheet.evaluate((el) => getComputedStyle(el).maxHeight)).toBe("58%");
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
  });
});
