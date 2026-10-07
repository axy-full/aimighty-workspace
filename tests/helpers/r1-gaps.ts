import { expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { OLD_WORDS } from "./uiStrings";
import { localPlatformDbUrl, signInLocally } from "./workbenchLocal";
import { smallTargets, smallText } from "../phoneFloors";
import { newProject, type Project } from "../../lib/workbench/studio";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Release 1, the three screens that were not built (control room tabs, phone fix and states, Make's Upscale):
 * what every one of their browser specs checks the same way. A fresh local account, a warm-up visit, then the floors.
 */

export const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
/** The shell treats 844x390 as a phone (lib/shell/use-compact.ts). */
export const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
export const SHOTS = process.env.R1_GAP_SHOTS || join(tmpdir(), "claude-r1-gap-shots");

/** Sign in a fresh local workspace with credits to spend, and visit Home once so the shell is warm. */
export async function signedInWarm(page: Page, name = "Gap Tester") {
  const workspaceId = (await signInLocally(page.request, name)).workspace.id;
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try { await db.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)", args: [randomUUID(), workspaceId, 2000, "Gap spec", "manual", "test", 0] }); } finally { db.close(); }
  await page.goto("/suites?view=home");
  await expect(page.getByTestId("screen").or(page.getByTestId("phone-app")).first()).toBeVisible();
  return workspaceId;
}

/** Console and page errors a screen raised, collected from the first call on. */
export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|favicon|ERR_|net::/.test(m.text())) errors.push(m.text()); });
  return errors;
}

const WORDS = new RegExp(`\\b(${OLD_WORDS.filter((w) => w !== "Astra").join("|")})(?:s|'s|’s)?\\b`);

/** None of the retired names in what a person can read; "Astra" only as Topaz's model name ("Topaz Astra 2"). */
export async function noBannedNames(page: Page, scope = "body") {
  const text = await page.locator(scope).first().innerText();
  const found = WORDS.exec(text);
  expect(found?.[0] ?? null, "a retired name is on screen").toBeNull();
  for (const m of text.matchAll(/\bAstra\b/g)) {
    const before = text.slice(Math.max(0, (m.index ?? 0) - 8), m.index);
    expect(before, "Astra stands alone").toMatch(/Topaz $/);
  }
}

/** Every control that spends shows a price or is disabled until it has one; nothing says "Retry" or "quoted" about a price. */
export async function everySpendButtonPriced(page: Page, scope = "body") {
  const bad = await page.evaluate((scope) => {
    const out: string[] = [];
    const figure = /(?:^|[\s·(,])(?:up to |about )?<?\d[\d,]*(?:\.\d+)?\s*cr\b|\bfree\b/i;
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(`${scope} [data-spend]`))) {
      if (!el.getClientRects().length) continue;
      const text = `${el.getAttribute("aria-label") ?? ""} ${el.textContent ?? ""}`;
      const unpriced = el.getAttribute("data-spend") === "unpriced";
      const disabled = (el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true";
      if (unpriced && !disabled) out.push(`unpriced but enabled: ${text.trim().slice(0, 40)}`);
      else if (!unpriced && !figure.test(text) && !el.hasAttribute("aria-busy")) out.push(`no figure: ${text.trim().slice(0, 40)}`);
    }
    return out;
  }, scope);
  expect(bad, "spending controls without a price").toEqual([]);
}

/** No sideways scroll, nothing read under 12 px, and 44 px targets on a phone. */
export async function floors(page: Page, scope: string, phone: boolean) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "horizontal overflow").toBeLessThanOrEqual(0);
  expect(await smallText(page), "text under 12 px").toEqual([]);
  if (phone) expect(await smallTargets(page, scope), "targets under 44×44").toEqual([]);
}

export async function shoot(page: Page, project: string, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/gap-${name}-${project.replace("workbench-", "")}.png`, animations: "disabled" });
}

/* ── A project whose takes are in the states the phone draws (frames D and H) ─────────────────────────────────── */

async function tenantDb(workspaceId: string) {
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    const row = (await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id = ?", args: [workspaceId] })).rows[0];
    expect(row, "the signed-in workspace has a database").toBeTruthy();
    const url = String(row.db_url);
    if (!url.startsWith("file:")) throw new Error("Browser fixtures require a local workspace database.");
    return createClient({ url, timeout: 10_000 });
  } finally { platform.close(); }
}

export type StateKind = "review" | "failed" | "rendering" | "held" | "still";
export type SeededStates = { project: Project; workspaceId: string; takes: Record<StateKind, string> };

/**
 * A fresh signed-in workspace (funded, so a short balance is the test's own choice) with a project holding one shot per state:
 * a finished clip waiting for review, a take that failed, one that is rendering and one held for credits. Rows in the local,
 * disposable databases of the spec's own ENGINE_MOCK server; nothing is generated and nothing is sent. Neutral names only.
 */
export async function seedPhoneStates(page: Page, options: { credits?: number; kinds?: StateKind[]; heldNeeds?: number; resolution?: string } = {}): Promise<SeededStates> {
  const { workspace } = await signInLocally(page.request, "Phone States");
  const me = await (await page.request.get("/api/me")).json() as { id: string };
  const scope = `particl-active-${workspace.id}-${me.id}`;
  const headers = { "X-Workbench-Scope": scope } as const;
  const base: Project = { ...newProject("Quiet harbour"), id: `gap-${Date.now().toString(36)}`, aspect: "16:9", fps: 24, brief: "A short film about a harbour at dusk." };
  const first = await page.request.put("/api/workbench/projects", { headers, data: { project: base, revision: 0 } });
  expect(first.ok(), await first.text()).toBe(true);
  const { productionProjectId: productionId } = await first.json() as { productionProjectId: string };
  const credits = options.credits ?? 2000;
  const kinds = options.kinds ?? ["review", "failed", "rendering", "held"];
  const db = await tenantDb(workspace.id);
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  const takes = {} as Record<StateKind, string>;
  const at = Date.now() - 300_000;
  try {
    await platform.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)", args: [randomUUID(), workspace.id, credits, "Gap spec", "manual", "test", 0] });
    for (const [i, kind] of kinds.entries()) {
      const shot = `shot_gap_${i}_${Date.now().toString(36)}`, take = `gen_gap_${i}_${Date.now().toString(36)}`;
      await db.execute({
        sql: `INSERT INTO shots (id,project_id,scene,code,title,description,status,position,created_by,created_at,updated_at,planned,setup,cast,kind,dirty)
              VALUES (?,?,?,?,?,?,'open',?,?,?,?,5,'{}','[]','render',1)`,
        args: [shot, productionId, "", `SH0${i + 1}`, `Shot ${i + 1}`, "", i, me.id, at, at],
      });
      const status = kind === "review" || kind === "still" ? "succeeded" : kind === "failed" ? "failed" : kind === "rendering" ? "running" : "held";
      const media = kind === "still" ? "image" : "video";
      const params = { duration: 5, resolution: options.resolution ?? "720p", ratio: "16:9", ...(kind === "held" ? { held: { why: "credits", needs: options.heldNeeds ?? 43 } } : {}) };
      await db.execute({
        sql: `INSERT INTO generations (id,project_id,shot_id,kind,model,prompt,params,status,stored_url,cost_usd,created_by,created_at,updated_at,version,provider,task,review_state,review_by,reviewed_at,deleted,error)
              VALUES (?,?,?,?,'dreamina-seedance-2-5-260628',?,?,?,?,0,?,?,?,1,'byteplus','generate','',NULL,NULL,0,?)`,
        args: [take, productionId, shot, media, `Take ${i + 1}`, JSON.stringify(params), status, kind === "review" ? "/fixtures/clip.mp4" : kind === "still" ? "/campaign/hero.webp" : null, me.id, at + i * 1000, at + i * 1000, kind === "failed" ? "The engine returned no frames." : null],
      });
      takes[kind] = take;
    }
  } finally { db.close(); platform.close(); }
  await page.addInitScript(({ scope, id }) => { try { localStorage.setItem(scope, id); } catch { /* storage off */ } }, { scope, id: base.id });
  return { project: base, workspaceId: workspace.id, takes };
}
