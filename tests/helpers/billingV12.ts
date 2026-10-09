import { expect, type Page } from "@playwright/test";
import { signInToRedesign } from "./newInterface";
import { signInLocally } from "./workbenchLocal";
import { forbidPaidWork, mockLibrary, mockMedia, mockProjects } from "./workspaceFixtures";
import { newProject, type Project } from "../../lib/workbench/studio";

/**
 * Settings › Credits & billing in the new interface (components/v12/settings/CreditsBilling.tsx), opened with its routes
 * answering in their real shapes. Neutral sample names only (CLAUDE.md rule 3). Nothing here spends: Top up opens
 * today's screen, and every paid route is refused by forbidPaidWork.
 */
export const BILLING_PATH = "/suites?view=workspace&tab=credits";

const MIN = 60_000;
const DAY = 86_400_000;

export async function openBilling(page: Page, opts: { on?: boolean; low?: boolean } = {}) {
  if (opts.on === false) await signInLocally(page.request);
  else {
    await signInToRedesign(page.request);
    /* The server holds the switch's list for a few seconds (lib/newInterface.server.ts): wait until it sees this workspace. */
    await expect.poll(async () => ((await (await page.request.get("/api/me")).json()) as { workspace?: { newInterface?: boolean } }).workspace?.newInterface ?? false,
      { timeout: 30_000, intervals: [500, 1000, 2000] }).toBe(true);
  }
  await forbidPaidWork(page);
  await mockMedia(page);
  const project: Project = { ...newProject("Launch film"), id: "ws-billing", productionProjectId: "prod-billing", shotMappings: {} };
  await mockProjects(page, { current: project });
  await mockLibrary(page, { uploads: [], generations: [] });
  const now = Date.now();
  const monthStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1);
  const nextMonth = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() + 1, 1);
  await page.route("**/api/billing", (route) => route.fulfill({ json: {
    canManage: true, packs: [], credits: { balance: 1240 }, reach: null, rates: null,
    plans: [{ id: "invite", label: "Invite", priceUsd: 0, includedCredits: 0, maxProductions: 1, maxMembers: 3 }, { id: "studio", label: "Studio", priceUsd: 49, includedCredits: 400, maxProductions: null, maxMembers: null }],
    plan: { id: "studio", label: "Studio", includedCredits: 400 },
    subscription: { planId: "studio", status: "active", interval: "month", currentPeriodStart: monthStart, currentPeriodEnd: nextMonth, cancelAtPeriodEnd: false },
    cycles: [{ id: "c1", startsAt: monthStart, endsAt: nextMonth, credits: 400, invoiceId: "i1" }],
  } }));
  await page.route(/\/api\/workspaces\/topups(\?.*)?$/, (route) => route.fulfill({ json: {
    applies: true, provider: "manual", canRequest: true, openLimit: 3, creditUsd: 0.1, credits: null,
    packs: [{ id: "starter", label: "Starter", credits: 500, bonus: 0, total: 500, usd: 50, perCredit: 0.1 }, { id: "team", label: "Team", credits: 2000, bonus: 200, total: 2200, usd: 200, perCredit: 0.091 }],
    requests: [], history: [{ id: "g1", credits: 500, note: "Top up · Starter pack", createdAt: now - DAY - 3 * MIN }],
  } }));
  await page.route(/\/api\/usage\/boards(\?.*)?$/, (route) => route.fulfill({ json: { unit: "credits", month: new URL(route.request().url()).searchParams.get("month"), boards: [
    { id: "ws-billing", name: "Launch film", n: 8, credits: 186 },
    { id: "pb", name: "Product film", n: 4, credits: 94 },
    { id: "pc", name: "Spring campaign", n: 5, credits: 61 },
    { id: null, name: "Unfiled", n: 3, credits: 12 },
  ] } }));
  await page.route(/\/api\/usage(\?.*)?$/, (route) => {
    const q = new URL(route.request().url()).searchParams;
    if (q.get("rows") === "1") return route.fulfill({ json: { unit: "credits", month: q.get("month"), months: [q.get("month")], totals: { jobs: 9, charged: 163, held: 20, notBilled: 1 }, next: null, rows: [
      { id: "j1", at: now - 20 * MIN, who: "You", engine: "Nano Banana 2", kind: "image", credits: 10, state: "charged" },
      { id: "j2", at: now - 40 * MIN, who: "You", engine: "Seedance 2.5", kind: "video", credits: 20, state: "running" },
      { id: "j3", at: now - DAY, who: "You", engine: "Nano Banana 2", kind: "image", credits: 16, state: "charged" },
      { id: "j4", at: now - 3 * DAY, who: "You", engine: "Kling 3.0 Standard", kind: "video", credits: 54, state: "charged" },
    ] } });
    return route.fallback();
  });
  if (opts.low) {
    /* The live balance under 20% of the base, whatever the base: zero. */
    await page.route("**/api/me", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      return route.fulfill({ response, json: { ...body, credits: body.credits ? { ...body.credits, balance: 0 } : body.credits } });
    });
  }
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(BILLING_PATH);
  return { errors };
}
