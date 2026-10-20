import { test, expect, type Page } from "@playwright/test";
import { isCompact } from "./helpers/shellMode";

/*
 * PR 5: ✓ and ✕ on takes. The v25 card fed by a shot's takes (components/v12/board/ShotStepCard.tsx), on the test-only page app/(test)/v25-board-parts
 * (a 404 outside a local ENGINE_MOCK=1 development server). The page's rows are mock; the review routes are answered here, so what is checked is what the
 * card asks of them: ✓ is the review trail's approve, which the card calls Sent (owner, 20 Oct 2026; it takes itself back), ✕ is its "changes" mark with the reason as a note on the take, a card with nothing
 * to judge has no ✓ ✕, and nothing is paid. Also the review's should-fixes on the card: one tile a card, a greyed page keeps its words, ✕ says it is open
 * and what it opens, and the focus comes back to the card once a reason is sent.
 */
type Call = { method: string; url: string; body: Record<string, unknown> | null };
type Note = { text: string; author: string; createdAt: number; guest: boolean };
/** Every request the page makes that is not a read: the only ones allowed here are the review mark and the note. */
const WRITES_ALLOWED = (c: { method: string; url: string }) => (c.method === "PATCH" && /^\/api\/jobs\/[^/]+$/.test(c.url)) || (c.method === "POST" && c.url === "/api/notes");
async function watch(page: Page, notes: Record<string, Note[]> = {}) {
  const calls: Call[] = [];
  const writes: { method: string; url: string }[] = [];
  page.on("request", (r) => { if (!["GET", "HEAD", "OPTIONS"].includes(r.method())) writes.push({ method: r.method(), url: new URL(r.url()).pathname }); });
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
    return route.fulfill({ json: { notes: notes[new URL(req.url()).searchParams.get("genId") ?? ""] ?? [] } });
  });
  return Object.assign(calls, { writes });
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

test("the five statuses are read from the shot's takes: Ready (· vN with more than one), ✓ Sent, Making…, and Not started for none or a failed one", async ({ page }) => {
  const t = takes(page);
  await expect(status(t, "shot-1")).toHaveText("Ready · v2");
  await expect(status(t, "shot-2")).toHaveText("Ready");
  await expect(status(t, "shot-3")).toHaveText("✓ Sent");
  await expect(status(t, "shot-4")).toHaveText("Making…");
  await expect(status(t, "shot-5")).toHaveText("Not started");
  await expect(status(t, "shot-6")).toHaveText("Not started");
  /* An upload, and a finished take whose picture is not here: Ready, with nothing to judge. */
  await expect(status(t, "shot-9")).toHaveText("Ready");
  await expect(status(t, "shot-10")).toHaveText("Ready");
  /* Sent back: "✕", with the team's reason once there is one (the next test answers the notes). */
  await expect(status(t, "shot-11")).toHaveText(/^✕/);
  /* The ✓ names who sent it, on hover (the server shows names to this workspace's members only). */
  await reveal(t, "shot-3");
  await card(t, "shot-3").getByRole("button", { name: /^Send|^Sent/ }).hover();
  await expect(page.getByTestId("v12-tooltip")).toContainText("Sent by Reviewer One");
  await expect(page.getByTestId("v12-tooltip")).not.toContainText("Approve");
});

test("✓ is the review trail's approve (Sent) and takes itself back; ✕ sends the take back with its reason as a note; a card with nothing to judge has neither", async ({ page }, info) => {
  const calls = await watch(page);
  const t = takes(page);
  /* ✓ on a ready card: one PATCH, "approved" (the data value is unchanged), on the shown version, with an Undo in the toast, which says sent. */
  await reveal(t, "shot-2");
  await card(t, "shot-2").getByRole("button", { name: "Send Shot 2 · MAYA arrives" }).click();
  await expect.poll(() => calls.filter((c) => c.method === "PATCH").length).toBe(1);
  expect(calls[0]).toMatchObject({ url: "/api/jobs/gen_s2", body: { reviewState: "approved" } });
  await expect(page.getByText("Shot 2 v1 sent").first()).toBeVisible();
  await expect(page.getByText("Shot 2 v1 approved")).toHaveCount(0);
  await expect(status(t, "shot-2")).toHaveText("✓ Sent");
  /* ✓ on an approved card takes the approval back (Ready again; this page did not see it approved, so its earlier state is not known: ""),
     with an Undo that approves it again. */
  await reveal(t, "shot-3");
  await card(t, "shot-3").getByRole("button", { name: "Send Shot 3 · At the water" }).click();
  await expect.poll(() => calls.filter((c) => c.method === "PATCH").length).toBe(2);
  expect(calls[1]).toMatchObject({ url: "/api/jobs/gen_s3", body: { reviewState: "" } });
  await expect(page.getByTestId("v12-toast")).toContainText("Shot 3 v1 is Ready again");
  await page.getByTestId("v12-toast").getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => calls.filter((c) => c.method === "PATCH").length).toBe(3);
  expect(calls[2]).toMatchObject({ url: "/api/jobs/gen_s3", body: { reviewState: "approved" } });
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
  /* A card with nothing to judge (making, failed, no take, an upload, a finished take with no picture here, an upload shown beside a take) offers neither ✓ nor ✕. */
  for (const id of ["shot-4", "shot-5", "shot-6", "shot-9", "shot-10", "shot-12"]) {
    if (!isCompact(info)) await card(t, id).hover();
    await expect(card(t, id).getByRole("button", { name: /^Send|^Not right/ }), id).toHaveCount(0);
  }
  /* Free: every request that was not a read is the review mark or the note, nothing else (no generate, no spend). */
  expect(calls.writes.length).toBeGreaterThan(0);
  expect(calls.writes.filter((c) => !WRITES_ALLOWED(c)), "a write that is not a review mark or a note").toEqual([]);
});

test("Other with no line is refused (the panel stays and says why, nothing written); one word sends; the line takes at most 500 characters", async ({ page }) => {
  const calls = await watch(page);
  const t = takes(page);
  const reasons = card(t, "shot-2").getByTestId("v12-card-reasons");
  const line = card(t, "shot-2").getByLabel("One line, optional");
  /* The first press on a page that has just loaded can land before it answers: press until the panel is there (it is never closed by this). */
  await expect(async () => {
    if (!(await reasons.count())) { await reveal(t, "shot-2"); await card(t, "shot-2").getByRole("button", { name: /^Not right/ }).click(); }
    await expect(reasons).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await expect(line).toHaveAttribute("maxlength", "500");
  /* Other with no line (owner, 20 Oct 2026: ""Other" needs a line, one word is enough"): refused, the panel stays, the hint says why. */
  await reasons.getByRole("button", { name: "Other", exact: true }).click();
  await expect(line).toHaveAttribute("placeholder", "One word is enough · ⏎ to send");
  await expect(line).toHaveAttribute("aria-required", "true");
  await line.fill("   ");
  await line.press("Enter");
  const hint = card(t, "shot-2").getByTestId("v12-card-reasons-hint");
  await expect(hint).toHaveText("Other needs a line: one word is enough.");
  await expect(hint).toHaveAttribute("role", "alert");
  await expect(reasons).toBeVisible();
  await expect(line).toHaveAttribute("aria-invalid", "true");
  await expect(line).toHaveAttribute("aria-describedby", (await hint.getAttribute("id"))!);
  await expect(status(t, "shot-2")).toHaveText("Ready");
  expect(calls.length, "nothing written for Other with no line").toBe(0);
  /* Emptied again: still refused, and still nothing written. */
  await line.fill("");
  await expect(hint).toHaveCount(0);
  await line.press("Enter");
  await expect(hint).toHaveText("Other needs a line: one word is enough.");
  expect(calls.length, "nothing written for no reason at all").toBe(0);
  /* Too long (a chip and a full line pass 500): said as too long, not as Other's hint (#798 review: the card said "Say why…"). */
  await line.fill("x".repeat(500));
  await expect(line).toHaveValue("x".repeat(500));
  await reasons.getByRole("button", { name: "Wrong framing", exact: true }).click();
  await expect(hint).toHaveText("Too long: 500 characters at most.");
  await expect(reasons).toBeVisible();
  await expect(line).toHaveAttribute("aria-invalid", "true");
  expect(calls.length, "nothing written for a reason that is too long").toBe(0);
  /* Other with one short word sends: "ok" (two letters, refused before 20 Oct) is enough. */
  await reasons.getByRole("button", { name: "Other", exact: true }).click();
  await line.fill("ok");
  await expect(hint).toHaveCount(0);
  await line.press("Enter");
  await expect.poll(() => calls.filter((c) => c.url === "/api/notes").length).toBe(1);
  expect(calls.filter((c) => c.method === "PATCH").map((c) => [c.url, c.body])).toEqual([["/api/jobs/gen_s2", { reviewState: "changes" }]]);
  expect(calls.find((c) => c.url === "/api/notes")?.body).toEqual({ genId: "gen_s2", text: "ok" });
  await expect(reasons).toHaveCount(0);
});

test("a chip other than Other still sends without a line", async ({ page }) => {
  const calls = await watch(page);
  const t = takes(page);
  const reasons = card(t, "shot-2").getByTestId("v12-card-reasons");
  await expect(async () => {
    if (!(await reasons.count())) { await reveal(t, "shot-2"); await card(t, "shot-2").getByRole("button", { name: /^Not right/ }).click(); }
    await expect(reasons).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await expect(card(t, "shot-2").getByLabel("One line, optional")).toHaveValue("");
  await reasons.getByRole("button", { name: "Artifacts", exact: true }).click();
  await expect.poll(() => calls.filter((c) => c.url === "/api/notes").length).toBe(1);
  expect(calls.filter((c) => c.method === "PATCH").map((c) => [c.url, c.body])).toEqual([["/api/jobs/gen_s2", { reviewState: "changes" }]]);
  expect(calls.find((c) => c.url === "/api/notes")?.body).toEqual({ genId: "gen_s2", text: "Artifacts" });
  await expect(reasons).toHaveCount(0);
  await expect(card(t, "shot-2").getByTestId("v12-card-reasons-hint")).toHaveCount(0);
});

test("a rejected card reads the team's reason given at the mark: not a client's newer review-link comment, not an older note", async ({ page }) => {
  await watch(page, { gen_s11: [
    { text: "Nice light", author: "A", createdAt: 0, guest: false },
    { text: "Wrong framing", author: "A", createdAt: 100, guest: false },
    { text: "Love it", author: "Client", createdAt: 200, guest: true },
  ] });
  /* The page read its notes before the route was there: read them again. */
  await page.reload();
  await expect(status(takes(page), "shot-11")).toHaveText("✕ Wrong framing");
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
  /* Rule 15: text people read is at least 12 px and at least 55% white on black (about 6:1). Each word's colour, with its alpha and every ancestor's
     opacity, is laid over black and its contrast with black compared with 55% white's. Words not drawn (opacity 0, hidden) are not read. */
  const found = await takes(page).evaluate((root) => {
    const small: string[] = [];
    const faint: string[] = [];
    const lin = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const lum = (r: number, g: number, b: number) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    const floor = lum(255 * 0.55, 255 * 0.55, 255 * 0.55);
    const probe = document.createElement("canvas").getContext("2d")!;
    const rgba = (css: string) => {
      probe.clearRect(0, 0, 1, 1); probe.fillStyle = "#000"; probe.fillStyle = css; probe.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
      return { r, g, b, a: a / 255 };
    };
    for (const el of root.querySelectorAll<HTMLElement>("*")) {
      if (!el.childNodes.length || ![...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? "").trim())) continue;
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      const style = getComputedStyle(el);
      const px = parseFloat(style.fontSize);
      if (px < 12) small.push(`${el.className} ${px}px`);
      let opacity = 1;
      for (let at: HTMLElement | null = el; at; at = at.parentElement) opacity *= parseFloat(getComputedStyle(at).opacity);
      if (opacity === 0) continue;
      const c = rgba(style.color);
      const k = c.a * opacity;
      if (lum(c.r * k, c.g * k, c.b * k) + 1e-6 < floor) faint.push(`${el.className} "${(el.textContent ?? "").trim().slice(0, 24)}" ${style.color} × ${opacity.toFixed(2)}`);
    }
    return { small, faint };
  });
  expect(found.small, "text under 12 px").toEqual([]);
  expect(found.faint, "text under 55% white on black").toEqual([]);
});
