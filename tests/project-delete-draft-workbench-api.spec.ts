import { test, expect } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { newProject } from "../lib/workbench/studio";

/**
 * A project deleted from Projects never strands what pointed at it: the
 * Studio draft linked to it keeps saving its edits, and an original filed in
 * its library can be deleted afterwards — the filing is archived with the
 * project, like everything else filed under it, never erased. Through the real
 * routes on a local mock server, with the workspace database read directly.
 */
test("a deleted project's draft still saves, and an original filed in its library can be deleted after", async ({ request }) => {
  const account = await signInLocally(request);
  const me = await request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${account.workspace.id}-${me.id}` };

  const session = randomUUID();
  const chunk = await request.post("/api/uploads/chunk", { headers, multipart: { session, index: "0", chunk: { name: "chunk", mimeType: "application/octet-stream", buffer: await readFile("public/fixtures/still.png") } } });
  expect(chunk.ok(), await chunk.text()).toBe(true);
  const finish = await request.post("/api/uploads/finish", { headers, data: { session, count: 1, filename: "Filed original.png", purpose: "chat" } });
  expect(finish.ok(), await finish.text()).toBe(true);
  const upload = (await finish.json()) as { id: string };

  const project = newProject(`Deleted ${randomUUID().slice(0, 6)}`);
  const created = await request.put("/api/workbench/projects", { headers, data: { project, revision: 0 } });
  expect(created.ok(), await created.text()).toBe(true);
  const { productionProjectId } = (await created.json()) as { productionProjectId: string };
  const filed = await request.post("/api/workbench/library", { headers, data: { projectId: project.id, uploadId: upload.id } });
  expect(filed.ok(), await filed.text()).toBe(true);
  const blocked = await request.delete(`/api/uploads/${upload.id}`, { headers });
  expect(blocked.status()).toBe(409);
  expect((await blocked.json()).error).toContain("filed in a project library");

  const deleted = await request.delete(`/api/projects/${productionProjectId}`, { headers });
  expect(deleted.ok(), await deleted.text()).toBe(true);

  /* The draft keeps saving, still naming the project it was linked to. */
  const read = (await request.get(`/api/workbench/projects?id=${project.id}`, { headers }).then((r) => r.json())) as { project: typeof project; revision: number };
  const saved = await request.put("/api/workbench/projects", { headers, data: { project: { ...read.project, brief: "Written after the project was deleted" }, revision: read.revision } });
  expect(saved.ok(), await saved.text()).toBe(true);
  expect(await saved.json()).toMatchObject({ revision: read.revision + 1, productionProjectId });

  /* The original is no longer held by a filing nobody can remove. */
  const removed = await request.delete(`/api/uploads/${upload.id}`, { headers });
  expect(removed.ok(), await removed.text()).toBe(true);

  const platform = createClient({ url: localPlatformDbUrl() });
  try {
    const dbUrl = String((await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id=?", args: [account.workspace.id] })).rows[0].db_url);
    const tenant = createClient({ url: dbUrl });
    try {
      const archived = await tenant.execute({
        sql: "SELECT json_extract(body,'$.project_id') AS project FROM archived_rows WHERE table_name='project_library_uploads' AND json_extract(body,'$.upload_id')=?",
        args: [upload.id],
      });
      expect(archived.rows.map((row) => String(row.project))).toEqual([productionProjectId]);
    } finally {
      tenant.close();
    }
  } finally {
    platform.close();
  }
});
