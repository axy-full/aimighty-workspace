import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { seedProject } from "../../lib/workbench/studio";
import {
  captureEdit,
  applyEdit,
  validateBins,
} from "../../lib/workbench/editorial";
import { runInTenant, type TenantWorkspace } from "../../lib/tenant";
const dir = mkdtempSync(path.join(tmpdir(), "particl-edit-history-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "local-editorial-unit-keyring";
const workspace = (id: string) =>
  ({
    id: "edit-" + id,
    slug: id,
    name: id,
    legacy: true,
    dbUrl: `file:${path.join(dir, id + ".db")}`,
    dbToken: null,
    keys: {},
    usesPlatformKeys: false,
    ownerId: "owner",
    createdAt: 0,
  }) as TenantWorkspace;

test("saved cuts freeze selected lineage and restore only editorial decisions", () => {
  const original = {
    ...seedProject(),
    bins: [{ id: "bin", name: "Selects", assetIds: ["hero"] }],
  };
  const edit = captureEdit(original);
  expect(edit.clipAudio).toBe(true);
  expect(edit.assets.map((a) => a.id).sort()).toEqual([
    "character",
    "environment",
    "hero",
  ]);
  original.shots[0].duration = 240;
  expect(edit.shots[0].duration).toBe(96);
  const changed = {
    ...original,
    brief: "A newer brief",
    nodes: [],
    assets: original.assets.filter((a) => a.id !== "character"),
    clipAudio: false,
  };
  const restored = applyEdit(changed, edit);
  expect(restored.brief).toBe("A newer brief");
  expect(restored.nodes).toEqual([]);
  expect(restored.bins).toEqual(original.bins);
  expect(restored.shots[0].duration).toBe(96);
  expect(restored.assets.some((a) => a.id === "character")).toBe(true);
  expect(restored.clipAudio).toBe(true);
  expect(() =>
    applyEdit(
      {
        ...changed,
        assets: changed.assets.map((a) =>
          a.id === "hero" ? { ...a, url: "/campaign/different.webp" } : a,
        ),
      },
      edit,
    ),
  ).toThrow(/source identity changed/);
  expect(() =>
    captureEdit({
      ...original,
      assets: original.assets.filter((a) => a.id !== "character"),
    }),
  ).toThrow(/reference is missing/);
});

test("bins validate membership and names before the private draft can save", async () => {
  const { saveSchema } = await import("../../lib/workbench/studio-schema");
  const project = {
    ...seedProject(),
    bins: [{ id: "b1", name: "Selects", assetIds: ["hero"] }],
  };
  expect(saveSchema.safeParse({ project, revision: 0 }).success).toBe(true);
  expect(() =>
    validateBins({
      ...project,
      bins: [...project.bins, { id: "b2", name: "selects", assetIds: [] }],
    }),
  ).toThrow(/unique/);
  for (const ids of [["hero", "hero"], ["missing"]])
    expect(
      saveSchema.safeParse({
        project: {
          ...project,
          bins: [{ id: "bin", name: "Selects", assetIds: ids }],
        },
        revision: 0,
      }).success,
    ).toBe(false);
});

test("retained cuts restore explicit sound and color settings without retaining later changes", () => {
  const p = seedProject();
  p.assets.push({
    ...p.assets[0],
    id: "score",
    kind: "audio",
    url: "/campaign/score.wav",
    refs: [],
  });
  p.audioClips = [
    {
      id: "music",
      assetId: "score",
      lane: "music",
      startFrame: 24,
      sourceIn: 12,
      duration: 72,
      gainDb: -7,
      pan: -0.2,
      fadeIn: 12,
      fadeOut: 24,
      muted: false,
      solo: true,
    },
  ];
  p.colorGrade = {
    mix: 0.6,
    brightness: 1.1,
    contrast: 0.9,
    saturation: 0.8,
    bypassed: false,
  };
  p.clipAudio = false;
  const saved = captureEdit(p);
  p.audioClips[0].gainDb = 3;
  p.colorGrade.bypassed = true;
  const restored = applyEdit(p, saved);
  expect(restored.audioClips?.[0]).toMatchObject({
    gainDb: -7,
    pan: -0.2,
    fadeIn: 12,
    fadeOut: 24,
    solo: true,
    startFrame: 24,
    sourceIn: 12,
  });
  expect(restored.colorGrade).toEqual({
    mix: 0.6,
    brightness: 1.1,
    contrast: 0.9,
    saturation: 0.8,
    bypassed: false,
  });
  expect(restored.clipAudio).toBe(false);
});

test("named versions are private, immutable, idempotent and bound to the actual saved revision", async () => {
  const { saveDraft, readDraft } = await import("../../lib/workbench/records");
  const { saveEditVersion, readEditVersion, listEditVersions } =
    await import("../../lib/workbench/edit-versions");
  const { db } = await import("../../lib/db");
  const id = "request-original-1234";
  await runInTenant(workspace("private"), async () => {
    const p = seedProject();
    await saveDraft("alice", p, 0);
    const results = await Promise.all([
      saveEditVersion("alice", p.id, id, "Director cut", 1),
      saveEditVersion("alice", p.id, id, "Director cut", 1),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(await listEditVersions("alice", p.id)).toHaveLength(1);
    expect(await readEditVersion("bob", p.id, id)).toBeNull();
    expect(await readEditVersion("alice", "another-draft", id)).toBeNull();
    await expect(
      saveEditVersion("bob", p.id, "request-foreign-1234", "Foreign", 1),
    ).rejects.toThrow(/Save your production/);
    const current = (await readDraft("alice", p.id))!;
    await saveDraft(
      "alice",
      { ...current.project, shots: [{ ...p.shots[0], duration: 300 }] },
      1,
    );
    expect(
      (await readEditVersion("alice", p.id, id))!.edit.shots[0].duration,
    ).toBe(96);
    await expect(
      saveEditVersion("alice", p.id, "request-stale-1234", "Stale", 1),
    ).rejects.toThrow(/another window/);
    await expect(
      saveEditVersion("alice", p.id, id, "Changed label", 1),
    ).rejects.toThrow(/already belongs/);
    await db().execute({
      sql: "UPDATE workbench_edit_versions SET body='{}' WHERE owner=? AND id=?",
      args: ["alice", id],
    });
    await expect(readEditVersion("alice", p.id, id)).rejects.toThrow(
      /integrity/,
    );
  });
  await runInTenant(workspace("other"), async () =>
    expect(await readEditVersion("alice", seedProject().id, id)).toBeNull(),
  );
});

test("retained source bindings survive removal from the current draft and roll back with a failed version", async () => {
  const { saveDraft, readDraft } = await import("../../lib/workbench/records");
  const { saveEditVersion } = await import("../../lib/workbench/edit-versions");
  const { db } = await import("../../lib/db");
  const { mediaBindingProblem } = await import("../../lib/mediaBindings");
  await runInTenant(workspace("retained-media"), async () => {
    await import("../../lib/workbench/records").then((m) => m.workbenchReady());
    await db().execute(
      "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,created_at) VALUES('upl_edit','source.png','image/png','png',1,'hash','local',0)",
    );
    const p = {
      ...seedProject(),
      assets: [
        {
          ...seedProject().assets[0],
          id: "source",
          uploadId: "upl_edit",
          url: "/api/uploads/upl_edit",
          refs: [],
        },
      ],
      shots: [{ ...seedProject().shots[0], assetId: "source" }],
      nodes: [],
      sharedAssets: [],
      sharedNodes: [],
      sharedAssetIds: [],
      sharedNodeIds: [],
    };
    await saveDraft("alice", p, 0);
    await db().execute(
      "CREATE TRIGGER refuse_edit_refs BEFORE INSERT ON workbench_edit_sources BEGIN SELECT RAISE(ABORT,'simulated source-index failure'); END",
    );
    await expect(
      saveEditVersion("alice", p.id, "request-rollback-1234", "Cut", 1),
    ).rejects.toThrow(/source-index/);
    expect(
      Number(
        (
          await db().execute(
            "SELECT COUNT(*) AS n FROM workbench_edit_versions",
          )
        ).rows[0].n,
      ),
    ).toBe(0);
    await db().execute("DROP TRIGGER refuse_edit_refs");
    await saveEditVersion("alice", p.id, "request-rollback-1234", "Cut", 1);
    const current = (await readDraft("alice", p.id))!;
    await saveDraft("alice", { ...current.project, assets: [], shots: [] }, 1);
    const tx = await db().transaction("write");
    try {
      expect(await mediaBindingProblem(tx, "upload", "upl_edit")).toMatch(
        /retained by an edit version/,
      );
      await tx.rollback();
    } finally {
      tx.close();
    }
  });
});

test("concurrent saves honor the retained-version ceiling without losing existing cuts", async () => {
  const { saveDraft } = await import("../../lib/workbench/records");
  const { saveEditVersion, listEditVersions } =
    await import("../../lib/workbench/edit-versions");
  const { db } = await import("../../lib/db");
  await runInTenant(workspace("capacity"), async () => {
    const p = seedProject();
    await saveDraft("alice", p, 0);
    await saveEditVersion("alice", p.id, "request-first-1234", "First", 1);
    for (let i = 1; i < 49; i++)
      await db().execute({
        sql: "INSERT INTO workbench_edit_versions SELECT owner,draft_id,?,label,source_revision,created_at,shots,frames,fps,sha256,body FROM workbench_edit_versions WHERE id=?",
        args: ["fill-" + i, "request-first-1234"],
      });
    const result = await Promise.allSettled([
      saveEditVersion("alice", p.id, "request-race-a-1234", "A", 1),
      saveEditVersion("alice", p.id, "request-race-b-1234", "B", 1),
    ]);
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await listEditVersions("alice", p.id)).toHaveLength(50);
  });
});
