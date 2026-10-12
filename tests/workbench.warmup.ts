import { chromium, type FullConfig, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { mockInvitation, PASSPHRASE } from "./helpers/fiveMinute";
import { seededProject } from "../lib/shell/create-project";
import { localPlatformDbUrl } from "./helpers/workbenchLocal";

/**
 * The workbench specs' set-up: on a cold `next dev` server the first browser visit of a page compiles its client chunks, and the page
 * rebuilds ([Fast Refresh] rebuilding … done), reloads, and answers its first API reads late while each route handler compiles. A spec that
 * opens a menu or counts a list in that window finds the page gone (a reload) or the list not loaded yet. So one throwaway person walks the
 * main screens first, not timed and not asserted, and each stops being cold before a spec starts. (docs/ci.md; the five-minute test does the same
 * for its own path: tests/five-minute.warmup.ts.) Local, mocked servers only. Best effort: if the walk can't finish it says so and the specs run.
 * Set PW_NO_WARMUP=1 to skip it on a server that is already warm.
 */
const SCREENS = [
  "/suites?view=home",
  "/suites?make=image",
  "/suites?make=video",
  "/suites?make=audio",
  "/suites?view=board",
  "/suites?view=workspace&tab=credits",
];

/** A throwaway account in a workspace that sees the new interface, made through the real sign-up route (the helpers the specs use call test.skip, which a set-up can't). */
async function signUpForWarmup(api: import("@playwright/test").APIRequestContext, base: string): Promise<string> {
  const invite = await mockInvitation(base, "Warm Up");
  const signup = await api.post("/api/auth/signup", { data: { code: invite.code, name: "Warm Up", email: invite.email, workspace: `Warm ${invite.code.slice(0, 8)}`, password: PASSPHRASE, accept: true } });
  if (!signup.ok()) throw new Error(`sign-up answered ${signup.status()}`);
  const workspaceId = ((await signup.json()) as { workspace: { id: string } }).workspace.id;
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    const row = await db.execute({ sql: "SELECT value FROM platform_layer WHERE key = 'site'", args: [] });
    const site = row.rows.length ? JSON.parse(String(row.rows[0].value)) as Record<string, unknown> : {};
    const listed = Array.isArray(site.newInterfaceWorkspaces) ? (site.newInterfaceWorkspaces as string[]) : [];
    site.newInterfaceWorkspaces = [workspaceId, ...listed.filter((id) => id !== workspaceId)].slice(0, 40);
    await db.execute({ sql: `INSERT INTO platform_layer (key, value, updated_at, updated_by) VALUES ('site', ?, ?, 'test') ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`, args: [JSON.stringify(site), Date.now()] });
  } finally { db.close(); }
  return workspaceId;
}

/** A board of the person's own to open, so the stage screens (the rail, the shots, the cut, the deliver pages) are compiled too. */
async function seedBoard(api: import("@playwright/test").APIRequestContext, workspaceId: string): Promise<string> {
  const me = (await (await api.get("/api/me")).json()) as { id: string };
  const project = seededProject("Warm up board", { brief: "A short film about a harbour waking up.", aspect: "16:9", deliverables: "15 s", boardKind: "studio" });
  const saved = await api.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": `particl-active-${workspaceId}-${me.id}` }, data: { project, revision: 0 } });
  if (!saved.ok()) throw new Error(`saving the warm-up board answered ${saved.status()}`);
  return project.id;
}

/** The page has stopped rebuilding: no [Fast Refresh] line, no reload and no new document for `quietMs`, and the load event has come. */
async function quiet(page: Page, state: { last: number }, quietMs = 2500, capMs = 45_000) {
  const until = Date.now() + capMs;
  while (Date.now() < until) {
    if (Date.now() - state.last >= quietMs) return;
    await page.waitForTimeout(250);
  }
}

/** The server has stopped compiling: five answers in a row from /api/health, each inside 300 ms (a dev server that is still compiling answers it late or not at all). */
async function serverQuiet(base: string, capMs = 90_000) {
  const until = Date.now() + capMs;
  let fast = 0;
  while (Date.now() < until && fast < 5) {
    const began = Date.now();
    const ok = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(20_000) }).then((r) => r.ok).catch(() => false);
    fast = ok && Date.now() - began < 300 ? fast + 1 : 0;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

export default async function warmUp(config: FullConfig) {
  if (process.env.PW_NO_WARMUP === "1") return;
  const use = config.projects[0].use;
  const base = String(use.baseURL ?? process.env.PW_BASE_URL ?? "http://localhost:4551");
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(base) || !process.env.PW_PLATFORM_DATABASE_URL) return;
  const health = await fetch(`${base}/api/health`).then((r) => r.json()).catch(() => null) as { mock?: boolean } | null;
  if (!health?.mock) return;
  const browser = await chromium.launch({ channel: use.channel, executablePath: use.launchOptions?.executablePath });
  try {
    for (const phone of [false, true]) {
      const context = await browser.newContext({ baseURL: base, viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: phone, hasTouch: phone });
      const page = await context.newPage();
      try {
        /* The session is made on the page's own cookies, so the screens below are the signed-in ones. */
        const workspaceId = await signUpForWarmup(context.request, base);
        const board = phone ? null : await seedBoard(context.request, workspaceId);
        const state = { last: Date.now() };
        page.on("console", (m) => { if (/Fast Refresh|HMR/.test(m.text())) state.last = Date.now(); });
        page.on("framenavigated", (f) => { if (f === page.mainFrame()) state.last = Date.now(); });
        page.on("load", () => { state.last = Date.now(); });
        const screens = phone ? SCREENS.slice(0, 1) : [...SCREENS, ...(board ? ["shots", "script", "cut", "deliver"].map((stage) => `/suites?project=${board}&view=board&stage=${stage}`) : [])];
        for (const screen of screens) {
          state.last = Date.now();
          await page.goto(screen, { timeout: 120_000 }).catch(() => undefined);
          await page.waitForLoadState("load", { timeout: 60_000 }).catch(() => undefined);
          await quiet(page, state);
        }
      } finally {
        await context.close();
      }
    }
    await serverQuiet(base);
  } catch (error) {
    console.warn(`The workbench warm-up walk did not finish (${error instanceof Error ? error.message : String(error)}); the specs run anyway.`);
  } finally {
    await browser.close();
  }
}
