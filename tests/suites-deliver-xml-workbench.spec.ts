import { test, expect } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";



test("export names come from the workspace template for renders in this workspace only", async ({ request }) => {
  const account = await signInLocally(request);
  const { createClient } = await import("@libsql/client");
  const { localPlatformDbUrl } = await import("./helpers/workbenchLocal");
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  const tenantUrl = String((await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id=?", args: [account.workspace.id] })).rows[0].db_url);
  platform.close();
  const tenant = createClient({ url: tenantUrl, timeout: 10_000 });
  const id = `gen_name_${Date.now().toString(36)}`;
  try {
    await tenant.execute({ sql: "INSERT INTO projects(id,name,created_at) VALUES(?,?,?)", args: [`prj_${id}`, "Nike AW26", Date.now()] });
    await tenant.execute({ sql: "INSERT INTO generations(id,project_id,model,prompt,params,status,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)", args: [id, `prj_${id}`, "dreamina-seedance-2-5-260628", "x", "{}", "succeeded", 3, Date.now(), Date.now()] });
  } finally { tenant.close(); }
  const answer = await request.post("/api/workbench/export-names", { data: { generationIds: [id, "gen_not_here", "../bad"] } });
  expect(answer.ok(), await answer.text()).toBe(true);
  const { names } = await answer.json();
  expect(names[id]).toMatch(/^NikeAW26_.*v3/);
  expect(names[id]).not.toMatch(/\.[a-z0-9]+$/);
  expect(Object.keys(names).sort()).toEqual([id, "gen_not_here"].sort());
  expect(names["gen_not_here"]).toBe("gen_not_here");
});
