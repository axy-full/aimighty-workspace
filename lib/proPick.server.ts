import { platformDb, platformReady } from "./platform";
import { MODELS, displayModelName, findModel, isOffered } from "./models";
import { openGatedModels } from "./modelGate";
import { PRO_PICK_DEFAULT, cleanProPick, type ProPickEntry, type ProPickRow } from "./proPick";

/**
 * The server half of the Pro pick (lib/proPick.ts): the list in force (the site override, else the default) and, for the workspace in scope, which of its entries are there.
 * Reads the `proPick` field of the site row tolerantly, as lib/engineGate.ts reads `enginesOnWorkspaces`: a row that cannot be read, or an override that is not wholly well
 * formed, is the default.
 */
export async function proPickConfig(): Promise<readonly ProPickEntry[]> {
  try {
    await platformReady();
    const rs = await platformDb().execute({ sql: "SELECT value FROM platform_layer WHERE key = ?", args: ["site"] });
    const raw = (rs.rows[0] as { value?: unknown } | undefined)?.value;
    if (typeof raw !== "string") return PRO_PICK_DEFAULT;
    return cleanProPick((JSON.parse(raw) as { proPick?: unknown }).proPick) ?? PRO_PICK_DEFAULT;
  } catch {
    return PRO_PICK_DEFAULT;
  }
}

/** The seams a test can hand in; the composer's route passes none. */
export type ProPickSeams = {
  config?: readonly ProPickEntry[];
  /** The direct engines' tool names present for the workspace (lib/directEngineMcp.ts). */
  tools?: ReadonlySet<string>;
  /** The ids of the registry models the workspace's composer lists, gated ones included only while open. */
  models?: ReadonlySet<string>;
};

/**
 * The Pro entries that are there for this workspace, in order. A model entry is there when the composer lists the model (the registry's offered models, and a gated model only
 * while its switch is open and its row confirmed); a tool entry when the direct engine's tool is present. An entry that is not there stands in its fallback, under the fallback's
 * own name, when it has one, and is left out otherwise.
 */
export async function resolveProPick(seams: ProPickSeams = {}): Promise<ProPickRow[]> {
  const config = seams.config ?? (await proPickConfig());
  const models = seams.models ?? new Set([...MODELS.filter(isOffered).map((m) => m.id), ...(await openGatedModels()).map((m) => m.id)]);
  const tools = seams.tools ?? new Set((await (await import("./directEngineMcp")).directEngineMcpTools()).map((t) => t.name));
  const rows: ProPickRow[] = [];
  for (const entry of config) {
    const e = entry.engine;
    if (e.kind === "model" ? models.has(e.id) : tools.has(e.id)) {
      rows.push(e.kind === "model" ? { key: entry.key, label: entry.label, kind: "model", id: e.id, fellBack: false } : { key: entry.key, label: entry.label, kind: "tool", id: e.id, ...(e.model ? { model: e.model } : {}), fellBack: false });
    } else if (entry.fallback && models.has(entry.fallback.id) && findModel(entry.fallback.id)) {
      rows.push({ key: entry.key, label: displayModelName(entry.fallback.id), kind: "model", id: entry.fallback.id, fellBack: true });
    }
  }
  return rows;
}

/** The composer's engine rows with `pro` set (the entry's place, from 1) on those that are a Pro entry's model. */
export function markPro<T extends { id: string }>(rows: readonly T[], pro: readonly ProPickRow[]): (T & { pro?: number })[] {
  const place = new Map<string, number>();
  pro.forEach((p, i) => { if (p.kind === "model" && !place.has(p.id)) place.set(p.id, i + 1); });
  return rows.map((row) => (place.has(row.id) ? { ...row, pro: place.get(row.id)! } : row));
}
