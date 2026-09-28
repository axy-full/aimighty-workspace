import { test, expect } from "@playwright/test";
import { createClient } from "@libsql/client";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setCreditUsd } from "../helpers/creditRate";

/** The ledger's SQL sum must agree with the meter's JavaScript, row by row. */
test("the SQL rounding agrees with the meter", async () => {
  const { billedCreditsSum } = await import("../../lib/creditSql");
  const { marginFor, marginKeyOf } = await import("../../lib/creditTerms");
  const { legacyBilledCredits } = await import("../../lib/creditUnits");
  /* Takes that predate metering keep the terms they were made at — whole
     credits at US$0.10 — whatever CREDIT_USD or the rounding is now (lib/creditSql.ts). */
  const historical = (usd: number, key: string) => legacyBilledCredits(usd, marginFor(key));
  const dir = mkdtempSync(path.join(tmpdir(), "particl-sql-"));
  const c = createClient({ url: `file:${path.join(dir, "t.db")}` });
  await c.execute(`CREATE TABLE credit_receipts(event_id TEXT PRIMARY KEY, credits REAL, revision INTEGER)`);
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
  const rs = await c.execute(`SELECT ${billedCreditsSum()} AS credits FROM generations`);
  const expected = rows.reduce((a, r) => a + historical(r[3] + (r[4] ?? 0), marginKeyOf(r[1], r[2])), 0);
  expect(Number((rs.rows[0] as Record<string, unknown>).credits)).toBe(expected);
  expect(expected).toBeGreaterThan(0);
  /* And a different price for a credit today does not reprice them. */
  const before = process.env.CREDIT_USD;
  try {
    setCreditUsd("0.25");
    const again = await c.execute(`SELECT ${billedCreditsSum()} AS credits FROM generations`);
    expect(Number((again.rows[0] as Record<string, unknown>).credits)).toBe(expected);
  } finally { setCreditUsd(before); }
  const rs2 = await c.execute(`SELECT ${billedCreditsSum("g")} AS credits FROM generations g WHERE g.kind = 'audio'`);
  expect(Number((rs2.rows[0] as Record<string, unknown>).credits)).toBe(historical(0.036, "elevenlabs"));
});
