import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";
import { createClient } from "@libsql/client";
import { mkdirSync } from "node:fs";
import { localPlatformDbUrl } from "./helpers/workbenchLocal";
import { signInWithNewInterface } from "./helpers/newInterface";
import { dimLabels, smallTargets } from "./phoneFloors";

/**
 * Control room › Approvals (Atomik frame g) with the new interface on: one
 * queue across projects, each item approved through its own existing route at
 * its own price, "Approve in one go" one item at a time until the first
 * refusal, and the spending rules shown, never changed. Every paid route is
 * intercepted: nothing here releases, renders or charges.
 */

const PAGE = "/suites?suite=atomik&page=approvals";
const SHOTS = join(tmpdir(), "claude-s08-shots");
const SHOT_SIZES = ["workbench-1440x900", "workbench-390x844"];

/**
 * The viewports where the shell mounts the phone app (lib/shell/use-compact.ts: narrower than 768 px, or a touch screen no taller than
 * 500 px, so 844x390 is a phone). On a phone the control room's Approvals page is Home's "Needs you" queue (the same queue, the same
 * routes: lib/control-room/queue.ts, approve.ts), each wait with its price as the button. The phone has no "Approve in one go", no
 * decided ledger and no spending-rules panel; every phone row approves alone. The phone twins at the end of this file hold the same
 * money assertions on the phone's own rows.
 */
const COMPACT = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const isCompact = (info: { project: { name: string } }) => COMPACT.includes(info.project.name);

async function shoot(page: Page, project: string, name: string) {
  if (!SHOT_SIZES.includes(project)) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}-${project.replace("workbench-", "")}.png`, fullPage: true });
}

/** No sideways scroll, nothing read under 12 px in the control room, and phone-sized targets on a phone. */
async function floors(page: Page, phone: boolean) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "horizontal overflow").toBeLessThanOrEqual(0);
  const small = await page.evaluate(() => {
    const out: string[] = [];
    const root = document.querySelector(".cr");
    if (!root) return ["no .cr"];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.textContent ?? "").trim();
      const el = node.parentElement;
      if (!text || !el || !el.getClientRects().length) continue;
      const size = Number.parseFloat(getComputedStyle(el).fontSize);
      if (size < 12) out.push(`${size}px “${text.slice(0, 30)}”`);
    }
    return out;
  });
  expect(small, "text under 12 px").toEqual([]);
  if (phone) expect(await smallTargets(page, ".cr"), "targets under 44×44").toEqual([]);
}

/** A held take in this person's own fresh workspace, held for credits at a price the server re-derives. */
async function seedHeld(page: Page): Promise<{ id: string }> {
  const signed = await signInWithNewInterface(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  let tenantUrl = "";
  try {
    tenantUrl = String((await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id=?", args: [signed.workspace.id] })).rows[0].db_url);
    /* Enough credits to cover it, so the row offers Approve rather than Top up. Local test workspace only. */
    await platform.execute({
      sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,created_at) VALUES(?,?,1000,'s08 browser test',?)",
      args: [`grant_s08_${Date.now()}`, signed.workspace.id, Date.now()],
    });
  } finally {
    platform.close();
  }
  expect(tenantUrl).toMatch(/^file:/);
  const id = `gen_s08_${Date.now()}`;
  const tenant = createClient({ url: tenantUrl, timeout: 10_000 });
  try {
    await tenant.execute({
      sql: `INSERT INTO generations(id,kind,provider,model,prompt,params,status,created_by,created_at,updated_at)
            VALUES(?,'video','byteplus','dreamina-seedance-2-0-260128','A quiet street at dawn',?,'held',?,?,?)`,
      args: [id, JSON.stringify({ ratio: "16:9", resolution: "720p", duration: 5, held: { estUsd: 1, needs: 15, at: Date.now(), why: "credits" } }), me.id, Date.now(), Date.now()],
    });
  } finally {
    tenant.close();
  }
  return { id };
}

test("a held take in this workspace is approved through its own route at the price shown, and nothing else is sent", async ({ page }, info) => {
  test.skip(isCompact(info), "on a phone the Approvals page is Home's Needs you queue: the twin 'phone Home: a held take in this workspace…' below (same seed, same route, same price)");
  test.setTimeout(180_000);
  const { id } = await seedHeld(page);
  const queue = await page.request.get("/api/control-room/approvals").then((r) => r.json());
  const item = queue.items.find((i: { id: string }) => i.id === `held:${id}`);
  expect(item?.price?.kind).toBe("exact");
  const credits: number = item.price.credits;

  const sent: { url: string; body: unknown }[] = [];
  await page.route(`**/api/jobs/${id}/release`, async (route: Route) => {
    sent.push({ url: route.request().url(), body: route.request().postDataJSON() });
    await route.fulfill({ json: { released: true, id } });
  });
  await page.goto(PAGE);
  await expect(page.getByTestId("control-room")).toBeVisible();
  await expect(page.getByTestId("page-title")).toHaveText("Approvals");
  const row = page.locator(`[data-item="held:${id}"]`);
  await expect(row).toBeVisible();
  await expect(row.getByTestId("approval-approve")).toHaveText(new RegExp(`^Approve · ${credits.toLocaleString("en-US")} cr$`));
  /* The button that spends carries the marker and the very price it shows (docs/ui-checks.md). */
  await expect(row.getByTestId("approval-approve")).toHaveAttribute("data-spend", "priced");
  await expect(row.getByTestId("approval-approve")).toHaveAttribute("data-spend-price", /^(up to )?[\d.,]+ cr$/);
  await expect(row).toContainText("It starts when credits arrive; nothing is spent until then");
  await floors(page, info.project.use.isMobile === true);
  await shoot(page, info.project.name, "approvals-real");

  await row.getByTestId("approval-approve").click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0].body).toEqual({ credits });
});

/* ── Every kind of wait, the batch and the rules, against a fixed queue ───── */

const RUN = `rar_${"a".repeat(24)}`;
const FP = "f".repeat(64);
const project = { productionId: "prod_fx", draftId: null, name: "Project one" };
const base = { where: "Make", project, needsAdmin: false, canApprove: true, why: null, shortBy: null, note: null, step: null, sample: false };
const at = Date.now() - 3_600_000;
const FIXTURE = {
  inCredits: true,
  items: [
    { ...base, id: "held:gen_fx_a", source: "held", title: "Keyframe retake", at: at + 1, price: { kind: "exact", credits: 3 },
      approve: { kind: "release", genId: "gen_fx_a", credits: 3 }, decline: { kind: "discard", genId: "gen_fx_a" }, open: { kind: "take", genId: "gen_fx_a", draftId: null },
      note: "It starts when credits arrive; nothing is spent until then" },
    { ...base, id: `board-render:${RUN}:2`, source: "board-render", where: "Board", title: "Dialogue line", at: at + 2, price: { kind: "up-to", credits: 1 },
      approve: { kind: "board-render", productionId: "prod_fx", runId: RUN, seq: 2, fingerprint: FP }, decline: { kind: "board-skip", productionId: "prod_fx", runId: RUN, seq: 2 }, open: { kind: "board", productionId: "prod_fx", draftId: null } },
    { ...base, id: `board-render:${RUN}:3`, source: "board-render", where: "Board", title: "Hero take", at: at + 3, price: { kind: "exact", credits: 43 },
      needsAdmin: true, canApprove: false, why: "Members up to 40 cr a shot; an admin above it",
      approve: { kind: "board-render", productionId: "prod_fx", runId: RUN, seq: 3, fingerprint: FP }, decline: null, open: { kind: "board", productionId: "prod_fx", draftId: null } },
    { ...base, id: "thread:ach_fx", source: "thread", where: "Atomik", title: "Plan three takes", at: at + 4, price: { kind: "up-to", credits: 2 },
      step: { n: 1, of: 3 }, note: "Step 1 of 3 · Keyframes",
      approve: { kind: "thread", chatId: "ach_fx", stepId: "astp_fx", productionId: "prod_fx" }, decline: { kind: "thread-stop", stepId: "astp_fx" }, open: { kind: "thread", chatId: "ach_fx", productionId: "prod_fx" } },
    { ...base, id: "held:gen_fx_sample", source: "held", title: "Sample take", at: at + 5, price: { kind: "exact", credits: 2 }, sample: true,
      approve: { kind: "release", genId: "gen_fx_sample", credits: 2 }, decline: null, open: { kind: "take", genId: "gen_fx_sample", draftId: null } },
    { ...base, id: "held:gen_fx_short", source: "held", title: "Long take", at: at + 6, price: { kind: "exact", credits: 5 }, shortBy: 3, canApprove: false,
      approve: { kind: "release", genId: "gen_fx_short", credits: 5 }, decline: { kind: "discard", genId: "gen_fx_short" }, open: { kind: "take", genId: "gen_fx_short", draftId: null } },
    { ...base, id: "board-plan:rar_fx", source: "board-plan", where: "Board", title: "Three shots on the board", at: at + 7, price: { kind: "free" },
      note: "Next: render 3 shots · priced, each one approved first",
      approve: { kind: "board-approve", productionId: "prod_fx", runId: RUN, fingerprint: FP }, decline: { kind: "board-decline", productionId: "prod_fx", runId: RUN }, open: { kind: "board", productionId: "prod_fx", draftId: null } },
  ],
  decided: [
    { id: "thread-step:a", title: "Plates", project, what: "approved", by: "Teammate", byYou: false, at: at - 10, outcome: { kind: "settled", credits: 9 } },
    { id: "thread-step:b", title: "Turned down step", project, what: "turned down", by: null, byYou: false, at: at - 20, outcome: { kind: "nothing" } },
    { id: "board-render:c", title: "Render in flight", project, what: "approved", by: null, byYou: true, at: at - 30, outcome: { kind: "settling" } },
  ],
};

test("every kind of wait reads as the code has it; one tap approves only the listed items, one at a time, and stops at the first refusal", async ({ page }, info) => {
  test.skip(isCompact(info), "the phone has no batch approve, ledger or rules panel; how each kind of wait reads on its rows is the twin 'phone Home: every kind of wait…' below, and every phone row approves alone through its own route");
  test.setTimeout(180_000);
  await signInWithNewInterface(page.request);
  await page.route("**/api/control-room/approvals", (route) => route.fulfill({ json: FIXTURE }));
  const sent: { url: string; body: unknown }[] = [];
  await page.route(/\/api\/(jobs\/[^/]+\/release|workbench\/team-canvas)$/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    sent.push({ url: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    return route.request().url().includes("/release")
      ? route.fulfill({ json: { released: true } })
      : route.fulfill({ status: 409, json: { error: "This render's price changed. Look at it again before approving it." } });
  });
  await page.goto(PAGE);
  const rows = page.getByTestId("approval-row");
  await expect(rows).toHaveCount(FIXTURE.items.length);
  await expect(page.getByTestId("approvals-count")).toHaveText("7 items across 1 project");

  /* Each price in the shared words: "N cr", "up to N cr", "free". */
  await expect(page.locator(`[data-item="held:gen_fx_a"]`).getByTestId("approval-approve")).toHaveText("Approve · 3 cr");
  await expect(page.locator(`[data-item="board-render:${RUN}:2"]`).getByTestId("approval-approve")).toHaveText("Approve · up to 1 cr");
  await expect(page.locator(`[data-item="board-plan:rar_fx"]`).getByTestId("approval-approve")).toHaveText("Approve · free");
  /* Over the rule: no Approve, and the rule by role. */
  const admin = page.locator(`[data-item="board-render:${RUN}:3"]`);
  await expect(admin.getByTestId("approval-approve")).toHaveCount(0);
  await expect(admin.getByTestId("approval-why")).toHaveText("Members up to 40 cr a shot; an admin above it");
  /* The sample spends nothing; a short balance offers Top up instead of Approve. */
  await expect(page.locator(`[data-item="held:gen_fx_sample"]`)).toContainText("Sample production · nothing here spends credits");
  const short = page.locator(`[data-item="held:gen_fx_short"]`);
  await expect(short.getByTestId("approval-short")).toContainText("Short by 3 cr");
  await expect(short.getByTestId("approval-approve")).toHaveCount(0);
  /* Decided, in the ledger's words. */
  const decided = page.getByTestId("decided-row");
  await expect(decided.nth(0)).toContainText("9 cr settled");
  await expect(decided.nth(1)).toContainText("nothing billed");
  await expect(decided.nth(2)).toContainText("not settled yet");
  await expect(decided.nth(2)).toContainText("approved by you");

  /* The rules: shown, not changed here. */
  const spend = page.getByTestId("spend-without-asking");
  await expect(spend.getByRole("button", { name: "Ask" })).toHaveAttribute("aria-current", "true");
  await expect(spend.getByRole("button", { name: "Auto" })).toHaveAttribute("aria-disabled", "true");
  await expect(spend.getByTestId("spend-edit")).toHaveText("Edit in Settings › Spending rules ›");
  await expect(page.getByTestId("who-may-approve")).toContainText(/Any job over [\d,]+ cr needs a person’s approval, even under Auto\./);

  await floors(page, info.project.use.isMobile === true);
  await shoot(page, info.project.name, "approvals-kinds");

  /* Approve in one go: under 10 cr covers the release and the render, not the admin's, the plan's step, the sample, the short one or the build. */
  const batch = page.getByTestId("approve-in-one-go");
  await expect(batch.getByTestId("batch-line")).toHaveText("Keyframe retake (3 cr) · Dialogue line (up to 1 cr)");
  await expect(batch.getByTestId("batch-in-plan")).toContainText("Plan three takes");
  await expect(batch.getByTestId("batch-confirm")).toHaveText("Confirm · approve 2 items · up to 4 cr");
  await expect(batch.getByTestId("batch-confirm")).toHaveAttribute("data-spend-price", "up to 4 cr");
  await batch.getByTestId("batch-confirm").click();
  await expect(batch.getByTestId("batch-result")).toHaveText("Approved 1 of 2. Stopped at Dialogue line: This render's price changed. Look at it again before approving it.");
  expect(sent).toEqual([
    { url: "/api/jobs/gen_fx_a/release", body: { credits: 3 } },
    { url: "/api/workbench/team-canvas", body: { action: "agent.render", productionId: "prod_fx", runId: RUN, seq: 2, fingerprint: FP } },
  ]);
  /* A higher figure lists what it leaves out for an admin. */
  await batch.getByTestId("batch-under").fill("50");
  await expect(batch.getByTestId("batch-admin-out")).toContainText("Hero take");
});


/* ── The phone: Approvals is Home's Needs you queue (components/graphite/phone/HomeScreen.tsx) ───────────────────────────────────── */

test("phone Home: a held take in this workspace is approved through its own route at the price shown, and nothing else is sent", async ({ page }, info) => {
  test.skip(!isCompact(info), "desktop widths: 'a held take in this workspace…' above, on the Approvals page");
  test.setTimeout(180_000);
  const { id } = await seedHeld(page);
  const queue = await page.request.get("/api/control-room/approvals").then((r) => r.json());
  const item = queue.items.find((i: { id: string }) => i.id === `held:${id}`);
  expect(item?.price?.kind).toBe("exact");
  const credits: number = item.price.credits;

  const sent: { url: string; body: unknown }[] = [];
  const others: string[] = [];
  page.on("request", (r) => { if (r.method() !== "GET" && /\/api\/(generate|workbench\/team-canvas|pipelines|atomik)/.test(r.url())) others.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  await page.route(`**/api/jobs/${id}/release`, async (route: Route) => {
    sent.push({ url: route.request().url(), body: route.request().postDataJSON() });
    await route.fulfill({ json: { released: true, id } });
  });
  await page.goto("/suites?view=home");
  await expect(page.getByTestId("phone-home")).toBeVisible();
  /* A fresh workspace holds only the one take just seeded. */
  const row = page.getByTestId("phone-approval-row");
  await expect(row).toHaveCount(1);
  const approve = row.getByTestId("phone-row-approve");
  await expect(approve).toHaveText(`${credits.toLocaleString("en-US")} cr`);
  await expect(approve.locator("[data-price]")).toHaveAttribute("title", /^\$\d+\.\d\d$/);
  await expect(row).toContainText("It starts when credits arrive; nothing is spent until then");
  expect(await smallTargets(page, ".ph-app"), "targets under 44×44").toEqual([]);
  expect(await dimLabels(page, ".ph-app"), "labels under the floor").toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), "horizontal overflow").toBeLessThanOrEqual(0);
  await shoot(page, info.project.name, "approvals-phone-real");

  await approve.click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0].body).toEqual({ credits });
  expect(others).toEqual([]);
});

test("phone Home: every kind of wait reads as the code has it, each priced row alone, and nothing is sent by reading", async ({ page }, info) => {
  test.skip(!isCompact(info), "desktop widths: 'every kind of wait reads as the code has it…' above, on the Approvals page");
  test.setTimeout(180_000);
  await signInWithNewInterface(page.request);
  await page.route("**/api/control-room/approvals", (route) => route.fulfill({ json: FIXTURE }));
  const sent: string[] = [];
  page.on("request", (r) => { if (r.method() !== "GET" && /\/api\/(jobs|generate|workbench\/team-canvas|pipelines|atomik)/.test(r.url())) sent.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  await page.goto("/suites?view=home");
  await expect(page.getByTestId("phone-home")).toBeVisible();
  const rows = page.getByTestId("phone-approval-row");
  await expect(rows).toHaveCount(FIXTURE.items.length);
  const row = (title: string) => rows.filter({ hasText: title });

  /* Each price in the shared words: "N cr", "up to N cr", "free". */
  await expect(row("Keyframe retake").getByTestId("phone-row-approve")).toHaveText("3 cr");
  await expect(row("Dialogue line").getByTestId("phone-row-approve")).toHaveText("up to 1 cr");
  await expect(row("Three shots on the board").getByTestId("phone-row-plan")).toHaveText("free");
  /* Over the rule: no button, and who may press it. */
  await expect(row("Hero take")).toContainText("Needs an admin");
  await expect(row("Hero take").getByRole("button")).toHaveCount(0);
  /* The sample spends nothing: its price is shown, never pressable. */
  await expect(row("Sample take")).toContainText("Sample production · nothing here spends credits");
  await expect(row("Sample take").getByRole("button")).toBeDisabled();
  /* A short balance: by how much, and no way to approve it. */
  await expect(row("Long take")).toContainText("Short by 3 cr");
  await expect(row("Long take").getByTestId("phone-row-approve")).toHaveCount(0);
  /* A plan's step names its place in the plan. */
  await expect(row("Plan three takes")).toContainText("step 1 of 3");
  expect(await smallTargets(page, ".ph-app"), "targets under 44×44").toEqual([]);
  expect(await dimLabels(page, ".ph-app"), "labels under the floor").toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), "horizontal overflow").toBeLessThanOrEqual(0);
  await shoot(page, info.project.name, "approvals-phone-kinds");
  expect(sent, "reading the queue sent something").toEqual([]);
});
