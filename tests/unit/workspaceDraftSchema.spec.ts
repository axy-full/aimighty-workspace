import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { newProject, seedProject, type Project } from "../../lib/workbench/studio";
import { projectSchema, saveSchema } from "../../lib/workbench/studio-schema";
import { runInTenant, type TenantWorkspace } from "../../lib/tenant";

const dir = mkdtempSync(path.join(tmpdir(), "particl-ws-shot-schema-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "local-ws-shot-unit-keyring-local-ws-shot";
const workspace = (id: string) => ({ id: "shot-" + id, slug: id, name: id, legacy: true, dbUrl: `file:${path.join(dir, id + ".db")}`,
  dbToken: null, keys: {}, usesPlatformKeys: false, ownerId: "owner", createdAt: 0 }) as TenantWorkspace;

/** A draft as it was stored before the shot fields existed: JSON, every older optional shape. */
function legacyDrafts(): Project[] {
  const seeded = JSON.parse(JSON.stringify(seedProject())) as Project;
  const blank = JSON.parse(JSON.stringify(newProject("Legacy"))) as Project;
  const graph: Project = {
    ...seeded,
    id: "legacy-graph",
    productionProjectId: "prod-1",
    shotMappings: { scene: "shot-1" },
    nodes: [
      ...seeded.nodes,
      { id: "gen", title: "Generate 01", type: "generate", x: 0, y: 0, width: 344, linked: ["look"], role: "DOP", mode: "Video", status: "approved",
        operations: [{ id: "op-1", kind: "direction", enabled: true, values: { note: "Hold." } }],
        versions: [{ id: "v1", label: "Version 1", operations: [], savedAt: "2026-09-01T00:00:00Z" }], collapsed: true, bypassed: false },
    ],
  };
  return [seeded, blank, graph];
}

test("every draft saved before the shot fields loads and saves unchanged", () => {
  for (const draft of legacyDrafts()) {
    const parsed = projectSchema.parse(draft);
    expect(parsed).toEqual(draft);
    for (const node of parsed.nodes) {
      for (const field of ["look", "engine", "durationS", "ratio", "resolution"]) expect(node).not.toHaveProperty(field);
    }
    const saved = saveSchema.safeParse({ project: draft, revision: 4 });
    expect(saved.success, JSON.stringify(saved.error?.issues)).toBe(true);
    expect(saved.data!.project).toEqual(draft);
  }
});

test("shot fields are kept by the schema, not stripped, and bad values are rejected", () => {
  const draft = legacyDrafts()[2];
  const fields = { look: "look", engine: "dreamina-seedance-2-5-260628", durationS: 6, ratio: "16:9", resolution: "720p" };
  const withFields = { ...draft, nodes: draft.nodes.map((n) => (n.id === "scene" ? { ...n, ...fields } : n)) };
  const parsed = saveSchema.parse({ project: withFields, revision: 1 });
  expect(parsed.project.nodes.find((n) => n.id === "scene")).toMatchObject(fields);
  expect(projectSchema.parse({ ...withFields, nodes: withFields.nodes.map((n) => (n.id === "scene" ? { ...n, engine: "fal-ai/kling-video/v3/pro", ratio: "adaptive", resolution: "4k" } : n)) }).nodes[2])
    .toMatchObject({ engine: "fal-ai/kling-video/v3/pro", ratio: "adaptive", resolution: "4k" });
  const bad: Record<string, unknown>[] = [
    { durationS: 0 }, { durationS: 61 }, { durationS: 5.5 }, { durationS: "5" },
    { ratio: "wide" }, { ratio: "16:9; drop" }, { resolution: "720 p" }, { engine: "" }, { engine: "has space" },
    { look: "x".repeat(301) }, { look: 4 },
  ];
  for (const change of bad) {
    const project = { ...draft, nodes: draft.nodes.map((n) => (n.id === "scene" ? { ...n, ...change } : n)) };
    expect(saveSchema.safeParse({ project, revision: 1 }).success, JSON.stringify(change)).toBe(false);
  }
});

test("shot fields persist through the existing revision-checked draft save", async () => {
  const { saveDraft, readDraft } = await import("../../lib/workbench/records");
  const { shotPatch } = await import("../../lib/workspace/shots");
  await runInTenant(workspace("persist"), async () => {
    const p = seedProject();
    await saveDraft("alice", p, 0);
    const loaded = (await readDraft("alice", p.id))!;
    expect(loaded.project.nodes.find((n) => n.id === "scene")).not.toHaveProperty("engine");
    const edited = shotPatch(loaded.project, "scene", { engine: "dreamina-seedance-2-0-260128", durationS: 40, look: "look", note: "Mira enters." });
    const body = saveSchema.parse({ project: edited, revision: loaded.revision });
    await saveDraft("alice", body.project as Project, body.revision);
    const again = (await readDraft("alice", p.id))!;
    expect(again.revision).toBe(loaded.revision + 1);
    expect(again.project.nodes.find((n) => n.id === "scene")).toMatchObject({ engine: "dreamina-seedance-2-0-260128", durationS: 15, look: "look", ratio: "16:9", resolution: "720p" });
    await expect(saveDraft("alice", edited, loaded.revision)).rejects.toThrow(/changed in another window/);
  });
});
