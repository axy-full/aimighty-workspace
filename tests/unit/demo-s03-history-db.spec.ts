import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";
import type { CanvasNode } from "../../lib/workbench/studio";

/* Stream 3 · the board's History read (team-canvas GET `history=1`): this workspace's people only, newest first, read only. */

const dir = mkdtempSync(path.join(tmpdir(), "particl-board-history-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
delete process.env.LIVEBLOCKS_SECRET_KEY;

const workspace = (name: string): TenantWorkspace => ({ id: "ws_" + name, slug: name, name, legacy: true, dbUrl: `file:${path.join(dir, name + ".db")}`, dbToken: null, keys: {}, usesPlatformKeys: false, allowanceUsd: null, gatewayKeyId: null, ownerId: "owner", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null });
const scene = (id: string, title: string): CanvasNode => ({ id, title, type: "scene", x: 0, y: 0, width: 238, linked: [] });

test("History reads the canvas's changes with this workspace's names, newest first, and creates nothing", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { applyCanvasOps } = await import("../../lib/workbench/canvas-ops");
  const { boardHistory } = await import("../../lib/board/history.server");
  await runInTenant(workspace("history-read"), async () => {
    await ready();
    await db().execute("INSERT INTO projects(id,name,created_at) VALUES('prod-1','Team',0)");
    /* Never made a server change: nothing to read, and reading made no log. */
    expect(await boardHistory("prod-1")).toEqual([]);
    expect((await db().execute("SELECT 1 FROM sqlite_master WHERE name='rig_canvas_ops'")).rows).toHaveLength(0);
    await db().execute("INSERT INTO users(id,email,name,password_hash,created_at) VALUES('u1','a@example.test','Rowan Field','x',0)");
    await applyCanvasOps("prod-1", { opId: "h-1", ops: [{ kind: "create", node: scene("s1", "Wide") }], author: "u1" }, { room: null });
    await applyCanvasOps("prod-1", { opId: "h-2", ops: [{ kind: "create", node: scene("s2", "Close") }], author: "agent:run-1", runId: "run-1", what: "agent" }, { room: null });
    await applyCanvasOps("prod-1", { opId: "h-3", ops: [{ kind: "create", node: scene("s3", "Stranger") }], author: "u-elsewhere" }, { room: null });
    const entries = await boardHistory("prod-1");
    expect(entries.map((e) => [e.who.kind, e.who.initials, e.text, e.card])).toEqual([
      ["atomik", "AT", "Built on the board · 1 card", "s2"],
      ["person", "RF", "Added Wide", "s1"],
    ]);
    /* Another production's changes are not in it; nothing but words, a time and a card reaches the page. */
    expect(await boardHistory("prod-other")).toEqual([]);
    expect(Object.keys(entries[0]).sort()).toEqual(["at", "card", "id", "text", "who"]);
  });
});
