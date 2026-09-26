import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";
import { mergeTreatment, unionNotes, type TreatmentDoc } from "../../lib/treatmentMerge";

/**
 * Two people on one treatment (audit, 25 September): a save made against a
 * stale copy is refused instead of replacing a teammate's scenes and notes,
 * the page merges both, and where both changed the same words the other copy
 * is kept as an earlier draft. Nothing is lost either way.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-treatment-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

const scene = (n: number, prose: string) => ({ n, title: `Scene ${n}`, secs: 5, prose });
const note = (id: string, text: string, at: number) => ({ id, by: "A", scene: 1, text, at });
const base: TreatmentDoc = { title: "Dawn", logline: "A kitchen.", setup: { mood: "calm" }, scenes: [scene(1, "Kettle."), scene(2, "Door.")], notes: [note("n1", "Warmer.", 1)] };

test("a merge keeps what each side changed, and every note either side kept", () => {
  const mine: TreatmentDoc = { ...base, logline: "A kitchen at dawn.", scenes: [scene(1, "Kettle hisses."), scene(2, "Door.")], notes: [note("n2", "Mine.", 3), ...base.notes] };
  const theirs: TreatmentDoc = { ...base, title: "Dawn II", setup: { mood: "calm", light: "low" }, scenes: [scene(1, "Kettle."), scene(2, "Door opens.")], notes: [note("n3", "Theirs.", 2), ...base.notes] };
  const { doc, keptTheirs } = mergeTreatment(base, mine, theirs);
  expect(keptTheirs).toBe(false);
  expect(doc.title).toBe("Dawn II");
  expect(doc.logline).toBe("A kitchen at dawn.");
  expect(doc.setup).toEqual({ mood: "calm", light: "low" });
  expect(doc.scenes.map((s) => s.prose)).toEqual(["Kettle hisses.", "Door opens."]);
  expect(doc.notes.map((n) => n.id)).toEqual(["n2", "n3", "n1"]);
});

test("a note removed on screen stays removed; one added elsewhere is never dropped", () => {
  const mine: TreatmentDoc = { ...base, notes: [] };
  const theirs: TreatmentDoc = { ...base, notes: [note("n9", "Added elsewhere.", 9), ...base.notes] };
  expect(mergeTreatment(base, mine, theirs).doc.notes.map((n) => n.id)).toEqual(["n9"]);
  expect(unionNotes([note("a", "x", 1)], [note("a", "y", 2), note("b", "z", 3)]).map((n) => n.id)).toEqual(["b", "a"]);
});

test("when both change the same words, the screen stands and theirs is to be kept as a draft", () => {
  const same = mergeTreatment(base, { ...base, scenes: [scene(1, "Mine."), base.scenes[1]] }, { ...base, scenes: [scene(1, "Theirs."), base.scenes[1]] });
  expect(same.keptTheirs).toBe(true);
  expect(same.doc.scenes[0].prose).toBe("Mine.");
  const shape = mergeTreatment(base, { ...base, scenes: [base.scenes[0]] }, { ...base, scenes: [...base.scenes, scene(3, "New.")] });
  expect(shape.keptTheirs).toBe(true);
  expect(shape.doc.scenes).toHaveLength(1);
  expect(mergeTreatment(base, { ...base, title: "A" }, { ...base, title: "B" }).keptTheirs).toBe(true);
  expect(mergeTreatment(base, { ...base, title: "A" }, { ...base, title: "A" }).keptTheirs).toBe(false);
});

test("a save against a stale copy is refused with the current one; keep-both files the other as a draft", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const ws = { id: "trt", name: "trt", slug: "trt", legacy: false, dbUrl: `file:${path.join(dir, "trt.db")}`, dbToken: null, keys: {}, usesPlatformKeys: false } as TenantWorkspace;
  await runInTenant(ws, async () => {
    const { upsertTreatment, getTreatment, listTreatmentVersions, getTreatmentVersion, TreatmentConflict } = await import("../../lib/atomikDocs");
    const { db, ready } = await import("../../lib/db");
    await ready();
    await db().execute({ sql: `INSERT INTO projects (id, name, created_at) VALUES ('p','Dawn',0)` });
    const save = (doc: TreatmentDoc, expectedUpdatedAt: number | null | undefined, extra: { bump?: boolean; onConflict?: "keep" } = {}) =>
      upsertTreatment({ projectId: "p", ...doc, updatedBy: "A", expectedUpdatedAt, ...extra });

    const first = await save(base, null);
    // Tab A and tab B both loaded `first`. B saves first.
    const b = await save({ ...base, notes: [note("nb", "B's note.", 5), ...base.notes] }, first.updatedAt);
    expect(b.updatedAt).toBeGreaterThan(first.updatedAt);
    // A's autosave from the stale copy is refused, and nothing of B's is lost.
    const refused = await save({ ...base, scenes: [scene(1, "A rewrote it.")] }, first.updatedAt).catch((error) => error);
    expect(refused).toBeInstanceOf(TreatmentConflict);
    expect(refused.current.updatedAt).toBe(b.updatedAt);
    expect((await getTreatment("p"))!.notes.map((n) => n.id)).toContain("nb");
    // A save that names no version at all is refused too.
    await expect(save(base, undefined)).rejects.toBeInstanceOf(TreatmentConflict);
    // The page's merge, saved against the current version, lands with both.
    const merged = mergeTreatment(base, { ...base, scenes: [scene(1, "A rewrote it.")] }, b);
    const landed = await save(merged.doc, b.updatedAt, { bump: merged.keptTheirs });
    expect(landed.notes.map((n) => n.id)).toEqual(["nb", "n1"]);
    expect(landed.scenes.map((s) => s.prose)).toEqual(["A rewrote it."]);

    // The closing save cannot merge: theirs becomes an earlier draft and the notes of both are kept.
    const closing = await save({ ...base, title: "Closing tab", notes: [note("nc", "Closing note.", 7)] }, first.updatedAt, { onConflict: "keep" });
    expect(closing.title).toBe("Closing tab");
    expect(closing.draft).toBe(landed.draft + 1);
    expect(closing.notes.map((n) => n.id).sort()).toEqual(["n1", "nb", "nc"]);
    const kept = await getTreatmentVersion("p", landed.draft);
    expect(kept?.scenes.map((s) => s.prose)).toEqual(["A rewrote it."]);
    expect((await listTreatmentVersions("p")).map((v) => v.version)).toContain(landed.draft);
  });
});
