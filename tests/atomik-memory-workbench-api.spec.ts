import { test, expect, type APIRequestContext } from "@playwright/test";
import { createClient } from "@libsql/client";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";

/**
 * Atomik memory through its real routes on a local ENGINE_MOCK=1 server:
 * two real workspaces never read or change each other's entries, a project
 * reads only its own and the workspace's, forget archives (read straight from
 * the workspace database), money is refused, a write needs the page's
 * workspace scope, and nothing here spends.
 */
type Entry = { id: string; kind: string; text: string; scope: string; status: string };

/** The workspace's own database, read and written directly (a second production: the Invite plan makes one). */
async function tenantOf(workspaceId: string) {
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    const url = String((await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id=?", args: [workspaceId] })).rows[0].db_url);
    return createClient({ url, timeout: 10_000 });
  } finally { platform.close(); }
}

async function account(request: APIRequestContext) {
  const { workspace } = await signInLocally(request);
  const me = (await (await request.get("/api/me")).json()) as { id: string };
  const headers = { "X-Workbench-Scope": `particl-active-${workspace.id}-${me.id}` };
  const production = async (name: string) => {
    const made = await request.post("/api/projects", { data: { name } });
    expect(made.ok(), await made.text()).toBe(true);
    return ((await made.json()) as { id: string }).id;
  };
  const add = async (data: Record<string, unknown>) => request.post("/api/atomik/memory", { headers, data: { action: "add", ...data } });
  const list = async (projectId?: string) => {
    const reply = await request.get(`/api/atomik/memory${projectId ? `?projectId=${projectId}` : ""}`, { headers });
    expect(reply.ok(), await reply.text()).toBe(true);
    return ((await reply.json()) as { entries: Entry[] }).entries;
  };
  return { workspace, headers, production, add, list };
}

test("memory routes: one workspace's entries never reach another, a project reads only its own, and forget archives", async ({ request, playwright }) => {
  const a = await account(request);
  const otherContext = await playwright.request.newContext({ baseURL: process.env.PW_BASE_URL || "http://localhost:4551" });
  try {
    const b = await account(otherContext);
    const p1 = await a.production("Harbour"), p2 = `prod_dunes_${Date.now().toString(36)}`;
    const planted = await tenantOf(a.workspace.id);
    try { await planted.execute({ sql: "INSERT INTO projects(id,name,description,created_at) VALUES(?,?,'',?)", args: [p2, "Dunes", Date.now()] }); }
    finally { planted.close(); }
    const brand = await a.add({ kind: "brand", text: "Teal and sand." });
    expect(brand.status(), await brand.text()).toBe(201);
    const brandId = ((await brand.json()) as { entry: Entry }).entry.id;
    const audience = ((await (await a.add({ kind: "audience", text: "Night riders.", projectId: p1 })).json()) as { entry: Entry }).entry;
    await a.add({ kind: "note", text: "Dunes at golden hour only.", projectId: p2 });

    expect((await a.list(p1)).map((e) => e.text).sort()).toEqual(["Night riders.", "Teal and sand."]);
    expect((await a.list(p2)).map((e) => e.text).sort()).toEqual(["Dunes at golden hour only.", "Teal and sand."]);
    expect((await a.list()).map((e) => e.text)).toEqual(["Teal and sand."]);

    /* The other workspace sees none of it and can change none of it — even by id, even naming the project. */
    expect(await b.list()).toEqual([]);
    expect(await b.list(p1)).toEqual([]);
    expect((await otherContext.patch(`/api/atomik/memory/${brandId}`, { headers: b.headers, data: { text: "Hijacked" } })).status()).toBe(404);
    expect((await otherContext.delete(`/api/atomik/memory/${brandId}`, { headers: b.headers })).status()).toBe(404);
    const reached = await otherContext.post("/api/atomik/memory", { headers: b.headers, data: { action: "forget", ids: [brandId, audience.id] } });
    expect(await reached.json()).toEqual({ forgotten: 0 });
    expect((await b.add({ kind: "audience", text: "Their project", projectId: p1 })).status()).toBe(404);
    expect((await a.list(p1)).map((e) => e.text).sort()).toEqual(["Night riders.", "Teal and sand."]);

    /* A write needs the workspace scope the page was drawn with; money is refused; a malformed id is refused. */
    expect((await request.post("/api/atomik/memory", { data: { action: "add", kind: "note", text: "No scope" } })).status()).toBe(409);
    const money = await a.add({ kind: "note", text: "We have 400 credits left in the wallet." });
    expect(money.status()).toBe(422);
    expect(((await money.json()) as { error: string }).error).toContain("Amounts can't be remembered");
    expect(((await money.json()) as { error: string }).error).toContain("Take out “400 credits”");
    expect((await request.delete("/api/atomik/memory/..%2Fprojects", { headers: a.headers })).status()).toBeGreaterThanOrEqual(400);

    /* Forget archives the whole row in the workspace's own database; nothing is erased. */
    const forgot = await request.delete(`/api/atomik/memory/${audience.id}`, { headers: a.headers });
    expect(await forgot.json()).toEqual({ forgotten: 1 });
    expect((await a.list(p1)).map((e) => e.text)).toEqual(["Teal and sand."]);
    const tenant = await tenantOf(a.workspace.id);
    try {
      const kept = await tenant.execute({ sql: "SELECT reason, body FROM archived_rows WHERE table_name='atomik_memory' AND row_id=?", args: [audience.id] });
      expect(kept.rows).toHaveLength(1);
      expect(String(kept.rows[0].reason)).toBe("forgotten");
      expect(JSON.parse(String(kept.rows[0].body))).toMatchObject({ workspace_id: a.workspace.id, id: audience.id, text: "Night riders.", project_id: p1 });
      expect(Number((await tenant.execute({ sql: "SELECT COUNT(*) AS n FROM atomik_memory WHERE workspace_id <> ?", args: [a.workspace.id] })).rows[0].n)).toBe(0);
    } finally { tenant.close(); }

    /* A paste waits for review; "forget …" finds without archiving. */
    const imported = await request.post("/api/atomik/memory", { headers: a.headers, data: { action: "import", from: "chatgpt", text: "- Brand colours are teal\n- Pays $20/month for Plus\n- Audience: teenagers" } });
    expect(imported.status()).toBe(201);
    const made = (await imported.json()) as { entries: Entry[]; skipped: { money: number } };
    expect(made.entries.map((e) => e.status)).toEqual(["proposed", "proposed"]);
    expect(made.skipped.money).toBe(1);
    const found = (await (await request.post("/api/atomik/memory", { headers: a.headers, data: { action: "find", text: "Forget the teal and sand", projectId: p1 } })).json()) as { matches: (Entry & { selected: boolean })[] };
    expect(found.matches.filter((m) => m.selected).map((m) => m.id)).toEqual([brandId]);
    expect((await a.list(p1)).some((e) => e.id === brandId)).toBe(true);
  } finally {
    await otherContext.dispose();
  }
});
