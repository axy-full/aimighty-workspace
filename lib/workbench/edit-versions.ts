import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import {
  workbenchReady,
  workbenchTransaction,
  validateStoredMedia,
} from "./records";
import { captureEdit, type EditSnapshot, type EditVersion } from "./editorial";
import type { Project } from "./studio";
import { referencedMedia } from "@/lib/mediaBindings";

const MAX_VERSIONS = 50,
  MAX_BYTES = 1_000_000;
const digest = (body: string) =>
  createHash("sha256").update(body).digest("hex");
function metadata(row: Record<string, unknown>): EditVersion {
  return {
    id: String(row.id),
    label: String(row.label),
    revision: Number(row.source_revision),
    createdAt: Number(row.created_at),
    shots: Number(row.shots),
    frames: Number(row.frames),
    fps: Number(row.fps),
    hash: String(row.sha256),
  };
}
export async function listEditVersions(
  owner: string,
  draftId: string,
): Promise<EditVersion[]> {
  await workbenchReady();
  return (
    await db().execute({
      sql: "SELECT id,label,source_revision,created_at,shots,frames,fps,sha256 FROM workbench_edit_versions WHERE owner=? AND draft_id=? ORDER BY created_at DESC,id DESC LIMIT 50",
      args: [owner, draftId],
    })
  ).rows.map(metadata);
}
export async function readEditVersion(
  owner: string,
  draftId: string,
  id: string,
) {
  await workbenchReady();
  const row = (
    await db().execute({
      sql: "SELECT * FROM workbench_edit_versions WHERE owner=? AND draft_id=? AND id=?",
      args: [owner, draftId, id],
    })
  ).rows[0];
  if (!row) return null;
  const body = String(row.body);
  if (digest(body) !== row.sha256)
    throw Error(
      "This edit version failed its integrity check. Keep the current edit and contact support.",
    );
  return { version: metadata(row), edit: JSON.parse(body) as EditSnapshot };
}
export async function saveEditVersion(
  owner: string,
  draftId: string,
  id: string,
  label: string,
  revision: number,
): Promise<EditVersion> {
  if (
    !/^[A-Za-z0-9-]{1,100}$/.test(draftId) ||
    !/^[A-Za-z0-9-]{16,100}$/.test(id) ||
    !label.trim() ||
    label.trim().length > 100 ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  )
    throw Error(
      "Choose a saved production, a version name and its current revision.",
    );
  label = label.trim();
  await workbenchReady();
  return workbenchTransaction(async (tx) => {
    const prior = (
      await tx.execute({
        sql: "SELECT * FROM workbench_edit_versions WHERE owner=? AND draft_id=? AND id=?",
        args: [owner, draftId, id],
      })
    ).rows[0];
    if (prior) {
      if (prior.label !== label || Number(prior.source_revision) !== revision)
        throw Error(
          "This version request already belongs to another saved edit. Refresh version history.",
        );
      if (digest(String(prior.body)) !== prior.sha256)
        throw Error("This edit version failed its integrity check.");
      return metadata(prior);
    }
    const draft = (
      await tx.execute({
        sql: "SELECT body,revision FROM workbench_projects WHERE owner=? AND project_id=?",
        args: [owner, draftId],
      })
    ).rows[0];
    if (!draft)
      throw Error("Save your production before saving an edit version.");
    if (Number(draft.revision) !== revision)
      throw Error(
        "The production changed in another window. Refresh its saved revision before naming this cut.",
      );
    const count = Number(
      (
        await tx.execute({
          sql: "SELECT COUNT(*) AS n FROM workbench_edit_versions WHERE owner=? AND draft_id=?",
          args: [owner, draftId],
        })
      ).rows[0].n,
    );
    if (count >= MAX_VERSIONS)
      throw Error(
        "This production has 50 retained edit versions. Export its history before starting a new production.",
      );
    const edit = captureEdit(JSON.parse(String(draft.body)) as Project),
      body = JSON.stringify(edit);
    if (Buffer.byteLength(body) > MAX_BYTES)
      throw Error(
        "This edit version exceeds the 1 MB metadata limit. Reduce oversized source notes or split the edit.",
      );
    await validateStoredMedia(tx, edit);
    const value = {
      id,
      label,
      revision,
      createdAt: Date.now(),
      shots: edit.shots.length,
      frames: edit.shots.reduce((n, s) => n + s.duration, 0),
      fps: edit.fps,
      hash: digest(body),
    };
    await tx.execute({
      sql: "INSERT INTO workbench_edit_versions(owner,draft_id,id,label,source_revision,created_at,shots,frames,fps,sha256,body) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      args: [
        owner,
        draftId,
        id,
        label,
        revision,
        value.createdAt,
        value.shots,
        value.frames,
        value.fps,
        value.hash,
        body,
      ],
    });
    const refs = referencedMedia(edit);
    const statements = [...refs.uploads]
      .map((source) => ["upload", source])
      .concat([...refs.generations].map((source) => ["generation", source]))
      .map(([kind, source]) => ({
        sql: "INSERT INTO workbench_edit_sources(owner,draft_id,version_id,kind,source_id) VALUES(?,?,?,?,?)",
        args: [owner, draftId, id, kind, source],
      }));
    for (let offset = 0; offset < statements.length; offset += 100)
      await tx.batch(statements.slice(offset, offset + 100));
    return value;
  });
}
