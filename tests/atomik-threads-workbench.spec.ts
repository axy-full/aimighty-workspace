import { test, expect, type Page, type Locator } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { legacyShell } from "./helpers/legacyShell";
import { newProject } from "../lib/workbench/studio";
import { dimLabels, smallTargets } from "./phoneFloors";

/**
 * Several Atomik threads per project (lib/atomikThreads.ts), in the rail, on
 * a phone's sheet and on the Suites Agent page.
 *
 * Real local routes on an ENGINE_MOCK=1 server. A fresh workspace has a
 * Studio project whose production already holds one Atomik conversation from
 * before threads, written straight into its tenant database with a proposed
 * step. An old link opens it as thread 1. A second thread is asked for and
 * planned by the mocked planner (which answers every ask with "Mocked
 * production" and one "Mocked shot", so the threads are told apart by their
 * numbers, their first plans and a rename). Each keeps its own plan; the
 * person switches between them, renames one, archives and restores one; a
 * paid step is quoted and approved in one thread alone, its render sent under
 * a key naming that thread while the other thread's step stays proposed. No
 * provider is called and nothing is billed for real.
 */
const ENGINE = "dreamina-seedance-2-0-260128";

async function seeded(page: Page, opts: { second?: boolean } = {}) {
  const signed = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${signed.workspace.id}-${me.id}` };
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  let tenantUrl: string;
  try {
    await platform.execute({
      sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
      args: [randomUUID(), signed.workspace.id, 2000, "Local mock Atomik threads", "admin", "test", Date.now()],
    });
    tenantUrl = String((await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id=?", args: [signed.workspace.id] })).rows[0].db_url);
  } finally {
    platform.close();
  }
  const project = newProject("Harbour launch");
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const production = String((await saved.json()).productionProjectId);
  /* The workspace's tables exist once Atomik has been read. */
  expect((await page.request.get("/api/atomik")).ok()).toBe(true);
  const tag = randomUUID().slice(0, 8);
  const first = { chat: `ach_one_${tag}`, step: `astp_one_${tag}` };
  const second = { chat: `ach_two_${tag}`, step: `astp_two_${tag}` };
  const tenant = createClient({ url: tenantUrl, timeout: 10_000 });
  try {
    /* The production's conversation from before threads, as it was written then: no thread column set. */
    const conversation = async (c: { chat: string; step: string }, title: string, ask: string, shot: string, at: number) => {
      await tenant.execute({ sql: "INSERT INTO atomik_chats (id,project_id,title,model,agent_mode,status,text_cost_usd,created_by,created_at,updated_at,deleted) VALUES (?,?,?,'auto','ask','waiting',0,?,?,?,0)", args: [c.chat, production, title, me.id, at, at] });
      await tenant.execute({ sql: "INSERT INTO atomik_messages (id,chat_id,role,text,activity,created_at) VALUES (?,?,'user',?,'[]',?)", args: [`${c.chat}_u`, c.chat, ask, at] });
      await tenant.execute({ sql: "INSERT INTO atomik_messages (id,chat_id,role,text,activity,created_at) VALUES (?,?,'assistant','One shot.','[]',?)", args: [`${c.chat}_a`, c.chat, at + 1] });
      await tenant.execute({
        sql: `INSERT INTO atomik_steps (id,chat_id,message_id,position,kind,title,prompt,model,params,refs,status,est_cost_usd,created_at,updated_at)
              VALUES (?,?,?,0,'video',?,'A slow push in on a bottle on a kitchen table.',?,?,'[]','proposed',NULL,?,?)`,
        args: [c.step, c.chat, `${c.chat}_a`, shot, ENGINE, JSON.stringify({ ratio: "16:9", resolution: "720p", seconds: 5 }), at, at],
      });
    };
    await conversation(first, "Bottle spot", "A bottle spot.", "Push in", Date.now() - 120_000);
    if (opts.second) await conversation(second, "Harbour teaser", "A harbour teaser.", "Wide at dusk", Date.now() - 60_000);
  } finally {
    tenant.close();
  }
  /* This tab's production, and the rail open, as a returning person left them. */
  await page.addInitScript(([id, key]) => {
    localStorage.setItem("aw_project", id);
    localStorage.setItem(key, JSON.stringify({ state: "expanded", last: "expanded" }));
  }, [production, `particl:atomik:${me.email}`]);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && /same key|unique "key"|Maximum update depth|Cannot update a component|hydrat/i.test(message.text())) errors.push(message.text().slice(0, 300));
  });
  return { tenantUrl, draft: project.id, production, first, second, errors };
}

/** A step's row, read straight from the tenant database. */
async function stepRow(tenantUrl: string, id: string) {
  const tenant = createClient({ url: tenantUrl, timeout: 10_000 });
  try {
    const r = (await tenant.execute({ sql: "SELECT status, attempt, request_key FROM atomik_steps WHERE id=?", args: [id] })).rows[0];
    return { status: String(r.status), attempt: Number(r.attempt), requestKey: r.request_key == null ? null : String(r.request_key) };
  } finally {
    tenant.close();
  }
}
async function chatRow(tenantUrl: string, id: string) {
  const tenant = createClient({ url: tenantUrl, timeout: 10_000 });
  try {
    const r = (await tenant.execute({ sql: "SELECT archived_at, deleted, (SELECT COUNT(*) FROM atomik_messages WHERE chat_id = c.id) AS messages FROM atomik_chats c WHERE id=?", args: [id] })).rows[0];
    return { archived: r.archived_at != null, deleted: Number(r.deleted), messages: Number(r.messages) };
  } finally {
    tenant.close();
  }
}
async function threadsOf(tenantUrl: string, production: string) {
  const tenant = createClient({ url: tenantUrl, timeout: 10_000 });
  try {
    return (await tenant.execute({ sql: "SELECT c.id AS chat, s.id AS step FROM atomik_chats c LEFT JOIN atomik_steps s ON s.chat_id = c.id WHERE c.project_id=? ORDER BY c.created_at", args: [production] }))
      .rows.map((r) => ({ chat: String(r.chat), step: r.step == null ? null : String(r.step) }));
  } finally {
    tenant.close();
  }
}

const phone = (page: Page) => page.viewportSize()!.width < 760;
const surfaceOf = (page: Page) => (phone(page) ? page.getByRole("dialog", { name: "Atomik" }) : page.getByRole("complementary", { name: "Atomik" }));
/** Where the checkpoint's line and Continue are: the compact rail's card on a desktop, the sheet's checkpoint card on a phone. */
const checkpointOf = (page: Page) => (phone(page) ? page.getByRole("group", { name: "Checkpoint", exact: true }) : surfaceOf(page));
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** Ask Atomik in the open rail (or sheet): wait for the planning estimate for this production, then send at it. */
async function ask(page: Page, surface: Locator, brief: string, production: string) {
  const field = surface.getByRole("textbox", { name: "Ask Atomik" });
  const send = surface.getByRole("button", { name: /^Send · \d+ cr estimated/ });
  await expect(async () => {
    const quoted = page.waitForResponse((r) => {
      const request = r.request();
      if (request.method() !== "POST" || new URL(r.url()).pathname !== "/api/atomik") return false;
      const body = request.postDataJSON() as { quoteOnly?: boolean; projectId?: string; text?: string } | null;
      return body?.quoteOnly === true && body.projectId === production && body.text === brief;
    }, { timeout: 20_000 });
    await field.fill("");
    await field.fill(brief);
    expect((await quoted).status()).toBe(200);
    await expect(send).toBeEnabled({ timeout: 10_000 });
  }).toPass({ timeout: 120_000 });
  const turn = page.waitForResponse((r) => r.request().method() === "POST" && /\/api\/atomik\/ach_[^/]+$/.test(new URL(r.url()).pathname) && r.request().postDataJSON()?.quoteOnly !== true, { timeout: 120_000 });
  await send.click();
  const answered = await turn;
  expect(answered.status(), await answered.text()).toBe(200);
}

/**
 * Every control a thumb can reach under `scope` that is smaller than 44×44. A control hidden from everyone
 * (aria-hidden, as the visually hidden native select a Radix Select keeps for its form) is not a target.
 */
async function touchTargets(page: Page, scope: string) {
  return page.evaluate((scope) => {
    const out: string[] = [];
    for (const root of Array.from(document.querySelectorAll<HTMLElement>(scope)))
      for (const el of Array.from(root.querySelectorAll<HTMLElement>("button, a[href], select, input, textarea"))) {
        if (!el.getClientRects().length || el.closest("[aria-hidden='true']")) continue;
        const box = el.getBoundingClientRect();
        if (box.width < 43.5 || box.height < 43.5)
          out.push(`${el.dataset.testid || el.getAttribute("aria-label") || el.textContent?.trim().slice(0, 24) || el.tagName}: ${Math.round(box.width)}×${Math.round(box.height)}`);
      }
    return out;
  }, scope);
}

/**
 * The threads' floors where a thumb uses them: nothing off the side, labels at the floor and 44px targets in
 * `scope` (the repo's helpers), and, with `whole`, every control in that wider block too (its own composer).
 */
async function floors(page: Page, scope: string, whole?: string) {
  expect(await sideways(page), "no sideways scroll").toBeLessThanOrEqual(1);
  expect(await dimLabels(page, scope), "thread labels under #7C7C84").toEqual([]);
  if (page.viewportSize()!.width < 768) {
    expect(await smallTargets(page, scope), "thread targets under 44×44").toEqual([]);
    if (whole) expect(await touchTargets(page, whole), "targets under 44×44").toEqual([]);
  }
}

/**
 * The rail (components/ui/Rail.tsx) in a short window (max-height 500px, a phone on its side): its body keeps its
 * natural height and the whole rail scrolls as one column, so the Threads row never scrolls inside a strip squeezed
 * down to the body's padding, and the composer's Send is reached by scrolling the rail. Nothing to check on a phone's
 * sheet (it is not the rail) or in a taller window (the body scrolls between the pinned header and footer there).
 */
async function shortRail(page: Page) {
  return page.evaluate(() => {
    const rail = document.querySelector<HTMLElement>("aside.ui-rail[aria-label='Atomik']");
    if (!rail || !matchMedia("(max-height: 500px)").matches) return [];
    const body = rail.querySelector<HTMLElement>(":scope > header + div")!;
    const out: string[] = [];
    if (getComputedStyle(body).overflowY !== "visible" || body.scrollHeight > body.clientHeight + 1)
      out.push(`the body scrolls on its own: ${body.scrollHeight}px of content in ${body.clientHeight}px (overflow-y ${getComputedStyle(body).overflowY})`);
    const row = body.querySelector<HTMLElement>("[data-testid='atomik-threads-toggle']");
    if (!row) out.push("no Threads row in the rail body");
    else {
      const r = row.getBoundingClientRect(), b = body.getBoundingClientRect();
      if (r.top < b.top - 1 || r.bottom > b.bottom + 1) out.push(`the Threads row (${Math.round(r.top)}–${Math.round(r.bottom)}) runs outside the body (${Math.round(b.top)}–${Math.round(b.bottom)})`);
    }
    const before = rail.scrollTop;
    rail.scrollTop = rail.scrollHeight;
    const send = rail.querySelector<HTMLElement>("footer button[type='submit']");
    const box = rail.getBoundingClientRect();
    if (!send) out.push("no Send in the rail's footer");
    else if (send.getBoundingClientRect().bottom > box.bottom + 1) out.push(`Send ends at ${Math.round(send.getBoundingClientRect().bottom)}, below the rail's ${Math.round(box.bottom)} once it is scrolled to the end`);
    rail.scrollTop = before;
    return out;
  });
}

/** On a phone or any touch screen the shared composer's Send is a 44px target (min-h-11 alone is 2.75rem, 41px on the 15px root). */
async function sendTarget(page: Page, scope: Locator) {
  if (!(await page.evaluate(() => matchMedia("(max-width: 767px), (pointer: coarse)").matches))) return;
  const send = (await scope.locator("form:has(input[aria-label='Ask Atomik']) button[type='submit']").filter({ visible: true }).first().boundingBox())!;
  expect(Math.min(send.width, send.height), "Send is a 44px target on touch").toBeGreaterThanOrEqual(43.5);
}

test("threads in the rail and on a phone: an old link opens the production's conversation as thread 1; a second thread keeps its own plan; switch, rename, archive and restore; a step in thread 2 is approved alone", async ({ page }) => {
  test.setTimeout(300_000);
  const f = await seeded(page);
  const link = `/atomik?project=${encodeURIComponent(f.draft)}&page=generate`;
  await page.goto(await legacyShell(page, link));
  const surface = surfaceOf(page);
  await expect(surface).toBeVisible({ timeout: 60_000 });
  const threads = surface.getByTestId("atomik-threads");
  const toggle = threads.getByTestId("atomik-threads-toggle");
  const rows = threads.getByTestId("atomik-thread");
  const scope = phone(page) ? "[role='dialog'][aria-label='Atomik'] [data-testid='atomik-threads']" : "aside[aria-label='Atomik'] [data-testid='atomik-threads']";

  /* An old link, naming no thread: the production's conversation from before threads, as thread 1. */
  await expect(toggle).toContainText("Thread 1", { timeout: 60_000 });
  await expect(toggle).toContainText("Bottle spot");
  await expect(checkpointOf(page)).toContainText(/Next: push in/i, { timeout: 60_000 });
  expect(await shortRail(page), "a short window's rail scrolls as one column").toEqual([]);
  await sendTarget(page, surface);

  /* A new thread: the next ask starts it, and the planner plans it there. */
  await threads.getByTestId("atomik-thread-new").click();
  await expect(toggle).toContainText("New thread");
  await ask(page, surface, "A harbour teaser at dusk, one wide.", f.production);
  await expect(toggle).toContainText("Thread 2", { timeout: 60_000 });
  await expect(checkpointOf(page)).toContainText(/Next: mocked shot/i, { timeout: 60_000 });
  const second = (await threadsOf(f.tenantUrl, f.production)).find((t) => t.chat !== f.first.chat)!;
  expect(second.step).toBeTruthy();

  /* The list: newest activity first, the thread on screen marked, each with who started it and where it stands. */
  await toggle.click();
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("#2");
  await expect(rows.nth(0).getByRole("button", { name: /Mocked production/ })).toHaveAttribute("aria-current", "true");
  await expect(rows.nth(0).getByTestId("atomik-thread-meta")).toContainText("Started by you · Waiting for approval");
  await expect(rows.nth(1)).toContainText("#1");
  await expect(rows.nth(1)).toContainText("Bottle spot");
  await floors(page, scope);

  /* Rename the thread on screen: its name is the person's from now on. */
  await rows.nth(0).getByRole("button", { name: "Rename", exact: true }).click();
  await threads.getByLabel("Thread name").fill("Harbour teaser");
  await threads.getByRole("button", { name: "Save", exact: true }).click();
  await expect(rows.nth(0)).toContainText("Harbour teaser");
  await expect(toggle).toContainText("Harbour teaser");

  /* Switch: thread 1 shows its own plan, and thread 2 its own again. */
  await rows.nth(1).getByRole("button", { name: /Bottle spot/ }).click();
  await expect(toggle).toContainText("Thread 1");
  await expect(checkpointOf(page)).toContainText(/Next: push in/i);
  await toggle.click();
  await rows.filter({ hasText: "Harbour teaser" }).getByRole("button", { name: /Harbour teaser/ }).click();
  await expect(toggle).toContainText("Thread 2");
  await expect(checkpointOf(page)).toContainText(/Next: mocked shot/i);

  /* Continue in thread 2: quoted, then rendered under a key naming thread 2 alone; thread 1's step stays proposed. */
  const cont = checkpointOf(page).getByRole("button", { name: /^Continue/ }).first();
  await expect(cont).toContainText(/\d+ cr/, { timeout: 60_000 });
  await expect(cont).toBeEnabled();
  const rendered = page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/api/generate", { timeout: 60_000 });
  await cont.click();
  expect((await rendered).headers()["idempotency-key"]).toBe(`atomik-step:${second.chat}:${second.step}`);
  await expect.poll(async () => (await stepRow(f.tenantUrl, second.step!)).status, { timeout: 60_000 }).not.toBe("proposed");
  expect(await stepRow(f.tenantUrl, f.first.step)).toEqual({ status: "proposed", attempt: 0, requestKey: null });

  /* Archive thread 1: it leaves the list, the newest activity opens, and the Archived list says who archived it. */
  await toggle.click();
  await rows.filter({ hasText: "Bottle spot" }).getByRole("button", { name: /Bottle spot/ }).click();
  await expect(toggle).toContainText("Thread 1");
  await toggle.click();
  await rows.filter({ hasText: "Bottle spot" }).getByRole("button", { name: "Archive", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(toggle).toContainText("Thread 2");
  await threads.getByTestId("atomik-threads-archived").click();
  const shelf = threads.getByTestId("atomik-archived-thread");
  await expect(shelf).toHaveCount(1);
  await expect(shelf).toContainText("Bottle spot");
  await expect(shelf).toContainText("Archived by you");
  await floors(page, scope);
  /* Archived, never deleted: every message and the unapproved step are kept. */
  expect(await chatRow(f.tenantUrl, f.first.chat)).toEqual({ archived: true, deleted: 0, messages: 2 });
  expect((await stepRow(f.tenantUrl, f.first.step)).status).toBe("proposed");

  /* Restore brings it back as it was, and opens it. */
  await shelf.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(toggle).toContainText("Thread 1");
  await expect(rows).toHaveCount(2);
  await expect(checkpointOf(page)).toContainText(/Next: push in/i);
  expect(await chatRow(f.tenantUrl, f.first.chat)).toEqual({ archived: false, deleted: 0, messages: 2 });

  /* A link naming a thread opens it, whichever thread this tab was on. */
  await rows.filter({ hasText: "Harbour teaser" }).getByRole("button", { name: /Harbour teaser/ }).click();
  await expect(toggle).toContainText("Thread 2");
  await page.goto(`${link}&thread=${encodeURIComponent(f.first.chat)}`);
  await expect(surfaceOf(page).getByTestId("atomik-threads-toggle")).toContainText("Thread 1", { timeout: 60_000 });
  /* A link naming none, opened afresh in another tab, opens the thread with the newest activity. */
  const other = await page.context().newPage();
  try {
    await other.goto(link);
    await expect(surfaceOf(other).getByTestId("atomik-threads-toggle")).toContainText("Thread 2", { timeout: 60_000 });
  } finally {
    await other.close();
  }
  expect(await sideways(page)).toBeLessThanOrEqual(1);
  expect(f.errors).toEqual([]);
});

test("the Suites Agent page lists the project's threads; each shows its own plan and checkpoint, and Continue approves that thread's step alone", async ({ page }) => {
  test.setTimeout(240_000);
  const f = await seeded(page, { second: true });
  await page.goto(`/suites?suite=atomik&page=agent&sp=agent&project=${encodeURIComponent(f.draft)}`);
  const panel = page.getByTestId("atomik-threads-panel");
  await expect(panel).toBeVisible({ timeout: 60_000 });
  const rows = panel.getByTestId("atomik-thread");
  await expect(rows).toHaveCount(2, { timeout: 60_000 });
  /* Newest activity first: the thread asked last is on screen, with its own plan. */
  await expect(rows.nth(0)).toContainText("#2");
  await expect(rows.nth(0)).toContainText("Harbour teaser");
  await expect(rows.nth(1)).toContainText("#1");
  await expect(rows.nth(1)).toContainText("Bottle spot");
  const view = panel.getByTestId("atomik-thread-view");
  await expect(view).toContainText("Thread 2 · Harbour teaser", { timeout: 60_000 });
  await expect(view.getByTestId("atomik-thread-step")).toHaveCount(1);
  await expect(view.getByTestId("atomik-thread-step")).toContainText("Wide at dusk");

  /* Switch to thread 1: its own conversation, plan and checkpoint. */
  await rows.nth(1).getByRole("button", { name: /Bottle spot/ }).click();
  await expect(view).toContainText("Thread 1 · Bottle spot");
  await expect(view).toContainText("A bottle spot.");
  await expect(view.getByTestId("atomik-thread-step")).toContainText("Push in");
  await expect(rows.nth(1).getByRole("button", { name: /Bottle spot/ })).toHaveAttribute("aria-current", "true");

  /* Continue approves thread 1's step alone, at its quoted price, under a key naming thread 1. */
  const cont = view.getByTestId("atomik-thread-continue");
  await expect(cont).toContainText(/\d+ cr/, { timeout: 60_000 });
  await expect(cont).toBeEnabled();
  await floors(page, "[data-testid='atomik-threads-panel'] [data-testid='atomik-threads'], [data-testid='atomik-thread-checkpoint']", "[data-testid='atomik-threads-panel']");
  await sendTarget(page, panel);
  const rendered = page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/api/generate", { timeout: 60_000 });
  await cont.click();
  expect((await rendered).headers()["idempotency-key"]).toBe(`atomik-step:${f.first.chat}:${f.first.step}`);
  await expect.poll(async () => (await stepRow(f.tenantUrl, f.first.step)).status, { timeout: 60_000 }).not.toBe("proposed");
  expect(await stepRow(f.tenantUrl, f.second.step)).toEqual({ status: "proposed", attempt: 0, requestKey: null });

  /* On a phone the last of it ends above the tab bar once scrolled to. */
  if (await page.getByTestId("tabbar").isVisible()) {
    const gap = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('[data-testid="content"]')!;
      scroller.scrollTop = scroller.scrollHeight;
      const view = document.querySelector<HTMLElement>('[data-tool-body="agent"]')!;
      const shown = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
      const leaves = Array.from(view.querySelectorAll<HTMLElement>("*")).filter((el) => shown(el) && !Array.from(el.children).some(shown));
      return document.querySelector('[data-testid="tabbar"]')!.getBoundingClientRect().top - Math.max(...leaves.map((el) => el.getBoundingClientRect().bottom));
    });
    expect(gap, "the last content ends above the tab bar").toBeGreaterThanOrEqual(0);
  }
  expect(await sideways(page)).toBeLessThanOrEqual(1);
  expect(f.errors).toEqual([]);
});
