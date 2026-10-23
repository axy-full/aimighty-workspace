import { test, expect } from "@playwright/test";
import { createClient } from "@libsql/client";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** The one-time freeze of a pre-metering take (freezeEstimatesSql) must agree with the meter's JavaScript, row by row. A reader never computes it: billedCreditsExpr reads a receipt or the frozen figure. */
test("the SQL rounding agrees with the meter", async () => {
  const { billedCreditsSum, freezeEstimatesSql } = await import("../../lib/creditSql");
  const { billCredits, marginKeyOf } = await import("../../lib/creditTerms");
  const dir = mkdtempSync(path.join(tmpdir(), "particl-sql-"));
  const c = createClient({ url: `file:${path.join(dir, "t.db")}` });
  await c.execute(`CREATE TABLE credit_receipts(event_id TEXT PRIMARY KEY, credits REAL, revision INTEGER)`);
  await c.execute(`CREATE TABLE estimated_credits(gen_id TEXT PRIMARY KEY, credits INTEGER NOT NULL, frozen_at INTEGER NOT NULL)`);
  await c.execute(`CREATE TABLE generations (id TEXT, kind TEXT, model TEXT, cost_usd REAL, refine_cost_usd REAL)`);
  const rows: [string, string, string, number, number | null][] = [
    ["a", "video", "dreamina-seedance-2-5-260628", 2.864, 0.002],
    ["b", "video", "fal-ai/kling-video/v3/standard", 0.42, null],
    ["c", "image", "gemini-3-pro-image", 0.134, null],
    ["d", "audio", "eleven_v3", 0.036, null],
    ["e", "video", "dreamina-seedance-2-0-260128", 0, null],
    ["f", "video", "unknown-engine", 1, 0],
    ["g", "image", "gemini-3-pro-image", 0.1, null],
    ["h", "video", "dreamina-seedance-2-5-260628", 1.0, null],
  ];
  for (const r of rows) await c.execute({ sql: "INSERT INTO generations VALUES (?,?,?,?,?)", args: r });
  const rs = await c.execute(`SELECT COALESCE(SUM(${freezeEstimatesSql()}), 0) AS credits FROM generations`);
  const expected = rows.reduce((a, r) => a + billCredits(r[3] + (r[4] ?? 0), marginKeyOf(r[1], r[2])), 0);
  expect(Number((rs.rows[0] as Record<string, unknown>).credits)).toBe(expected);
  expect(expected).toBeGreaterThan(0);
  const rs2 = await c.execute(`SELECT COALESCE(SUM(${freezeEstimatesSql("g")}), 0) AS credits FROM generations g WHERE g.kind = 'audio'`);
  expect(Number((rs2.rows[0] as Record<string, unknown>).credits)).toBe(billCredits(0.036, "elevenlabs"));
});

test("a reader reads the receipt, else the frozen figure, else 0: never a figure worked out from today's margins, so a change to the margin table reprices nothing", async () => {
  const { billedCreditsSum, billedCreditsExpr, freezeEstimatesSql } = await import("../../lib/creditSql");
  const dir = mkdtempSync(path.join(tmpdir(), "particl-sql-frozen-"));
  const c = createClient({ url: `file:${path.join(dir, "t.db")}` });
  await c.execute(`CREATE TABLE credit_receipts(event_id TEXT PRIMARY KEY, credits REAL, revision INTEGER)`);
  await c.execute(`CREATE TABLE estimated_credits(gen_id TEXT PRIMARY KEY, credits INTEGER NOT NULL, frozen_at INTEGER NOT NULL)`);
  await c.execute(`CREATE TABLE generations (id TEXT, kind TEXT, model TEXT, cost_usd REAL, refine_cost_usd REAL)`);
  for (const r of [["metered", "video", "dreamina-seedance-2-5-260628", 1], ["old", "video", "dreamina-seedance-2-5-260628", 2], ["newer", "video", "dreamina-seedance-2-5-260628", 3]])
    await c.execute({ sql: "INSERT INTO generations VALUES (?,?,?,?,NULL)", args: r });
  await c.execute("INSERT INTO credit_receipts VALUES ('metered', 11, 1)");
  /* Freeze the old take as the one-time fill does, at today's margins, for that take only. */
  await c.execute(`INSERT INTO estimated_credits SELECT g.id, CAST(${freezeEstimatesSql("g")} AS INTEGER), 1 FROM generations g WHERE g.id = 'old'`);
  const frozen = Number((await c.execute("SELECT credits FROM estimated_credits WHERE gen_id='old'")).rows[0].credits);
  expect(frozen).toBeGreaterThan(0);
  const read = async () => Object.fromEntries((await c.execute(`SELECT g.id, ${billedCreditsExpr("g")} AS credits FROM generations g`)).rows.map((r) => [String(r.id), Number(r.credits)]));
  expect(await read()).toEqual({ metered: 11, old: frozen, newer: 0 });
  /* Nothing a reader runs can reach a margin or a cost: its SQL names the receipt and the frozen figure only, so a change to the margin table (CREDIT_MARGINS) moves no figure it returns. */
  for (const alias of ["", "g"]) {
    const sql = billedCreditsExpr(alias);
    expect(sql).toContain("credit_receipts");
    expect(sql).toContain("estimated_credits");
    expect(sql).not.toMatch(/cost_usd|refine_cost|CASE|\b0\.1\b|model/i);
  }
  expect(Number((await c.execute(`SELECT ${billedCreditsSum("g")} AS total FROM generations g`)).rows[0].total)).toBe(11 + frozen);
});
