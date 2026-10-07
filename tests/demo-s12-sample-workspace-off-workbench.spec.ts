import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { seedFinishedProduction } from "./helpers/s12-sample";
import { PAID_PATTERNS } from "./helpers/paidRoutes";

/*
 * The owner's switch (6 Oct): guests find nothing that spends in the sample workspace (the one holding the sample mark,
 * which Guest Home reads from). On a local ENGINE_MOCK server the signed-in person marks their finished production as
 * the sample, then walks Home, Make, Atomik and both boards (the sample's copy and their own production). On every
 * screen no paid control is enabled: a `data-spend` control is "free" or disabled, a button showing a credit figure is
 * disabled, Make has no Enhance, and Atomik's ask box carries the sample's line with no price. No paid POST leaves the
 * page at any point (quotes and reads are not paid). Runs at 1440x900 and 390x844.
 */
const LINE = "Sample production · nothing here spends credits";
const SIZES = new Set(["1440x900", "390x844"]);
/** Where each screen's picture goes, when asked (SAMPLE_OFF_SHOTS=<dir>). */
const SHOTS = process.env.SAMPLE_OFF_SHOTS || "";

/** A POST to a route that can spend, unless it only asks for a price. */
function watchPaid(page: Page): string[] {
  const paid: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    const path = new URL(request.url()).pathname;
    const body = (() => { try { return request.postDataJSON() as Record<string, unknown> | null; } catch { return null; } })();
    if (body?.quoteOnly === true || body?.action === "quote") return;
    /* A paid route's pattern, with its id holes ("{}" in tests/helpers/paidRoutes.ts) matching a real id. */
    const spends = PAID_PATTERNS.some((route) => new RegExp(route.pattern.source.replace(/\\\{\\\}/g, "[^/]+")).test(path))
      || (path === "/api/workbench/team-canvas" && typeof body?.action === "string" && body.action.startsWith("agent.") && !["agent.decline", "agent.stop", "agent.skip", "agent.undo"].includes(body.action));
    if (spends) paid.push(`POST ${path} ${JSON.stringify(body ?? {}).slice(0, 80)}`);
  });
  return paid;
}

/** Every visible control on the page that could still be pressed to spend. */
async function livePaidControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const figure = /(?:^|[\s·(,])(?:up to |about )?<?\d[\d,]*(?:\.\d+)?\s*cr\b/i;
    const visible = (el: Element) => (el as HTMLElement).getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
    const off = (el: Element) => (el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true" || !!el.closest("fieldset:disabled");
    const out: string[] = [];
    for (const el of document.querySelectorAll("[data-spend]")) {
      if (!visible(el) || off(el) || el.getAttribute("data-spend") === "free") continue;
      out.push(`data-spend ${el.getAttribute("data-testid") ?? el.tagName}: ${(el.textContent ?? "").trim().slice(0, 60)}`);
    }
    /* The balance chip shows credits held, not a price: it opens Credits and spends nothing. */
    const balance = new Set(["workspace-credits", "phone-credits"]);
    for (const el of document.querySelectorAll("button, [role=button]")) {
      if (el.hasAttribute("data-spend") || balance.has(el.getAttribute("data-testid") ?? "") || !visible(el) || off(el)) continue;
      const text = `${el.textContent ?? ""} ${el.getAttribute("aria-label") ?? ""}`;
      if (figure.test(text)) out.push(`priced ${el.getAttribute("data-testid") ?? el.tagName}: ${text.trim().slice(0, 60)}`);
    }
    return out;
  });
}

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test("the sample workspace offers nothing that spends: Home, Make, Atomik and both boards, with no paid request", async ({ page }, info) => {
  test.skip(!SIZES.has(info.project.name.replace("workbench-", "")), "runs at 1440x900 and 390x844");
  const paid = watchPaid(page);
  const made = await seedFinishedProduction(page);
  const marked = await page.request.post("/api/demo/sample", { headers: made.headers, data: { action: "mark", draftId: made.project.id } });
  expect(marked.status(), await marked.text()).toBe(200);
  expect(await (await page.request.get("/api/demo/sample")).json()).toMatchObject({ sampleWorkspace: true });
  const opened = await (await page.request.post("/api/demo/sample", { headers: made.headers, data: { action: "open" } })).json() as { project: { id: string } };

  const screens: [string, string][] = [
    ["Home", "/suites?view=home"],
    ["Make", "/suites?make=1"],
    ["Atomik", "/suites?atomik=1"],
    ["Sample board", `/suites?project=${opened.project.id}&view=board`],
    ["Own production's board", `/suites?project=${made.project.id}&view=board`],
  ];
  const found: Record<string, string[]> = {};
  for (const [name, path] of screens) {
    await page.goto(path);
    await expect(page.locator(".gx").first()).toBeVisible();
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await page.waitForTimeout(800);
    const live = await livePaidControls(page);
    if (live.length) found[name] = live;
    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: `${SHOTS}/${name.toLowerCase().replace(/[^a-z]+/g, "-")}-${info.project.name.replace("workbench-", "")}.png` });
    }
    expect(await overflow(page), name).toBeLessThanOrEqual(0);
  }
  expect(found).toEqual({});

  /* Make with words in it: no Enhance at all (Advanced opened), and the press that makes waits with the line, no price on it. */
  await page.goto("/suites?make=1");
  await page.waitForLoadState("networkidle").catch(() => undefined);
  const phone = (page.viewportSize()?.width ?? 0) < 768;
  await page.getByTestId(phone ? "phone-make-prompt" : "gen-prompt").fill("A tree in the rain at dusk");
  if (!phone) {
    await page.getByTestId("gen-model").click();
    await page.getByTestId("make-advanced-toggle").click();
    await expect(page.getByTestId("make-advanced")).toBeVisible();
  }
  await page.waitForTimeout(1500);
  await expect(page.getByTestId("enhance-auto")).toHaveCount(0);
  await expect(page.getByTestId("enhance")).toHaveCount(0);
  const go = page.getByTestId(phone ? "phone-make-go" : "gen-generate");
  await expect(go).toHaveAttribute("aria-disabled", "true");
  await expect(go).not.toContainText(/\d\s*cr\b/);
  await expect(page.getByText(LINE).first()).toBeVisible();
  /* Pressed anyway (it is aria-disabled, so a press still lands): it only says the line again, and nothing is sent. */
  await go.click({ force: true });
  await page.waitForTimeout(800);
  expect(await livePaidControls(page), "Make with words").toEqual([]);

  /* Atomik: the ask box says the line, sends nothing and shows no price. */
  await page.goto("/suites?atomik=1");
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await expect(page.getByText(LINE).first()).toBeVisible();
  const input = page.locator('[data-testid="atomik-input"], [data-testid="phone-atomik-input"]').first();
  await expect(input).toBeDisabled();
  const send = page.locator('[data-testid="atomik-send"], [data-testid="phone-atomik-send"]').first();
  await expect(send).toBeDisabled();
  await expect(send).not.toContainText(/\d\s*cr\b/);
  expect(await livePaidControls(page), "Atomik").toEqual([]);

  expect(paid).toEqual([]);
});
