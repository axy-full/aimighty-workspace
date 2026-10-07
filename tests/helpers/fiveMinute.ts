import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomBytes } from "node:crypto";
import { seededProject } from "../../lib/shell/create-project";
import { OLD_PHRASES, OLD_WORDS } from "./uiStrings";
import { localPlatformDbUrl } from "./workbenchLocal";

/**
 * Shared by tests/five-minute.spec.ts and its warm-up (tests/five-minute.warmup.ts). Nothing here spends: the
 * invitation is a row in the LOCAL platform database (the same table the platform owner's invite fills, as
 * tests/helpers/workbenchLocal.ts does), and the ledger below only watches the browser's own requests.
 */

export const PASSPHRASE = "a long passphrase for a test account 42";

/** A mocked invitation: the row the platform owner's invite would file, and the link its email would carry. */
export async function mockInvitation(base: string, name = "Test Person") {
  const code = randomBytes(18).toString("base64url");
  const email = `five-minute-${code}@example.test`.toLowerCase();
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    await db.execute({
      sql: "INSERT INTO signup_invites(code,email,name,note,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?)",
      args: [code, email, name, "Five-minute test", "test", Date.now(), Date.now() + 3_600_000],
    });
  } finally {
    db.close();
  }
  return { code, email, name, link: `${base.replace(/\/$/, "")}/signup?invite=${code}` };
}

/** The retired names (design README § 7), found in what a person can read. "Astra" is allowed only as Topaz's model. */
export function bannedNamesIn(text: string): string[] {
  const re = new RegExp(`\\b(${OLD_WORDS.join("|")})(?:s|'s|’s)?\\b|\\b(${OLD_PHRASES.join("|")})\\b`, "g");
  const found: string[] = [];
  for (const m of text.matchAll(re)) {
    const word = m[1] ?? m[2];
    const around = text.slice(Math.max(0, (m.index ?? 0) - 24), (m.index ?? 0) + word.length + 24);
    if (word === OLD_WORDS[OLD_WORDS.length - 1] && /topaz/i.test(around)) continue;
    found.push(`${word} … ${around.replace(/\s+/g, " ").trim()}`);
  }
  return found;
}

/** What a person can read on the page now. */
export const visibleText = (page: Page) => page.evaluate(() => document.body.innerText);

/** Requests that spend. A route is spending when a press of its button can bill (CLAUDE.md § Pricing). */
export type SpendKind = "agent.plan" | "agent.render" | "agent.approvePlan" | "generate" | "retry" | "audio" | "identity";

/**
 * The paid-route ledger. A paid request is allowed only while the step that a person presses has opened it
 * (`allow`), and is recorded as a violation otherwise. `spent` lists every paid request that went out, in order,
 * with the step that was open: the test reads it to show nothing paid went before a person's press.
 */
export function watchSpending(page: Page) {
  const allowed = new Map<SpendKind, string>();
  const spent: { kind: SpendKind; step: string; body?: Record<string, unknown> }[] = [];
  const violations: string[] = [];
  const note = (kind: SpendKind, body?: Record<string, unknown>) => {
    const step = allowed.get(kind);
    if (step) spent.push(body ? { kind, step, body } : { kind, step });
    else violations.push(`${kind} went out with no person's press open for it`);
  };
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    const path = new URL(request.url()).pathname;
    if (path === "/api/workbench/team-canvas") {
      const body = request.postDataJSON() as ({ action?: string } & Record<string, unknown>) | null;
      const action = body?.action;
      /* A plan's one approval spends too: its renders then go with no press of their own (CLAUDE.md rule 14). */
      if (action === "agent.plan" || action === "agent.render" || action === "agent.approvePlan") note(action, body ?? undefined);
    } else if (path === "/api/generate" || (path.startsWith("/api/generate/") && !path.endsWith("/quote"))) note("generate");
    else if (/^\/api\/jobs\/[^/]+\/retry$/.test(path)) note("retry");
    else if (/^\/api\/audio(\/dub)?$/.test(path)) note("audio");
    else if (path === "/api/soul/identities") note("identity");
  });
  return {
    spent,
    violations,
    /** A person is about to press the button that spends `kind`. */
    allow: (kind: SpendKind, step: string) => { allowed.set(kind, step); },
    /** Their press is done. */
    close: (kind: SpendKind) => { allowed.delete(kind); },
  };
}
export type SpendLedger = ReturnType<typeof watchSpending>;

/**
 * Buttons inside `root` that spend and say so: every one whose words start with a spending verb must carry a
 * figure ("N cr", "up to N cr") or say "free". Returns the ones that do not. A button that is disabled cannot spend, so it is
 * left out (a price still being read is such a button).
 */
export async function unpricedSpendButtons(page: Page, root: string): Promise<string[]> {
  return page.evaluate((selector) => {
    const SPENDS = /^(Start|Render\b|Build identity|Show me looks|Ask\b(?! the crew)|Make \d|Generate|Transfer|Retry|Again|Approve ·)/i;
    const PRICED = /\d[\d,.]*\s*cr\b|\bfree\b/i;
    const out: string[] = [];
    for (const scope of Array.from(document.querySelectorAll(selector))) {
      const buttons = [scope, ...Array.from(scope.querySelectorAll("button, [data-spend]"))].filter((el) => el.matches("button, [data-spend]"));
      for (const el of buttons) {
        const box = (el as HTMLElement).getBoundingClientRect();
        if (!box.width || !box.height || (el as HTMLButtonElement).disabled) continue;
        /* A template only makes the project (free; the figure is on Start, in the row above them): "Start from a script" matches the verb by name alone. */
        if (el.closest('[data-testid="home-templates"]') && !el.hasAttribute("data-spend")) continue;
        const text = ((el as HTMLElement).innerText || el.textContent || "").replace(/\s+/g, " ").trim();
        if ((SPENDS.test(text) || el.hasAttribute("data-spend")) && !PRICED.test(text)) out.push(text);
      }
    }
    return out;
  }, root);
}

/** The credits in the header's balance chip, or null while it is not readable. */
export async function balanceCr(page: Page): Promise<number | null> {
  const text = await page.getByTestId("workspace-credits").innerText().catch(() => "");
  const m = /([\d,]+(?:\.\d+)?)\s*cr/i.exec(text.replace(/\s+/g, " "));
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

export const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

/** The workspace-and-person scope the workbench routes ask for (X-Workbench-Scope), as the app itself builds it. */
export async function scopeFor(api: APIRequestContext) {
  const me = (await (await api.get("/api/me")).json()) as { id: string; workspace: { id: string } };
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  return { scope, headers: { "X-Workbench-Scope": scope }, workspaceId: me.workspace.id };
}

/** The newest Atomik run on a production (what the board's plan card reads), or null. */
export async function runOf(api: APIRequestContext, headers: Record<string, string>, productionId: string, draftId: string) {
  const read = await api.get(`/api/workbench/team-canvas?productionId=${productionId}&agent=1&projectId=${draftId}`, { headers });
  expect(read.ok(), await read.text()).toBe(true);
  const { agent } = (await read.json()) as { agent: {
    run: {
      id: string; state: string; proposal: { fingerprint: string } | null;
      plan?: { quote: { total: number; ceiling: number; fingerprint: string } | null } | null;
      paid: { tool: string; state: string; charged: number | null }[];
    } | null;
    ask: { planning: number } | null;
  } };
  return agent;
}

/**
 * What Home's Start does, on the routes it uses (components/graphite/home/start.ts): make the project from the brief,
 * read what Atomik's thinking costs, and ask with that figure as the limit. Warm-up only (tests/five-minute.warmup.ts):
 * the timed run presses Start on screen.
 */
export async function startAtomikOnApi(api: APIRequestContext, brief: string) {
  const { headers } = await scopeFor(api);
  const project = seededProject("Courier film", { brief, aspect: "16:9", deliverables: "15 s", boardKind: "studio" });
  const saved = await api.put("/api/workbench/projects", { headers, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const { productionProjectId: productionId } = (await saved.json()) as { productionProjectId?: string };
  expect(productionId, "the saved project has a production").toBeTruthy();
  const terms = await runOf(api, headers, productionId!, project.id);
  expect(terms.ask?.planning, "Atomik's thinking has a price").toBeGreaterThan(0);
  const asked = await api.post("/api/workbench/team-canvas", {
    headers,
    data: { action: "agent.plan", productionId, projectId: project.id, requestId: `five-minute-${Date.now()}`, goal: `${brief} · 16:9 · 15 s`, limit: terms.ask!.planning, mode: "ask" },
  });
  expect(asked.status(), await asked.text()).toBeLessThan(300);
  return { draftId: project.id, productionId: productionId!, headers, planning: terms.ask!.planning };
}
