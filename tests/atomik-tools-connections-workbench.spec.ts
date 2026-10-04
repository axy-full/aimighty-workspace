import { test, expect, type Page, type Route } from "@playwright/test";
import { createClient } from "@libsql/client";
import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { forbidPaidWork, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";
import { newProject, type Project } from "../lib/workbench/studio";
import { closeSuitesMenu, openSuitesMenu } from "./helpers/suitesMenu";

/**
 * Atomik › Tools & connections (idea 20), which replaced Atomik › Skills.
 * What Atomik can do: Particl's own rows, each with an Open that goes where
 * it runs. Since 28 September 2026 Atomik reaches no signed-in account, so
 * the page checks none (the account's capability route is watched and must
 * never be asked). Claude & ChatGPT: real tokens on the real routes — made with a
 * ceiling in the workspace's unit, shown once, filled into the setup, revoked
 * (disabled, never erased) — and the setup for five clients; the account's
 * skill packs are gone.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
/* Review screenshots are written only when TOOLS_SHOTS names a folder; CI takes none. */
const SHOTS = process.env.TOOLS_SHOTS;
const PATH = "/suites?suite=atomik&page=skills&sp=skills";
const fixture = (): Project => ({ ...newProject("Coastal light study"), id: "ws-tools", productionProjectId: "prod-tools", shotMappings: {} });

/* `armed` names #392's development-only crash probes (lib/shell/fault.ts): each named boundary throws as it renders.
   The account's capability check (the reach read this page used to make) is watched: this page must never ask it. */
async function open(page: Page, armed: string[] = []) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  await mockLibrary(page, { uploads: [], generations: [] });
  const asked: string[] = [];
  await page.route("**/api/higgsfield/consumer/capabilities", async (route: Route) => {
    asked.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    return route.fulfill({ status: 409, json: { error: "Atomik reaches no signed-in account." } });
  });
  if (armed.length) await page.addInitScript((list) => { (window as unknown as { __particlCrash?: unknown[] }).__particlCrash = list; }, armed);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(PATH);
  if (!armed.includes("stage:skills")) await expect(page.getByTestId("tools-view")).toBeVisible();
  return { asked, errors };
}

/*
 * A step that must happen within one page load (as tests/hf-error-boundaries-workbench.spec.ts does): on a cold
 * webpack dev server a first compile can reload the page under the step, which re-arms the probes. The step runs
 * again on the reloaded page; a failure within one load still fails.
 */
async function withinOneLoad(page: Page, step: () => Promise<void>) {
  const loadedAt = () => page.evaluate(() => performance.timeOrigin).catch(() => -1);
  for (let attempt = 1; ; attempt++) {
    const loaded = await loadedAt();
    try {
      await step();
    } catch (error) {
      if (attempt < 3 && (await loadedAt()) !== loaded) continue;
      throw error;
    }
    if ((await loadedAt()) === loaded) return;
    if (attempt >= 3) throw new Error("the dev server kept reloading the page under the step");
  }
}

/* The shell scrolls inside its content column, so a review shot walks that column a screen at a time. */
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const size = `${page.viewportSize()!.width}x${page.viewportSize()!.height}`;
  const steps = await page.evaluate(() => {
    let el: HTMLElement | null = document.querySelector('[data-testid="tools-view"]');
    while (el && !(el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
    const box = el ?? document.scrollingElement as HTMLElement;
    box.setAttribute("data-shot-scroll", "");
    box.scrollTop = 0;
    return Math.min(6, Math.ceil(box.scrollHeight / Math.max(1, box.clientHeight)));
  });
  for (let i = 0; i < steps; i++) {
    await page.evaluate((n) => { const box = document.querySelector<HTMLElement>("[data-shot-scroll]")!; box.scrollTop = n * box.clientHeight * 0.9; }, i);
    await page.screenshot({ path: `${SHOTS}/${name}-${size}-${i + 1}.png` });
  }
}

/** No sideways scroll; on a phone every control is a 44px target; labels are never dimmer than #7C7C84; no serif face. */
async function checkLayout(page: Page, phone: boolean) {
  const problems = await page.evaluate((isPhone) => {
    const out: string[] = [];
    if (document.documentElement.scrollWidth > innerWidth + 1) out.push(`document scrolls sideways: ${document.documentElement.scrollWidth} > ${innerWidth}`);
    const view = document.querySelector<HTMLElement>('[data-testid="tools-view"]')!;
    const shown = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden" && !el.closest("details:not([open]) > :not(summary)"); };
    for (const el of Array.from(view.querySelectorAll<HTMLElement>("*"))) {
      if (!shown(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.right > innerWidth + 1) out.push(`${el.className || el.tagName} runs past the viewport (${Math.round(r.right)})`);
      const face = getComputedStyle(el).fontFamily;
      if (/(^|[^-])\bserif\b/i.test(face)) out.push(`serif face on ${el.className || el.tagName}: ${face}`);
    }
    if (isPhone) {
      for (const el of Array.from(view.querySelectorAll<HTMLElement>("button:not(.gx-seg-btn), a, input, summary, .gx-seg"))) {
        if (!shown(el)) continue;
        const h = Math.round(el.getBoundingClientRect().height * 100) / 100;
        if (h < 44) out.push(`${el.textContent?.trim().slice(0, 30) || el.className} is ${h}px tall`);
      }
    }
    /* Relative luminance, with the text colour laid over the darkest ground it can sit on. */
    const lum = (r: number, g: number, b: number) => [r, g, b].map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }).reduce((a, c, i) => a + c * [0.2126, 0.7152, 0.0722][i], 0);
    const floor = lum(0x7c, 0x7c, 0x84);
    for (const el of Array.from(view.querySelectorAll<HTMLElement>(".cw-dim, .tc-summary, .tc-note, .tc-copy-label, .tc-pill, .tc-intro, .gx-empty, .tc-cmd"))) {
      if (!shown(el)) continue;
      const m = getComputedStyle(el).color.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/);
      if (!m) continue;
      const a = m[4] == null ? 1 : Number(m[4]);
      const over = (c: number, bg: number) => c * a + bg * (1 - a);
      const l = lum(over(+m[1], 0), over(+m[2], 0), over(+m[3], 0));
      if (l + 1e-6 < floor) out.push(`${el.className} text ${getComputedStyle(el).color} is dimmer than #7C7C84`);
    }
    return out;
  }, phone);
  expect(problems).toEqual([]);
}

test("What Atomik can do: Particl's own rows only, each with an Open that goes where it runs; no connected account is checked", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { asked, errors } = await open(page);
  await expect(page.getByTestId("page-title")).toHaveText("Tools & connections");
  /* The old page's "+ Run stage" opened a plan with nothing to run; this page has its own controls. */
  await expect(page.getByTestId("primary-action")).toHaveCount(0);
  await expect(page.getByTestId("tools-tab-reach")).toHaveAttribute("aria-selected", "true");
  const built = page.getByTestId("reach-particl").getByTestId("reach-row");
  await expect(built).toHaveCount(6);
  for (const pill of await built.getByTestId("reach-status").all()) await expect(pill).toHaveText("Built in");
  await expect(built.getByTestId("reach-open")).toHaveCount(6);
  /* Nothing of the signed-in account: no card, no summary, no check. */
  await expect(page.getByTestId("reach-connected")).toHaveCount(0);
  await expect(page.getByTestId("reach-summary")).toHaveCount(0);
  await expect(page.getByTestId("reach-check")).toHaveCount(0);
  await expect(page.getByTestId("tools-view")).not.toContainText(/connected account|higgsfield/i);
  await checkLayout(page, PHONES.includes(info.project.name));
  await shot(page, "reach-particl");

  /* The side panels describe this page, not the old Skills registry behind its page id. */
  const inspector = page.getByTestId("inspector");
  const openedInspector = !(await inspector.isVisible());
  if (openedInspector) await page.getByTestId("toggle-inspector").click();
  await expect(inspector).toContainText("Nothing on this page spends.");
  await expect(inspector).not.toContainText("connected account");
  await expect(inspector).not.toContainText("Audit installed skills");
  await expect(inspector).not.toContainText("Not runnable yet");
  if (openedInspector) await page.getByTestId("close-inspector").click();
  const library = page.getByTestId("library");
  const openedLibrary = !(await library.isVisible());
  if (openedLibrary) await page.getByTestId("toggle-library").click();
  await expect(library).toContainText("This page has no tools of its own.");
  if (openedLibrary) await page.getByTestId("close-library").click();

  /* Open goes where the capability runs: thinking models are Atomik › Models. */
  await built.and(page.locator('[data-id="thinking"]')).getByTestId("reach-open").click();
  await expect(page).toHaveURL(/[?&]sp=models(&|$)/);
  await page.goBack();
  /* The assistant row opens the other tab; the tab list answers the arrow keys. */
  await built.and(page.locator('[data-id="assistant"]')).getByTestId("reach-open").click();
  await expect(page.getByTestId("tools-tab-connect")).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("tools-tab-connect").focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("tools-tab-reach")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("tools-tab-reach")).toBeFocused();
  expect(asked).toEqual([]);
  expect(errors).toEqual([]);
});

test("inside the shell's panel boundaries: the page fails on its own card, and Try again brings it back", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { asked, errors } = await open(page, ["stage:skills"]);
  const fault = page.locator('[data-testid="panel-fault"][data-fault="stage:skills"]');
  await expect(fault).toContainText("Tools & connections stopped");
  /* The chrome is untouched: header, page title, strip; and the page head still offers no Run stage.
     A phone keeps the Suites behind its context badge (components/graphite/phone.css), one tap away. */
  await openSuitesMenu(page);
  await expect(page.getByRole("tablist", { name: "Suites" })).toBeVisible();
  await closeSuitesMenu(page);
  await expect(page.getByTestId("page-title")).toHaveText("Tools & connections");
  await expect(page.getByRole("navigation", { name: "Pages" })).toBeVisible();
  await expect(page.getByTestId("primary-action")).toHaveCount(0);
  /* The Inspector is walled off on its own: its body for this page still renders, with no plan to run. */
  const inspector = page.getByTestId("inspector");
  const opened = !(await inspector.isVisible());
  if (opened) await page.getByTestId("toggle-inspector").click();
  await expect(inspector).toContainText("Nothing on this page spends.");
  await expect(inspector.getByRole("button", { name: "Run with Atomik" })).toHaveCount(0);
  if (opened) await page.getByTestId("close-inspector").click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "no horizontal page scroll").toBe(true);

  /* Fixed underneath: Try again renders the page, with Particl's own rows. */
  await withinOneLoad(page, async () => {
    await page.evaluate(() => { (window as unknown as { __particlCrash?: unknown[] }).__particlCrash = []; });
    await fault.getByTestId("fault-retry").click();
    await expect(page.getByTestId("tools-view")).toBeVisible();
  });
  await expect(page.locator('[data-testid="panel-fault"][data-fault="stage:skills"]')).toHaveCount(0);
  await expect(page.getByTestId("reach-particl").getByTestId("reach-row")).toHaveCount(6);
  await expect(page.getByTestId("reach-connected")).toHaveCount(0);
  await checkLayout(page, PHONES.includes(info.project.name));
  expect(asked).toEqual([]);
  expect(errors, "a caught throw never reaches the window").toEqual([]);
});

test("inside the shell's panel boundaries: a failing Atomik gate keeps its own row, and the page keeps working with no plan sheet to open", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { asked, errors } = await open(page, ["atomik-gate"]);
  await expect(page.locator('[data-testid="panel-fault"][data-fault="atomik-gate"]')).toContainText("The Atomik gate stopped");
  await expect(page.locator('[data-testid="panel-fault"][data-fault="stage:skills"]')).toHaveCount(0);
  await expect(page.getByTestId("reach-particl").getByTestId("reach-row")).toHaveCount(6);
  expect(asked).toEqual([]);
  await expect(page.getByTestId("primary-action")).toHaveCount(0);
  await page.getByTestId("tools-tab-connect").click();
  await expect(page.getByTestId("tokens-empty")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "no horizontal page scroll").toBe(true);
  expect(errors, "a caught throw never reaches the window").toEqual([]);
});

test("a member sees the same Particl rows, and the page never asks an account on their behalf", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  await signInLocally(page.request);
  const owner = await page.request.get("/api/me").then((r) => r.json()) as { id: string; workspace: { id: string } };
  await signInLocally(page.request);
  const member = await page.request.get("/api/me").then((r) => r.json()) as { email: string };
  const code = randomBytes(18).toString("base64url");
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    await platform.execute({
      sql: "INSERT INTO workspace_invites(code,workspace_id,email,name,role,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)",
      args: [code, owner.workspace.id, member.email, "Tools member", "member", owner.id, Date.now(), Date.now() + 3_600_000],
    });
  } finally { platform.close(); }
  expect((await page.request.post("/api/auth/accept", { data: { code } })).ok()).toBe(true);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  await mockLibrary(page, { uploads: [], generations: [] });
  let asked = 0;
  await page.route("**/api/higgsfield/consumer/capabilities", (route) => { asked++; return route.fulfill({ status: 403, json: { error: "Only the owner" } }); });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(PATH);
  await expect(page.getByTestId("tools-view")).toBeVisible();
  await expect(page.getByTestId("reach-particl").getByTestId("reach-open")).toHaveCount(6);
  await expect(page.getByTestId("reach-connected")).toHaveCount(0);
  await expect(page.getByTestId("reach-summary")).toHaveCount(0);
  await expect(page.getByTestId("reach-check")).toHaveCount(0);
  await checkLayout(page, PHONES.includes(info.project.name));
  await shot(page, "reach-member-particl");
  expect(asked).toBe(0);
  expect(errors).toEqual([]);
});

test("a token is made with a ceiling in the workspace's unit, shown once, filled into the setup, and revoked by disabling it", async ({ page, playwright }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors } = await open(page);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByTestId("tools-tab-connect").click();
  await expect(page.getByTestId("tokens-empty")).toBeVisible();
  const { unit } = await page.request.get("/api/tokens").then((r) => r.json()) as { unit: "cr" | "usd" };
  /* A new workspace pays in credits: the ceiling starts at a figure, in credits, and no dollar is named. */
  expect(unit).toBe("cr");
  await expect(page.getByTestId("token-ceiling")).toHaveValue("500");
  await expect(page.getByTestId("connect-tokens")).not.toContainText("$");
  await expect(page.getByTestId("token-create")).toBeDisabled();
  await checkLayout(page, PHONES.includes(info.project.name));
  await shot(page, "connect-empty");

  /* No limit has to be said: clearing the ceiling changes the button and warns. A fraction is refused before anything is made. */
  await page.getByTestId("token-name").fill(`Claude on a laptop ${info.project.name}`);
  await page.getByTestId("token-ceiling").fill("");
  await expect(page.getByTestId("token-create")).toHaveText("Make token without a ceiling");
  await expect(page.getByTestId("token-unbounded")).toContainText("No ceiling: it can spend until the workspace’s credits run out.");
  await page.getByTestId("token-ceiling").fill("2.5");
  await page.getByTestId("token-create").click();
  await expect(page.getByTestId("token-problem")).toHaveText("Type a monthly ceiling in whole credits, like 500, or leave it blank for no limit.");
  await expect(page.getByTestId("token-row")).toHaveCount(0);

  await page.getByTestId("token-ceiling").fill("500");
  await page.getByTestId("token-create").click();
  const secret = page.getByTestId("token-secret");
  await expect(secret).toHaveText(/^(pk_[a-z0-9]+_|aw_)[0-9a-f]{48}$/);
  const token = (await secret.textContent())!;
  /* Shown once, so it comes to the person: in view, with focus on its Copy, wherever the form was scrolled. */
  await expect(page.getByTestId("token-copy")).toBeFocused();
  await expect(page.getByTestId("token-copy")).toBeInViewport();
  await expect(page.getByTestId("token-row")).toHaveCount(1);
  await expect(page.getByTestId("token-facts")).toHaveText("Can generate · 0 cr of 500 cr this month · never used");
  await page.getByTestId("token-copy").click();
  await expect(page.getByTestId("token-copy")).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(token);
  /* The setup has the new token and this workspace's own address in it. */
  const origin = new URL(page.url()).origin;
  await expect(page.getByTestId("setup-step").nth(1)).toContainText(`claude mcp add particl --env PARTICL_URL=${origin} --env PARTICL_TOKEN=${token} -- node ~/particl-mcp.mjs`);
  await expect(page.getByTestId("setup-token-note")).toHaveText("Your new token is filled in above.");
  await shot(page, "connect-fresh");

  /* It works as a token, then Revoke disables it: the row leaves, the secret leaves the setup, and the token is refused.
     A context of its own, so no session cookie answers in the token's place. */
  const bearer = await playwright.request.newContext({ baseURL: origin, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
  expect((await bearer.get("/api/projects")).status()).toBe(200);
  await page.getByTestId("token-revoke").click();
  await expect(page.getByTestId("token-keep")).toBeVisible();
  await checkLayout(page, PHONES.includes(info.project.name));
  await page.getByTestId("token-revoke-confirm").click();
  await expect(page.getByTestId("toast")).toContainText("revoked. Anything using it is refused from its next call.");
  await expect(page.locator("#tc-tokens")).toBeFocused();
  await expect(page.getByTestId("token-row")).toHaveCount(0);
  await expect(page.getByTestId("token-fresh")).toHaveCount(0);
  await expect(page.getByTestId("setup-step").nth(1)).toContainText("PARTICL_TOKEN=YOUR_TOKEN");
  expect((await bearer.get("/api/projects")).status()).toBe(401);
  await bearer.dispose();

  /* A read-only token carries no ceiling and says what it cannot do. */
  await page.getByTestId("token-scope-read").click();
  await expect(page.getByTestId("token-ceiling")).toHaveCount(0);
  await expect(page.getByTestId("token-read-note")).toContainText("every paid call is refused");
  await page.getByTestId("token-name").fill("Reader for the nightly shot-list batch on the studio laptop");
  await page.getByTestId("token-create").click();
  await expect(page.getByTestId("token-facts")).toHaveText("Read-only · never used");
  await expect(page.getByTestId("token-row")).toContainText("Reader for the nightly shot-list batch on the studio laptop");
  await checkLayout(page, PHONES.includes(info.project.name));
  await page.getByTestId("token-done").click();
  await expect(page.getByTestId("token-fresh")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("the token list recovers from a failed read, and the setup covers five clients with this workspace's address", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  let failed = false;
  await page.route("**/api/tokens", (route) => {
    if (route.request().method() === "GET" && !failed) { failed = true; return route.fulfill({ status: 503, json: { error: "Tokens are unavailable right now." } }); }
    return route.fallback();
  });
  const { errors } = await open(page);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByTestId("tools-tab-connect").click();
  await expect(page.getByTestId("tokens-error")).toContainText("Tokens are unavailable right now.");
  await expect(page.getByTestId("token-create")).toBeDisabled();
  await checkLayout(page, PHONES.includes(info.project.name));
  await page.getByTestId("tokens-retry").click();
  await expect(page.getByTestId("tokens-empty")).toBeVisible();

  const origin = new URL(page.url()).origin;
  const expected: Record<string, number> = { "claude-code": 3, "claude-desktop": 3, chatgpt: 2, mcp: 2, cli: 2 };
  for (const [client, steps] of Object.entries(expected)) {
    await page.getByTestId(`client-${client}`).click();
    await expect(page.getByTestId(`client-${client}`)).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("setup-step")).toHaveCount(steps);
    await expect(page.getByTestId("connect-setup")).toContainText(origin);
    await expect(page.getByTestId("setup-note")).not.toBeEmpty();
    await checkLayout(page, PHONES.includes(info.project.name));
  }
  await page.getByTestId("client-mcp").click();
  await page.getByTestId("setup-step").first().getByRole("button", { name: "Copy: Server URL" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${origin}/api/mcp`);
  await expect(page.getByTestId("mcp-endpoint")).toContainText(`${origin}/api/mcp`);
  await expect(page.getByTestId("mcp-tool")).toHaveCount(7);
  await shot(page, "connect-setup");
  expect(errors).toEqual([]);
});

test("Claude & ChatGPT lists Particl's own server and tokens only: no skill packs for a signed-in account", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { asked, errors } = await open(page);
  await page.getByTestId("tools-tab-connect").click();
  await expect(page.getByTestId("tokens-empty")).toBeVisible();
  await expect(page.getByTestId("mcp-tool")).toHaveCount(7);
  await expect(page.getByTestId("skill-packs")).toHaveCount(0);
  await expect(page.getByTestId("skill-row")).toHaveCount(0);
  await expect(page.getByTestId("tools-view")).not.toContainText(/higgsfield|connected account/i);
  await checkLayout(page, PHONES.includes(info.project.name));
  expect(asked).toEqual([]);
  expect(errors).toEqual([]);
});
