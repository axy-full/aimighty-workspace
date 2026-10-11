import { expect, type Page } from "@playwright/test";
import { createClient, type Client } from "@libsql/client";
import { signInLocally, localPlatformDbUrl } from "./workbenchLocal";
import { newProject, type Project } from "../../lib/workbench/studio";

/*
 * Guest Home's browser specs share this: a signed-in local workspace holding a FINISHED production, the way the owner's
 * sample will be there (a saved draft with a cast and a cut over three shots, a take on each, and the ledger's record of
 * what each cost), marked as the sample the way stream 12's build action marks it. The rows live in the local,
 * disposable databases the spec's own ENGINE_MOCK server uses; nothing is generated and nothing is sent. Neutral words.
 */
export const PRICES = [43, 43, 7] as const;
const MODELS = ["dreamina-seedance-2-5-260628", "dreamina-seedance-2-5-260628", "fal-ai/kling-video/v3/standard"] as const;

async function tenantDb(workspaceId: string): Promise<Client> {
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    const row = (await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id = ?", args: [workspaceId] })).rows[0];
    expect(row, "the signed-in workspace has a database").toBeTruthy();
    const url = String(row.db_url);
    if (!url.startsWith("file:")) throw new Error("Browser fixtures require a local workspace database.");
    return createClient({ url, timeout: 10_000 });
  } finally { platform.close(); }
}

/** A finished production in a fresh local workspace, marked as the sample. `approve`: how many of the three takes are approved (the first ones). */
export async function seedMarkedSample(page: Page, options: { approve?: number; name?: string } = {}): Promise<{ workspaceId: string; project: Project }> {
  const approve = options.approve ?? 2;
  const { workspace } = await signInLocally(page.request, "Sample Builder");
  const me = await (await page.request.get("/api/me")).json() as { id: string };
  const headers = { "X-Workbench-Scope": `particl-active-${workspace.id}-${me.id}` } as const;
  const base: Project = { ...newProject(options.name ?? "A 15-second film"), id: `g15-${Date.now().toString(36)}`, aspect: "16:9", fps: 24, brief: "A short film about a walk to a sculpture." };
  const first = await page.request.put("/api/workbench/projects", { headers, data: { project: base, revision: 0 } });
  expect(first.ok(), await first.text()).toBe(true);
  const { productionProjectId: production, revision } = await first.json() as { productionProjectId: string; revision: number };

  const db = await tenantDb(workspace.id);
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  const takes: string[] = [];
  const at = Date.now() - 600_000;
  try {
    for (let i = 0; i < 3; i++) {
      const shot = `shot_g15_${i}_${Date.now().toString(36)}`, take = `gen_g15_${i}_${Date.now().toString(36)}`;
      await db.execute({
        sql: `INSERT INTO shots (id,project_id,scene,code,title,description,status,position,created_by,created_at,updated_at,planned,setup,cast,kind,dirty)
              VALUES (?,?,?,?,?,?,'open',?,?,?,?,5,'{}','[]','render',1)`,
        args: [shot, production, "", `C${i + 1}`, `Shot ${i + 1}`, "", i, me.id, at, at],
      });
      await db.execute({
        sql: `INSERT INTO generations (id,project_id,shot_id,kind,model,prompt,params,status,stored_url,cost_usd,created_by,created_at,updated_at,version,provider,task,review_state,review_by,reviewed_at,deleted)
              VALUES (?,?,?,'video',?,?,?,'succeeded','/fixtures/clip.mp4',0,?,?,?,1,'byteplus','generate',?,?,?,0)`,
        args: [take, production, shot, MODELS[i], `Take ${i + 1}`, JSON.stringify({ duration: 5, resolution: "1080p" }), me.id, at + i, at + i, i < approve ? "approved" : "", i < approve ? me.id : null, i < approve ? at + i + 1000 : null],
      });
      await platform.execute({
        sql: `INSERT INTO meter_events(id,workspace_id,project_id,shot_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_by,created_at,updated_at)
              VALUES (?,?,?,?,'video','byteplus',?,'succeeded',0.5,?,1,?,?,?)`,
        args: [take, workspace.id, production, shot, MODELS[i], PRICES[i], me.id, at + i, at + i],
      });
      takes.push(take);
    }
    const project: Project = {
      ...base, productionProjectId: production,
      assets: takes.map((take, i) => ({ id: `asset-${i}`, name: `Take ${i + 1}`, kind: "video" as const, category: "Shot", url: `/api/media/${take}`, description: "", prompt: "", status: i < approve ? "Selected" as const : "Draft" as const, locked: false, version: 1, refs: [], generationId: take })),
      shots: takes.map((_, i) => ({ id: `cut-${i}`, name: `Shot ${i + 1}`, assetId: `asset-${i}`, duration: 120, sourceIn: 0, note: "" })),
      production: { cast: { entries: [{ id: "cast-lead", name: "Lead", kind: "character" as const, description: "ivory suit, short dark bob", prompt: "", takes: [] }] } },
    };
    const saved = await page.request.put("/api/workbench/projects", { headers, data: { project, revision } });
    expect(saved.ok(), await saved.text()).toBe(true);
    /* The mark stream 12's build action writes (lib/demo/sample.ts). */
    await db.execute({
      sql: `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ('sampleProduction', ?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      args: [JSON.stringify({ version: 1, projectId: production, name: base.name, draftOwner: me.id, draftId: base.id, markedBy: me.id, markedAt: Date.now() }), me.id, Date.now()],
    });
    return { workspaceId: workspace.id, project };
  } finally { db.close(); platform.close(); }
}
