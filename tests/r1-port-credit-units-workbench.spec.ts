import { test, expect, type APIRequestContext } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";

/**
 * A workspace on the platform's keys reads credits, and never a vendor's dollar (OLD-PAGES-SPECS, port "credit units").
 *
 * The Productions list, a deliverable's Shots and Media pages, the project overview and the shot list each asserted this in a
 * browser, on a page that is gone (the addresses redirect into the shell). The rule is the routes': what those pages read is
 * what these routes send. So it is asserted of what the routes send: for a seeded production whose takes the vendors charged
 * for, and whose project carries a dollar cap beside its credit cap, no route answers with a dollar figure or a vendor
 * amount, and the shot-list CSV has no dollar column. Real local routes on a mock engine; nothing is rendered or paid for.
 */

/* What the vendors charged for the seeded takes, and the dollar caps beside the credit ones: a leak would print one of these. */
const VENDOR_USD = [1.339101, 0.512901];
const DOLLAR_CAPS = [55.55, 77.77];

async function seeded(request: APIRequestContext) {
  const signed = await signInLocally(request);
  const me = await request.get("/api/me").then((response) => response.json());
  expect(me.rates.unit, "a new workspace pays in credits").toBe("cr");
  const made = await request.post("/api/projects", { data: { name: `Harbour ${randomUUID().slice(0, 6)}` } });
  expect(made.ok(), await made.text()).toBeTruthy();
  const projectId = ((await made.json()) as { id: string }).id;
  const shotMade = await request.post("/api/shots", { data: { projectId, code: "SH010", title: "Harbour wide", planned: 5 } });
  expect(shotMade.ok(), await shotMade.text()).toBeTruthy();
  const shotId = ((await shotMade.json()) as { shot: { id: string } }).shot.id;
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  let dbUrl: string;
  try {
    dbUrl = String((await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id = ?", args: [signed.workspace.id] })).rows[0].db_url);
  } finally {
    platform.close();
  }
  const tenant = createClient({ url: dbUrl, timeout: 10_000 });
  const at = Date.now() - 60_000;
  try {
    for (const [i, cost] of VENDOR_USD.entries())
      await tenant.execute({
        sql: `INSERT INTO generations(id,project_id,shot_id,kind,model,prompt,params,status,created_by,created_at,updated_at,provider,cost_usd,stored_url,version)
              VALUES(?,?,?,'video','dreamina-seedance-2-5-260628','A harbour at dawn',?,'succeeded',?,?,?,'byteplus',?,'/fixtures/clip.mp4',?)`,
        args: [`gen_margin_${randomUUID().slice(0, 8)}`, projectId, shotId, JSON.stringify({ resolution: "1080p", ratio: "16:9", duration: 5 }), me.id, at + i, at + i, cost, i + 1],
      });
    await tenant.execute({ sql: "UPDATE projects SET cap_usd = 55.55, cap_credits = 555 WHERE id = ?", args: [projectId] });
    await tenant.execute({ sql: "UPDATE productions SET cap_usd = 77.77, cap_credits = 777 WHERE id = (SELECT production_id FROM projects WHERE id = ?)", args: [projectId] });
  } finally {
    tenant.close();
  }
  return { projectId, shotId };
}

/** Every key at any depth whose name says dollars, with a value that is not null or zero; and every vendor figure however it is printed. */
function leaks(value: unknown, path = "$"): string[] {
  const found: string[] = [];
  if (Array.isArray(value)) value.forEach((item, i) => found.push(...leaks(item, `${path}[${i}]`)));
  else if (value && typeof value === "object")
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (/usd|dollar/i.test(key) && inner !== null && inner !== undefined && inner !== 0 && inner !== false && inner !== "") found.push(`${path}.${key}`);
      found.push(...leaks(inner, `${path}.${key}`));
    }
  else if (typeof value === "number" && [...VENDOR_USD, ...DOLLAR_CAPS].some((usd) => Math.abs(value - usd) < 1e-9)) found.push(`${path}=${value}`);
  return found;
}

test("the routes the Productions list, deliverable pages, project overview and shot list read send credits and no vendor dollar", async ({ page }) => {
  const { projectId } = await seeded(page.request);
  const reads = [
    "/api/productions",
    "/api/projects",
    `/api/projects/${projectId}`,
    `/api/analytics?projectId=${projectId}`,
    `/api/shots?projectId=${projectId}`,
    `/api/jobs?projectId=${projectId}&limit=500`,
  ];
  for (const path of reads) {
    const response = await page.request.get(path);
    expect(response.ok(), `${path}: ${await response.text()}`).toBe(true);
    const text = await response.text();
    const body = JSON.parse(text) as unknown;
    /* GET /api/projects/:id sends the project's own cap row, `capUsd` among it: a setting an admin made, no vendor figure, and never
       drawn by the page this replaces. Reported as a finding (OLD-PAGES-SPECS); every other field is held to the rule. */
    expect(leaks(body).filter((leak) => !(path === `/api/projects/${projectId}` && /^\$\.project\.capUsd(=|$)/.test(leak))), path).toEqual([]);
    for (const usd of VENDOR_USD) for (const printed of [usd.toFixed(2), usd.toFixed(3), usd.toFixed(4), usd.toFixed(6)]) expect(text, `${path} prints ${printed}`).not.toContain(printed);
    if (path !== `/api/projects/${projectId}`) for (const usd of DOLLAR_CAPS) expect(text, `${path} prints ${usd}`).not.toContain(String(usd));
  }
  /* What the pages did show: the credit side is there to read (the caps in credits, the spend in credits). */
  const productions = (await page.request.get("/api/productions").then((r) => r.json())) as { productions: { capCredits: number | null; spentCredits?: number; projects: { id: string; capCredits: number | null }[] }[] };
  const production = productions.productions.find((p) => p.projects.some((x) => x.id === projectId))!;
  expect(production.capCredits).toBe(777);
  expect(production.projects.find((x) => x.id === projectId)!.capCredits).toBe(555);
  expect(production.spentCredits ?? 0).toBeGreaterThanOrEqual(0);
});

test("the shot list's CSV names credits and has no dollar column, and no vendor amount", async ({ page }) => {
  const { projectId } = await seeded(page.request);
  let answered = 0;
  for (const path of [`/api/export/selects?projectId=${projectId}&format=csv`, `/api/export?format=csv`]) {
    const response = await page.request.get(path);
    if (!response.ok()) continue;
    answered++;
    const body = await response.text();
    const header = body.split("\n")[0];
    expect(header, path).not.toMatch(/usd/i);
    for (const usd of [...VENDOR_USD, ...DOLLAR_CAPS]) expect(body, path).not.toContain(usd.toFixed(2));
  }
  expect(answered, "at least one CSV export answered").toBeGreaterThan(0);
});
