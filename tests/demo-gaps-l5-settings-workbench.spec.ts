import { test, expect, type Page } from "@playwright/test";
import { signInWithNewInterface } from "./helpers/newInterface";
import { SIZES, desktop, floors, shot, watchErrors, watchPaid } from "./helpers/l5";

/*
 * Lane 5 · Settings › Connections (MCP tokens) and Settings › Team (Team security), Gaps B. Real local ENGINE_MOCK=1
 * server and real routes, nothing mocked: a person makes a token that prepares jobs, sees it once, copies it; the
 * token then prepares a job, and is refused every people-only act (approving spend, limits and the budget, top-ups,
 * consent, its own kind) end to end; a person opens the job in Make, where Make prices it, or dismisses it. Team
 * shows two-factor per person and the three roles. Nothing paid is sent. Neutral names only.
 */
/** Settings' own style sheet has arrived (a dev server can serve the page a moment before it). */
async function styled(page: Page) {
  await expect.poll(() => page.evaluate(() => { const el = document.querySelector(".gs-page"); return el ? getComputedStyle(el).paddingTop : "0px"; })).not.toBe("0px");
}

async function signIn(page: Page) {
  const { workspace } = await signInWithNewInterface(page.request, "Settings Tester");
  const me = await (await page.request.get("/api/me")).json() as { id: string };
  return { workspace, me, headers: { "X-Workbench-Scope": `particl-active-${workspace.id}-${me.id}` } };
}

test("Connections: a token that prepares jobs, shown once; it can't approve, spend, set limits, top up or record consent; a person opens its job in Make", async ({ page, context, playwright }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signIn(page);
  const paid = watchPaid(page);
  const errors = watchErrors(page);
  await page.goto("/suites?view=workspace&tab=connections");
  await expect(page.getByTestId("settings-title")).toHaveText("Connections");
  await styled(page);
  await page.getByTestId("settings-token-make").click();
  const form = page.getByTestId("settings-token-form");
  await expect(form.getByRole("dialog")).toContainText("New token for an outside agent");
  await expect(form).toContainText("MCP · the agent prepares jobs; a person approves each one");
  await expect(form.getByTestId("settings-token-scope-prepare")).toHaveAttribute("aria-checked", "true");
  /* While the dialog is open, the page drops its filled action (one filled button per screen). */
  await expect(page.getByTestId("settings-token-make")).toHaveCount(0);
  await form.getByTestId("settings-token-name").fill("A script on the studio computer");
  await floors(page, "Connections, new token", "[data-testid=settings-token-form]");
  await shot(page, "token-new", info);
  await form.getByTestId("settings-token-create").click();

  const shown = page.getByTestId("settings-token-fresh");
  await expect(shown).toContainText("Token created");
  await expect(shown).toContainText("Token · shown once");
  const secret = await shown.getByTestId("settings-token-secret").innerText();
  expect(secret).toMatch(/^pk_[a-z0-9]+_[0-9a-f]{48}$/);
  await shown.getByTestId("settings-token-copy").click();
  await expect(shown.getByTestId("settings-token-copy")).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(secret);
  await floors(page, "Connections, token shown", "[data-testid=settings-token-fresh]");
  await shot(page, "token-shown", info);
  await shown.getByTestId("settings-token-done").click();
  const row = page.getByTestId("settings-token").filter({ hasText: "A script on the studio computer" });
  await expect(row).toContainText("Prepares jobs · a person approves each");
  /* Shown once: a reload never shows the secret again. */
  await page.reload();
  await expect(page.locator("body")).not.toContainText(secret);

  /* The token, as an outside agent holds it (no session): it prepares, and every people-only act is refused. */
  const agent = await playwright.request.newContext({ baseURL: new URL(page.url()).origin, extraHTTPHeaders: { Authorization: `Bearer ${secret}` } });
  try {
    const prepared = await agent.post("/api/prepared-jobs", { data: { prompt: "A slow push on a quiet street at first light", duration: 5, resolution: "720p", ratio: "16:9" } });
    expect(prepared.status(), await prepared.text()).toBe(201);
    for (const [method, url, data] of [
      ["POST", "/api/generate", { prompt: "x" }],
      ["POST", "/api/jobs/gen-none/release", { credits: 43 }],
      ["POST", "/api/atomik/steps/step-none/claim", {}],
      ["PATCH", "/api/settings", { shotCapCredits: "5000" }],
      ["POST", "/api/workspaces/topups", { pack: "starter" }],
      ["POST", "/api/identity-consents", { projectId: "p", subjectKey: "s", personName: "A Person", face: true, uses: ["production"], until: "2030-01-01", recordingUploadId: "u", attested: true }],
      ["POST", "/api/tokens", { name: "another", scope: "render" }],
      ["POST", "/api/review-links", { projectId: "p" }],
    ] as const) {
      const res = await agent.fetch(url, { method, data });
      expect(res.status(), `${method} ${url}`).toBe(403);
    }
  } finally { await agent.dispose(); }

  /* A person sees it waiting, opens it in Make (where Make prices it), and nothing is sent. */
  await page.reload();
  await styled(page);
  const job = page.getByTestId("settings-prepared-job");
  await expect(job).toHaveCount(1);
  await expect(job).toContainText("A slow push on a quiet street at first light");
  await expect(job).toContainText("Seedance 2.5 · 5 s · 720p · 16:9 · from A script on the studio computer");
  await expect(job).not.toContainText(/\bcr\b/);
  await floors(page, "Connections, prepared job");
  await shot(page, "token-prepared", info);
  await job.getByTestId("settings-prepared-open").click();
  /* Desktop: Make's panel; a phone: its own Make screen. Either way the words are there and Make prices them. */
  await expect(page.getByTestId(desktop(page) ? "gen-prompt" : "phone-make-prompt")).toHaveValue("A slow push on a quiet street at first light");
  await shot(page, "token-prepared-make", info);
  expect(paid).toEqual([]);
  expect(errors).toEqual([]);
});

test("Team security: two-factor per person, and the owner, admin and member roles only", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  await signIn(page);
  const paid = watchPaid(page);
  const errors = watchErrors(page);
  await page.goto("/suites?view=workspace&tab=team");
  await expect(page.getByTestId("settings-title")).toHaveText("Team");
  await styled(page);
  const me = page.getByTestId("settings-member").first();
  await expect(me).toContainText("two-factor off");
  await expect(me).toContainText("owner");
  const roles = page.getByTestId("settings-role");
  await expect(roles).toHaveCount(3);
  await expect(roles.nth(0)).toContainText("Owner");
  await expect(roles.nth(1)).toContainText("Admin");
  await expect(roles.nth(2)).toContainText("Member");
  await expect(page.getByTestId("settings-roles")).not.toContainText(/producer|editor/i);
  await expect(roles.nth(0)).toContainText("1");
  await page.getByTestId("settings-security").getByRole("button").first().click();
  await expect(page.getByTestId("settings-two-step")).toContainText("Your two-factor sign-in");
  await expect(page.getByTestId("settings-two-step")).not.toContainText("Reading…");
  await expect(page.getByTestId("settings-sessions")).not.toContainText("Reading…");
  await page.getByTestId("settings-roles").scrollIntoViewIfNeeded();
  await floors(page, "Team security", ".gs");
  await shot(page, "team", info);
  expect(paid).toEqual([]);
  expect(errors).toEqual([]);
});
