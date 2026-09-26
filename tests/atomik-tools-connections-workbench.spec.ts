import { test, expect, type Page, type Route } from "@playwright/test";
import { createClient } from "@libsql/client";
import { mkdirSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { forbidPaidWork, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";
import { newProject, type Project } from "../lib/workbench/studio";
import { reachFromTools } from "../lib/higgsfield-consumer/reach";

/**
 * Atomik › Tools & connections (idea 20), which replaced Atomik › Skills.
 * What Atomik can do: Particl's own rows, then the connected account's, each
 * with its live status and an Open that goes where it runs (the account is
 * mocked at its route; nothing is priced or sent). Claude & ChatGPT: real
 * tokens on the real routes — made with a ceiling in the workspace's unit,
 * shown once, filled into the setup, revoked (disabled, never erased) — the
 * setup for five clients, and the old page's skill packs.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
/* Review screenshots are written only when TOOLS_SHOTS names a folder; CI takes none. */
const SHOTS = process.env.TOOLS_SHOTS;
const PATH = "/suites?suite=atomik&page=skills&sp=skills";
const fixture = (): Project => ({ ...newProject("Coastal light study"), id: "ws-tools", productionProjectId: "prod-tools", shotMappings: {} });
const OURS = (JSON.parse(readFileSync("tests/fixtures/connected-tools-98.json", "utf8")) as { tools: { name: string }[] }).tools.map((t) => t.name);
const checked = (names = OURS) => {
  const reach = reachFromTools(names, { off: ["analysis"] });
  return { status: "checked", checkedAt: Date.now(), reach, available: reach.filter((r) => r.available).length, total: reach.length };
};

type Reply = { status: number; json: unknown } | "hang";
async function open(page: Page, replies: Reply[] = [{ status: 200, json: checked() }]) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  await mockLibrary(page, { uploads: [], generations: [] });
  const asked: unknown[] = [];
  await page.route("**/api/higgsfield/consumer/capabilities", async (route: Route) => {
    asked.push(route.request().postDataJSON());
    const reply = replies[Math.min(asked.length - 1, replies.length - 1)];
    if (reply === "hang") return;
    return route.fulfill({ status: reply.status, json: reply.json });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(PATH);
  await expect(page.getByTestId("tools-view")).toBeVisible();
  return { asked, errors };
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
      const l = lum(over(+m[1], 13), over(+m[2], 13), over(+m[3], 16));
      if (l + 1e-6 < floor) out.push(`${el.className} text ${getComputedStyle(el).color} is dimmer than #7C7C84`);
    }
    return out;
  }, phone);
  expect(problems).toEqual([]);
}

test("What Atomik can do: Particl's own rows, then every connected row with its live status and an Open that goes where it runs", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { asked, errors } = await open(page);
  await expect(page.getByTestId("page-title")).toHaveText("Tools & connections");
  /* The old page's "+ Run stage" opened a plan with nothing to run; this page has its own controls. */
  await expect(page.getByTestId("primary-action")).toHaveCount(0);
  await expect(page.getByTestId("tools-tab-reach")).toHaveAttribute("aria-selected", "true");
  const built = page.getByTestId("reach-particl").getByTestId("reach-row");
  await expect(built).toHaveCount(6);
  for (const pill of await built.getByTestId("reach-status").all()) await expect(pill).toHaveText("Built in");
  const connected = page.getByTestId("reach-connected").getByTestId("reach-row");
  await expect(connected).toHaveCount(14);
  await expect(page.getByTestId("reach-summary")).toContainText("13 of 14 available · checked");
  await expect(connected.and(page.locator('[data-id="analysis"]')).getByTestId("reach-status")).toHaveText("Switched off");
  await expect(connected.and(page.locator('[data-id="analysis"]')).getByTestId("reach-open")).toHaveCount(0);
  await expect(connected.and(page.locator('[data-id="templates"]')).getByTestId("reach-status")).toHaveText("Available");
  expect(asked).toEqual([{ view: "reach" }]);
  await checkLayout(page, PHONES.includes(info.project.name));
  await shot(page, "reach-checked");

  /* The side panels describe this page, not the old Skills registry behind its page id. */
  const inspector = page.getByTestId("inspector");
  const openedInspector = !(await inspector.isVisible());
  if (openedInspector) await page.getByTestId("toggle-inspector").click();
  await expect(inspector).toContainText("Nothing on this page spends.");
  await expect(inspector).not.toContainText("Audit installed skills");
  await expect(inspector).not.toContainText("Not runnable yet");
  if (openedInspector) await page.getByTestId("close-inspector").click();
  const library = page.getByTestId("library");
  const openedLibrary = !(await library.isVisible());
  if (openedLibrary) await page.getByTestId("toggle-library").click();
  await expect(library).toContainText("This page has no tools of its own.");
  if (openedLibrary) await page.getByTestId("close-library").click();

  await page.getByTestId("reach-check").click();
  await expect(page.getByTestId("reach-summary")).toContainText("13 of 14 available");
  expect(asked).toHaveLength(2);

  /* Open goes where the capability runs: the account's ad templates are Business › Image ads. */
  await connected.and(page.locator('[data-id="templates"]')).getByTestId("reach-open").click();
  await expect(page).toHaveURL(/[?&]sp=dtc(&|$)/);
  await expect(page.getByTestId("page-title")).toHaveText("Image ads");
  /* Back on the page within a minute, the answer is reused: the owner's six-a-minute allowance is not spent twice. */
  await page.goBack();
  await expect(page.getByTestId("reach-summary")).toContainText("13 of 14 available");
  expect(asked).toHaveLength(2);
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
  expect(errors).toEqual([]);
});

test("without an account, or when the check fails, each row says so and the page says what to do next", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { asked, errors } = await open(page, [
    { status: 409, json: { status: "unavailable", code: "not_connected", error: "Connect the owner’s account in Workspace › Engines." } },
    { status: 503, json: { status: "unavailable", code: "unavailable", error: "Tool discovery is temporarily unavailable." } },
    { status: 429, json: { status: "unavailable", code: "rate_limited", error: "Too many discovery requests. Try again later." } },
    { status: 200, json: checked(OURS.filter((name) => !name.startsWith("marketing_studio_v2_"))) },
  ]);
  const connected = page.getByTestId("reach-connected").getByTestId("reach-row");
  await expect(page.getByTestId("reach-summary")).toHaveText("Connect the account in Workspace › Engines");
  for (const pill of await connected.getByTestId("reach-status").all()) await expect(pill).toHaveText("Connect first");
  await expect(connected.getByTestId("reach-open")).toHaveCount(0);
  await expect(page.getByTestId("reach-engines")).toBeVisible();
  await checkLayout(page, PHONES.includes(info.project.name));
  await shot(page, "reach-connect");

  await page.getByTestId("reach-check").click();
  await expect(page.getByTestId("reach-summary")).toContainText("could not be checked. Try again, or open Workspace › Engines.");
  for (const pill of await connected.getByTestId("reach-status").all()) await expect(pill).toHaveText("Not checked");
  await expect(page.getByTestId("reach-check")).toHaveText("Try again");
  await page.getByTestId("reach-check").click();
  await expect(page.getByTestId("reach-summary")).toHaveText("Checked too often. Try again in a minute.");
  await page.getByTestId("reach-check").click();
  /* This client offers no Marketing Studio templates: that row, and only that one besides the switched-off analysis, is not offered. */
  await expect(page.getByTestId("reach-summary")).toContainText("12 of 14 available");
  await expect(connected.and(page.locator('[data-id="templates"]')).getByTestId("reach-status")).toHaveText("Not offered");
  expect(asked).toHaveLength(4);

  await page.getByTestId("reach-check").click();
  await expect(page.getByTestId("reach-summary")).toContainText("12 of 14 available");
  await page.getByTestId("reach-engines").count().then((n) => expect(n).toBe(0));
  expect(errors).toEqual([]);
});

test("while the account is being read, the rows and the button say so", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { asked, errors } = await open(page, ["hang"]);
  await expect(page.getByTestId("reach-summary")).toHaveText("Checking the connected account…");
  await expect(page.getByTestId("reach-check")).toBeDisabled();
  await expect(page.getByTestId("reach-check")).toHaveText("Checking…");
  await expect(page.getByTestId("reach-connected")).toHaveAttribute("aria-busy", "true");
  for (const pill of await page.getByTestId("reach-connected").getByTestId("reach-status").all()) await expect(pill).toHaveText("Checking…");
  expect(asked).toHaveLength(1);
  await checkLayout(page, PHONES.includes(info.project.name));
  expect(errors).toEqual([]);
});

test("a member sees who uses the connected account, and the page never asks the account on their behalf", async ({ page }, info) => {
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
  await expect(page.getByTestId("reach-summary")).toHaveText("Only the workspace owner uses the connected account");
  const connected = page.getByTestId("reach-connected").getByTestId("reach-row");
  await expect(connected).toHaveCount(14);
  for (const pill of await connected.getByTestId("reach-status").all()) await expect(pill).toHaveText("Owner only");
  await expect(page.getByTestId("reach-check")).toHaveCount(0);
  await expect(page.getByTestId("reach-particl").getByTestId("reach-open")).toHaveCount(6);
  await checkLayout(page, PHONES.includes(info.project.name));
  await shot(page, "reach-member");
  expect(asked).toBe(0);
  expect(errors).toEqual([]);
});

test("a token is made with a ceiling in the workspace's unit, shown once, filled into the setup, and revoked by disabling it", async ({ page, playwright }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors } = await open(page);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByTestId("tools-tab-connect").click();
  await expect(page.getByTestId("tokens-empty")).toBeVisible();
  const { unit } = await page.request.get("/api/tokens").then((r) => r.json()) as { unit: "credits" | "usd" };
  /* A new workspace pays in credits: the ceiling starts at a figure, in credits, and no dollar is named. */
  expect(unit).toBe("credits");
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

test("the old Skills page's packs are still here, with the same install commands and folders", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors } = await open(page);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByTestId("tools-tab-connect").click();
  const packs = page.getByTestId("skill-packs");
  await expect(packs.getByTestId("skill-row").first()).toBeHidden();
  await packs.locator("summary").click();
  await expect(packs.getByTestId("skill-row")).toHaveCount(8);
  const first = packs.getByTestId("skill-row").first();
  await expect(first).toContainText("higgsfield-generate");
  await expect(first.getByRole("link", { name: "Open the higgsfield-generate folder" })).toHaveAttribute("href", "https://github.com/higgsfield-ai/skills/tree/main/higgsfield-generate");
  await first.getByRole("button", { name: "Copy the install command for higgsfield-generate" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("npx skills add higgsfield-ai/skills --skill higgsfield-generate");
  await expect(packs.getByTestId("skill-packs-all")).toHaveAttribute("href", "https://github.com/higgsfield-ai/skills");
  await checkLayout(page, PHONES.includes(info.project.name));
  await shot(page, "connect-packs");
  expect(errors).toEqual([]);
});
