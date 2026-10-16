import { test, expect, type Page } from "@playwright/test";
import { isCompact } from "./helpers/shellMode";

/*
 * PR 6: the v25 preview (components/v12/board/CardPreview.tsx, ShotPreview.tsx), on the test-only page app/(test)/v25-board-parts (a 404 outside a local
 * ENGINE_MOCK=1 development server). Opens on a card (double-click, or Enter/Space on a focused card); the header says which version of how many; ✓ and ✕ act
 * on the version on screen through the review trail (answered here, so what is checked is what is asked); the versions strip shows any version; Compare sets
 * the version before beside the one on screen; Download points at the original as an attachment; ← and → step through the cards; Esc closes the reasons, then
 * the preview, and the focus goes back to the card. A script has its tabs, a sound its waveform, a clip its controls. Nothing is paid.
 */
type Call = { method: string; url: string; body: Record<string, unknown> | null };
async function watch(page: Page) {
  const calls: Call[] = [];
  await page.route("**/api/jobs/*", async (route) => {
    const req = route.request();
    if (req.method() !== "PATCH") return route.fallback();
    const body = req.postDataJSON() as Record<string, unknown>;
    calls.push({ method: "PATCH", url: new URL(req.url()).pathname, body });
    await route.fulfill({ json: { review: { reviewState: body.reviewState } } });
  });
  await page.route("**/api/notes**", async (route) => {
    const req = route.request();
    if (req.method() === "POST") { calls.push({ method: "POST", url: new URL(req.url()).pathname, body: req.postDataJSON() as Record<string, unknown> }); return route.fulfill({ json: { ok: true } }); }
    return route.fulfill({ json: { notes: [] } });
  });
  page.on("request", (r) => { const p = new URL(r.url()).pathname; if (r.method() === "POST" && p.startsWith("/api/generate")) calls.push({ method: "POST", url: p, body: null }); });
  return calls;
}

test.beforeEach(async ({ page }) => {
  const res = await page.goto("/v25-board-parts");
  test.skip(res?.status() === 404, "requires a local ENGINE_MOCK=1 development server");
  await expect(page.getByTestId("v25-board-takes")).toBeVisible();
});

const takes = (page: Page) => page.getByTestId("v25-board-takes");
const card = (page: Page, id: string) => takes(page).locator(`[data-card="${id}"]`);
const preview = (page: Page) => page.getByTestId("v12-preview");
async function open(page: Page, id: string) {
  await expect(async () => {
    if (!(await preview(page).count())) { await card(page, id).scrollIntoViewIfNeeded(); await card(page, id).dblclick(); }
    await expect(preview(page)).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 20_000 });
}

test("a card opens its preview: the title, which version of how many, and the versions strip", async ({ page }) => {
  await open(page, "shot-7");
  await expect(page.getByTestId("v12-preview-title")).toHaveText("Shot 7 · Three versions");
  await expect(page.getByTestId("v12-preview-version")).toHaveText("v3 of 3");
  const strip = page.getByTestId("v12-preview-versions").getByTestId("v12-preview-version-btn");
  await expect(strip).toHaveCount(3);
  await expect(strip.nth(2)).toHaveAttribute("aria-pressed", "true");
  /* Pressing a version shows it. */
  await strip.nth(0).click();
  await expect(page.getByTestId("v12-preview-version")).toHaveText("v1 of 3");
  await expect(strip.nth(0)).toHaveAttribute("aria-pressed", "true");
  await expect(strip.nth(2)).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("v12-preview-picture")).toBeVisible();
  /* A shot with one version names none, and has no Compare. */
  await page.keyboard.press("Escape");
  await expect(preview(page)).toHaveCount(0);
  await open(page, "shot-2");
  await expect(page.getByTestId("v12-preview-version")).toHaveCount(0);
  await expect(page.getByTestId("v12-preview-compare")).toHaveCount(0);
});

test("Compare sets the version before beside the one on screen, each labelled", async ({ page }) => {
  await open(page, "shot-7");
  await page.getByTestId("v12-preview-compare").click();
  const view = page.getByTestId("v12-preview-compare-view");
  await expect(view).toBeVisible();
  await expect(view.getByTestId("v12-preview-compare-label")).toHaveText(["v2", "v3"]);
  await expect(page.getByTestId("v12-preview-compare")).toHaveAttribute("aria-pressed", "true");
  /* Pressing v2 in the strip compares v1 with v2. */
  await page.getByTestId("v12-preview-versions").getByTestId("v12-preview-version-btn").nth(1).click();
  await expect(view.getByTestId("v12-preview-compare-label")).toHaveText(["v1", "v2"]);
  const boxes = await view.locator(".v12-pv-img").evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height }; }));
  expect(boxes).toHaveLength(2);
  for (const b of boxes) { expect(b.w).toBeGreaterThan(40); expect(b.h).toBeGreaterThan(20); }
  await page.getByTestId("v12-preview-compare").click();
  await expect(view).toHaveCount(0);
});

test("✓ and ✕ act on the version on screen, through the review trail; ✕ names the version and sends the reason as a note", async ({ page }) => {
  const calls = await watch(page);
  await open(page, "shot-7");
  const strip = page.getByTestId("v12-preview-versions").getByTestId("v12-preview-version-btn");
  /* v3 is on screen: ✓ approves v3 (a review version), and v2 is not touched. */
  await expect(page.getByTestId("v12-preview-ok")).toHaveText("✓ Approve v3");
  await page.getByTestId("v12-preview-ok").click();
  await expect.poll(() => calls.filter((c) => c.method === "PATCH").length).toBe(1);
  expect(calls[0]).toMatchObject({ url: "/api/jobs/gen_s7c", body: { reviewState: "approved" } });
  /* v2: ✕ asks what is wrong with v2, and a chip records it on v2. */
  await strip.nth(1).click();
  await page.getByTestId("v12-preview-no").click();
  const reasons = page.getByTestId("v12-preview-reasons");
  await expect(reasons).toContainText("What’s wrong with v2?");
  await expect(page.getByTestId("v12-preview-no")).toHaveAttribute("aria-expanded", "true");
  await reasons.getByRole("button", { name: "Wrong framing", exact: true }).click();
  await expect.poll(() => calls.filter((c) => c.url === "/api/notes").length).toBe(1);
  expect(calls.filter((c) => c.method === "PATCH" && c.url === "/api/jobs/gen_s7b").map((c) => c.body)).toEqual([{ reviewState: "changes" }]);
  expect(calls.find((c) => c.url === "/api/notes")?.body).toEqual({ genId: "gen_s7b", text: "Wrong framing" });
  await expect(reasons).toHaveCount(0);
  /* The approved shot's ✓ says so and takes it back. */
  await page.keyboard.press("Escape");
  await open(page, "shot-3");
  await expect(page.getByTestId("v12-preview-ok")).toHaveText("✓ Approved");
  await expect(page.getByTestId("v12-preview-ok")).toHaveAttribute("title", /Approved by Reviewer One/);
  await page.getByTestId("v12-preview-ok").click();
  await expect.poll(() => calls.filter((c) => c.method === "PATCH" && c.url === "/api/jobs/gen_s3").length).toBe(1);
  expect(calls.find((c) => c.url === "/api/jobs/gen_s3")?.body).toEqual({ reviewState: "" });
  expect(calls.filter((c) => c.url.startsWith("/api/generate"))).toEqual([]);
});

test("a shot with nothing to judge (making, failed, no take) has no preview ✓ ✕; Download points at the original as an attachment", async ({ page }) => {
  await open(page, "shot-2");
  await expect(page.getByTestId("v12-preview-ok")).toBeVisible();
  const href = await page.getByTestId("v12-preview-download").getAttribute("href");
  expect(href).toBeTruthy();
  await page.keyboard.press("Escape");
  await open(page, "shot-4");
  await expect(page.getByTestId("v12-preview-ok")).toHaveCount(0);
  await expect(page.getByTestId("v12-preview-no")).toHaveCount(0);
  await expect(page.getByTestId("v12-preview-download")).toHaveCount(0);
});

test("← and → step through the cards and wrap; Esc closes the reasons first, then the preview, and the focus goes back to the card", async ({ page }) => {
  await open(page, "shot-1");
  await expect(page.getByTestId("v12-preview-title")).toHaveText("Shot 1 · Camp at night");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("v12-preview-title")).toHaveText("Shot 2 · MAYA arrives");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("v12-preview-title")).toHaveText("Shot 8 · A clip");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("v12-preview-title")).toHaveText("Shot 1 · Camp at night");
  /* Esc: the reasons first. */
  await page.getByTestId("v12-preview-no").click();
  await expect(page.getByTestId("v12-preview-reasons")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("v12-preview-reasons")).toHaveCount(0);
  await expect(preview(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(preview(page)).toHaveCount(0);
  await expect(card(page, "shot-1")).toBeFocused();
  /* The arrows do not step while a field has them. */
  await open(page, "shot-1");
  await page.getByTestId("v12-preview-no").click();
  await page.getByLabel("One line, optional").fill("ab");
  await page.getByLabel("One line, optional").press("ArrowLeft");
  await expect(page.getByTestId("v12-preview-title")).toHaveText("Shot 1 · Camp at night");
});

test("a clip has its controls and a script its tabs; a sound draws its waveform", async ({ page }) => {
  await open(page, "shot-8");
  await expect(page.getByTestId("v12-preview-video")).toBeVisible();
  await expect(page.getByTestId("v12-preview-play")).toHaveAccessibleName("Play");
  await expect(page.getByTestId("v12-preview-scrub")).toBeVisible();
  await expect(page.getByTestId("v12-preview-time")).toHaveText(/^\d:\d\d \/ \d:\d\d$/);
  await page.keyboard.press("Escape");
  await page.getByTestId("open-script").click();
  const tabs = page.getByTestId("v12-preview-tab");
  await expect(tabs).toHaveText(["Script", "Beats", "Breakdown"]);
  await expect(page.getByTestId("v12-preview-text")).toContainText("A cold bottle");
  await tabs.nth(1).click();
  await expect(page.getByTestId("v12-preview-text")).toContainText("The arrival");
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  /* A script is not a take: no ✓ ✕, no versions to compare. */
  await expect(page.getByTestId("v12-preview-ok")).toHaveCount(0);
  await expect(page.getByTestId("v12-preview-compare")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByTestId("open-sound").click();
  await expect(page.getByTestId("v12-preview-wave").locator("span")).toHaveCount(40);
});

test("the preview fits the window at every size: no sideways scroll, its header and versions inside it, text 12 px or more, 44 px controls on a touch screen", async ({ page }, info) => {
  await open(page, "shot-7");
  await page.getByTestId("v12-preview-compare").click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), "horizontal overflow").toBeLessThanOrEqual(0);
  const view = page.viewportSize()!;
  const inside = await preview(page).evaluate((el) => {
    const out: string[] = [];
    for (const sel of ["[data-testid=v12-preview-title]", "[data-testid=v12-preview-ok]", "[data-testid=v12-preview-no]", "[data-testid=v12-preview-compare]", "[data-testid=v12-preview-close]", "[data-testid=v12-preview-versions]"]) {
      const node = el.querySelector(sel); if (!node) { out.push(`${sel} missing`); continue; }
      const r = node.getBoundingClientRect();
      if (r.left < -0.5 || r.right > window.innerWidth + 0.5 || r.top < -0.5 || r.bottom > window.innerHeight + 0.5) out.push(`${sel} outside (${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)})`);
    }
    return out;
  });
  expect(inside, `${view.width}x${view.height}`).toEqual([]);
  const small = await preview(page).evaluate((root) => {
    const out: string[] = [];
    for (const el of root.querySelectorAll<HTMLElement>("*")) {
      if (![...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? "").trim())) continue;
      const px = parseFloat(getComputedStyle(el).fontSize);
      if (px < 12) out.push(`${el.className} ${px}px`);
    }
    return out;
  });
  expect(small, "text under 12 px").toEqual([]);
  if (isCompact(info)) {
    const tiny = await preview(page).evaluate((root) => [...root.querySelectorAll<HTMLElement>("button, a, input")].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.height < 43.5 || r.width < 43.5) && !el.closest(".v12-pv-versions"); }).map((el) => `${el.getAttribute("data-testid") ?? el.className} ${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`));
    expect(tiny, "controls under 44 px").toEqual([]);
  }
});

test("the large screens: the preview fills the window, with its picture inside it and no sideways scroll", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1920x1080", "the large sizes are set here, once");
  for (const [width, height] of [[1728, 1117], [2560, 1440]]) {
    await page.setViewportSize({ width, height });
    await open(page, "shot-7");
    const box = (await preview(page).boundingBox())!;
    expect(box.x, `${width}: starts at the left edge`).toBeLessThanOrEqual(0.5);
    expect(box.width, `${width}: fills the window`).toBeGreaterThanOrEqual(width - 1);
    expect(box.height, `${width}: fills the window`).toBeGreaterThanOrEqual(height - 1);
    const pic = (await page.getByTestId("v12-preview-picture").boundingBox())!;
    expect(pic.x >= 0 && pic.x + pic.width <= width && pic.y >= 0 && pic.y + pic.height <= height, `${width}: the picture is inside`).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `${width}: horizontal overflow`).toBeLessThanOrEqual(0);
    await page.keyboard.press("Escape");
    await expect(preview(page)).toHaveCount(0);
  }
});
