import type { Client, Transaction } from "@libsql/client";
import type { TenantWorkspace } from "./tenant";
import { runInTenant } from "./tenant";
import { db, ready } from "./db";
import { billCreditsWith, heldPriceNow, marginFor, marginKeyOf } from "./creditTerms";
import { memoDrop } from "./memo";

/**
 * The credit figures a workspace keeps in its OWN database, restated with the
 * platform's (lib/creditConversion.ts).
 *
 * They cannot share the platform's write, so this half is made safe to run
 * again: everything it changes is changed in one write of the workspace's
 * database, together with a row in `credit_unit_applied` naming the
 * conversion. A second run finds that row and does nothing. The platform's
 * record (`billing_unit_conversions.tenant_applied_at`) is set only after this
 * write commits, so a run that stopped in between is found by that column
 * being empty and finished by running the conversion again; until every
 * workspace's half is in, the ledger's unit is not moved and paid jobs stay
 * paused (lib/ledgerUnit.ts).
 *
 * Every changed row is listed in `credit_unit_rows` with its factor, so a
 * reversal divides exactly what was multiplied.
 *
 * What is converted, and why:
 *  - caps and limits a person set, in credits: the shot cap setting
 *    (`shotCapCredits`), production and project credit caps, API tokens'
 *    monthly credit ceilings, an Atomik run's approved limit, per-job line and
 *    limit history;
 *  - approved figures waiting to be spent: an Atomik step's approved quote and
 *    ceiling (`admission.request.maxCredits`), a pipeline attempt's prepared
 *    ceiling;
 *  - held takes: the price shown on the card (`params.held.needs`) is
 *    re-priced from the held dollars (`estUsd`) at the new price of a credit,
 *    exactly as Release prices it (creditTerms heldPriceNow); a take too old
 *    to carry dollars is multiplied instead;
 *  - display mirrors of what the meter charged or quoted (Atomik and
 *    development jobs, Astra renders, dubbing, take checks, crew sessions,
 *    pipeline runs), so a list and the meter agree;
 *  - archived copies of the rows above (a restore must come back in the
 *    right unit).
 * A pipeline quote not yet approved is expired instead: it lives ten minutes,
 * and asking again at the new price is safer than editing a priced body.
 * Dollars, and vendors' own credits (ElevenLabs, Higgsfield), are never touched.
 */
export type TenantFigure = {
  what: string; id: string; before: number | string; after: number | string;
  /** A cap a person saved: never guessed from a timestamp; kept unless the owner chose ×factor for it. */
  cap?: { id: string; choice: CapChoice };
};
export type CapChoice = "keep" | "x8";

export type TenantPlan = {
  /** The factor for a row given its time (ms), or null when the row has none. */
  factorAt: (ts: number | null) => number;
  conversionId: string;
  dryRun: boolean;
  /** Reverse the rows this conversion recorded instead of choosing rows. */
  reverses?: string | null;
  /** The whole factor (8), for caps the owner chose to multiply. */
  factor?: number;
  /** The owner's choice per cap, keyed `<table>:<id>` (`settings:shotCapCredits`); a cap not named is kept. */
  caps?: Record<string, CapChoice>;
  /** The price held takes are re-priced at (a dry run before CREDIT_USD changes names it); default CREDIT_USD. */
  unitUsd?: number;
};

/** Caps a person saved. Their tables carry no time a cap was set, so the owner decides each one. */
const CAPS: { table: string; key: string; col?: string; json?: string; where?: string }[] = [
  { table: "projects", key: "id", col: "cap_credits" },
  { table: "productions", key: "id", col: "cap_credits" },
  { table: "api_tokens", key: "id", col: "cap_credits" },
  { table: "archived_rows", key: "id", json: "cap_credits", where: "table_name IN ('projects','productions','api_tokens')" },
];

type Spec = { table: string; key: string; ts: string[]; cols: string[]; json?: { col: string; paths: string[] }[]; where?: string };

const SPECS: Spec[] = [
  /* A run's limit is approved by a person at a time on record; patchRun moves updated_at, so it is not used. */
  { table: "rig_agent_runs", key: "id", ts: ["approved_at", "created_at"], cols: ["cap_credits", "per_job_cap"], json: [{ col: "limits", paths: ["[].credits", "[].jobCeiling"] }] },
  { table: "rig_agent_steps", key: "id", ts: ["created_at"], cols: ["quote_credits", "credits_reserved", "credits_settled"],
    json: [{ col: "admission", paths: ["request.maxCredits", "quote.estimatedCredits"] }] },
  { table: "pipeline_attempts", key: "id", ts: ["created_at"], cols: [], json: [{ col: "prepared", paths: ["request.maxCredits", "quote.estimatedCredits"] }] },
  { table: "runs", key: "id", ts: ["started_at", "updated_at"], cols: ["estimate_credits"] },
  { table: "stage_runs", key: "id", ts: ["started_at", "updated_at"], cols: ["estimate_credits", "spent_credits"] },
  { table: "workbench_atomik_jobs", key: "id", ts: ["created_at"], cols: ["estimate_credits", "credits"] },
  { table: "workbench_development_jobs", key: "id", ts: ["created_at"], cols: ["estimate_credits", "credits"] },
  { table: "astra_render_jobs", key: "id", ts: ["created_at"], cols: ["estimate_credits", "billed_credits"] },
  { table: "dubbing_jobs", key: "id", ts: ["created_at"], cols: ["estimate_credits"] },
  { table: "take_verifications", key: "id", ts: ["created_at"], cols: ["credits"] },
  { table: "crew_sessions", key: "id", ts: ["created_at"], cols: ["spend_cr"] },
];

type Exec = Pick<Transaction, "execute">;

async function columnsOf(c: Exec, table: string): Promise<Set<string>> {
  const rs = await c.execute(`PRAGMA table_info(${table})`);
  return new Set(rs.rows.map((r) => String(r.name)));
}

const num = (v: unknown): number | null => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** Multiply one dotted path (`[]` walks an array) inside a parsed JSON value. Returns the figures it changed. */
function scaleJson(value: unknown, path: string[], factor: number, changed: { path: string; before: number; after: number }[], at = ""): void {
  if (!path.length || value == null || typeof value !== "object") return;
  const [head, ...rest] = path;
  if (head === "[]") {
    if (Array.isArray(value)) value.forEach((v, i) => scaleJson(v, rest, factor, changed, `${at}[${i}]`));
    return;
  }
  const obj = value as Record<string, unknown>;
  if (!rest.length) {
    const n = num(obj[head]);
    if (n != null && typeof obj[head] === "number") {
      obj[head] = n * factor;
      changed.push({ path: `${at}.${head}`, before: n, after: n * factor });
    }
    return;
  }
  scaleJson(obj[head], rest, factor, changed, `${at}.${head}`);
}

const splitPath = (p: string) => p.split(".").flatMap((s) => (s.startsWith("[]") ? ["[]", ...(s.length > 2 ? [s.slice(3)] : [])] : [s])).filter(Boolean);

async function tableExists(c: Exec, table: string): Promise<boolean> {
  const rs = await c.execute({ sql: `SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`, args: [table] });
  return rs.rows.length > 0;
}

const ROWS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS credit_unit_applied(conversion_id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS credit_unit_rows(conversion_id TEXT NOT NULL, tbl TEXT NOT NULL, row_key TEXT NOT NULL, factor REAL NOT NULL,
    PRIMARY KEY(conversion_id, tbl, row_key))`,
];

async function work(c: Exec, plan: TenantPlan): Promise<TenantFigure[]> {
  const figures: TenantFigure[] = [];
  const record = async (tbl: string, key: string, factor: number) => {
    if (!plan.dryRun)
      await c.execute({ sql: `INSERT OR REPLACE INTO credit_unit_rows(conversion_id,tbl,row_key,factor) VALUES(?,?,?,?)`, args: [plan.conversionId, tbl, key, factor] });
  };
  /* A reversal divides exactly the rows its conversion multiplied. */
  let recorded: Map<string, number> | null = null;
  if (plan.reverses) {
    recorded = new Map();
    if (await tableExists(c, "credit_unit_rows")) {
      const rs = await c.execute({ sql: `SELECT tbl,row_key,factor FROM credit_unit_rows WHERE conversion_id=?`, args: [plan.reverses] });
      for (const r of rs.rows) recorded.set(`${r.tbl}\u0000${r.row_key}`, 1 / Number(r.factor));
    }
  }
  const factorFor = (tbl: string, key: string, ts: number | null): number =>
    recorded ? (recorded.get(`${tbl}\u0000${key}`) ?? 1) : plan.factorAt(ts);

  /* Caps: listed every time, multiplied only where the owner chose it (or reversed where it was). */
  const capFactor = (capId: string): { f: number; choice: CapChoice } => {
    if (recorded) return { f: recorded.get(capId.replace(":", "\u0000")) ?? 1, choice: recorded.has(capId.replace(":", "\u0000")) ? "x8" : "keep" };
    const choice: CapChoice = plan.caps?.[capId] === "x8" ? "x8" : "keep";
    return { f: choice === "x8" ? (plan.factor ?? 1) : 1, choice };
  };
  if (await tableExists(c, "settings")) {
    const rs = await c.execute(`SELECT value FROM settings WHERE key='shotCapCredits'`);
    for (const r of rs.rows) {
      const n = num(r.value);
      if (n == null) continue;
      const { f, choice } = capFactor("settings:shotCapCredits");
      const after = Math.round(n * f * 1e6) / 1e6;
      figures.push({ what: "settings.shotCapCredits", id: "shotCapCredits", before: n, after, cap: { id: "settings:shotCapCredits", choice } });
      if (f === 1) continue;
      if (!plan.dryRun) await c.execute({ sql: `UPDATE settings SET value=? WHERE key='shotCapCredits'`, args: [String(after)] });
      await record("settings", "shotCapCredits", f);
    }
  }
  for (const cap of CAPS) {
    if (!(await tableExists(c, cap.table))) continue;
    if (cap.col && !(await columnsOf(c, cap.table)).has(cap.col)) continue;
    const value = cap.col ? cap.col : `json_extract(body,'$.${cap.json}')`;
    const rs = await c.execute(`SELECT ${cap.key} AS k, ${value} AS v${cap.json ? ", body" : ""} FROM ${cap.table} WHERE ${value} IS NOT NULL${cap.where ? ` AND ${cap.where}` : ""}`);
    for (const r of rs.rows) {
      const n = num(r.v);
      if (n == null) continue;
      const key = String(r.k);
      const capId = `${cap.table}:${key}`;
      const { f, choice } = capFactor(capId);
      figures.push({ what: `${cap.table}.${cap.col ?? `body.${cap.json}`}`, id: key, before: n, after: n * f, cap: { id: capId, choice } });
      if (f === 1) continue;
      if (!plan.dryRun)
        await c.execute(cap.col
          ? { sql: `UPDATE ${cap.table} SET ${cap.col}=? WHERE ${cap.key}=?`, args: [n * f, key] }
          : { sql: `UPDATE ${cap.table} SET body=json_set(body,'$.${cap.json}',?) WHERE ${cap.key}=?`, args: [n * f, key] });
      await record(cap.table, key, f);
    }
  }

  for (const spec of SPECS) {
    if (!(await tableExists(c, spec.table))) continue;
    const have = await columnsOf(c, spec.table);
    const cols = spec.cols.filter((x) => have.has(x));
    const json = (spec.json ?? []).filter((j) => have.has(j.col));
    if (!cols.length && !json.length) continue;
    const ts = spec.ts.find((x) => have.has(x)) ?? null;
    const select = [spec.key, ...(ts ? [ts] : []), ...cols, ...json.map((j) => j.col)].join(",");
    const rs = await c.execute(`SELECT ${select} FROM ${spec.table}${spec.where ? ` WHERE ${spec.where}` : ""}`);
    for (const r of rs.rows) {
      const key = String(r[spec.key]);
      const f = factorFor(spec.table, key, ts ? num(r[ts]) : null);
      if (f === 1) continue;
      const sets: string[] = [];
      const args: (number | string | null)[] = [];
      for (const col of cols) {
        const n = num(r[col]);
        if (n == null) continue;
        sets.push(`${col}=?`);
        args.push(n * f);
        figures.push({ what: `${spec.table}.${col}`, id: key, before: n, after: n * f });
      }
      for (const j of json) {
        if (r[j.col] == null) continue;
        let parsed: unknown;
        try { parsed = JSON.parse(String(r[j.col])); } catch { continue; }
        const changed: { path: string; before: number; after: number }[] = [];
        for (const p of j.paths) scaleJson(parsed, splitPath(p), f, changed);
        if (!changed.length) continue;
        sets.push(`${j.col}=?`);
        args.push(JSON.stringify(parsed));
        for (const ch of changed) figures.push({ what: `${spec.table}.${j.col}${ch.path}`, id: key, before: ch.before, after: ch.after });
      }
      if (!sets.length) continue;
      if (!plan.dryRun) await c.execute({ sql: `UPDATE ${spec.table} SET ${sets.join(",")} WHERE ${spec.key}=?`, args: [...args, key] });
      await record(spec.table, key, f);
    }
  }

  /* Held takes: the card's price, re-priced from the held dollars as Release will price them. */
  if (await tableExists(c, "generations")) {
    const rs = await c.execute(`SELECT id,kind,model,created_at,json_extract(params,'$.held') AS held FROM generations WHERE status='held' AND json_extract(params,'$.held') IS NOT NULL`);
    for (const r of rs.rows) {
      let held: { estUsd?: unknown; needs?: unknown };
      try { held = JSON.parse(String(r.held)); } catch { continue; }
      const id = String(r.id);
      const needs = num(held.needs);
      if (needs == null) continue;
      const f = factorFor("generations", id, num(r.created_at));
      const est = num(held.estUsd);
      // Forward: priced from its dollars at the new price; a reversal, or a take without dollars, by the factor.
      const after = !recorded && est != null && est > 0
        ? (plan.unitUsd ? billCreditsWith(est, marginFor(marginKeyOf(String(r.kind), String(r.model))), plan.unitUsd)
          : heldPriceNow({ estUsd: est }, String(r.kind), String(r.model)))
        : Math.ceil(needs * f - 1e-9);
      if (after === needs) continue;
      figures.push({ what: "generations.params.held.needs", id, before: needs, after });
      if (!plan.dryRun)
        await c.execute({ sql: `UPDATE generations SET params=json_set(params,'$.held.needs',?) WHERE id=? AND status='held'`, args: [after, id] });
      await record("generations", id, after / needs);
    }
  }

  /* Pipeline quotes not yet approved: expired, to be asked again at the new price. */
  if (!plan.reverses && (await tableExists(c, "pipeline_quotes"))) {
    const at = Date.now();
    const rs = await c.execute({ sql: `SELECT id FROM pipeline_quotes WHERE approved_at IS NULL AND expires_at>?`, args: [at] });
    for (const r of rs.rows) {
      figures.push({ what: "pipeline_quotes (expired, to be re-quoted)", id: String(r.id), before: "open", after: "expired" });
      if (!plan.dryRun) await c.execute({ sql: `UPDATE pipeline_quotes SET expires_at=? WHERE id=? AND approved_at IS NULL`, args: [at, String(r.id)] });
    }
  }
  return figures;
}

/**
 * Restate (or, with `reverses`, un-restate) this workspace's own credit
 * figures. A dry run reads and reports; a real run writes once per conversion id.
 */
export async function convertTenantFigures(ws: TenantWorkspace, plan: TenantPlan): Promise<TenantFigure[]> {
  return runInTenant(ws, async () => {
    await ready();
    const client: Client = db();
    if (plan.dryRun) return work(client, plan);
    await client.batch(ROWS_SCHEMA, "write");
    const tx = await client.transaction("write");
    try {
      const done = await tx.execute({ sql: `SELECT applied_at FROM credit_unit_applied WHERE conversion_id=?`, args: [plan.conversionId] });
      if (done.rows.length) { await tx.rollback(); return []; }
      const figures = await work(tx, plan);
      await tx.execute({ sql: `INSERT INTO credit_unit_applied(conversion_id,applied_at) VALUES(?,?)`, args: [plan.conversionId, Date.now()] });
      await tx.commit();
      memoDrop("settings");
      return figures;
    } catch (error) {
      await tx.rollback().catch(() => {});
      throw error;
    } finally {
      tx.close();
    }
  });
}
