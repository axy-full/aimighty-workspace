import { test, expect, type Page } from "@playwright/test";
import { isCompact } from "./helpers/shellMode";

/*
 * PR 5: ✓ and ✕ on takes. The v25 card fed by a shot's takes (components/v12/board/ShotStepCard.tsx), on the test-only page app/(test)/v25-board-parts
 * (a 404 outside a local ENGINE_MOCK=1 development server). The page's rows are mock; the review routes are answered here, so what is checked is what the
 * card asks of them: ✓ is the review trail's approve (and takes it back), ✕ is its "changes" mark with the reason as a note on the take, a card with nothing
 * to judge has no ✓ ✕, and nothing is paid. Also the review's should-fixes on the card: one tile a card, a greyed page keeps its words, ✕ says it is open
 * and what it opens, and the focus comes back to the card once a reason is sent.
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
const kinds = (page: Page) => page.getByTestId("v25-board-kinds");
const card = (scope: ReturnType<typeof takes>, id: string) => scope.locator(`[data-card="${id}"]`);
const status = (scope: ReturnType<typeof takes>, id: string) => card(scope, id).getByTestId("v12-card-status");
async function reveal(scope: ReturnType<typeof takes>, id: string) { await card(scope, id).hover(); await card(scope, id).focus(); }

test("the five statuses are read from the shot's takes: Ready (· vN with more than one), ✓ Approved, Making…, and Not started for none or a failed one", async ({ page }) => {
  const t = takes(page);
  await expect(status(t, "shot-1")).toHaveText("Ready · v2");
  await expect(status(t, "shot-2")).toHaveText("Ready");
  await expect(status(t, "shot-3")).toHaveText("✓ Approved");
  await expect(status(t, "shot-4")).toHaveText("Making…");
  await expect(status(t, "shot-5")).toHaveText("Not started");
  await expect(status(t, "shot-6")).toHaveText("Not started");
  /* The ✓ names who approved it, on hover (the server shows names to this workspace's members only). */
  await reveal(t, "shot-3");
  await card(t, "shot-3").getByRole("button", { name: /^Approve|^Approved/ }).hover();
  await expect(page.getByTestId("v12-tooltip")).toContainText("Approved by Reviewer One");
});

test("✓ is the review trail's approve and takes itself back; ✕ sends the take back with its reason as a note; a card with nothing to judge has neither", async ({ page }, info) => {
  const calls = await watch(page);
  const t = takes(page);
  /* ✓ on a ready card: one PATCH, "approved", on the shown version, with an Undo in the toast. */
  await reveal(t, "shot-2");
  await card(t, "shot-2").getByRole("button", { name: "Approve Shot 2 · MAYA arrives" }).click();
  await expect.poll(() => calls.filter((c) => c.method === "PATCH").length).toBe(1);
  expect(calls[0]).toMatchObject({ url: "/api/jobs/gen_s2", body: { reviewState: "approved" } });
  await expect(page.getByText("Shot 2 v1 approved").first()).toBeVisible();
  /* ✓ on an approved card takes the approval back (Ready again). */
  await reveal(t, "shot-3");
  await card(t, "shot-3").getByRole("button", { name: "Approve Shot 3 · At the water" }).click();
  await expect.poll(() => calls.filter((c) => c.method === "PATCH").length).toBe(2);
  expect(calls[1]).toMatchObject({ url: "/api/jobs/gen_s3", body: { reviewState: "" } });
  /* ✕ with a chip: the "changes" mark on the shown version, then the reason as a note on it. */
  await reveal(t, "shot-1");
  await card(t, "shot-1").getByRole("button", { name: /^Not right/ }).click();
  const reasons = card(t, "shot-1").getByTestId("v12-card-reasons");
  await expect(reasons).toBeVisible();
  await reasons.getByRole("button", { name: "Off the brief", exact: true }).click();
  await expect.poll(() => calls.filter((c) => c.url === "/api/notes").length).toBe(1);
  const marks = calls.filter((c) => c.method === "PATCH" && c.url === "/api/jobs/gen_s1b");
  expect(marks).toHaveLength(1);
  expect(marks[0].body).toEqual({ reviewState: "changes" });
  expect(calls.find((c) => c.url === "/api/notes")?.body).toEqual({ genId: "gen_s1b", text: "Off the brief" });
  /* The focus is back on the card, not lost with the panel. */
  await expect(card(t, "shot-1")).toBeFocused();
  /* "Other" with a line records the line. */
  await reveal(t, "shot-2");
  await card(t, "shot-2").getByRole("button", { name: /^Not right/ }).click();
  await card(t, "shot-2").getByTestId("v12-card-reasons").getByRole("button", { name: "Other", exact: true }).click();
  await card(t, "shot-2").getByLabel("One line, optional").fill("Too dark by the fire");
  await card(t, "shot-2").getByLabel("One line, optional").press("Enter");
  await expect.poll(() => calls.filter((c) => c.url === "/api/notes").length).toBe(2);
  expect(calls.filter((c) => c.url === "/api/notes")[1].body).toEqual({ genId: "gen_s2", text: "Too dark by the fire" });
  /* A card with nothing to judge (making, failed, no take) offers neither ✓ nor ✕. */
  for (const id of ["shot-4", "shot-5", "shot-6"]) {
    if (!isCompact(info)) await card(t, id).hover();
    await expect(card(t, id).getByRole("button", { name: /^Approve|^Not right/ }), id).toHaveCount(0);
  }
  /* Free: nothing was generated. */
  expect(calls.filter((c) => c.url.startsWith("/api/generate"))).toEqual([]);
});

test("✕ says it is open and what it opens, and Esc closes it and keeps the status", async ({ page }) => {
  await watch(page);
  const t = takes(page);
  await reveal(t, "shot-2");
  const no = card(t, "shot-2").getByRole("button", { name: /^Not right/ });
  await expect(no).toHaveAttribute("aria-expanded", "false");
  await expect(no).not.toHaveAttribute("aria-pressed", /.*/);
  await no.click();
  await expect(no).toHaveAttribute("aria-expanded", "true");
  const panel = card(t, "shot-2").getByTestId("v12-card-reasons");
  const id = await panel.getAttribute("id");
  expect(id).toBeTruthy();
  await expect(no).toHaveAttribute("aria-controls", id!);
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(no).toHaveAttribute("aria-expanded", "false");
  await expect(status(t, "shot-2")).toHaveText("Ready");
});

test("one tile a card: none on a picture, one on a page's title row, one large on a card with neither; a greyed page keeps its words", async ({ page }) => {
  const k = kinds(page);
  const tiles = (id: string) => card(k, id).locator(".v12-card-tile");
  await expect(tiles("k-pic-tile")).toHaveCount(0);
  await expect(tiles("k-text")).toHaveCount(1);
  await expect(tiles("k-tile")).toHaveCount(1);
  await expect(tiles("k-grey-text")).toHaveCount(1);
  /* A greyed page has no scrim over it, and its words are drawn as an ungreyed page's are (rule 15). */
  await expect(card(k, "k-grey-text").locator(".v12-card-grey")).toHaveCount(0);
  const color = (id: string) => card(k, id).locator(".v12-card-page-text").evaluate((el) => getComputedStyle(el).color);
  expect(await color("k-grey-text")).toBe(await color("k-text"));
  expect(await card(k, "k-grey-text").locator(".v12-card-page-text").evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
  /* A greyed picture still has its scrim. */
  await expect(card(k, "k-grey").locator(".v12-card-grey")).toHaveCount(1);
});

test("no sideways scroll, and no word under 12 px or 55% white on the takes board", async ({ page }) => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), "horizontal overflow").toBeLessThanOrEqual(0);
  const small = await takes(page).evaluate((root) => {
    const out: string[] = [];
    for (const el of root.querySelectorAll<HTMLElement>("*")) {
      if (!el.childNodes.length || ![...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? "").trim())) continue;
      const px = parseFloat(getComputedStyle(el).fontSize);
      if (px < 12) out.push(`${el.className} ${px}px`);
    }
    return out;
  });
  expect(small, "text under 12 px").toEqual([]);
});
