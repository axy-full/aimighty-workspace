import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/* A throwaway platform and workspace database; nothing here reaches a vendor. */
const dir = mkdtempSync(path.join(tmpdir(), "particl-app-pages-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.CREDIT_USD = "0.10";
process.env.ENGINE_MOCK = "1";

const workspace = (id: string, own = false) => ({
  id, slug: id, name: id, legacy: false, dbUrl: process.env.TURSO_DATABASE_URL, dbToken: null,
  keys: own ? { openai: "own", gateway: "own" } : {}, usesPlatformKeys: !own, allowanceUsd: null, gatewayKeyId: null, ownerId: "u", createdAt: 0,
  suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null,
});

test("a board write from a stale revision is refused with the board as it stands; a current one lands", async () => {
  const { createBoard, getBoard, saveBoard, saveBoardIfCurrent } = await import("../../lib/boards");
  const { runInTenant } = await import("../../lib/tenant");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ws = workspace("ws_boards") as any;
  await runInTenant(ws, async () => {
    const board = await createBoard("proj_1", "Board");
    const note = (id: string) => ({ id, kind: "note", x: 0, y: 0, label: id, text: id, ports: [], inputs: [], settings: {}, state: "idle", credits: 0, staleSince: null, output: null });
    /* Mine, from the loaded revision: lands, and moves the revision on. */
    const mine = await saveBoardIfCurrent(board.id, { nodes: [note("a")] as never, wires: [] }, board.updatedAt);
    expect(mine && "board" in mine).toBe(true);
    const after = (mine as { board: { updatedAt: number; nodes: unknown[] } }).board;
    expect(after.updatedAt).toBeGreaterThan(board.updatedAt);
    /* A teammate still on the loaded revision is refused, and gets what is there. */
    const theirs = await saveBoardIfCurrent(board.id, { nodes: [note("b")] as never, wires: [] }, board.updatedAt);
    expect(theirs && "conflict" in theirs).toBe(true);
    expect(((theirs as { conflict: { nodes: { id: string }[] } }).conflict.nodes).map((n) => n.id)).toEqual(["a"]);
    expect((await getBoard(board.id))!.nodes.map((n) => n.id)).toEqual(["a"]);
    /* From the new revision it lands. */
    const next = await saveBoardIfCurrent(board.id, { nodes: [note("a"), note("c")] as never, wires: [] }, after.updatedAt);
    expect(next && "board" in next).toBe(true);
    /* A write that names no revision behaves as it always did. */
    expect((await saveBoard(board.id, { name: "Renamed" }))!.name).toBe("Renamed");
    expect(await saveBoardIfCurrent("brd_missing", { nodes: [] }, 1)).toBeNull();
  });
});

test("a finished text run on credits reports the credits the ledger billed; on own keys, its dollars", async () => {
  const { meter } = await import("../../lib/meter");
  const { textRunCost } = await import("../../lib/textRunCost");
  const { billCredits } = await import("../../lib/creditTerms");
  const { runInTenant } = await import("../../lib/tenant");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const credits = workspace("ws_text") as any, own = { ...workspace("ws_text_own", true), usesPlatformKeys: false } as any;
  await runInTenant(credits, () => meter({ id: "text_1", kind: "text", engine: "vercel", model: "anthropic/claude-sonnet-4.5", status: "succeeded", engineCostUsd: 0.12 }));
  const billed = await runInTenant(credits, () => textRunCost({ id: "text_1", costUsd: 0.12 }));
  expect(billed).toEqual({ credits: billCredits(0.12, "text") });
  /* Not settled on the ledger: nothing is claimed. */
  expect(await runInTenant(credits, () => textRunCost({ id: "text_unmetered", costUsd: 0.12 }))).toEqual({ credits: null });
  expect(await runInTenant(own, () => textRunCost({ id: "text_2", costUsd: 0.12 }))).toEqual({ costUsd: 0.12 });
});
