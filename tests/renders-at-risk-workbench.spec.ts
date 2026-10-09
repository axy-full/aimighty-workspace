import { test, expect as baseExpect, type APIRequestContext, type Page } from "@playwright/test";
import { password, signupInvite } from "./helpers/identityAdmin";
import { signInLocally } from "./helpers/workbenchLocal";
import type { AtRiskDesk } from "../lib/rendersAtRiskText";

/**
 * The platform desk's "Renders at risk" card (components/RendersAtRiskCard.tsx)
 * at every configured viewport: the line (count and oldest), the list, the empty
 * and fault states, nothing past the screen's edge and nothing too faint to read.
 * The card's data is mocked at the browser (page.route); the page itself runs on
 * a local ENGINE_MOCK server, signed in as the platform owner. Nothing is sent
 * to any provider or mail service.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const TOUCH = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const expect = baseExpect.configure({ timeout: 60_000 });
const MIN = 60_000;
const HOUR = 60 * MIN;
const ROUTE = "**/api/admin/renders-at-risk";

function desk(count: number): AtRiskDesk {
  const at = Date.UTC(2026, 9, 9, 12, 0, 0);
  const renders = Array.from({ length: Math.min(count, 3) }, (_, i) => ({
    workspaceId: `ws_${i}_a_rather_long_workspace_identifier_that_must_wrap`,
    workspace: i === 0 ? "Harbour Films International Productions Limited" : `Studio ${i}`,
    generationId: `gen_${i}_01JABCDEFGHJKMNPQRSTVWXYZ0123456789`,
    provider: i === 2 ? "fal" : "byteplus",
    model: i === 2 ? "fal-ai/kling-video/v3/standard/text-to-video" : "dreamina-seedance-2-5-260628",
    since: at - (50 - i * 20) * HOUR,
    billed: i !== 2,
    lost: i === 0,
    lastError: i === 1 ? null : "storage refused the upload (503): the bucket answered SlowDown after three attempts",
    alertedAt: at - HOUR,
  }));
  return { at, count, lost: count ? 1 : 0, oldestSince: count ? at - 50 * HOUR : null, lastMailAt: count ? at - HOUR : null, renders };
}

/** The platform's owner, as the local server names it (SUPER_ADMIN_EMAIL): signed in, or signed up once through an invitation. */
async function signInAsPlatformOwner(api: APIRequestContext) {
  const ownerEmail = "platform-owner@example.test";
  const login = await api.post("/api/auth/login", { data: { email: ownerEmail, password } });
  if (!login.ok()) {
    const code = await signupInvite(ownerEmail);
    const signup = await api.post("/api/auth/signup", { data: { code, name: "Platform owner", email: ownerEmail, workspace: "Platform desk", password, accept: true } });
    baseExpect(signup.ok(), await signup.text()).toBe(true);
  }
  const me = await api.get("/api/me").then((r) => r.json()) as { superAdmin?: boolean };
  baseExpect(me.superAdmin, `start the server with SUPER_ADMIN_EMAIL=${ownerEmail}`).toBe(true);
}

async function pageOverflow(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}
/** Nothing in `scope` scrolls sideways or reaches past the card's or the screen's edge. */
async function fits(page: Page, scope: string): Promise<string[]> {
  return page.evaluate((scope) => {
    const root = document.querySelector<HTMLElement>(scope);
    if (!root) return [`no ${scope}`];
    const out: string[] = [];
    const box = root.getBoundingClientRect();
    for (const el of [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))]) {
      if (!el.getClientRects().length) continue;
      if (el.scrollWidth > el.clientWidth + 0.5 && getComputedStyle(el).overflowX !== "visible") out.push(`${el.className || el.tagName} scrolls sideways`);
      const rect = el.getBoundingClientRect();
      if (rect.width && (rect.right > box.right + 0.5 || rect.right > window.innerWidth + 0.5)) out.push(`${el.className || el.tagName} ends at ${Math.round(rect.right)}`);
    }
    return out;
  }, scope);
}
/** Readable: every text at least 12 px, and none dimmer than #7C7C84 on its ground (lighter than it on a light one). */
async function unreadable(page: Page, scope: string): Promise<string[]> {
  return page.evaluate((scope) => {
    const rgba = (c: string) => { const n = (c.match(/[\d.]+/g) ?? ["0", "0", "0"]).map(Number); return [n[0], n[1], n[2], n.length > 3 ? n[3] : 1]; };
    const over = (top: number[], under: number[]) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3]));
    const luminance = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    const root = document.querySelector(scope);
    if (!root) return [`no ${scope}`];
    const out: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      if (!el || !(node.textContent ?? "").trim() || !el.getClientRects().length) continue;
      const chain: Element[] = [];
      for (let e: Element | null = el; e; e = e.parentElement) chain.unshift(e);
      let ground = [0, 0, 0];
      for (const e of chain) { const bg = rgba(getComputedStyle(e).backgroundColor); if (bg[3] > 0) ground = over(bg, ground); }
      const style = getComputedStyle(el);
      const ink = over(rgba(style.color), ground);
      const floor = luminance([0x7c, 0x7c, 0x84]);
      const faint = luminance(ground) > 128 ? luminance(ink) > floor + 0.5 : luminance(ink) < floor - 0.5;
      const text = (node.textContent ?? "").trim().slice(0, 24);
      if (faint) out.push(`faint ${style.color}: “${text}”`);
      if (parseFloat(style.fontSize) < 12) out.push(`${style.fontSize}: “${text}”`);
    }
    return out;
  }, scope);
}

test("the platform desk's Renders at risk card: the line, the list, empty and fault states, readable and within the screen", async ({ page, browser }, info) => {
  test.setTimeout(240_000);
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  await signInAsPlatformOwner(page.request);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let reply: { status: number; body: unknown } = { status: 200, body: desk(24) };
  await page.route(ROUTE, (route) => route.fulfill({ status: reply.status, json: reply.body }));

  await page.goto("/admin");
  const card = page.getByTestId("renders-at-risk-card");
  await expect(card).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  await expect(card.getByText("Renders at risk", { exact: true })).toBeVisible();
  await expect(card.getByTestId("renders-at-risk-line")).toHaveText("24 renders with no stored copy · 1 lost · oldest 2 d 2 h");
  /* The list: each render readable on the screen, the fal one marked not billed, the count of the rest. */
  const items = card.locator("span.rail-help");
  await expect(items.filter({ hasText: "Harbour Films International Productions Limited · gen_0_" })).toContainText("byteplus dreamina-seedance-2-5-260628 · 2 d 2 h · lost: no longer retried · last save error: storage refused");
  await expect(items.filter({ hasText: "Studio 2" })).toContainText("fal fal-ai/kling-video/v3/standard/text-to-video · 10 h · provider finished, not billed yet");
  await expect(card.getByText("…and 21 more.")).toBeVisible();
  const width = page.viewportSize()!.width;
  for (const item of await items.all()) {
    await item.scrollIntoViewIfNeeded();
    await expect(item).toBeInViewport();
    const box = (await item.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
  }
  expect(await pageOverflow(page), "no horizontal overflow").toBeLessThanOrEqual(0);
  expect(await fits(page, '[data-testid="renders-at-risk-card"]'), "the card").toEqual([]);
  expect(await unreadable(page, '[data-testid="renders-at-risk-card"]'), "readable text").toEqual([]);

  /* None at risk: one plain line. */
  reply = { status: 200, body: desk(0) };
  await page.reload();
  await expect(page.getByTestId("renders-at-risk-line")).toHaveText("No render is waiting for a stored copy.");
  expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
  expect(await unreadable(page, '[data-testid="renders-at-risk-card"]')).toEqual([]);

  /* A read that fails says so, with a Try again big enough to touch, and Try again reads it. */
  reply = { status: 503, body: { error: "unavailable" } };
  await page.reload();
  const again = page.getByTestId("renders-at-risk-card").getByRole("button", { name: "Try again" });
  await expect(page.getByTestId("renders-at-risk-card")).toContainText("could not be read");
  if (TOUCH.includes(info.project.name)) {
    const box = (await again.boundingBox())!;
    expect(Math.round(box.height)).toBeGreaterThanOrEqual(44);
  }
  expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
  reply = { status: 200, body: desk(1) };
  await again.click();
  await expect(page.getByTestId("renders-at-risk-line")).toHaveText("1 render with no stored copy · 1 lost · oldest 2 d 2 h");
  expect(errors).toEqual([]);
  await page.unroute(ROUTE);

  /* The real route answers nobody but the platform owner. */
  const other = await browser.newContext({ baseURL: process.env.PW_BASE_URL || "http://localhost:4551" });
  try {
    const stranger = await other.newPage();
    await signInLocally(stranger.request, "Studio owner");
    baseExpect((await stranger.request.get("/api/admin/renders-at-risk")).status()).toBe(403);
  } finally { await other.close(); }
});
