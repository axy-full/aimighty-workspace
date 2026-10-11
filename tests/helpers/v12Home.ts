import { expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { newProject, type Project } from "../../lib/workbench/studio";
import { localPlatformDbUrl } from "./workbenchLocal";
import { signInToRedesign } from "./newInterface";

/**
 * A signed-in redesign workspace with something on its Home (redesign C2): three boards of three kinds and a few
 * finished stills made on the local ENGINE_MOCK server (real routes, mock engine: nothing is spent outside it).
 * Neutral names only (plan decision 4).
 */
export const HOME_BOARDS = [
  { name: "Harbour film", kind: "studio" },
  { name: "Spring launch", kind: "ads" },
  { name: "Ridge clips", kind: "social" },
] as const;

const PROMPTS = [
  ["A lighthouse at dusk, slow push-in", "16:9"],
  ["Rain on a kitchen window at dawn", "9:16"],
  ["A brass compass on a map", "1:1"],
  ["A desert camp under stars", "16:9"],
  ["Waves on black sand", "9:16"],
  ["A cyclist on a ridge at noon", "16:9"],
] as const;

/**
 * Signed in to a fresh redesign workspace, and the switch already on for it: the server holds the site setting for a few
 * seconds (lib/newInterface.server.ts), so this waits until /api/me says so before any page is opened.
 */
export async function signInSwitchedOn(page: Page) {
  const signed = await signInToRedesign(page.request);
  await expect.poll(async () => (await page.request.get("/api/me").then((r) => r.json())).workspace?.newInterface, { timeout: 30_000, intervals: [500, 1_000, 2_000] }).toBe(true);
  return signed;
}

export async function seedHome(page: Page, { takes = 6 }: { takes?: number } = {}) {
  const signed = await signInSwitchedOn(page);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const scope = `particl-active-${signed.workspace.id}-${me.id}`;
  const headers = { "X-Workbench-Scope": scope, "Content-Type": "application/json" };
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    /* A paid plan, so a workspace may hold three boards (the Invite plan allows one). */
    await platform.execute({ sql: "UPDATE workspaces SET plan_id='studio' WHERE id=?", args: [signed.workspace.id] });
    await platform.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
      args: [randomUUID(), signed.workspace.id, 2000, "Home redesign test", "admin", "test", Date.now()] });
  } finally { platform.close(); }

  const boards: (Project & { productionId: string })[] = [];
  for (const board of HOME_BOARDS) {
    const project = { ...newProject(board.name), boardKind: board.kind } as Project;
    const saved = await page.request.put("/api/workbench/projects", { headers, data: { project, revision: 0 } });
    expect(saved.ok(), await saved.text()).toBe(true);
    boards.push({ ...project, productionId: String((await saved.json()).productionProjectId) });
  }

  const made: string[] = [];
  for (const [prompt, ratio] of PROMPTS.slice(0, takes)) {
    const body = { prompt, model: "gemini-3.1-flash-image", projectId: boards[0].productionId, shotId: "", ratio, resolution: "1K", duration: 5, refine: false, references: [] };
    const quote = await page.request.post("/api/generate/quote", { headers, data: body }).then((r) => r.json());
    const sent = await page.request.post("/api/generate", { headers: { ...headers, "Idempotency-Key": `home-${randomUUID()}` }, data: { ...body, maxCredits: quote.estimatedCredits, quoteFingerprint: quote.fingerprint } });
    expect(sent.ok(), await sent.text()).toBe(true);
    made.push(String((await sent.json()).id));
  }
  for (const id of made)
    await expect.poll(async () => (await page.request.get(`/api/jobs/${id}`, { headers }).then((r) => r.json())).generation?.status, { timeout: 90_000 }).toBe("succeeded");
  return { signed, scope, headers, boards, takes: made };
}
