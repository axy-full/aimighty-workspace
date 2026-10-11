import { expect, type APIRequestContext } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomBytes, randomUUID } from "node:crypto";
import { newProject } from "../../lib/workbench/studio";
import { localPlatformDbUrl, signInLocally } from "./workbenchLocal";

/**
 * A workspace with private work in it, for the privacy specs (redesign P4): a board, a finished take, a kept memory, a
 * workspace and an owner with names of their own. Every private string carries one random mark, so a spec can say "none
 * of it reaches this caller" by looking for the mark and for each id. Built on the local ENGINE_MOCK server through the
 * real routes (nothing is billed outside it).
 */
export type Private = {
  api: APIRequestContext;
  mark: string;
  workspaceId: string;
  workspaceName: string;
  userId: string;
  email: string;
  scope: string;
  /** The board's draft id, its production id, and the take's id. */
  draftId: string;
  productionId: string;
  genId: string;
  headers: Record<string, string>;
  /** Every string that must stay inside this workspace. */
  secrets: string[];
};

export async function seedPrivate(api: APIRequestContext, who = "Private Owner"): Promise<Private> {
  const mark = `PRIVMARK${randomBytes(5).toString("hex")}`;
  const { workspace } = await signInLocally(api, `${who} ${mark}`);
  const me = await api.get("/api/me").then((r) => r.json()) as { id: string; email: string };
  const scope = `particl-active-${workspace.id}-${me.id}`;
  const headers = { "X-Workbench-Scope": scope, "Content-Type": "application/json" };
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    await platform.execute({ sql: "UPDATE workspaces SET plan_id='studio' WHERE id=?", args: [workspace.id] });
    await platform.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)", args: [randomUUID(), workspace.id, 500, "Privacy test", "admin", "test", Date.now()] });
  } finally { platform.close(); }

  const project = { ...newProject(`Private board ${mark}`), brief: `Private brief ${mark}` };
  const saved = await api.put("/api/workbench/projects", { headers, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const productionId = String((await saved.json()).productionProjectId);

  const body = { prompt: `Private prompt ${mark}`, model: "gemini-3.1-flash-image", projectId: productionId, shotId: "", ratio: "16:9", resolution: "1K", duration: 5, refine: false, references: [] };
  const quote = await api.post("/api/generate/quote", { headers, data: body }).then((r) => r.json());
  const sent = await api.post("/api/generate", { headers: { ...headers, "Idempotency-Key": `privacy-${randomUUID()}` }, data: { ...body, maxCredits: quote.estimatedCredits, quoteFingerprint: quote.fingerprint } });
  expect(sent.ok(), await sent.text()).toBe(true);
  const genId = String((await sent.json()).id);
  await expect.poll(async () => (await api.get(`/api/jobs/${genId}`, { headers }).then((r) => r.json())).generation?.status, { timeout: 90_000 }).toBe("succeeded");

  const memory = await api.post("/api/atomik/memory", { headers, data: { action: "add", kind: "note", text: `Private memory ${mark}` } });
  expect(memory.ok(), await memory.text()).toBe(true);

  return {
    api, mark, workspaceId: workspace.id, workspaceName: workspace.name, userId: me.id, email: me.email, scope, draftId: project.id, productionId, genId, headers,
    secrets: [mark, workspace.id, workspace.name, me.id, me.email, project.id, productionId, genId],
  };
}

/** Which of the private strings a response carries (case-insensitive: an email may be lower-cased on the way). */
export function leaks(text: string, secrets: readonly string[]): string[] {
  const hay = text.toLowerCase();
  return secrets.filter((s) => s && hay.includes(s.toLowerCase()));
}
