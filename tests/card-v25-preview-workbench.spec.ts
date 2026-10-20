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
  page.on("request", (r) => { const p = new URL(r.url()).pathname; /* A paid send: not a quote (reading a price is free; the Director board on the same page reads them). */
    if (r.method() === "POST" && p.startsWith("/api/generate") && !p.endsWith("/quote")) calls.push({ method: "POST", url: p, body: null }); });
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
  /* The focus is in the preview once it is open, and stays there (a development build mounts it twice; the first mount's focus-return is cancelled). */
  await page.waitForTimeout(100);
  expect(await preview(page).evaluate((el) => el.contains(document.activeElement)), "the focus is in the preview").toBe(true);
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

test("Compare on clips plays each version's own clip, and on sounds gives each its own player", async ({ page }) => {
  await open(page, "shot-13");
  await page.getByTestId("v12-preview-compare").click();
  const view = page.getByTestId("v12-preview-compare-view");
  await expect(view.getByTestId("v12-preview-compare-label")).toHaveText(["v1", "v2"]);
  /* Two players, each with its own clip (not the shot's frame twice) and its own Play. */
  const videos = view.getByTestId("v12-preview-video");
  await expect(videos).toHaveCount(2);
  const srcs = await videos.evaluateAll((els) => els.map((el) => new URL((el as HTMLVideoElement).src).pathname));
  expect(srcs).toEqual(["/fixtures/clip.mp4", "/fixtures/clip-6s.mp4"]);
  await expect(view.locator('[data-side="a"]').getByTestId("v12-preview-play")).toHaveCount(1);
  await expect(view.locator('[data-side="b"]').getByTestId("v12-preview-play")).toHaveCount(1);
  for (const side of ["a", "b"]) {
    const box = (await view.locator(`[data-side="${side}"]`).getByTestId("v12-preview-video").boundingBox())!;
    expect(box.width, `side ${side}: the clip is drawn`).toBeGreaterThan(40);
    expect(box.height, `side ${side}: the clip is drawn`).toBeGreaterThan(20);
  }
  await page.keyboard.press("Escape");
  await expect(preview(page)).toHaveCount(0);
  /* A sound with two versions: two waveforms and two players, each its own file. */
  await page.getByTestId("open-sound").click();
  await page.getByTestId("v12-preview-compare").click();
  await expect(view.getByTestId("v12-preview-wave")).toHaveCount(2);
  const audio = await view.locator("audio").evaluateAll((els) => els.map((el) => { const u = new URL((el as HTMLAudioElement).src); return u.pathname + u.search; }));
  expect(audio).toEqual(["/fixtures/tone.mp3", "/fixtures/tone.mp3?v=2"]);
  /* A page of words has one text for the card: no Compare. */
  await page.keyboard.press("Escape");
  await page.getByTestId("open-script").click();
  await expect(page.getByTestId("v12-preview-tab").first()).toBeVisible();
  await expect(page.getByTestId("v12-preview-compare")).toHaveCount(0);
});

test("a tall clip's Play and time are not under Previous or Next, at every size", async ({ page }) => {
  await open(page, "shot-14");
  await expect(page.getByTestId("v12-preview-video")).toBeVisible();
  await page.waitForTimeout(300);
  for (const id of ["v12-preview-play", "v12-preview-time"]) {
    const box = (await page.getByTestId(id).boundingBox())!;
    const hit = await page.evaluate(({ x, y, id }) => {
      const at = document.elementFromPoint(x, y);
      return at ? Boolean(at.closest(`[data-testid="${id}"]`)) : false;
    }, { x: box.x + box.width / 2, y: box.y + box.height / 2, id });
    expect(hit, `${id} is the topmost thing at its centre`).toBe(true);
  }
});

test("✓ and ✕ act on the version on screen, through the review trail; ✕ names the version and sends the reason as a note", async ({ page }) => {
  const calls = await watch(page);
  await open(page, "shot-7");
  const strip = page.getByTestId("v12-preview-versions").getByTestId("v12-preview-version-btn");
  /* v3 is on screen: ✓ sends v3 (a review version; the trail's "approved" mark), and v2 is not touched. */
  await expect(page.getByTestId("v12-preview-ok")).toHaveText("✓ Send v3");
  await expect(page.getByTestId("v12-preview-ok")).toHaveAttribute("title", "Send this version");
  await page.getByTestId("v12-preview-ok").click();
  await expect.poll(() => calls.filter((c) => c.method === "PATCH").length).toBe(1);
  expect(calls[0]).toMatchObject({ url: "/api/jobs/gen_s7c", body: { reviewState: "approved" } });
  await expect(page.getByTestId("v12-toast")).toContainText("Shot 7 v3 sent");
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
  /* The sent shot's ✓ says so and takes it back. */
  await page.keyboard.press("Escape");
  await open(page, "shot-3");
  await expect(page.getByTestId("v12-preview-ok")).toHaveText("✓ Sent");
  await expect(page.getByTestId("v12-preview-ok")).toHaveAttribute("title", "Sent by Reviewer One. Press again to undo.");
  await expect(page.getByTestId("v12-preview-versions").getByTestId("v12-preview-version-btn").first()).toHaveAttribute("aria-label", "v1, sent");
  await page.getByTestId("v12-preview-ok").click();
  await expect.poll(() => calls.filter((c) => c.method === "PATCH" && c.url === "/api/jobs/gen_s3").length).toBe(1);
  expect(calls.find((c) => c.url === "/api/jobs/gen_s3")?.body).toEqual({ reviewState: "" });
  /* Through the card's judge (#792): Ready again, with an Undo that approves it again. */
  await expect(page.getByTestId("v12-toast")).toContainText("Shot 3 v1 is Ready again");
  await page.getByTestId("v12-toast").getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => calls.filter((c) => c.method === "PATCH" && c.url === "/api/jobs/gen_s3").length).toBe(2);
  expect(calls.filter((c) => c.url === "/api/jobs/gen_s3").map((c) => c.body)).toEqual([{ reviewState: "" }, { reviewState: "approved" }]);
  expect(calls.filter((c) => c.url.startsWith("/api/generate"))).toEqual([]);
});

test("a shot with nothing to judge (making, failed, no take, an upload, a take with no picture here) has no preview ✓ ✕; Download points at the original as an attachment", async ({ page }) => {
  await open(page, "shot-2");
  await expect(page.getByTestId("v12-preview-ok")).toBeVisible();
  const href = await page.getByTestId("v12-preview-download").getAttribute("href");
  expect(href).toBeTruthy();
  await page.keyboard.press("Escape");
  await open(page, "shot-4");
  await expect(page.getByTestId("v12-preview-ok")).toHaveCount(0);
  await expect(page.getByTestId("v12-preview-no")).toHaveCount(0);
  await expect(page.getByTestId("v12-preview-download")).toHaveCount(0);
  /* #792's rows: an upload, and a finished take whose picture is not here. */
  for (const id of ["shot-9", "shot-10"]) {
    await page.keyboard.press("Escape");
    await expect(preview(page)).toHaveCount(0);
    await open(page, id);
    await expect(page.getByTestId("v12-preview-ok"), id).toHaveCount(0);
    await expect(page.getByTestId("v12-preview-no"), id).toHaveCount(0);
  }
});

test("in a shot with a take and an upload, the take's version has ✓ ✕ and the upload's has neither", async ({ page }) => {
  const calls = await watch(page);
  await open(page, "shot-12");
  /* It opens on the upload (v2, shown): no marks, though it has a picture and Download. */
  await expect(page.getByTestId("v12-preview-version")).toHaveText("v2 of 2");
  await expect(page.getByTestId("v12-preview-picture")).toBeVisible();
  await expect(page.getByTestId("v12-preview-ok")).toHaveCount(0);
  await expect(page.getByTestId("v12-preview-no")).toHaveCount(0);
  /* The take (v1): ✓ and ✕, acting on v1. */
  const strip = page.getByTestId("v12-preview-versions").getByTestId("v12-preview-version-btn");
  await strip.nth(0).click();
  await expect(page.getByTestId("v12-preview-version")).toHaveText("v1 of 2");
  await expect(page.getByTestId("v12-preview-ok")).toHaveText("✓ Send v1");
  await expect(page.getByTestId("v12-preview-no")).toBeVisible();
  await page.getByTestId("v12-preview-ok").click();
  await expect.poll(() => calls.filter((c) => c.method === "PATCH").length).toBe(1);
  expect(calls[0]).toMatchObject({ url: "/api/jobs/gen_s12a", body: { reviewState: "approved" } });
  /* Back to the upload: the marks go again. */
  await strip.nth(1).click();
  await expect(page.getByTestId("v12-preview-version")).toHaveText("v2 of 2");
  await expect(page.getByTestId("v12-preview-ok")).toHaveCount(0);
  await expect(page.getByTestId("v12-preview-no")).toHaveCount(0);
  expect(calls.filter((c) => c.url === "/api/jobs/gen_s12b")).toEqual([]);
});

test("Other with no line keeps the preview's ✕ panel open and says why, nothing written; one word sends; the line takes at most 500 characters", async ({ page }) => {
  const calls = await watch(page);
  await open(page, "shot-2");
  await page.getByTestId("v12-preview-no").click();
  const reasons = page.getByTestId("v12-preview-reasons");
  const line = reasons.getByLabel("Why", { exact: true });
  await expect(line).toHaveAttribute("maxlength", "500");
  /* Other with no line (owner, 20 Oct 2026: ""Other" needs a line, one word is enough"): refused, and the panel says why. */
  await reasons.getByRole("button", { name: "Other", exact: true }).click();
  await expect(line).toHaveAttribute("placeholder", "One word is enough · ⏎");
  await expect(line).toHaveAttribute("aria-required", "true");
  await line.fill("  ");
  await line.press("Enter");
  const hint = page.getByTestId("v12-preview-reasons-hint");
  await expect(hint).toHaveText("Other needs a line: one word is enough.");
  await expect(hint).toHaveAttribute("role", "alert");
  await expect(reasons).toBeVisible();
  await expect(line).toHaveValue("  ");
  await expect(line).toHaveAttribute("aria-invalid", "true");
  await expect(line).toHaveAttribute("aria-describedby", (await hint.getAttribute("id"))!);
  expect(calls.length, "nothing written for Other with no line").toBe(0);
  /* The panel and its hint stay inside the stage and the window, at every size (it scrolls inside itself when the stage is short). */
  const fit = await reasons.evaluate((panel) => {
    const r = panel.getBoundingClientRect();
    const stage = panel.closest(".v12-pv-stage")!.getBoundingClientRect();
    const input = panel.querySelector("input")!.getBoundingClientRect();
    const said = panel.querySelector("[role=alert]")!.getBoundingClientRect();
    const out: string[] = [];
    if (r.left < -0.5 || r.top < -0.5 || r.right > window.innerWidth + 0.5 || r.bottom > window.innerHeight + 0.5) out.push(`panel outside the window (${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)})`);
    if (r.top < stage.top - 0.5 || r.bottom > stage.bottom + 0.5) out.push(`panel outside the stage (${Math.round(r.top)}-${Math.round(r.bottom)} in ${Math.round(stage.top)}-${Math.round(stage.bottom)})`);
    if (input.top < r.top - 0.5 || input.bottom > r.bottom + 0.5) out.push("the line is scrolled out of the panel");
    if (said.top < r.top - 0.5 || said.bottom > r.bottom + 0.5) out.push("the hint is scrolled out of the panel");
    return out;
  });
  expect(fit).toEqual([]);
  await expect(hint).toBeInViewport();
  /* Too long (a chip and a full line pass 500): said as too long, not as Other's hint. */
  await line.fill("x".repeat(500));
  await expect(line).toHaveValue("x".repeat(500));
  await reasons.getByRole("button", { name: "Wrong framing", exact: true }).click();
  await expect(hint).toHaveText("Too long: 500 characters at most.");
  await expect(reasons).toBeVisible();
  expect(calls.length, "nothing written for a reason that is too long").toBe(0);
  /* Other with one short word sends ("Other" again, so the line is the whole reason): "ok", two letters, refused before 20 Oct, is enough. */
  await reasons.getByRole("button", { name: "Other", exact: true }).click();
  await line.fill("ok");
  await expect(hint).toHaveCount(0);
  await line.press("Enter");
  await expect.poll(() => calls.filter((c) => c.url === "/api/notes").length).toBe(1);
  expect(calls.filter((c) => c.method === "PATCH").map((c) => [c.url, c.body])).toEqual([["/api/jobs/gen_s2", { reviewState: "changes" }]]);
  expect(calls.find((c) => c.url === "/api/notes")?.body).toEqual({ genId: "gen_s2", text: "ok" });
  await expect(reasons).toHaveCount(0);
});

test("in the preview, a chip other than Other still sends without a line", async ({ page }) => {
  const calls = await watch(page);
  await open(page, "shot-2");
  await page.getByTestId("v12-preview-no").click();
  const reasons = page.getByTestId("v12-preview-reasons");
  await expect(reasons.getByLabel("Why", { exact: true })).toHaveValue("");
  await reasons.getByRole("button", { name: "Off the brief", exact: true }).click();
  await expect.poll(() => calls.filter((c) => c.url === "/api/notes").length).toBe(1);
  expect(calls.filter((c) => c.method === "PATCH").map((c) => [c.url, c.body])).toEqual([["/api/jobs/gen_s2", { reviewState: "changes" }]]);
  expect(calls.find((c) => c.url === "/api/notes")?.body).toEqual({ genId: "gen_s2", text: "Off the brief" });
  await expect(reasons).toHaveCount(0);
  await expect(page.getByTestId("v12-preview-reasons-hint")).toHaveCount(0);
});

test("← and → step through the cards and wrap; Esc closes the reasons first, then the preview, and the focus goes back to the card", async ({ page }) => {
  await open(page, "shot-1");
  await expect(page.getByTestId("v12-preview-title")).toHaveText("Shot 1 · Camp at night");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("v12-preview-title")).toHaveText("Shot 2 · MAYA arrives");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  /* The last card is shot 14 (the rows run 1 to 8, then #792's 9 to 11, then 12 to 14). */
  await expect(page.getByTestId("v12-preview-title")).toHaveText("Shot 14 · Tall clip");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("v12-preview-title")).toHaveText("Shot 1 · Camp at night");
  /* Esc: the reasons first, and the focus goes back to ✕. */
  await page.getByTestId("v12-preview-no").click();
  await expect(page.getByTestId("v12-preview-reasons")).toBeVisible();
  await page.getByLabel("Why", { exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("v12-preview-reasons")).toHaveCount(0);
  await expect(preview(page)).toBeVisible();
  await expect(page.getByTestId("v12-preview-no")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(preview(page)).toHaveCount(0);
  await expect(card(page, "shot-1")).toBeFocused();
  /* The arrows do not step while a field has them. */
  await open(page, "shot-1");
  await page.getByTestId("v12-preview-no").click();
  await page.getByLabel("Why", { exact: true }).fill("ab");
  await page.getByLabel("Why", { exact: true }).press("ArrowLeft");
  await expect(page.getByTestId("v12-preview-title")).toHaveText("Shot 1 · Camp at night");
  /* A layer that owns its keys (a menu beside the preview) keeps them: the preview neither steps nor closes. */
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("v12-preview-reasons")).toHaveCount(0);
  await page.evaluate(() => { const m = document.createElement("div"); m.setAttribute("role", "menu"); m.tabIndex = 0; m.dataset.testid = "a-menu"; m.textContent = "Menu"; document.body.appendChild(m); m.focus(); });
  await expect(page.getByTestId("a-menu")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Escape");
  await expect(preview(page)).toBeVisible();
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
    const tiny = await preview(page).evaluate((root) => [...root.querySelectorAll<HTMLElement>("button, a, input")].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.height < 43.5 || r.width < 43.5); }).map((el) => `${el.getAttribute("data-testid") ?? el.className} ${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`));
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
